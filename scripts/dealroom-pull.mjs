// One-off Dealroom pull into D1, run locally. Replaces the old daily cron.
//
//   node scripts/dealroom-pull.mjs --remote --minutes 60
//
// 1. Lists companies matching --filter, 500 a page, into `companies`. The
//    cursor is saved in `sync_state` with each page, so a rerun with the same
//    filter and sort resumes, and a finished list is not bought again.
// 2. Until the time limit, fetches filed financials (EBITDA, profit) for stored
//    companies that don't have them yet, best fit for the brief first. A
//    company is marked once fetched, so it is never paid for twice.
// Writes go only to `companies`, `sync_state` and `sync_runs`, never to
// `leads`, through `wrangler d1 execute` (--local by default, --remote for
// Cloudflare). Credentials come from .dev.vars. Ctrl-C stops cleanly.
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { createDealroomClient, DealroomError, toCompanyRow, toFinancials } from '../worker/dealroom.js';
import { COMPANY_COLUMNS, FINANCIAL_COLUMNS } from '../worker/store.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// UK, operational, launched by 2018, 10 to 1,000 people: about 30,000
// companies on 5 November 2026. Wider than the brief so the leads ranking
// (EBITDA, funding, growth) has room to choose.
export const DEFAULT_FILTER = 'and(hq_location[eq]:93,company_status[eq]:operational,launch_date[lte]:2018,employees_count[gte]:10,employees_count[lte]:1000)';
export const DEFAULT_SORT = '-employee_count_1y_growth';
const MAX_STATEMENT = 90_000; // D1 rejects SQL statements over 100 KB.

export function sqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function upsertCompanySql(company, fetchedAt, currency = 'USD') {
  const row = toCompanyRow(company, fetchedAt, currency);
  const build = () => `INSERT INTO companies (${COMPANY_COLUMNS.join(', ')}) VALUES (${COMPANY_COLUMNS.map(column => sqlLiteral(row[column])).join(', ')})
  ON CONFLICT(uuid) DO UPDATE SET ${COMPANY_COLUMNS.slice(1).map(column => `${column}=excluded.${column}`).join(', ')};`;
  let sql = build();
  if (sql.length > MAX_STATEMENT) {
    // Keep the typed columns; drop the bulky parts of the raw record.
    row.raw_json = JSON.stringify({ uuid: company.uuid, name: company.name, truncated: true });
    row.about = row.about?.slice(0, 4000) ?? null;
    sql = build();
  }
  return sql;
}

export function financialsSql(uuid, financials) {
  return `UPDATE companies SET ${FINANCIAL_COLUMNS.map(column => `${column}=${sqlLiteral(financials[column])}`).join(', ')} WHERE uuid=${sqlLiteral(uuid)};`;
}

const stateSql = ({ filter, sort, cursor, done }, now) => `INSERT INTO sync_state (id, filter, sort, next_cursor, done, updated_at)
  VALUES (1, ${sqlLiteral(filter)}, ${sqlLiteral(sort)}, ${sqlLiteral(cursor)}, ${done ? 1 : 0}, ${sqlLiteral(now)})
  ON CONFLICT(id) DO UPDATE SET filter=excluded.filter, sort=excluded.sort, next_cursor=excluded.next_cursor, done=excluded.done, updated_at=excluded.updated_at;`;

// Best fit for the brief first: no disclosed funding, growing, revenue known.
export function financialsPriority(company) {
  const growing = company.employee_growth_1y > 0;
  const tier = company.unfunded && growing && company.has_revenue ? 0 : growing && company.has_revenue ? 1 : growing ? 2 : 3;
  return [tier, -(company.employee_growth_1y ?? -Infinity)];
}

// D1 through Wrangler. `exec` runs a batch of statements from a file; `query` returns rows.
export function wranglerD1({ remote = false, database = 'synergy' } = {}) {
  const run = promisify(execFile);
  const where = remote ? '--remote' : '--local';
  const dir = mkdtempSync(join(tmpdir(), 'synergy-pull-'));
  let n = 0;
  const wrangler = args => run('npm', ['run', '--silent', 'wrangler', '--', 'd1', 'execute', database, where, '--yes', ...args],
    { cwd: root, maxBuffer: 256 * 1024 * 1024 });
  return {
    async exec(sql) {
      const file = join(dir, `batch-${n++}.sql`);
      writeFileSync(file, sql);
      try { await wrangler(['--file', file]); } finally { rmSync(file, { force: true }); }
    },
    async query(sql) {
      const { stdout } = await wrangler(['--command', sql, '--json']);
      return JSON.parse(stdout.slice(stdout.indexOf('[')))[0].results;
    },
    close: () => rmSync(dir, { recursive: true, force: true })
  };
}

// Statements are buffered and written in batches, one batch at a time, in order.
function writer(d1, { batchSize, log }) {
  let pending = [];
  let chain = Promise.resolve();
  const flush = () => {
    if (!pending.length) return chain;
    const batch = pending;
    pending = [];
    chain = chain.then(async () => {
      for (let attempt = 1; ; attempt++) {
        try { return await d1.exec(batch.join('\n')); } catch (error) {
          if (attempt >= 3) throw error;
          log(`D1 write failed (attempt ${attempt}), retrying: ${String(error.message).split('\n')[0]}`);
          await new Promise(done => setTimeout(done, 2000 * attempt));
        }
      }
    });
    return chain;
  };
  return {
    add(...statements) { pending.push(...statements); return pending.length >= batchSize ? flush() : chain; },
    flush
  };
}

export async function pull({ client, d1, filter = DEFAULT_FILTER, sort = DEFAULT_SORT, pageSize = 500, minutes = 60,
  concurrency = 8, batchSize = 200, financials = true, now = Date.now, log = console.log, signal } = {}) {
  const startedAt = new Date(now()).toISOString();
  const deadline = now() + minutes * 60_000;
  const timeUp = () => now() >= deadline || signal?.aborted;
  const out = writer(d1, { batchSize, log });
  const stats = { listed: 0, pages: 0, financials: 0, skippedCached: 0, failed: 0, credits: 0 };

  await d1.exec(`INSERT INTO sync_runs (started_at, status) VALUES (${sqlLiteral(startedAt)}, 'running');`);
  const finish = async (status, error = null) => {
    await out.flush();
    stats.credits = client.creditsUsed();
    await d1.exec(`UPDATE sync_runs SET finished_at=${sqlLiteral(new Date(now()).toISOString())}, status=${sqlLiteral(status)},
      companies=${stats.listed + stats.financials}, credits_used=${stats.credits}, error=${sqlLiteral(error)} WHERE started_at=${sqlLiteral(startedAt)};`);
  };

  try {
    // The cache: what D1 already holds.
    const known = new Map((await d1.query('SELECT uuid, financials_fetched_at IS NOT NULL AS has_financials, funding_total IS NULL AS unfunded, employee_growth_1y, revenue IS NOT NULL AS has_revenue FROM companies'))
      .map(row => [row.uuid, { ...row, has_financials: !!row.has_financials, unfunded: !!row.unfunded, has_revenue: !!row.has_revenue }]));
    const state = (await d1.query('SELECT filter, sort, next_cursor, done FROM sync_state WHERE id = 1'))[0];
    const sameList = state && state.filter === filter && state.sort === sort;
    log(`D1 holds ${known.size} companies, ${[...known.values()].filter(c => c.has_financials).length} with financials.`);

    // 1. List.
    if (sameList && state.done) log('Company list already complete for this filter; not listing again.');
    else {
      let cursor = sameList ? state.next_cursor : null;
      if (cursor) log('Resuming the company list from the saved cursor.');
      while (!timeUp()) {
        const page = await client.listCompanies({ filter, sort, limit: pageSize, cursor });
        const fetchedAt = new Date(now()).toISOString();
        cursor = page.nextCursor;
        stats.pages++;
        stats.listed += page.companies.length;
        for (const company of page.companies) {
          const row = toCompanyRow(company, fetchedAt);
          known.set(company.uuid, { uuid: company.uuid, has_financials: known.get(company.uuid)?.has_financials ?? false,
            unfunded: row.funding_total === null, employee_growth_1y: row.employee_growth_1y, has_revenue: row.revenue !== null });
        }
        // The cursor goes in the same batch as its page, after it.
        await out.add(...page.companies.map(company => upsertCompanySql(company, fetchedAt)), stateSql({ filter, sort, cursor, done: !cursor }, fetchedAt));
        await out.flush();
        log(`Listed page ${stats.pages}: ${stats.listed} companies, ${client.creditsUsed()} credits so far.`);
        if (!cursor) break;
      }
    }

    // 2. Financials, skipping every company already fetched.
    if (financials) {
      const queue = [...known.values()].filter(company => {
        if (company.has_financials) stats.skippedCached++;
        return !company.has_financials;
      });
      queue.sort((a, b) => { const [x, y] = [financialsPriority(a), financialsPriority(b)]; return x[0] - y[0] || x[1] - y[1]; });
      log(`Fetching financials for up to ${queue.length} companies (${stats.skippedCached} already cached).`);
      let exhausted = false;
      const worker = async () => {
        while (!timeUp() && !exhausted && queue.length) {
          const company = queue.shift();
          try {
            const { years } = await client.getFinancials(company.uuid);
            await out.add(financialsSql(company.uuid, toFinancials(years, new Date(now()).toISOString())));
            stats.financials++;
          } catch (error) {
            if (error instanceof DealroomError && error.status === 404) {
              await out.add(financialsSql(company.uuid, toFinancials([], new Date(now()).toISOString())));
              stats.financials++;
            } else if (error instanceof DealroomError && error.status === 402) {
              exhausted = true;
              log('Dealroom credits exhausted; stopping.');
            } else {
              stats.failed++; // Not marked, so the next run tries again.
              if (stats.failed <= 20) log(`Financials failed for ${company.uuid}: ${error.message}`);
            }
          }
        }
      };
      const progress = setInterval(() => log(`Financials: ${stats.financials} fetched, ${queue.length} queued, ${stats.failed} failed, ${client.creditsUsed()} credits.`), 30_000);
      try { await Promise.all(Array.from({ length: concurrency }, worker)); } finally { clearInterval(progress); }
    }
    await finish('ok');
    return stats;
  } catch (error) {
    await finish('failed', String(error.message).slice(0, 500)).catch(() => {});
    throw error;
  }
}

function devVars() {
  try {
    return Object.fromEntries(readFileSync(join(root, '.dev.vars'), 'utf8').split('\n').filter(line => line.includes('=') && !line.startsWith('#'))
      .map(line => { const at = line.indexOf('='); return [line.slice(0, at).trim(), line.slice(at + 1).trim().replace(/^"|"$/g, '')]; }));
  } catch { return {}; }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: {
    remote: { type: 'boolean', default: false },
    minutes: { type: 'string', default: '60' },
    filter: { type: 'string', default: DEFAULT_FILTER },
    sort: { type: 'string', default: DEFAULT_SORT },
    rps: { type: 'string', default: '4' },
    'no-financials': { type: 'boolean', default: false }
  } });
  const vars = { ...devVars(), ...process.env };
  const client = createDealroomClient({ clientId: vars.DEALROOM_CLIENT_ID, clientSecret: vars.DEALROOM_API_KEY,
    requestsPerSecond: Number(values.rps), retries: 4 });
  const d1 = wranglerD1({ remote: values.remote });
  const controller = new AbortController();
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { console.log(`${sig}: finishing in-flight requests and writing.`); controller.abort(); });
  const log = message => console.log(`${new Date().toISOString()} ${message}`);
  log(`Pulling into ${values.remote ? 'remote' : 'local'} D1 for ${values.minutes} minutes at ${values.rps} requests a second.`);
  try {
    const stats = await pull({ client, d1, filter: values.filter, sort: values.sort, minutes: Number(values.minutes),
      financials: !values['no-financials'], log, signal: controller.signal });
    log(`Done: ${JSON.stringify(stats)}`);
  } finally { d1.close(); }
}
