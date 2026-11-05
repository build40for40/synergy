import test from 'node:test';
import assert from 'node:assert/strict';
import { createDealroomClient, toCompanyRow, toFinancials, TOKEN_URL } from '../worker/dealroom.js';
import { company } from './helpers.js';

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length);
  };
  fn.calls = calls;
  return fn;
}
const jsonResponse = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

test('exchanges client credentials once and sends bearer + client id', async () => {
  const fetch = fakeFetch(url => url === TOKEN_URL
    ? jsonResponse({ access_token: 'tok', expires_in: 3600 })
    : jsonResponse({ data: [company(1)], page: { next_cursor: 'abc' } }, 200, { 'X-Credits-Used': '2' }));
  const client = createDealroomClient({ clientId: 'id', clientSecret: 'secret', fetch });
  const first = await client.listCompanies({ filter: 'and(employees_count[gte]:50)', limit: 10 });
  await client.listCompanies({ cursor: first.nextCursor });

  assert.equal(fetch.calls.filter(call => call.url === TOKEN_URL).length, 1);
  assert.deepEqual(JSON.parse(fetch.calls[0].init.body), { client_id: 'id', client_secret: 'secret', audience: 'https://api.beta.dealroom.app', grant_type: 'client_credentials' });
  const list = new URL(fetch.calls[1].url);
  assert.equal(list.pathname, '/data/companies');
  assert.equal(list.searchParams.get('filter'), 'and(employees_count[gte]:50)');
  assert.equal(list.searchParams.get('limit'), '10');
  assert.equal(fetch.calls[1].init.headers.Authorization, 'Bearer tok');
  assert.equal(fetch.calls[1].init.headers['X-Client-Id'], 'id');
  // With a cursor, limit is omitted because the cursor carries it.
  const next = new URL(fetch.calls[2].url);
  assert.equal(next.searchParams.get('cursor'), 'abc');
  assert.equal(next.searchParams.has('limit'), false);
  assert.equal(first.credits, 2);
  assert.equal(first.nextCursor, 'abc');
});

test('surfaces Dealroom error codes and Retry-After', async () => {
  const fetch = fakeFetch(url => url === TOKEN_URL
    ? jsonResponse({ access_token: 'tok' })
    : jsonResponse({ error: { code: 'RATE_LIMITED', message: 'Slow down' } }, 429, { 'Retry-After': '2' }));
  const client = createDealroomClient({ clientId: 'id', clientSecret: 'secret', fetch });
  await assert.rejects(client.listCompanies(), { code: 'RATE_LIMITED', status: 429, retryAfter: 2 });
});

test('requires credentials', () => {
  assert.throws(() => createDealroomClient({ clientId: '', clientSecret: 'x' }), /DEALROOM_CLIENT_ID/);
});

test('maps a company and keeps unknowns null', () => {
  const row = toCompanyRow(company(3, { revenue: undefined, employees_count: undefined }), '2026-11-05T00:00:00Z');
  assert.equal(row.hq_city, 'London');
  assert.equal(row.launch_year, 2012);
  assert.equal(row.employees, null);
  assert.equal(row.revenue, null);
  assert.equal(row.funding_total, null);
  assert.deepEqual(JSON.parse(row.founders_json), [{ uuid: 'p3', name: 'Founder 3' }]);
});

test('stores NULL, not [], when Dealroom lists no founders', () => {
  const row = toCompanyRow(company(4, { founders: { total: 0, items: [] } }));
  assert.equal(row.founders_json, null);
});

test('throttles requests and retries 429s using Retry-After', async () => {
  let clock = 0;
  const waits = [];
  let attempts = 0;
  const fetch = fakeFetch(url => {
    if (url === TOKEN_URL) return jsonResponse({ access_token: 'tok' });
    attempts++;
    return attempts === 1
      ? jsonResponse({ error: { code: 'RATE_LIMITED', message: 'Slow down' } }, 429, { 'Retry-After': '3' })
      : jsonResponse({ data: [{ year: 2024, ebitda: 5 }] }, 200, { 'X-Credits-Used': '2' });
  });
  const client = createDealroomClient({ clientId: 'id', clientSecret: 'secret', fetch, now: () => clock, requestsPerSecond: 4, retries: 2,
    sleep: async ms => { waits.push(ms); clock += ms; } });
  const { years } = await client.getFinancials('abc');
  assert.deepEqual(years, [{ year: 2024, ebitda: 5 }]);
  assert.ok(waits.includes(3000), 'waited for Retry-After');
  assert.equal(client.creditsUsed(), 2);
  assert.equal(new URL(fetch.calls.at(-1).url).pathname, '/data/companies/abc/financials');
});

test('gives up after the retry limit', async () => {
  const fetch = fakeFetch(url => url === TOKEN_URL ? jsonResponse({ access_token: 'tok' }) : jsonResponse({}, 503));
  const client = createDealroomClient({ clientId: 'id', clientSecret: 'secret', fetch, retries: 1, sleep: async () => {} });
  await assert.rejects(client.getFinancials('abc'), { status: 503 });
  assert.equal(fetch.calls.filter(call => call.url !== TOKEN_URL).length, 2);
});

test('takes the latest filed EBITDA and profit', () => {
  const financials = toFinancials([
    { year: 2022, revenue: 10, ebitda: 3, profit: 1 },
    { year: 2023, revenue: 12, ebitda: 4, profit: null },
    { year: 2024, revenue: null, ebitda: null, profit: null }
  ], 'now');
  assert.deepEqual({ ...financials, financials_json: JSON.parse(financials.financials_json).length },
    { ebitda: 4, ebitda_year: 2023, profit: 1, profit_year: 2022, financials_json: 2, financials_fetched_at: 'now' });
  assert.deepEqual(toFinancials([], 'now'), { ebitda: null, ebitda_year: null, profit: null, profit_year: null, financials_json: null, financials_fetched_at: 'now' });
});

test('dates a carried-forward figure to the year it was filed', () => {
  const financials = toFinancials([
    { year: 2022, ebitda: 5, profit: 1 },
    { year: 2023, ebitda: 9, profit: 2 },
    { year: 2024, ebitda: 9, profit: 2 },
    { year: 2025, ebitda: 9, profit: 3 }
  ]);
  assert.equal(financials.ebitda_year, 2023);
  assert.equal(financials.profit_year, 2025);
});
