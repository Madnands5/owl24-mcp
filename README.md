# owl24-mcp

MCP server for [owl24](https://owl24.dev) — gives Claude Code, Cursor, or any [MCP](https://modelcontextprotocol.io)-speaking client direct access to your error queue. Ask "what's breaking in checkout" and get an answer, instead of writing a script against a REST API first.

This doesn't replace the [REST-plus-AGENTS.md](https://owl24.dev/docs#agent-integration) workflow — it's a thinner way to reach the exact same endpoints. If you already have an AGENTS.md-driven CI loop working, you don't need this. This is for working *with* your agent interactively, from inside your editor.

## What it can do

| Tool | Does |
|---|---|
| `list_errors` | Deduplicated error groups — occurrence counts, first/last seen, queue state, whether an AI report already exists |
| `queue_error` | Adds an error group to the agent-access queue (free, never calls AI) |
| `list_queue` | Lists queue items — defaults to open/unclaimed |
| `claim_error` | Claims a queue item so nothing else works it at the same time |
| `get_trace` | The actual evidence — spans, logs, stack trace for one trace |
| `get_rca_report` | Checks for an *existing* cached AI root-cause report (read-only) |
| `resolve_error` | Marks a queue item resolved, with a note naming the PR and fingerprint — **this is what's billed** (see below) |
| `count_open_items` | Cheap poll target — just the open-item count, no full list fetch |
| `release_error` | Gives up on a claimed item **for free**, without resolving it |
| `extend_claim` | Pushes a claim's expiry out if you're still actively working it |

**What it deliberately can't do:** run a new AI Root-Cause Analysis. That's a separate, paid, human action from the owl24 dashboard — this server never spends AI-RCA credit on its own initiative. `get_rca_report` only reads a report that already exists; if one doesn't, investigate from `get_trace`'s data instead, the same way [AGENTS.md](https://owl24.dev/owl24-AGENTS.md) already tells an agent to.

**Billing:** listing, queuing, claiming, releasing, and extending are all free. A small per-item charge (current rate on [Pricing](https://owl24.dev/#pricing)) applies only when `resolve_error` marks something resolved, up to a monthly cap you control from the project's Agent Access panel. If you can't actually confirm a fix, call `release_error` instead of `resolve_error` — it's the free exit, not a lesser version of resolving.

We don't build, run, or host your agent. This server runs locally, on your machine, using your own project API key — same trust model as the REST workflow it wraps.

## Install

You don't need to install this yourself — most MCP clients run it via `npx` on demand.

### Claude Code

```bash
claude mcp add owl24 -e OWL24_API_KEY=your_api_key -- npx -y owl24-mcp
```

### Cursor

Add to your MCP settings (`Cursor Settings → MCP`):

```json
{
  "mcpServers": {
    "owl24": {
      "command": "npx",
      "args": ["-y", "owl24-mcp"],
      "env": {
        "OWL24_API_KEY": "your_api_key"
      }
    }
  }
}
```

Any other MCP client: the same `command`/`args`/`env` shape works — `npx -y owl24-mcp` over stdio, with `OWL24_API_KEY` in the environment.

Get your API key from a project's page on [the owl24 dashboard](https://owl24.dev/projects). Agent Access needs to be turned on for that project first (`Agent Access (Beta)` toggle) — every tool here 403s until it is.

## Environment variables

| Variable | Required | Default |
|---|---|---|
| `OWL24_API_KEY` | Yes | — |
| `OWL24_API_BASE` | No | `https://api.owl24.dev` — override for self-hosted/local testing |

## Example

Once connected, in Claude Code or Cursor:

> What's breaking in checkout-service?

The model calls `list_errors({ serviceName: "checkout-service" })`, reads the results, and can go straight into `get_trace` for the top offender, write the fix itself, and — once you've opened the PR — `resolve_error` with a note. A human always reviews the PR; nothing here merges anything.

## License

MIT
