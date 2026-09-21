#!/usr/bin/env node
// owl24-mcp - MCP server exposing owl24's agent-access queue as tools an MCP
// client (Claude Code, Cursor, or anything else that speaks MCP) can call
// directly, instead of an agent having to be separately instructed to curl a
// REST API from an AGENTS.md file.
//
// Runs over stdio, spawned locally by the MCP client - same trust model as
// the existing hand-off: this process runs on the customer's own machine,
// on their own subscription, using their own project API key. owl24 never
// runs or hosts this; it's just a thinner way to reach the same endpoints
// AGENTS.md already documents.
//
// Every tool here maps to one existing, already-shipped dashboard-api
// endpoint - see client.js for the exact mapping and why get_rca_report is
// read-only (no tool here can spend a real AI-RCA credit on its own
// initiative).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createClient, Owl24ApiError } from './client.js';

const apiKey = process.env.OWL24_API_KEY;
// Overridable for local/self-hosted testing (matches OWL24_INGEST_URL's
// role in the server SDKs) - production customers never need to set this.
const baseUrl = process.env.OWL24_API_BASE;

if (!apiKey) {
  // Written to stderr, not stdout: stdout is the MCP JSON-RPC channel, and
  // writing plain text there would corrupt the protocol stream rather than
  // surface as a readable error in the client's logs.
  console.error('[owl24-mcp] OWL24_API_KEY is not set. Add it to this server\'s env in your MCP client config.');
  process.exit(1);
}

const client = createClient({ apiKey, baseUrl });

// Every handler follows the same shape: call the client, and on failure
// return isError: true with the real message as tool content rather than
// throwing - an MCP tool error is meant to be readable by the calling model
// (so it can decide to retry, skip, or explain the failure to the human),
// not a transport-level crash.
const toResult = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const toError = (err) => ({
  isError: true,
  content: [{
    type: 'text',
    text: err instanceof Owl24ApiError
      ? `owl24 API error (${err.status}): ${err.message}`
      : `owl24-mcp error: ${err.message}`,
  }],
});

const server = new McpServer({ name: 'owl24-mcp', version: '0.2.0' });

server.registerTool(
  'list_errors',
  {
    title: 'List broken things',
    description: "Lists deduplicated error groups for this project - one row per distinct bug, with occurrence count, first/last seen, which service it's in, whether it's already queued/claimed/resolved (queue_state), and whether a cached AI root-cause report already exists for it (has_report). Use this to answer \"what's breaking in <service>\" - filter with serviceName. Each group's `fingerprint` is what you pass to queue_error, and `sample_trace_id` is what you pass to get_trace / get_rca_report.",
    inputSchema: {
      serviceName: z.string().optional().describe('Exact service name to filter to, e.g. "checkout-service". Omit to see every service.'),
      search: z.string().optional().describe('Substring match against service name or operation name.'),
      limit: z.number().int().min(1).max(100).optional().describe('Max groups to return (default 20, max 100).'),
    },
  },
  async (args) => {
    try {
      return toResult(await client.listErrors(args));
    } catch (err) {
      return toError(err);
    }
  }
);

server.registerTool(
  'queue_error',
  {
    title: 'Queue an error for hand-off',
    description: 'Adds one or more error groups (by fingerprint, from list_errors) to the agent-access queue. Free, and never calls an AI provider - this only marks errors as ready for an agent to claim and investigate. Safe to call again on an already-queued-and-open fingerprint (a no-op, reported back as "skipped").',
    inputSchema: {
      fingerprints: z.array(z.string()).min(1).describe('One or more error-group fingerprints from list_errors.'),
    },
  },
  async (args) => {
    try {
      return toResult(await client.queueErrors(args));
    } catch (err) {
      return toError(err);
    }
  }
);

server.registerTool(
  'list_queue',
  {
    title: 'List the agent-access queue',
    description: 'Lists items already in the agent-access queue, each with its numeric id (what claim_error/resolve_error need), fingerprint, trace_id, service_name, and claim state. Defaults to open (unclaimed, unresolved) items only - the actual work queue. Pass status: "all" or "resolved" to see history instead.',
    inputSchema: {
      serviceName: z.string().optional().describe('Exact service name to filter to.'),
      status: z.enum(['open', 'all', 'resolved']).optional().describe('Defaults to open items only.'),
    },
  },
  async (args) => {
    try {
      return toResult(await client.listQueue(args));
    } catch (err) {
      return toError(err);
    }
  }
);

server.registerTool(
  'claim_error',
  {
    title: 'Claim a queue item',
    description: 'Claims one queue item by its numeric id (from list_queue), so no other agent works it at the same time. Returns a 409-shaped error if something else already holds the claim within its TTL - that is expected and not fatal; move on to the next item rather than treating it as a hard failure.',
    inputSchema: {
      // Coerced, not a plain z.number(): dashboard-api.js's own JSON response
      // (list_queue's own `id` field) comes back as a string - Postgres
      // BIGINT ids are serialized as strings by the driver, and the existing
      // REST/curl workflow never had to care since a curl URL is text
      // either way. An agent naturally piping list_queue's id straight into
      // claim_error would otherwise fail validation on a perfectly valid id
      // it just read from this same server. Confirmed live 2026-09-20.
      id: z.coerce.number().int().describe("The queue item's numeric id, from list_queue."),
      claimedBy: z.string().optional().describe('An identifier for this agent/run, e.g. "claude-code" or a CI run id. Defaults to "owl24-mcp".'),
      serviceName: z.string().optional().describe('If set, the claim only succeeds if the item belongs to this service - a safety check when a claim script is scoped to one service.'),
    },
  },
  async (args) => {
    try {
      return toResult(await client.claimError(args));
    } catch (err) {
      return toError(err);
    }
  }
);

server.registerTool(
  'get_trace',
  {
    title: 'Read the trace - the real evidence',
    description: 'Fetches the spans, logs, and stack trace for one trace_id (from list_errors\' sample_trace_id or list_queue\'s trace_id). This is the primary evidence to investigate from - most queued items have no AI report attached (queuing never runs one), so read this before assuming one exists.',
    inputSchema: {
      traceId: z.string().describe('The trace_id to fetch, from list_errors or list_queue.'),
    },
  },
  async (args) => {
    try {
      return toResult(await client.getTrace(args));
    } catch (err) {
      return toError(err);
    }
  }
);

server.registerTool(
  'get_rca_report',
  {
    title: 'Check for an existing AI root-cause report',
    description: 'Checks whether a human already ran (and paid for) AI Root-Cause Analysis on this trace, and returns it if so. Read-only - this tool NEVER runs a new analysis or spends AI-RCA credit. Returns {found: false} for the normal case where no report exists yet; that is not an error, and is not a reason to wait for one - investigate from get_trace\'s data instead. Running a new analysis is a deliberate, paid, human action taken from the owl24 dashboard, by design not something this MCP server can trigger on its own.',
    inputSchema: {
      traceId: z.string().describe('The trace_id to check.'),
    },
  },
  async (args) => {
    try {
      return toResult(await client.getRcaReport(args));
    } catch (err) {
      return toError(err);
    }
  }
);

server.registerTool(
  'resolve_error',
  {
    title: 'Mark a queue item resolved',
    description: 'Resolves a queue item once you have opened a pull request for it. Always include the PR link and the fingerprint you believe you fixed in resolutionNote (e.g. "Opened myorg/myrepo#123 - fixes fingerprint <fingerprint>") - that is what lets a later check confirm the error actually stopped recurring. Resolving is a permanent record, not a delete, and does not require you to be the one who claimed it. IMPORTANT: resolving is what triggers billing on the account\'s wallet (see the owl24 Pricing page) - only call this once you have real evidence the fix works, not as a way to give up on an item. If you can\'t actually confirm the cause, call release_error instead - it\'s free.',
    inputSchema: {
      id: z.coerce.number().int().describe("The queue item's numeric id."),
      resolutionNote: z.string().max(2000).optional().describe('What you did - should name the PR and the fingerprint fixed.'),
      serviceName: z.string().optional().describe('If set, only resolves if the item belongs to this service.'),
    },
  },
  async (args) => {
    try {
      return toResult(await client.resolveError(args));
    } catch (err) {
      return toError(err);
    }
  }
);

server.registerTool(
  'count_open_items',
  {
    title: 'Cheap poll: how many open items are there',
    description: 'Returns just the count of open (unresolved) queue items, without the cost of fetching the full list - call this on every poll and only call list_queue when the count is greater than 0. Matches GET /api/v1/agent-access/count.',
    inputSchema: {
      serviceName: z.string().optional().describe('Exact service name to filter to. Omit to count across every service.'),
    },
  },
  async (args) => {
    try {
      return toResult(await client.countOpenItems(args));
    } catch (err) {
      return toError(err);
    }
  }
);

server.registerTool(
  'release_error',
  {
    title: 'Give up on a claimed item, for free',
    description: 'Releases a claimed item back to open WITHOUT resolving it - this is the free exit when you can\'t actually find or confirm the cause. Unlike resolve_error, this is never billed. `reason` is required and is kept in the item\'s attempt history so the next claimant (you next time, or a human) knows what was already ruled out. Prefer this over resolve_error when you are not actually confident in the fix.',
    inputSchema: {
      id: z.coerce.number().int().describe("The queue item's numeric id."),
      reason: z.string().min(1).max(2000).describe('Required. What you ruled out and why you\'re giving up on this attempt.'),
      serviceName: z.string().optional().describe('If set, only releases if the item belongs to this service.'),
    },
  },
  async (args) => {
    try {
      return toResult(await client.releaseError(args));
    } catch (err) {
      return toError(err);
    }
  }
);

server.registerTool(
  'extend_claim',
  {
    title: 'Extend a claim before it expires',
    description: 'Pushes a claim\'s expiry another claim-TTL window out. Use this if you\'re still actively working an item and getting close to claim_expires_at (from claim_error\'s or list_queue\'s response) - the alternative is racing the clock and risking another agent claiming it out from under you. Free, and does not affect billing either way.',
    inputSchema: {
      id: z.coerce.number().int().describe("The queue item's numeric id."),
      claimedBy: z.string().optional().describe('Must match the identifier the claim was made with, if one was set.'),
      serviceName: z.string().optional().describe('If set, only extends if the item belongs to this service.'),
    },
  },
  async (args) => {
    try {
      return toResult(await client.extendClaim(args));
    } catch (err) {
      return toError(err);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[owl24-mcp] Connected over stdio.');
