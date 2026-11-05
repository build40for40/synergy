import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { createDealroomClient, TOKEN_URL } from '../worker/dealroom.js';
import { pull, sqlLiteral, upsertCompanySql } from '../scripts/dealroom-pull.mjs';
import { company } from './helpers.js';

// The script's D1 interface (exec a batch, query rows) over real SQLite.
function sqliteD1() {
  const sqlite = new DatabaseSync(':memory:');
  const dir = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(dir).filter(name => name.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(file, dir), 'utf8'));
  return { sqlite, exec: async sql => sqlite.exec(sql), query: async sql => sqlite.prepare(sql).all() };
}

// Fake Dealroom: two pages of companies, financials for anyone, counting calls.
function dealroom({ pages, financials = () => [{ year: 2024, revenue: 100, ebitda: 20, profit: 10 }] }) {
  const calls = { list: [], financials: [] };
  const fetch = async url => {
    if (String(url) === TOKEN_URL) return Response.json({ access_token: 'tok' });
    const { pathname, searchParams } = new URL(url);
    const match = pathname.match(/^\/data\/companies\/(.+)\/financials$/);
    if (match) {
      calls.financials.push(match[1]);
      return new Response(JSON.stringify({ data: financials(match[1]) }), { headers: { 'X-Credits-Used': '34' } });
    }
    calls.list.push(searchParams.get('cursor'));
    const page = pages[searchParams.get('cursor') ?? 'first'];
    return new Response(JSON.stringify({ data: page.data, page: { next_cursor: page.next } }), { headers: { 'X-Credits-Used': String(page.data.length * 2) } });
  };
  return { calls, client: () => createDealroomClient({ clientId: 'id', clientSecret: 'secret', fetch }) };
}
const quiet = () => {};

test('lists every page, fetches financials once, and never touches leads', async () => {
  const d1 = sqliteD1();
  const api = dealroom({ pages: { first: { data: [company(1), company(2)], next: 'p2' }, p2: { data: [company(3)], next: null } } });
  const stats = await pull({ client: api.client(), d1, log: quiet, batchSize: 2 });
  assert.equal(stats.listed, 3);
  assert.equal(stats.financials, 3);
  assert.deepEqual(api.calls.list, [null, 'p2']);
  const rows = d1.sqlite.prepare('SELECT name, ebitda, ebitda_year, financials_fetched_at IS NOT NULL AS cached FROM companies ORDER BY name').all();
  assert.deepEqual(rows.map(row => ({ ...row })), ['Company 1', 'Company 2', 'Company 3'].map(name => ({ name, ebitda: 20, ebitda_year: 2024, cached: 1 })));
  assert.equal(d1.sqlite.prepare('SELECT COUNT(*) AS n FROM leads').get().n, 0);
  const run = d1.sqlite.prepare('SELECT status, credits_used FROM sync_runs').get();
  assert.deepEqual({ ...run }, { status: 'ok', credits_used: 6 + 3 * 34 });

  // Second run: the list is complete and every company is cached, so nothing is bought.
  const again = dealroom({ pages: {} });
  const second = await pull({ client: again.client(), d1, log: quiet });
  assert.deepEqual(again.calls, { list: [], financials: [] });
  assert.equal(second.skippedCached, 3);
});

test('resumes a part-listed run from the saved cursor and keeps cached financials', async () => {
  const d1 = sqliteD1();
  const pages = { first: { data: [company(1)], next: 'p2' }, p2: { data: [company(2)], next: null } };
  let clock = 0;
  // Time runs out after the first page.
  const first = dealroom({ pages });
  await pull({ client: first.client(), d1, log: quiet, minutes: 1, now: () => (clock += 40_000) });
  assert.deepEqual(first.calls.list, [null]);

  const second = dealroom({ pages });
  await pull({ client: second.client(), d1, log: quiet });
  assert.deepEqual(second.calls.list, ['p2']);
  assert.equal(d1.sqlite.prepare('SELECT COUNT(*) AS n FROM companies WHERE financials_fetched_at IS NOT NULL').get().n, 2);
});

test('a new filter lists again but still skips cached financials', async () => {
  const d1 = sqliteD1();
  const pages = { first: { data: [company(1)], next: null } };
  await pull({ client: dealroom({ pages }).client(), d1, log: quiet });
  const api = dealroom({ pages: { first: { data: [company(1), company(2)], next: null } } });
  await pull({ client: api.client(), d1, log: quiet, filter: 'employees_count[gte]:50' });
  assert.deepEqual(api.calls.list, [null]);
  assert.deepEqual(api.calls.financials, [company(2).uuid]);
});

test('re-listing a company keeps its financials', async () => {
  const d1 = sqliteD1();
  await pull({ client: dealroom({ pages: { first: { data: [company(1)], next: null } } }).client(), d1, log: quiet });
  d1.sqlite.exec(upsertCompanySql(company(1, { name: 'Renamed' }), 'later'));
  const row = d1.sqlite.prepare('SELECT name, ebitda FROM companies').get();
  assert.deepEqual({ ...row }, { name: 'Renamed', ebitda: 20 });
});

test('escapes SQL literals', () => {
  assert.equal(sqlLiteral("O'Brien"), "'O''Brien'");
  assert.equal(sqlLiteral(null), 'NULL');
  assert.equal(sqlLiteral(Number.NaN), 'NULL');
  assert.equal(sqlLiteral(2.5), '2.5');
});
