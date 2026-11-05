import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { createDealroomClient, TOKEN_URL } from '../worker/dealroom.js';
import { matchCompany, noRaiseSince, portfolioFilter, pullVcs, uniquePartners } from '../scripts/vc-pull.mjs';
import worker from '../worker/index.js';
import { company, database } from './helpers.js';

const now = new Date('2026-11-05T12:00:00Z');
const financials = (ebitda, ebitda_year = 2025) => ({ ebitda, ebitda_year, profit: null, profit_year: null, financials_json: null, financials_fetched_at: 'x' });

test('the 2-year cutoff and the portfolio filter', () => {
  assert.equal(noRaiseSince(now), '2024-11');
  const filter = portfolioFilter([93, 283], now);
  for (const part of ['hq_location[in_any]:93|283', 'company_status[eq]:operational', 'classification[nin_any]:exited|pe_owned',
    'employee_count_1y_growth[gt]:0', 'last_funding.date[lt]:2024-11', 'launch_date[lte]:2018']) assert.ok(filter.includes(part), part);
});

test('matches on recent EBITDA over £1m, or on a Series A or later round', () => {
  const seed = [{ standardized_round: 'Seed', announced_date: '2021-03' }];
  const seriesB = [{ standardized_round: 'Series B', announced_date: '2022-06' }, ...seed];
  assert.deepEqual(matchCompany(seed, financials(1_500_000), now), { matches: true, ebitdaOver1m: true, seriesAPlus: false });
  assert.deepEqual(matchCompany(seriesB, financials(null, null), now), { matches: true, ebitdaOver1m: false, seriesAPlus: true });
  assert.equal(matchCompany(seed, financials(900_000), now).matches, false);
  assert.equal(matchCompany(seed, financials(5_000_000, 2019), now).matches, false, 'EBITDA filed too long ago');
});

test('rejects a company that raised in the last 2 years or has exited', () => {
  const recent = [{ standardized_round: 'Debt', announced_date: '2025-02' }, { standardized_round: 'Series A', announced_date: '2020-01' }];
  assert.equal(matchCompany(recent, financials(9e6), now).reason, 'raised_recently');
  const ipo = [{ round_type: 'IPO', is_exit: true, announced_date: '2021-07' }, { standardized_round: 'Series C', announced_date: '2019-01' }];
  assert.equal(matchCompany(ipo, financials(9e6), now).reason, 'exited');
});

test('keeps one partner per name, preferring one with LinkedIn', () => {
  const member = (uuid, name, linkedin = null) => ({ person: { uuid, name, links: { linkedin } } });
  const kept = uniquePartners([member('a', 'Chris Barnes'), member('b', 'chris barnes ', 'https://linkedin.com/in/cb'), member('c', 'Neil Rimer')]);
  assert.deepEqual(kept.map(m => m.person.uuid), ['b', 'c']);
});

function sqliteD1() {
  const sqlite = new DatabaseSync(':memory:');
  const dir = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(dir).filter(name => name.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(file, dir), 'utf8'));
  return { sqlite, exec: async sql => sqlite.exec(sql), query: async sql => sqlite.prepare(sql).all() };
}

// A fake Dealroom with one UK VC (two candidates, one matching) and one Spanish VC (no candidates).
function fakeDealroom() {
  const calls = [];
  const vc = (uuid, name) => ({ uuid, name, links: { website: `https://${uuid}.vc` }, types: [{ name: 'venture capital' }], investments: { count: 9 } });
  const fetch = async url => {
    if (String(url) === TOKEN_URL) return Response.json({ access_token: 'tok' });
    const { pathname, searchParams } = new URL(url);
    calls.push(pathname);
    const reply = data => new Response(JSON.stringify({ data, page: { next_cursor: null } }), { headers: { 'X-Credits-Used': '1' } });
    if (pathname === '/data/investors') return reply(searchParams.get('filter').includes(':93,') ? [vc('vc-uk', 'UK Ventures')] : [vc('vc-es', 'ES Capital')]);
    if (pathname === '/data/investors/vc-uk/portfolio') return reply([{ is_lead: true, rounds_count: 2, company: company(1) }, { is_lead: false, rounds_count: 1, company: company(2) }]);
    if (pathname === '/data/investors/vc-es/portfolio') return reply([]);
    if (pathname === `/data/companies/${company(1).uuid}/funding-rounds`) return reply([{ standardized_round: 'Series A', announced_date: '2022-04', amount: 5e6 }]);
    if (pathname.endsWith('/funding-rounds')) return reply([{ standardized_round: 'Seed', announced_date: '2021-01' }]);
    if (pathname.endsWith('/financials')) return reply([{ year: 2025, ebitda: 200_000 }]);
    if (pathname === '/data/investors/vc-uk/team') return reply([{ raw_title: 'Partner', person: { uuid: 'p1', name: 'Pat Partner', links: { linkedin: 'https://linkedin.com/in/pat' } } }]);
    if (pathname === '/data/companies') return reply([company(1)]);
    throw new Error(`unexpected ${pathname}`);
  };
  return { calls, client: () => createDealroomClient({ clientId: 'id', clientSecret: 'secret', fetch, currency: 'GBP' }) };
}

test('pulls VCs with their matching companies and partners, and skips them next time', async () => {
  const d1 = sqliteD1();
  const api = fakeDealroom();
  const stats = await pullVcs({ client: api.client(), d1, vcs: 1, now: () => now, log: () => {} });
  assert.deepEqual({ kept: stats.vcsKept, matches: stats.matches }, { kept: 1, matches: 1 });
  const match = d1.sqlite.prepare(`SELECT i.name investor, c.name company, c.currency, c.last_round_label, m.series_a_plus, m.ebitda_over_1m
    FROM portfolio_matches m JOIN investors i ON i.uuid = m.investor_uuid JOIN companies c ON c.uuid = m.company_uuid`).all();
  assert.deepEqual(match.map(row => ({ ...row })), [{ investor: 'UK Ventures', company: 'Company 1', currency: 'GBP', last_round_label: 'Series A', series_a_plus: 1, ebitda_over_1m: 0 }]);
  assert.equal(d1.sqlite.prepare('SELECT name FROM investor_partners').get().name, 'Pat Partner');
  assert.equal(d1.sqlite.prepare('SELECT COUNT(*) n FROM leads').get().n, 0);

  // Run again: the VC is cached and counts towards the total, so nothing is bought.
  const again = fakeDealroom();
  await pullVcs({ client: again.client(), d1, vcs: 1, now: () => now, log: () => {} });
  assert.deepEqual(again.calls, []);
});

test('GET /vcs lists each VC with partners and matching companies', async () => {
  const db = database();
  const d1 = { exec: async sql => { for (const statement of sql.split(/;\n/).filter(s => s.trim())) await db.prepare(statement).run(); }, query: async sql => (await db.prepare(sql).all()).results };
  await pullVcs({ client: fakeDealroom().client(), d1, vcs: 1, now: () => now, log: () => {} });
  const { vcs } = await (await worker.fetch(new Request('http://api/vcs'), { DB: db })).json();
  assert.equal(vcs.length, 1);
  assert.equal(vcs[0].name, 'UK Ventures');
  assert.equal(vcs[0].matching_companies, 1);
  assert.deepEqual(vcs[0].investor_types, ['venture capital']);
  assert.equal(vcs[0].partners[0].linkedin, 'https://linkedin.com/in/pat');
  assert.deepEqual(vcs[0].companies[0].matched_on, ['series_a_no_raise_2y']);
  assert.equal(vcs[0].companies[0].is_lead, true);
});
