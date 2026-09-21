// client.js's job is entirely "translate a tool call into the right HTTP
// request against dashboard-api.js's already-shipped endpoints" - these
// tests lock in the exact method/path/body/query-param shape for each one,
// against the docs page's own documented request/response examples (see
// tracelite-ui's app/docs/DocsContent.tsx, "Agent integration" section),
// not just against whatever client.js happens to do. A mismatch here means
// a real customer's agent calling a real endpoint wrong.
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, Owl24ApiError } from '../client.js';

let calls;
let responder;

beforeEach(() => {
  calls = [];
  responder = async () => ({ status: 200, body: {} });
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    const { status, body } = await responder(url, opts);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  };
});

afterEach(() => {
  delete global.fetch;
});

describe('createClient', () => {
  test('throws immediately without an API key - never makes a request with no auth', () => {
    assert.throws(() => createClient({ apiKey: '' }), /OWL24_API_KEY/);
    assert.equal(calls.length, 0);
  });

  test('defaults to the real production base URL', async () => {
    const client = createClient({ apiKey: 'k1' });
    await client.listErrors({});
    assert.match(calls[0].url, /^https:\/\/api\.owl24\.dev\//);
  });

  test('honors OWL24_API_BASE override, trimming a trailing slash', async () => {
    const client = createClient({ apiKey: 'k1', baseUrl: 'http://localhost:4001/' });
    await client.listErrors({});
    assert.equal(calls[0].url, 'http://localhost:4001/api/v1/error-groups');
  });

  test('every request carries x-api-key', async () => {
    const client = createClient({ apiKey: 'secret-key' });
    await client.listErrors({});
    assert.equal(calls[0].opts.headers['x-api-key'], 'secret-key');
  });
});

describe('listErrors', () => {
  test('GET /api/v1/error-groups with no params when none given', async () => {
    const client = createClient({ apiKey: 'k' });
    await client.listErrors({});
    assert.equal(calls[0].url, 'https://api.owl24.dev/api/v1/error-groups');
    assert.equal(calls[0].opts.method, 'GET');
  });

  test('serializes serviceName, search, and limit as query params', async () => {
    const client = createClient({ apiKey: 'k' });
    await client.listErrors({ serviceName: 'checkout-service', search: 'timeout', limit: 5 });
    const url = new URL(calls[0].url);
    assert.equal(url.searchParams.get('serviceName'), 'checkout-service');
    assert.equal(url.searchParams.get('search'), 'timeout');
    assert.equal(url.searchParams.get('limit'), '5');
  });
});

describe('queueErrors', () => {
  test('POST /api/v1/agent-access with a fingerprints array - matches the documented request', async () => {
    responder = async () => ({
      status: 200,
      body: { added: ['cf38a1d1'], skipped: [], notFound: [], counts: { added: 1, skipped: 0, notFound: 0 } },
    });
    const client = createClient({ apiKey: 'k' });
    const result = await client.queueErrors({ fingerprints: ['cf38a1d1'] });
    assert.equal(calls[0].url, 'https://api.owl24.dev/api/v1/agent-access');
    assert.equal(calls[0].opts.method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].opts.body), { fingerprints: ['cf38a1d1'] });
    assert.equal(calls[0].opts.headers['Content-Type'], 'application/json');
    assert.deepEqual(result.added, ['cf38a1d1']);
  });

  test('rejects an empty fingerprints array before making a request', async () => {
    const client = createClient({ apiKey: 'k' });
    await assert.rejects(client.queueErrors({ fingerprints: [] }), /non-empty array/);
    assert.equal(calls.length, 0);
  });
});

describe('listQueue', () => {
  test('GET /api/v1/agent-access, status omitted by default (open items)', async () => {
    const client = createClient({ apiKey: 'k' });
    await client.listQueue({});
    assert.equal(calls[0].url, 'https://api.owl24.dev/api/v1/agent-access');
  });

  test('passes status through when given', async () => {
    const client = createClient({ apiKey: 'k' });
    await client.listQueue({ status: 'resolved' });
    const url = new URL(calls[0].url);
    assert.equal(url.searchParams.get('status'), 'resolved');
  });
});

describe('claimError', () => {
  test('POST /api/v1/agent-access/:id/claim with claimedBy defaulted', async () => {
    const client = createClient({ apiKey: 'k' });
    await client.claimError({ id: 42 });
    assert.equal(calls[0].url, 'https://api.owl24.dev/api/v1/agent-access/42/claim');
    const body = JSON.parse(calls[0].opts.body);
    assert.equal(body.claimedBy, 'owl24-mcp');
  });

  test('a 409 (already claimed) surfaces as Owl24ApiError with status 409, not a generic throw', async () => {
    responder = async () => ({ status: 409, body: { error: 'Already claimed, resolved, service mismatch, or not found' } });
    const client = createClient({ apiKey: 'k' });
    await assert.rejects(client.claimError({ id: 42 }), (err) => {
      assert.ok(err instanceof Owl24ApiError);
      assert.equal(err.status, 409);
      return true;
    });
  });

  test('rejects a non-integer id before making a request', async () => {
    const client = createClient({ apiKey: 'k' });
    await assert.rejects(client.claimError({ id: 'forty-two' }), /numeric id/);
    assert.equal(calls.length, 0);
  });
});

describe('getTrace', () => {
  test('GET /api/v1/trace/:traceId, URL-encoded', async () => {
    const client = createClient({ apiKey: 'k' });
    await client.getTrace({ traceId: 'abc/def' });
    assert.equal(calls[0].url, 'https://api.owl24.dev/api/v1/trace/abc%2Fdef');
  });
});

describe('getRcaReport', () => {
  test('returns { found: true, report } when the response has a real report', async () => {
    responder = async () => ({ status: 200, body: { report: { summary: 'root cause here' } } });
    const client = createClient({ apiKey: 'k' });
    const result = await client.getRcaReport({ traceId: 't1' });
    assert.deepEqual(result, { found: true, report: { summary: 'root cause here' } });
  });

  test('a real 200 response with report: null becomes { found: false } - this is the ACTUAL "no report" signal, confirmed live 2026-09-20 (this endpoint never 404s, contrary to what the docs page claims)', async () => {
    responder = async () => ({ status: 200, body: { report: null } });
    const client = createClient({ apiKey: 'k' });
    const result = await client.getRcaReport({ traceId: 't1' });
    assert.deepEqual(result, { found: false, report: null });
  });

  test('a 404 (kept as defense-in-depth, not because it happens today) also becomes { found: false }, not a thrown error', async () => {
    responder = async () => ({ status: 404, body: { error: 'Not found' } });
    const client = createClient({ apiKey: 'k' });
    const result = await client.getRcaReport({ traceId: 't1' });
    assert.deepEqual(result, { found: false, report: null });
  });

  test('a non-404 error (e.g. 500) still throws - only 404 is treated as "normal"', async () => {
    responder = async () => ({ status: 500, body: { error: 'boom' } });
    const client = createClient({ apiKey: 'k' });
    await assert.rejects(client.getRcaReport({ traceId: 't1' }), (err) => {
      assert.ok(err instanceof Owl24ApiError);
      assert.equal(err.status, 500);
      return true;
    });
  });
});

describe('resolveError', () => {
  test('PATCH /api/v1/agent-access/:id with the resolution note', async () => {
    const client = createClient({ apiKey: 'k' });
    await client.resolveError({ id: 42, resolutionNote: 'Opened org/repo#123 - fixes fingerprint abc' });
    assert.equal(calls[0].url, 'https://api.owl24.dev/api/v1/agent-access/42');
    assert.equal(calls[0].opts.method, 'PATCH');
    const body = JSON.parse(calls[0].opts.body);
    assert.equal(body.resolutionNote, 'Opened org/repo#123 - fixes fingerprint abc');
  });
});

describe('countOpenItems', () => {
  test('GET /api/v1/agent-access/count with no params when none given', async () => {
    responder = async () => ({ status: 200, body: { count: 0 } });
    const client = createClient({ apiKey: 'k' });
    const result = await client.countOpenItems();
    assert.equal(calls[0].url, 'https://api.owl24.dev/api/v1/agent-access/count');
    assert.equal(calls[0].opts.method, 'GET');
    assert.deepEqual(result, { count: 0 });
  });

  test('serializes serviceName as a query param', async () => {
    const client = createClient({ apiKey: 'k' });
    await client.countOpenItems({ serviceName: 'checkout-service' });
    const url = new URL(calls[0].url);
    assert.equal(url.searchParams.get('serviceName'), 'checkout-service');
  });
});

describe('releaseError', () => {
  test('POST /api/v1/agent-access/:id/release with the required reason', async () => {
    const client = createClient({ apiKey: 'k' });
    await client.releaseError({ id: 42, reason: 'Ruled out a null-pointer, could not confirm a cause.' });
    assert.equal(calls[0].url, 'https://api.owl24.dev/api/v1/agent-access/42/release');
    assert.equal(calls[0].opts.method, 'POST');
    const body = JSON.parse(calls[0].opts.body);
    assert.equal(body.reason, 'Ruled out a null-pointer, could not confirm a cause.');
  });

  test('rejects a missing reason before making a request - matches the server\'s own requirement', async () => {
    const client = createClient({ apiKey: 'k' });
    await assert.rejects(client.releaseError({ id: 42, reason: '' }), /reason is required/);
    assert.equal(calls.length, 0);
  });

  test('rejects a non-integer id before making a request', async () => {
    const client = createClient({ apiKey: 'k' });
    await assert.rejects(client.releaseError({ id: 'forty-two', reason: 'why' }), /numeric id/);
    assert.equal(calls.length, 0);
  });
});

describe('extendClaim', () => {
  test('POST /api/v1/agent-access/:id/extend with claimedBy and serviceName', async () => {
    const client = createClient({ apiKey: 'k' });
    await client.extendClaim({ id: 42, claimedBy: 'my-agent-v1', serviceName: 'checkout-service' });
    assert.equal(calls[0].url, 'https://api.owl24.dev/api/v1/agent-access/42/extend');
    assert.equal(calls[0].opts.method, 'POST');
    const body = JSON.parse(calls[0].opts.body);
    assert.equal(body.claimedBy, 'my-agent-v1');
    assert.equal(body.serviceName, 'checkout-service');
  });

  test('rejects a non-integer id before making a request', async () => {
    const client = createClient({ apiKey: 'k' });
    await assert.rejects(client.extendClaim({ id: 'forty-two' }), /numeric id/);
    assert.equal(calls.length, 0);
  });
});
