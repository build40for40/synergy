import { createDealroomClient, DealroomError } from './dealroom.js';
import { getProfile, LEADS_PER_DAY, unofferedCount, upsertCompanies } from './store.js';

// The brief's default target when the About you form sets no filter: UK
// companies that are
// - established: launched in 2016 or earlier, 20 to 500 people, operational;
// - growing: headcount up on a year ago;
// - cash-generative: revenue on record and never raised a disclosed amount.
//   Dealroom has no profit or EBITDA filter, so this is a proxy. The
//   /financials endpoint has filed EBITDA but costs about 34 credits a company;
// - not recently funded: no disclosed funding, and not PE-owned or exited.
//   "Never raised, or last raised before 2023" would be closer, but Dealroom
//   times out on or(total_funding[is_null],last_funding.date[lte]:2022).
// UK because Companies House filings are the qualifier. About 550 matches on
// 5 November 2026.
export const DEFAULT_FILTER = 'and(hq_location[eq]:93,company_status[eq]:operational,launch_date[lte]:2016,'
  + 'employees_count[gte]:20,employees_count[lte]:500,employee_count_1y_growth[gt]:0,latest_revenue[is_not_null],'
  + 'total_funding[is_null],classification[nin_any]:pe_owned|exited)';
export const DEFAULT_SORT = '-employee_count_1y_growth';

// Skip the Dealroom call while this many leads are already waiting (3 days' worth).
export const MIN_STOCK = LEADS_PER_DAY * 3;

const getState = db => db.prepare('SELECT filter, sort, next_cursor FROM sync_state WHERE id = 1').first();
const saveState = (db, filter, sort, cursor) => db.prepare(`INSERT INTO sync_state (id, filter, sort, next_cursor, updated_at) VALUES (1, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET filter=excluded.filter, sort=excluded.sort, next_cursor=excluded.next_cursor, updated_at=excluded.updated_at`)
  .bind(filter, sort, cursor, new Date().toISOString()).run();

// Pull a bounded number of companies matching the profile's Dealroom filter
// into D1. Capped by pages so a broad filter can't burn through credits, and
// skipped while enough unoffered companies are stored. Each run continues from
// where the last one stopped; at the end of the list it starts again from the top.
export async function syncCompanies(env, { maxPages = 2, pageSize = 50, minStock = MIN_STOCK, fetch: fetchImpl } = {}) {
  const db = env.DB;
  const startedAt = new Date().toISOString();
  const { meta } = await db.prepare("INSERT INTO sync_runs (started_at, status) VALUES (?, 'running')").bind(startedAt).run();
  const runId = meta.last_row_id;
  let count = 0;
  let credits = 0;
  try {
    const stock = await unofferedCount(db);
    if (stock >= minStock) {
      await db.prepare("UPDATE sync_runs SET finished_at = ?, status = 'skipped', companies = 0, credits_used = 0 WHERE id = ?")
        .bind(new Date().toISOString(), runId).run();
      return { status: 'skipped', companies: 0, credits: 0, stock };
    }
    const client = createDealroomClient({ clientId: env.DEALROOM_CLIENT_ID, clientSecret: env.DEALROOM_API_KEY, ...(fetchImpl && { fetch: fetchImpl }) });
    const profile = await getProfile(db);
    const filter = profile.dealroom_filter || DEFAULT_FILTER;
    const sort = profile.dealroom_sort || DEFAULT_SORT;
    const state = await getState(db);
    let cursor = state && state.filter === filter && state.sort === sort ? state.next_cursor : null;
    for (let page = 0; page < maxPages; page++) {
      let result;
      try {
        result = await client.listCompanies({ filter, sort, limit: pageSize, cursor });
      } catch (error) {
        // A saved cursor Dealroom no longer accepts: start again from the top.
        if (!(cursor && page === 0 && error instanceof DealroomError && error.status === 400)) throw error;
        cursor = null;
        result = await client.listCompanies({ filter, sort, limit: pageSize });
      }
      await upsertCompanies(db, result.companies);
      count += result.companies.length;
      credits += result.credits;
      cursor = result.nextCursor;
      await saveState(db, filter, sort, cursor);
      if (!cursor) break;
    }
    await db.prepare("UPDATE sync_runs SET finished_at = ?, status = 'ok', companies = ?, credits_used = ? WHERE id = ?")
      .bind(new Date().toISOString(), count, credits, runId).run();
    return { status: 'ok', companies: count, credits };
  } catch (error) {
    await db.prepare("UPDATE sync_runs SET finished_at = ?, status = 'failed', companies = ?, credits_used = ?, error = ? WHERE id = ?")
      .bind(new Date().toISOString(), count, credits, String(error.message).slice(0, 500), runId).run();
    throw error;
  }
}
