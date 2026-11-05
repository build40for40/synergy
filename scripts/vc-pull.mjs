// Find VC leads: UK and Spanish VC firms whose portfolio companies match the brief.
//
//   node scripts/vc-pull.mjs --remote --vcs 10
//
// A portfolio company matches when it is headquartered in the UK or Spain,
// operational, not exited or PE-owned, established (launched by 2018, 10 to
// 1,000 people), growing (headcount up on a year ago), has not raised in the
// last 2 years (any disclosed round that isn't an exit), and either filed
// EBITDA over £1m in the last 3 years or has raised a Series A or later round. VCs are taken best-ranked first, in turn
// from each country, until --vcs of them have at least one match.
//
// Money is requested in GBP. Writes investors, investor_partners,
// portfolio_matches and the matching companies, never leads, through
// `wrangler d1 execute` (--local by default). Cached: an investor already in
// D1 is not pulled again, and a company with financials keeps them.
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createDealroomClient, toFinancials } from '../worker/dealroom.js';
import { financialsSql, sqlLiteral, upsertCompanySql, wranglerD1 } from './dealroom-pull.mjs';
import { readFileSync } from 'node:fs';

export const UK = 93;
export const SPAIN = 283;
const SERIES_A_PLUS = /^series\s+[a-z]\b/i;

// The month two years before `now`, as Dealroom's YYYY-MM.
export function noRaiseSince(now = new Date()) {
  return `${now.getUTCFullYear() - 2}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

export const portfolioFilter = (countries, now) => `and(hq_location[in_any]:${countries.join('|')},company_status[eq]:operational,`
  + 'classification[nin_any]:exited|pe_owned,launch_date[lte]:2018,employees_count[gte]:10,employees_count[lte]:1000,'
  + `employee_count_1y_growth[gt]:0,last_funding.date[lt]:${noRaiseSince(now)})`;

// rounds: newest first, from /funding-rounds. financials: from toFinancials, in GBP.
// Dealroom's last_funding.date skips some rounds, so the 2-year rule and exits
// are checked again here against every round.
export function matchCompany(rounds, financials, now = new Date()) {
  const cutoff = noRaiseSince(now);
  if (rounds.some(round => round.is_exit)) return { matches: false, ebitdaOver1m: false, seriesAPlus: false, reason: 'exited' };
  if (rounds.some(round => (round.announced_date ?? '') >= cutoff)) return { matches: false, ebitdaOver1m: false, seriesAPlus: false, reason: 'raised_recently' };
  const ebitdaOver1m = financials.ebitda !== null && financials.ebitda > 1_000_000 && financials.ebitda_year >= now.getUTCFullYear() - 3;
  const seriesAPlus = rounds.some(round => SERIES_A_PLUS.test(round.standardized_round ?? ''));
  return { matches: ebitdaOver1m || seriesAPlus, ebitdaOver1m, seriesAPlus };
}

const hq = entity => entity.locations?.find(location => location.role === 'hq') ?? null;
const num = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);

export function investorSql(investor, fetchedAt) {
  const row = {
    uuid: investor.uuid, name: investor.name, website: investor.links?.website ?? null, linkedin: investor.links?.linkedin ?? null,
    dealroom_url: investor.dealroom_url ?? null, tagline: investor.tagline ?? null, hq_city: hq(investor)?.city?.name ?? null,
    hq_country: hq(investor)?.country?.name ?? null,
    investor_types_json: investor.types?.length ? JSON.stringify(investor.types.map(type => type.name)) : null,
    deal_size_min: num(investor.deal_size?.min), deal_size_max: num(investor.deal_size?.max),
    investments_count: num(investor.investments?.count), last_investment_date: investor.investments?.last_round_date ?? null,
    currency: 'GBP', raw_json: JSON.stringify(investor), fetched_at: fetchedAt
  };
  const columns = Object.keys(row);
  return `INSERT INTO investors (${columns.join(', ')}) VALUES (${columns.map(column => sqlLiteral(row[column])).join(', ')})
  ON CONFLICT(uuid) DO UPDATE SET ${columns.slice(1).map(column => `${column}=excluded.${column}`).join(', ')};`;
}

export function partnerSql(investorUuid, member) {
  const person = member.person ?? {};
  const values = [investorUuid, person.uuid, person.name, member.raw_title || member.titles?.join(', ') || null,
    person.links?.linkedin || null, person.dealroom_url ?? null, person.email ?? null];
  return `INSERT OR REPLACE INTO investor_partners (investor_uuid, person_uuid, name, title, linkedin, dealroom_url, email)
  VALUES (${values.map(sqlLiteral).join(', ')});`;
}

// Dealroom has duplicate person records; keep one per name, preferring one with LinkedIn.
export function uniquePartners(members) {
  const byName = new Map();
  for (const member of members.filter(member => member.person?.uuid && member.person?.name)) {
    const key = member.person.name.trim().toLowerCase();
    const seen = byName.get(key);
    if (!seen || (!seen.person.links?.linkedin && member.person.links?.linkedin)) byName.set(key, member);
  }
  return [...byName.values()];
}

const lastRoundSql = (uuid, round) => `UPDATE companies SET last_round_date=${sqlLiteral(round?.announced_date ?? null)},
  last_round_label=${sqlLiteral(round?.standardized_round ?? round?.round_type ?? null)}, last_round_amount=${sqlLiteral(num(round?.amount))}
  WHERE uuid=${sqlLiteral(uuid)};`;

const matchSql = (investorUuid, row, match, at) => `INSERT OR REPLACE INTO portfolio_matches
  (investor_uuid, company_uuid, is_lead, rounds_count, ebitda_over_1m, series_a_plus, matched_at)
  VALUES (${[investorUuid, row.company.uuid, typeof row.is_lead === 'boolean' ? row.is_lead : null, num(row.rounds_count),
    match.ebitdaOver1m, match.seriesAPlus, at].map(sqlLiteral).join(', ')});`;

async function inBatches(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(...await Promise.all(items.slice(i, i + size).map(fn)));
  return out;
}

export async function pullVcs({ client, d1, countries = [UK, SPAIN], vcs = 10, maxCandidates = 25, partners = 5,
  concurrency = 4, now = () => new Date(), log = console.log }) {
  const stats = { vcsChecked: 0, vcsKept: 0, cachedVcs: 0, candidates: 0, matches: 0, credits: 0 };
  const cachedInvestors = new Set((await d1.query('SELECT DISTINCT investor_uuid FROM portfolio_matches')).map(row => row.investor_uuid));
  // Only GBP rows: the earlier company pull stored USD, which can't be tested against £1m.
  const cachedFinancials = new Map((await d1.query('SELECT uuid, ebitda, ebitda_year, profit, profit_year, financials_json, financials_fetched_at FROM companies WHERE financials_fetched_at IS NOT NULL AND currency = \'GBP\''))
    .map(row => [row.uuid, row]));
  stats.cachedVcs = cachedInvestors.size;
  let kept = cachedInvestors.size;
  if (kept) log(`${kept} VCs already in D1; they count towards ${vcs} and are not pulled again.`);

  // Best-ranked VCs from each country, taken in turn.
  const queues = countries.map(country => ({ country, items: [], cursor: undefined, done: false }));
  const nextVc = async () => {
    for (let tries = 0; tries < queues.length; tries++) {
      const queue = queues.shift();
      queues.push(queue);
      if (!queue.items.length && !queue.done) {
        const { body } = await client.get('/data/investors', { filter: `and(hq_location[eq]:${queue.country},investor_type[eq]:venture_capital)`,
          view: 'summary', limit: queue.cursor ? undefined : 50, cursor: queue.cursor });
        queue.items.push(...(body.data ?? []));
        queue.cursor = body.page?.next_cursor ?? null;
        queue.done = !queue.cursor;
      }
      if (queue.items.length) return queue.items.shift();
    }
    return null;
  };

  while (kept < vcs) {
    const investor = await nextVc();
    if (!investor) { log('No more VCs to check.'); break; }
    if (cachedInvestors.has(investor.uuid)) continue;
    stats.vcsChecked++;
    const at = now().toISOString();
    const { body: portfolio } = await client.get(`/data/investors/${investor.uuid}/portfolio`, { filter: portfolioFilter(countries, now()), limit: maxCandidates });
    const rows = portfolio.data ?? [];
    stats.candidates += rows.length;
    const checked = await inBatches(rows, concurrency, async row => {
      const uuid = row.company.uuid;
      const { body: rounds } = await client.get(`/data/companies/${uuid}/funding-rounds`, { limit: 50 });
      const financials = cachedFinancials.get(uuid) ?? toFinancials((await client.getFinancials(uuid)).years, at);
      return { row, rounds: rounds.data ?? [], financials, match: matchCompany(rounds.data ?? [], financials, now()) };
    });
    const matched = checked.filter(item => item.match.matches);
    log(`${investor.name}: ${rows.length} candidates, ${matched.length} match. ${client.creditsUsed()} credits so far.`);
    if (!matched.length) continue;

    const { body: team } = await client.get(`/data/investors/${investor.uuid}/team`, { role: 'partner', is_past: 'false', limit: partners });
    const { body: profiles } = await client.get('/data/companies', { filter: `id[in_any]:${matched.map(item => item.row.company.uuid).join('|')}`, view: 'full', limit: 50 });
    const full = new Map((profiles.data ?? []).map(company => [company.uuid, company]));
    const statements = [investorSql(investor, at), ...uniquePartners(team.data ?? []).map(member => partnerSql(investor.uuid, member))];
    for (const item of matched) {
      const uuid = item.row.company.uuid;
      statements.push(upsertCompanySql(full.get(uuid) ?? item.row.company, at, 'GBP'), financialsSql(uuid, item.financials),
        lastRoundSql(uuid, item.rounds[0]), matchSql(investor.uuid, item.row, item.match, at));
    }
    await d1.exec(statements.join('\n'));
    kept++;
    stats.vcsKept++;
    stats.matches += matched.length;
  }
  stats.credits = client.creditsUsed();
  return stats;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: {
    remote: { type: 'boolean', default: false },
    vcs: { type: 'string', default: '10' },
    'max-candidates': { type: 'string', default: '25' },
    rps: { type: 'string', default: '4' }
  } });
  const vars = Object.fromEntries(readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8').split('\n').filter(line => line.includes('='))
    .map(line => { const at = line.indexOf('='); return [line.slice(0, at).trim(), line.slice(at + 1).trim().replace(/^"|"$/g, '')]; }));
  const client = createDealroomClient({ clientId: process.env.DEALROOM_CLIENT_ID ?? vars.DEALROOM_CLIENT_ID,
    clientSecret: process.env.DEALROOM_API_KEY ?? vars.DEALROOM_API_KEY, requestsPerSecond: Number(values.rps), retries: 4, currency: 'GBP' });
  const d1 = wranglerD1({ remote: values.remote });
  const log = message => console.log(`${new Date().toISOString()} ${message}`);
  try {
    log(`Finding ${values.vcs} VC leads into ${values.remote ? 'remote' : 'local'} D1.`);
    log(`Done: ${JSON.stringify(await pullVcs({ client, d1, vcs: Number(values.vcs), maxCandidates: Number(values['max-candidates']), log }))}`);
  } finally { d1.close(); }
}
