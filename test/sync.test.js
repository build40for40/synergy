import test from 'node:test';
import assert from 'node:assert/strict';
import { saveProfile, upsertCompanies } from '../worker/store.js';
import { DEFAULT_FILTER, DEFAULT_SORT, syncCompanies } from '../worker/sync.js';
import { TOKEN_URL } from '../worker/dealroom.js';
import { company, database } from './helpers.js';

const env = () => ({ DB: database(), DEALROOM_CLIENT_ID: 'id', DEALROOM_API_KEY: 'secret' });

// A fake Dealroom: `respond(params)` returns the JSON body for each companies request.
function dealroom(respond) {
  const requests = [];
  const fetch = async (url, init) => {
    if (String(url) === TOKEN_URL) return Response.json({ access_token: 'tok' });
    const params = Object.fromEntries(new URL(url).searchParams);
    requests.push(params);
    const { status = 200, body } = respond(params, requests.length);
    return new Response(JSON.stringify(body), { status, headers: { 'X-Credits-Used': String(2 * (body.data?.length ?? 0)) } });
  };
  return { fetch, requests };
}
const page = (from, to, next) => ({ body: { data: Array.from({ length: to - from + 1 }, (_, i) => company(from + i)), page: { next_cursor: next } } });

test('uses the brief\'s default filter and sort when the profile sets none', async () => {
  const api = dealroom(() => page(1, 2, null));
  await syncCompanies(env(), { fetch: api.fetch });
  assert.equal(api.requests[0].filter, DEFAULT_FILTER);
  assert.equal(api.requests[0].sort, DEFAULT_SORT);
  assert.equal(api.requests[0].view, 'full');
  for (const part of ['hq_location[eq]:93', 'launch_date[lte]:2016', 'employee_count_1y_growth[gt]:0', 'latest_revenue[is_not_null]', 'total_funding[is_null]']) {
    assert.ok(DEFAULT_FILTER.includes(part), part);
  }
});

test('the next run continues from the saved cursor, and a new filter starts over', async () => {
  const e = env();
  const api = dealroom(params => (params.cursor === 'c2' ? page(3, 4, 'c3') : page(1, 2, 'c2')));
  await syncCompanies(e, { fetch: api.fetch, maxPages: 1 });
  await syncCompanies(e, { fetch: api.fetch, maxPages: 1 });
  assert.equal(api.requests[0].cursor, undefined);
  assert.equal(api.requests[1].cursor, 'c2');

  await saveProfile(e.DB, { dealroom_filter: 'employees_count[gte]:50' });
  await syncCompanies(e, { fetch: api.fetch, maxPages: 1 });
  assert.equal(api.requests[2].cursor, undefined);
  assert.equal(api.requests[2].filter, 'employees_count[gte]:50');
});

test('a rejected saved cursor falls back to the first page', async () => {
  const e = env();
  const api = dealroom((params, n) => {
    if (n === 1) return page(1, 2, 'stale');
    if (params.cursor === 'stale') return { status: 400, body: { error: { code: 'VALIDATION_ERROR', message: 'Invalid cursor' } } };
    return page(1, 2, 'c2');
  });
  await syncCompanies(e, { fetch: api.fetch, maxPages: 1 });
  const result = await syncCompanies(e, { fetch: api.fetch, maxPages: 1 });
  assert.equal(result.status, 'ok');
  assert.equal(api.requests[2].cursor, undefined);
});

test('skips Dealroom while enough unoffered companies are stored', async () => {
  const e = env();
  await upsertCompanies(e.DB, Array.from({ length: 30 }, (_, i) => company(i + 1)));
  const api = dealroom(() => page(31, 32, null));
  const result = await syncCompanies(e, { fetch: api.fetch });
  assert.equal(result.status, 'skipped');
  assert.equal(api.requests.length, 0);
  const run = await e.DB.prepare('SELECT status, credits_used FROM sync_runs').first();
  assert.deepEqual({ ...run }, { status: 'skipped', credits_used: 0 });
});
