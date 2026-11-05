// Pull VC facts from Dealroom: UK and Spanish VC firms, their partners, and
// their portfolio companies with every funding round and filed financials.
//
//   node scripts/vc-pull.mjs --vcs 10            (local D1)
//   node scripts/vc-pull.mjs --vcs 10 --remote   (Cloudflare D1)
//
// It stores facts only. Which companies match is decided later by the user's
// criteria (worker/criteria.js), so the pull takes a deliberately wide set:
// every portfolio company based in the UK or Spain that is operational, not
// exited or PE-owned, with 10 or more people. VCs are taken best-ranked first,
// in turn by country, until --vcs of them have a match under the default
// criteria.
//
// Money is requested in GBP. Writes companies, company_financials,
// funding_rounds, investors, investments and investor_team, never leads.
// Cached: an investor whose portfolio is stored is not pulled again, and a
// GBP company with rounds and financials is not bought again.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createDealroomClient, toFinancials } from '../worker/dealroom.js';
import { DEFAULT_CRITERIA, matchQuery } from '../worker/criteria.js';
import { financialRowsSql, financialsSql, roundsSql, sqlLiteral, upsertCompanySql, wranglerD1 } from './dealroom-pull.mjs';

export const UK = 93;
export const SPAIN = 283;

export const universeFilter = countries => `and(hq_location[in_any]:${countries.join('|')},company_status[eq]:operational,`
  + 'classification[nin_any]:exited|pe_owned,employees_count[gte]:10)';

// Bind values into SQL for `wrangler d1 execute --command`, which takes no binds.
export function inline(sql, binds) {
  let i = 0;
  return sql.replace(/\?/g, () => sqlLiteral(binds[i++]));
}

const hq = entity => entity.locations?.find(location => location.role === 'hq') ?? null;
const num = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const upsert = (table, row, keys) => {
  const columns = Object.keys(row);
  return `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(column => sqlLiteral(row[column])).join(', ')})
  ON CONFLICT(${keys.join(', ')}) DO UPDATE SET ${columns.filter(column => !keys.includes(column)).map(column => `${column}=excluded.${column}`).join(', ')};`;
};

export function investorSql(investor, currency, fetchedAt) {
  return upsert('investors', {
    uuid: investor.uuid, name: investor.name, website: investor.links?.website ?? null, linkedin: investor.links?.linkedin ?? null,
    dealroom_url: investor.dealroom_url ?? null, tagline: investor.tagline ?? null, hq_city: hq(investor)?.city?.name ?? null,
    hq_country: hq(investor)?.country?.name ?? null,
    investor_types_json: investor.types?.length ? JSON.stringify(investor.types.map(type => type.name)) : null,
    deal_size_min: num(investor.deal_size?.min), deal_size_max: num(investor.deal_size?.max),
    investments_count: num(investor.investments?.count), last_investment_date: investor.investments?.last_round_date ?? null,
    currency, raw_json: JSON.stringify(investor), fetched_at: fetchedAt
  }, ['uuid']);
}

export function investmentSql(investorUuid, row, fetchedAt) {
  return upsert('investments', {
    investor_uuid: investorUuid, company_uuid: row.company.uuid, is_lead: typeof row.is_lead === 'boolean' ? row.is_lead : null,
    rounds_count: num(row.rounds_count), last_round_date: row.last_round_date ?? null, fetched_at: fetchedAt
  }, ['investor_uuid', 'company_uuid']);
}

export function teamSql(investorUuid, member, fetchedAt) {
  const person = member.person ?? {};
  return upsert('investor_team', {
    investor_uuid: investorUuid, person_uuid: person.uuid, name: person.name, title: member.raw_title || member.titles?.join(', ') || null,
    linkedin: person.links?.linkedin || null, dealroom_url: person.dealroom_url ?? null, email: person.email ?? null,
    is_partner: typeof member.is_partner === 'boolean' ? member.is_partner : null, is_past: typeof member.is_past === 'boolean' ? member.is_past : null,
    fetched_at: fetchedAt
  }, ['investor_uuid', 'person_uuid']);
}

async function inBatches(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(...await Promise.all(items.slice(i, i + size).map(fn)));
  return out;
}

async function pages(client, path, params, max) {
  const rows = [];
  let cursor;
  while (rows.length < max) {
    const { body } = await client.get(path, cursor ? { ...params, cursor } : { ...params, limit: Math.min(50, max) });
    rows.push(...(body.data ?? []));
    cursor = body.page?.next_cursor;
    if (!cursor) break;
  }
  return rows.slice(0, max);
}

export async function pullVcs({ client, d1, countries = [UK, SPAIN], vcs = 10, maxCompanies = 150, partners = 10,
  criteria = DEFAULT_CRITERIA, currency = 'GBP', concurrency = 4, now = () => new Date(), log = console.log, minutes = null, signal } = {}) {
  // With `minutes`, no new VC is started after the deadline; the one in progress finishes and is written.
  const deadline = minutes === null ? Infinity : now().getTime() + minutes * 60_000;
  const timeUp = () => now().getTime() >= deadline || signal?.aborted;
  const stats = { vcsChecked: 0, vcsWithMatches: 0, companies: 0, boughtRounds: 0, boughtFinancials: 0, credits: 0 };
  const matchingVcs = async () => {
    const match = matchQuery(criteria, now());
    return (await d1.query(inline(`SELECT DISTINCT investor_uuid FROM (${match.sql})`, match.binds))).map(row => row.investor_uuid);
  };
  const stored = new Set((await d1.query('SELECT DISTINCT investor_uuid FROM investments')).map(row => row.investor_uuid));
  const cached = new Map((await d1.query(`SELECT uuid, rounds_fetched_at IS NOT NULL AS rounds, financials_fetched_at IS NOT NULL AS financials
    FROM companies WHERE currency = ${sqlLiteral(currency)}`)).map(row => [row.uuid, row]));
  let matching = (await matchingVcs()).length;
  if (stored.size) log(`${stored.size} VCs already stored (${matching} with matches); they are not pulled again.`);

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

  while (matching < vcs) {
    if (timeUp()) { log('Time limit reached.'); break; }
    const investor = await nextVc();
    if (!investor) { log('No more VCs to check.'); break; }
    if (stored.has(investor.uuid)) continue;
    stats.vcsChecked++;
    const at = now().toISOString();
    const portfolio = await pages(client, `/data/investors/${investor.uuid}/portfolio`, { filter: universeFilter(countries) }, maxCompanies);
    const fresh = portfolio.filter(row => !cached.has(row.company.uuid));
    const profiles = new Map();
    for (let i = 0; i < fresh.length; i += 50) {
      const ids = fresh.slice(i, i + 50).map(row => row.company.uuid);
      const { body } = await client.get('/data/companies', { filter: `id[in_any]:${ids.join('|')}`, view: 'full', limit: 50 });
      for (const company of body.data ?? []) profiles.set(company.uuid, company);
    }
    const facts = await inBatches(portfolio, concurrency, async row => {
      const uuid = row.company.uuid;
      const known = cached.get(uuid);
      const rounds = known?.rounds ? null : (await client.get(`/data/companies/${uuid}/funding-rounds`, { limit: 100 })).body.data ?? [];
      const years = known?.financials ? null : (await client.getFinancials(uuid)).years;
      return { row, rounds, years };
    });
    const { body: team } = await client.get(`/data/investors/${investor.uuid}/team`, { role: 'partner', is_past: 'false', limit: partners });

    // Parents before children: investor and companies, then their facts.
    const statements = [investorSql(investor, currency, at)];
    for (const { row, rounds, years } of facts) {
      const uuid = row.company.uuid;
      if (!cached.has(uuid)) statements.push(upsertCompanySql(profiles.get(uuid) ?? row.company, at, currency));
      if (years) { statements.push(financialsSql(uuid, toFinancials(years, at)), ...financialRowsSql(uuid, years, currency, at)); stats.boughtFinancials++; }
      if (rounds) { statements.push(...roundsSql(uuid, rounds, currency, at)); stats.boughtRounds++; }
      statements.push(investmentSql(investor.uuid, row, at));
      cached.set(uuid, { uuid, rounds: 1, financials: 1 });
    }
    statements.push(...(team.data ?? []).filter(member => member.person?.uuid && member.person?.name).map(member => teamSql(investor.uuid, member, at)));
    await d1.exec(statements.join('\n'));
    stored.add(investor.uuid);
    stats.companies += portfolio.length;

    const now_ = await matchingVcs();
    const has = now_.includes(investor.uuid);
    matching = now_.length;
    if (has) stats.vcsWithMatches++;
    log(`${investor.name}: ${portfolio.length} companies stored, ${has ? 'has' : 'no'} matches. ${matching}/${vcs} VCs with matches, ${client.creditsUsed()} credits.`);
  }
  stats.credits = client.creditsUsed();
  return stats;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: {
    remote: { type: 'boolean', default: false },
    vcs: { type: 'string', default: '10' },
    minutes: { type: 'string' },
    'max-companies': { type: 'string', default: '150' },
    rps: { type: 'string', default: '4' }
  } });
  const vars = Object.fromEntries(readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8').split('\n').filter(line => line.includes('='))
    .map(line => { const at = line.indexOf('='); return [line.slice(0, at).trim(), line.slice(at + 1).trim().replace(/^"|"$/g, '')]; }));
  const client = createDealroomClient({ clientId: process.env.DEALROOM_CLIENT_ID ?? vars.DEALROOM_CLIENT_ID,
    clientSecret: process.env.DEALROOM_API_KEY ?? vars.DEALROOM_API_KEY, requestsPerSecond: Number(values.rps), retries: 4, currency: 'GBP' });
  const d1 = wranglerD1({ remote: values.remote });
  const log = message => console.log(`${new Date().toISOString()} ${message}`);
  const controller = new AbortController();
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { log(`${sig}: finishing the current VC, then stopping.`); controller.abort(); });
  const minutes = values.minutes === undefined ? null : Number(values.minutes);
  try {
    log(`Pulling VC facts into ${values.remote ? 'remote' : 'local'} D1 until ${values.vcs} VCs have matches${minutes === null ? '' : ` or ${minutes} minutes pass`}.`);
    log(`Done: ${JSON.stringify(await pullVcs({ client, d1, vcs: Number(values.vcs), maxCompanies: Number(values['max-companies']), log, minutes, signal: controller.signal }))}`);
  } finally { d1.close(); }
}
