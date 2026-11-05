import { createDealroomClient } from './dealroom.js';
import { getProfile, upsertCompanies } from './store.js';

// Pull a bounded number of companies matching the profile's Dealroom filter
// into D1. Capped by pages so a broad filter can't burn through credits.
export async function syncCompanies(env, { maxPages = 2, pageSize = 50, fetch: fetchImpl } = {}) {
  const db = env.DB;
  const startedAt = new Date().toISOString();
  const { meta } = await db.prepare("INSERT INTO sync_runs (started_at, status) VALUES (?, 'running')").bind(startedAt).run();
  const runId = meta.last_row_id;
  let count = 0;
  let credits = 0;
  try {
    const client = createDealroomClient({ clientId: env.DEALROOM_CLIENT_ID, clientSecret: env.DEALROOM_API_KEY, ...(fetchImpl && { fetch: fetchImpl }) });
    const profile = await getProfile(db);
    let cursor = null;
    for (let page = 0; page < maxPages; page++) {
      const result = await client.listCompanies({ filter: profile.dealroom_filter, sort: profile.dealroom_sort, limit: pageSize, cursor });
      await upsertCompanies(db, result.companies);
      count += result.companies.length;
      credits += result.credits;
      cursor = result.nextCursor;
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
