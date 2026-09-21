// client.js
//
// Thin wrapper over owl24's existing dashboard-api endpoints - every one of
// these already exists, is already documented (tracelite-ui's docs page,
// "Agent integration" section), and is already what the manually-written
// AGENTS.md workflow tells a coding agent to curl. This file changes NONE of
// that server-side behavior; it just gives an MCP client typed, named tools
// instead of a REST spec to re-implement per agent.
//
// Auth is the same x-api-key header the SDKs and AGENTS.md workflow already
// use (validateApiKey in dashboard-api.js) - no new auth mechanism, no new
// credential to manage. Deliberately does NOT expose a "run a new AI-RCA"
// tool: that requires POSTing a full trace payload to a Next.js route
// (tracelite-ui's app/api/ai/rca/route.ts) that spends a real, billed Gemini
// call. Making that one MCP tool call away from an LLM's own judgment is
// exactly the "stuck with a huge AI bill" failure mode the manual RCA button
// was built to prevent in the first place - an agent deciding on its own that
// root-cause analysis would be "helpful" and spending real money without a
// human in the loop. get_rca_report below only ever reads an EXISTING,
// already-paid-for cached report; it never triggers a new one.

export class Owl24ApiError extends Error {
  constructor(status, body) {
    super(typeof body?.error === 'string' ? body.error : `owl24 API returned ${status}`);
    this.name = 'Owl24ApiError';
    this.status = status;
    this.body = body;
  }
}

export function createClient({ apiKey, baseUrl }) {
  if (!apiKey) {
    throw new Error('OWL24_API_KEY is required - set it in the MCP client config that launches this server.');
  }
  const base = (baseUrl || 'https://api.owl24.dev').replace(/\/+$/, '');

  // Every call site below builds its own querystring rather than sharing one
  // helper for the ~4 params involved - not worth an abstraction for this
  // few call sites, and each endpoint's params are different enough (some
  // take serviceName, some take status, some take neither) that a shared
  // "build query" helper would need almost as many conditionals as just
  // writing each one out plainly.
  const request = async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        'x-api-key': apiKey,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    // 404 is a normal, expected outcome for get_rca_report (see its own
    // comment below) - every OTHER caller treats it as a real error via the
    // shared !res.ok branch, get_rca_report is the one place that
    // special-cases it before this function is even called.
    let parsed = null;
    try {
      parsed = await res.json();
    } catch {
      // A non-JSON body (e.g. a plain-text 500 from an upstream proxy) is
      // still a real error condition below; parsed staying null is fine,
      // Owl24ApiError's message just falls back to the status code.
    }

    if (!res.ok) {
      throw new Owl24ApiError(res.status, parsed);
    }
    return parsed;
  };

  return {
    /**
     * Deduplicated error groups - the same list the dashboard's Errors view
     * shows, including whether each one is already queued/claimed/resolved
     * and whether a cached AI report exists for it (has_report).
     */
    listErrors: async ({ serviceName, search, limit } = {}) => {
      const params = new URLSearchParams();
      if (serviceName) params.set('serviceName', serviceName);
      if (search) params.set('search', search);
      if (limit) params.set('limit', String(limit));
      const qs = params.toString();
      return request(`/api/v1/error-groups${qs ? `?${qs}` : ''}`);
    },

    /**
     * Queues one or more error groups by fingerprint (from listErrors'
     * `fingerprint` field) for agent hand-off. Free, and does not call any
     * AI provider - matches POST /api/v1/agent-access exactly.
     */
    queueErrors: async ({ fingerprints }) => {
      if (!Array.isArray(fingerprints) || fingerprints.length === 0) {
        throw new Error('fingerprints must be a non-empty array of error-group fingerprints');
      }
      return request('/api/v1/agent-access', { method: 'POST', body: { fingerprints } });
    },

    /**
     * Lists queue items - defaults to unresolved-only (status omitted),
     * matching what a polling agent wants; pass status: 'all' or 'resolved'
     * for the dashboard's own broader views.
     */
    listQueue: async ({ serviceName, status } = {}) => {
      const params = new URLSearchParams();
      if (serviceName) params.set('serviceName', serviceName);
      if (status) params.set('status', status);
      const qs = params.toString();
      return request(`/api/v1/agent-access${qs ? `?${qs}` : ''}`);
    },

    /**
     * Claims one queue item (by its numeric id, from listQueue's `id`
     * field). 409 means someone/something else already holds it - surfaced
     * as an Owl24ApiError with status 409, not swallowed, so the caller can
     * decide to move on to the next item rather than treat it as fatal.
     */
    claimError: async ({ id, claimedBy, serviceName }) => {
      if (!Number.isInteger(id)) throw new Error('id must be the queue item\'s numeric id');
      return request(`/api/v1/agent-access/${id}/claim`, {
        method: 'POST',
        body: { claimedBy: claimedBy || 'owl24-mcp', serviceName },
      });
    },

    /**
     * The actual evidence: spans, logs, and the stack trace for one trace.
     * This is what AGENTS.md tells an agent to investigate from - a report
     * (see getRcaReport) is a bonus when one exists, not the starting point.
     */
    getTrace: async ({ traceId }) => {
      if (!traceId) throw new Error('traceId is required');
      return request(`/api/v1/trace/${encodeURIComponent(traceId)}`);
    },

    /**
     * Reads a CACHED AI root-cause report, if one already exists for this
     * trace - it does not run a new analysis.
     *
     * Confirmed live 2026-09-20 against the real endpoint (GET
     * /api/v1/trace/:traceId/analysis, dashboard-api.js): it never 404s.
     * The route always returns 200 with `{ report: null }` when no analysis
     * exists yet - the tracelite-ui docs page's own AGENTS.md workflow text
     * says "a 404 there is normal," which is stale/wrong (a separate fix,
     * filed against DocsContent.tsx). Checking `report === null` here is
     * the only signal that's actually real; a 404 handler is kept as
     * defense-in-depth in case that ever changes, not because it fires
     * today.
     */
    getRcaReport: async ({ traceId }) => {
      if (!traceId) throw new Error('traceId is required');
      try {
        const data = await request(`/api/v1/trace/${encodeURIComponent(traceId)}/analysis`);
        return data?.report ? { found: true, report: data.report } : { found: false, report: null };
      } catch (err) {
        if (err instanceof Owl24ApiError && err.status === 404) {
          return { found: false, report: null };
        }
        throw err;
      }
    },

    /**
     * Resolves a queue item with a note. Per AGENTS.md convention, the note
     * should name both the PR and the fingerprint it addresses - that's
     * what later makes "did this error actually stop happening?" checkable.
     * Resolving is an update, not a delete: the item stays as a permanent
     * record of what was reviewed and when.
     */
    resolveError: async ({ id, resolutionNote, serviceName }) => {
      if (!Number.isInteger(id)) throw new Error('id must be the queue item\'s numeric id');
      return request(`/api/v1/agent-access/${id}`, {
        method: 'PATCH',
        body: { resolutionNote, serviceName },
      });
    },

    /**
     * Cheap poll target - how many open (unclaimed-or-claimed, unresolved)
     * items are waiting, without fetching the full list. Matches GET
     * /api/v1/agent-access/count exactly - check this before listQueue on
     * every poll, and skip the full fetch when count is 0.
     */
    countOpenItems: async ({ serviceName } = {}) => {
      const params = new URLSearchParams();
      if (serviceName) params.set('serviceName', serviceName);
      const qs = params.toString();
      return request(`/api/v1/agent-access/count${qs ? `?${qs}` : ''}`);
    },

    /**
     * Releases a claimed item back to open WITHOUT resolving it - the free
     * exit when an agent can't actually find or fix the cause. This is not
     * billed the way resolveError can be; use this instead of resolving
     * something you didn't actually fix, so the item's own billing status
     * stays accurate for whoever claims it next. `reason` is required by
     * the server and is recorded in attempt_history.
     */
    releaseError: async ({ id, reason, serviceName }) => {
      if (!Number.isInteger(id)) throw new Error('id must be the queue item\'s numeric id');
      if (!reason || !reason.trim()) throw new Error('reason is required - say what you ruled out and why you\'re giving up, so the next claimant does not repeat the same dead end.');
      return request(`/api/v1/agent-access/${id}/release`, {
        method: 'POST',
        body: { reason, serviceName },
      });
    },

    /**
     * Pushes a claim's expiry another claim-TTL window out. Use this if
     * you're still actively working an item and getting close to
     * claim_expires_at - the alternative is racing the clock and risking
     * another agent claiming it out from under you.
     */
    extendClaim: async ({ id, claimedBy, serviceName }) => {
      if (!Number.isInteger(id)) throw new Error('id must be the queue item\'s numeric id');
      return request(`/api/v1/agent-access/${id}/extend`, {
        method: 'POST',
        body: { claimedBy, serviceName },
      });
    },
  };
}
