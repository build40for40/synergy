import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { createDealroomClient, TOKEN_URL } from '../worker/dealroom.js';
import { DEFAULT_CRITERIA, matchQuery, monthsBefore, normalizeCriteria } from '../worker/criteria.js';
import { listVcLeads, uniqueByName } from '../worker/vcs.js';
import { financialRowsSql } from '../scripts/dealroom-pull.mjs';
import { inline, pullVcs, universeFilter } from '../scripts/vc-pull.mjs';
import { handle } from '../worker/index.js';
import { company, database, issuer, keys, signToken } from './helpers.js';

const now = new Date('2026-11-05T12:00:00Z');

function sqliteD1() {
  const sqlite = new DatabaseSync(':memory:');
  const dir = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(dir).filter(name => name.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(file, dir), 'utf8'));
  return { sqlite, exec: async sql => sqlite.exec(sql), query: async sql => sqlite.prepare(sql).all() };
}

test('criteria: defaults, overrides, null switches a rule off, junk is dropped', () => {
  assert.deepEqual(normalizeCriteria(null), DEFAULT_CRITERIA);
  const criteria = normalizeCriteria({ ebitda_min_gbp: 2e6, series_a_plus: null, growing: 'yes', company_countries: ['Spain'], drop_tables: true });
  assert.equal(criteria.ebitda_min_gbp, 2e6);
  assert.equal(criteria.series_a_plus, null);
  assert.equal(criteria.growing, true);
  assert.deepEqual(criteria.company_countries, ['Spain']);
  assert.ok(!('drop_tables' in criteria));
  assert.equal(monthsBefore(now, 24), '2024-11');
  assert.equal(monthsBefore(new Date('2026-01-15T00:00:00Z'), 1), '2025-12');
});

test('keeps one person per name, preferring one with LinkedIn', () => {
  const people = [{ name: 'Chris Barnes', linkedin: null, id: 1 }, { name: 'chris barnes ', linkedin: 'x', id: 2 }, { name: 'Neil Rimer', linkedin: null, id: 3 }];
  assert.deepEqual(uniqueByName(people).map(person => person.id), [2, 3]);
});

test('marks financial years that repeat the year before as carried forward', () => {
  const d1 = sqliteD1();
  d1.sqlite.exec(`INSERT INTO companies (uuid, name, raw_json, fetched_at) VALUES ('c', 'C', '{}', 'x')`);
  d1.sqlite.exec(financialRowsSql('c', [{ year: 2023, ebitda: 9 }, { year: 2024, ebitda: 9 }, { year: 2025, ebitda: 10 }, { year: 2026 }], 'GBP', 'x').join('\n'));
  const rows = d1.sqlite.prepare('SELECT year, carried_forward FROM company_financials ORDER BY year').all().map(row => [row.year, row.carried_forward]);
  assert.deepEqual(rows, [[2023, 0], [2024, 1], [2025, 0]]);
});

// Facts for one UK VC holding five companies, each testing one rule.
function seedFacts(sqlite) {
  sqlite.exec(`INSERT INTO investors (uuid, name, hq_country, currency, raw_json, fetched_at) VALUES ('vc', 'UK Ventures', 'United Kingdom', 'GBP', '{}', 'x');
    INSERT INTO investor_team (investor_uuid, person_uuid, name, linkedin, is_partner, is_past, fetched_at) VALUES
      ('vc', 'p1', 'Pat Partner', NULL, 1, 0, 'x'), ('vc', 'p2', 'Pat Partner', 'https://linkedin.com/in/pat', 1, 0, 'x'), ('vc', 'p3', 'Old Partner', NULL, 1, 1, 'x');`);
  const add = (n, overrides = '') => {
    sqlite.exec(`INSERT INTO companies (uuid, name, hq_country, status, launch_year, employees, employee_growth_1y, currency, rounds_fetched_at, raw_json, fetched_at)
      VALUES ('c${n}', 'Company ${n}', 'United Kingdom', 'operational', 2015, 100, 10, 'GBP', 'x', '{}', 'x');
      INSERT INTO investments (investor_uuid, company_uuid, is_lead, fetched_at) VALUES ('vc', 'c${n}', 1, 'x');${overrides}`);
  };
  const round = (n, id, date, label, exit = 0) => `INSERT INTO funding_rounds (id, company_uuid, announced_date, standardized_round, currency, is_exit, fetched_at) VALUES (${id}, 'c${n}', '${date}', '${label}', 'GBP', ${exit}, 'x');`;
  const fin = (n, year, ebitda, carried = 0) => `INSERT INTO company_financials (company_uuid, year, currency, ebitda, carried_forward, fetched_at) VALUES ('c${n}', ${year}, 'GBP', ${ebitda}, ${carried}, 'x');`;
  add(1, round(1, 11, '2021-05', 'Series B'));                           // matches: Series A+
  add(2, round(2, 21, '2020-01', 'Seed') + fin(2, 2025, 2e6));            // matches: EBITDA
  add(3, round(3, 31, '2025-03', 'Series C'));                           // raised in the last 2 years
  add(4, round(4, 41, '2019-01', 'Series A') + round(4, 42, '2022-01', 'IPO', 1)); // exited
  add(5, round(5, 51, '2020-01', 'Seed') + fin(5, 2022, 3e6) + fin(5, 2025, 3e6, 1)); // EBITDA only carried forward to 2025
}

test('the match query applies each rule to the facts', async () => {
  const db = database();
  const { sqlite } = sqliteD1();
  seedFacts(sqlite);
  const run = criteria => { const q = matchQuery(normalizeCriteria(criteria), now); return sqlite.prepare(q.sql).all(...q.binds).map(row => row.company_uuid).sort(); };
  assert.deepEqual(run({}), ['c1', 'c2']);
  assert.deepEqual(run({ series_a_plus: false }), ['c2']);
  assert.deepEqual(run({ ebitda_min_gbp: null }), ['c1']);
  assert.deepEqual(run({ no_raise_months: null }), ['c1', 'c2', 'c3']);
  // c5 filed £3m in 2022; Dealroom's repeat of it in 2025 is carried forward, so it only counts with no recency rule.
  assert.deepEqual(run({ series_a_plus: false }), ['c2'], 'a carried-forward year is not a recent filing');
  assert.deepEqual(run({ ebitda_within_years: null, series_a_plus: false }), ['c2', 'c5']);
  assert.deepEqual(run({ company_countries: ['Spain'] }), []);
  // The inlined form used by the pull script gives the same answer.
  const q = matchQuery(DEFAULT_CRITERIA, now);
  assert.deepEqual(sqlite.prepare(inline(q.sql, q.binds)).all().map(row => row.company_uuid).sort(), ['c1', 'c2']);
});

test('GET /vcs follows the profile criteria', async () => {
  const db = database();
  // Reuse the SQLite-backed D1 from helpers by seeding through its prepare().
  const statements = [];
  seedFacts({ exec: sql => statements.push(sql) });
  for (const sql of statements) for (const statement of sql.split(';').map(part => part.trim()).filter(Boolean)) await db.prepare(statement).run();
  // Signed in as one user: criteria now belong to that user's profile.
  const call = async (path, init = {}) => handle(
    new Request(`http://api${path}`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${await signToken('user_test')}` } }),
    { DB: db }, { keys, issuer });
  const first = await (await call('/vcs')).json();
  assert.equal(first.vcs.length, 1);
  const [vc] = first.vcs;
  assert.equal(vc.matching_companies, first.vcs[0].companies.length);
  assert.deepEqual(vc.partners.map(person => [person.name, person.linkedin]), [['Pat Partner', 'https://linkedin.com/in/pat']]);
  assert.deepEqual(Object.fromEntries(vc.companies.map(c => [c.name, c.matched_on])), { 'Company 2': ['ebitda'], 'Company 1': ['series_a_plus'] });
  assert.equal(vc.companies.find(c => c.name === 'Company 1').last_round_label, 'Series B');

  await call('/profile', { method: 'PUT', body: JSON.stringify({ who: 'Me', criteria: { series_a_plus: false } }) });
  const after = await (await call('/vcs')).json();
  assert.equal(after.criteria.series_a_plus, false);
  assert.deepEqual(after.vcs[0].companies.map(c => c.name), ['Company 2']);
  // Saving the profile without criteria keeps them.
  await call('/profile', { method: 'PUT', body: JSON.stringify({ who: 'Me again' }) });
  assert.equal((await (await call('/profile')).json()).criteria.series_a_plus, false);
  // Another user's criteria are their own: still the defaults.
  const other = await (await handle(new Request('http://api/vcs', { headers: { Authorization: `Bearer ${await signToken('user_other')}` } }), { DB: db }, { keys, issuer })).json();
  assert.equal(other.criteria.series_a_plus, true);
  assert.deepEqual(other.vcs[0].companies.map(c => c.name).sort(), ['Company 1', 'Company 2']);
});

// A fake Dealroom: one UK VC holding two UK companies, one matching.
function fakeDealroom() {
  const calls = [];
  const fetch = async url => {
    if (String(url) === TOKEN_URL) return Response.json({ access_token: 'tok' });
    const { pathname, searchParams } = new URL(url);
    calls.push(pathname);
    const reply = data => new Response(JSON.stringify({ data, page: { next_cursor: null } }), { headers: { 'X-Credits-Used': '1' } });
    const c1 = company(1, { launch_date: '2015', employee_count_1y_growth: 12 });
    const c2 = company(2, { launch_date: '2015', employee_count_1y_growth: 12 });
    if (pathname === '/data/investors') return reply(searchParams.get('filter').includes(':93,')
      ? [{ uuid: 'vc-uk', name: 'UK Ventures', locations: [{ role: 'hq', country: { name: 'United Kingdom' } }], investments: { count: 9 } }] : []);
    if (pathname === '/data/investors/vc-uk/portfolio') return reply([{ is_lead: true, rounds_count: 2, company: c1 }, { is_lead: false, rounds_count: 1, company: c2 }]);
    if (pathname === '/data/companies') return reply([c1, c2]);
    if (pathname === `/data/companies/${c1.uuid}/funding-rounds`) return reply([{ id: 1, standardized_round: 'Series A', announced_date: '2022-04', amount: 5e6, is_exit: false }]);
    if (pathname.endsWith('/funding-rounds')) return reply([{ id: 2, standardized_round: 'Seed', announced_date: '2021-01', is_exit: false }]);
    if (pathname.endsWith('/financials')) return reply([{ year: 2025, ebitda: 200_000 }]);
    if (pathname === '/data/investors/vc-uk/team') return reply([{ raw_title: 'Partner', is_partner: true, is_past: false, person: { uuid: 'p1', name: 'Pat Partner' } }]);
    throw new Error(`unexpected ${pathname}`);
  };
  return { calls, client: () => createDealroomClient({ clientId: 'id', clientSecret: 'secret', fetch, currency: 'GBP' }) };
}

test('the pull stores facts for every holding, never leads, and skips stored VCs next time', async () => {
  const d1 = sqliteD1();
  const stats = await pullVcs({ client: fakeDealroom().client(), d1, vcs: 1, now: () => now, log: () => {} });
  assert.deepEqual({ checked: stats.vcsChecked, withMatches: stats.vcsWithMatches, companies: stats.companies }, { checked: 1, withMatches: 1, companies: 2 });
  const count = table => d1.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
  assert.deepEqual(['investors', 'companies', 'investments', 'funding_rounds', 'company_financials', 'investor_team', 'leads'].map(count), [1, 2, 2, 2, 2, 1, 0]);
  assert.equal(d1.sqlite.prepare("SELECT COUNT(*) n FROM companies WHERE currency = 'GBP' AND rounds_fetched_at IS NOT NULL").get().n, 2);
  const q = matchQuery(DEFAULT_CRITERIA, now);
  assert.deepEqual(d1.sqlite.prepare(q.sql).all(...q.binds).map(row => row.company_uuid), [company(1).uuid]);

  const again = fakeDealroom();
  await pullVcs({ client: again.client(), d1, vcs: 1, now: () => now, log: () => {} });
  assert.deepEqual(again.calls, []);
  assert.ok(universeFilter([93, 283]).includes('hq_location[in_any]:93|283'));
});

test('stops starting new VCs once the time limit passes', async () => {
  const d1 = sqliteD1();
  let clock = now.getTime();
  const api = fakeDealroom();
  const stats = await pullVcs({ client: api.client(), d1, vcs: 5, minutes: 1, now: () => new Date(clock += 61_000), log: () => {} });
  assert.equal(stats.vcsChecked, 0);
  assert.deepEqual(api.calls, []);
});
