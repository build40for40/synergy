import { normalizeCriteria } from './criteria.js';
import { toCompanyRow } from './dealroom.js';

export const LEADS_PER_DAY = 10;
export const COMPANY_COLUMNS = ['uuid', 'name', 'domain', 'website', 'linkedin', 'dealroom_url', 'tagline', 'hq_city', 'hq_country',
  'launch_year', 'employees', 'employee_growth_1y', 'funding_total', 'funding_rounds', 'revenue', 'revenue_year', 'status',
  'founders_json', 'about', 'industries_json', 'classifications_json', 'signal_rating', 'monthly_visits', 'is_hiring', 'open_jobs',
  'valuation', 'currency', 'raw_json', 'fetched_at'];
export const FINANCIAL_COLUMNS = ['ebitda', 'ebitda_year', 'profit', 'profit_year', 'financials_json', 'financials_fetched_at'];
export const UPSERT_COMPANY = `INSERT INTO companies (${COMPANY_COLUMNS.join(', ')}) VALUES (${COMPANY_COLUMNS.map(() => '?').join(', ')})
  ON CONFLICT(uuid) DO UPDATE SET ${COMPANY_COLUMNS.slice(1).map(column => `${column}=excluded.${column}`).join(', ')}`;

export function upsertCompanies(db, companies, fetchedAt = new Date().toISOString()) {
  if (!companies.length) return Promise.resolve([]);
  return db.batch(companies.map(company => {
    const row = toCompanyRow(company, fetchedAt);
    return db.prepare(UPSERT_COMPANY).bind(...COMPANY_COLUMNS.map(column => row[column]));
  }));
}

// Every lead, profile and piece of feedback belongs to one user (an install id, from
// worker/user.js). Companies, investors and the Dealroom pull are shared.
// `criteria` is always complete: the user's saved rules over the defaults.
export async function getProfile(db, userId) {
  const row = await db.prepare('SELECT who, offer, looking_for, dealroom_filter, dealroom_sort, criteria_json, leads_per_day, updated_at FROM profiles WHERE user_id = ?').bind(userId).first()
    ?? { who: '', offer: '', looking_for: '', dealroom_filter: null, dealroom_sort: null, criteria_json: null, leads_per_day: 10, updated_at: null };
  const { criteria_json, ...profile } = row;
  return { ...profile, criteria: normalizeCriteria(criteria_json ? JSON.parse(criteria_json) : null) };
}

export async function saveProfile(db, userId, input, now = new Date().toISOString()) {
  const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
  const optional = (value, max) => text(value, max) || null;
  const profile = {
    who: text(input.who, 2000),
    offer: text(input.offer, 2000),
    looking_for: text(input.looking_for, 2000),
    dealroom_filter: optional(input.dealroom_filter, 2000),
    dealroom_sort: optional(input.dealroom_sort, 200)
  };
  // Criteria are kept unless the input sends them; unknown or invalid keys are dropped.
  const existing = (await db.prepare('SELECT criteria_json FROM profiles WHERE user_id = ?').bind(userId).first())?.criteria_json ?? null;
  const criteria = input.criteria && typeof input.criteria === 'object'
    ? normalizeCriteria(input.criteria) : normalizeCriteria(existing ? JSON.parse(existing) : null);
  // 5 or 10 leads a day; kept unless the input sends a valid value.
  const existingPerDay = (await db.prepare('SELECT leads_per_day FROM profiles WHERE user_id = ?').bind(userId).first())?.leads_per_day ?? 10;
  const leadsPerDay = [5, 10].includes(input.leads_per_day) ? input.leads_per_day : existingPerDay;
  await db.prepare(`INSERT INTO profiles (user_id, who, offer, looking_for, dealroom_filter, dealroom_sort, criteria_json, leads_per_day, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET who=excluded.who, offer=excluded.offer, looking_for=excluded.looking_for,
    dealroom_filter=excluded.dealroom_filter, dealroom_sort=excluded.dealroom_sort, criteria_json=excluded.criteria_json,
    leads_per_day=excluded.leads_per_day, updated_at=excluded.updated_at`)
    .bind(userId, profile.who, profile.offer, profile.looking_for, profile.dealroom_filter, profile.dealroom_sort, JSON.stringify(criteria), leadsPerDay, now).run();
  return { ...profile, criteria, leads_per_day: leadsPerDay, updated_at: now };
}

const LEAD_SELECT = `SELECT l.id, l.lead_date, l.tier, l.notes, l.notes_at, l.reached_out, l.feedback_at,
  l.sent_at, l.dismissed_at, l.dismiss_reason, l.outcome, l.outcome_at,
  c.uuid, c.name, c.domain, c.website, c.linkedin, c.dealroom_url, c.tagline, c.hq_city, c.hq_country, c.launch_year,
  c.employees, c.employee_growth_1y, c.funding_total, c.funding_rounds, c.revenue, c.revenue_year, c.status, c.founders_json,
  c.ebitda, c.ebitda_year, c.profit, c.profit_year, c.industries_json, c.currency
  FROM leads l JOIN companies c ON c.uuid = l.company_uuid`;

// One status per lead, derived from the feedback columns:
// new -> sent (waiting) -> call | rejected | no_reply, or new -> not_for_me.
export function leadStatus(row) {
  if (row.dismissed_at) return 'not_for_me';
  if (row.outcome) return row.outcome;
  if (row.sent_at) return 'sent';
  return 'new';
}

function toLead(row) {
  const { founders_json, industries_json, ...lead } = row;
  return { ...lead, status: leadStatus(row), reached_out: row.reached_out === null ? null : row.reached_out === 1,
    founders: founders_json ? JSON.parse(founders_json) : null, industries: industries_json ? JSON.parse(industries_json) : null };
}

// The brief, as a ranking: filed positive EBITDA (cash-generative) first, then
// no disclosed funding (not recently funded), then growing headcount, then
// revenue on record. Within each, fastest headcount growth first.
const LEAD_RANK = `COALESCE(ebitda > 0, 0) DESC, funding_total IS NULL DESC, COALESCE(employee_growth_1y > 0, 0) DESC,
  revenue IS NOT NULL DESC, employee_growth_1y IS NULL, employee_growth_1y DESC, name`;

// Today's leads for one user. Tops up to 10 from companies never offered to that
// user before, so nobody sees a company twice. Ranking is deliberately simple for now.
export async function leadsFor(db, userId, date) {
  const existing = await db.prepare('SELECT COUNT(*) AS n FROM leads WHERE user_id = ? AND lead_date = ?').bind(userId, date).first();
  const missing = LEADS_PER_DAY - (existing?.n ?? 0);
  if (missing > 0) {
    await db.prepare(`INSERT INTO leads (user_id, company_uuid, lead_date)
      SELECT ?, uuid, ? FROM companies c WHERE NOT EXISTS (SELECT 1 FROM leads l WHERE l.user_id = ? AND l.company_uuid = c.uuid)
      AND (status IS NULL OR status = 'operational')
      ORDER BY ${LEAD_RANK} LIMIT ?`).bind(userId, date, userId, missing).run();
  }
  const { results } = await db.prepare(`${LEAD_SELECT} WHERE l.user_id = ? AND l.lead_date = ? ORDER BY l.id`).bind(userId, date).all();
  return results.map(toLead);
}

export const OUTCOMES = ['call', 'rejected', 'no_reply'];

// Applies feedback from the dashboard. Every field is optional:
//   sent: true | false            marks the lead sent (or undoes it)
//   not_for_me: true | false      dismisses the lead (or undoes it)
//   reason: string                why it's not for me (optional, kept with the dismissal)
//   outcome: 'call' | 'rejected' | 'no_reply' | null   what happened after sending
//   notes: string                 free text, replaces the current notes
//   reached_out: true | false | null   the extension's original yes/no; true also marks it sent
//   tier: 'A' | 'B' | 'C' | null
// Returns { lead } or { error: { code, message, status } }.
// Another user's lead is reported as missing, never as forbidden, so ids reveal nothing.
export async function updateLead(db, userId, id, input, now = new Date().toISOString()) {
  const current = await db.prepare('SELECT id, sent_at, dismissed_at, outcome FROM leads WHERE id = ? AND user_id = ?').bind(id, userId).first();
  if (!current) return { error: { code: 'not_found', message: 'No such lead.', status: 404 } };
  if ('outcome' in input && input.outcome !== null && !OUTCOMES.includes(input.outcome)) {
    return { error: { code: 'invalid_outcome', message: `outcome must be one of ${OUTCOMES.join(', ')}, or null.`, status: 400 } };
  }

  const set = [];
  const values = [];
  const assign = (column, value) => { set.push(`${column} = ?`); values.push(value); };
  let sentAt = current.sent_at;
  let dismissedAt = current.dismissed_at;

  // The original yes/no still works, and a yes counts as sent.
  if ('reached_out' in input) {
    assign('reached_out', input.reached_out === null ? null : input.reached_out ? 1 : 0);
    assign('feedback_at', now);
    if (input.reached_out === true && !sentAt) { sentAt = now; assign('sent_at', now); }
    if (input.reached_out === false && sentAt && !('sent' in input)) { sentAt = null; assign('sent_at', null); }
  }
  if ('sent' in input) {
    sentAt = input.sent ? (sentAt ?? now) : null;
    assign('sent_at', sentAt);
    if (sentAt) { dismissedAt = null; assign('dismissed_at', null); assign('dismiss_reason', null); }
  }
  if ('not_for_me' in input) {
    dismissedAt = input.not_for_me ? (dismissedAt ?? now) : null;
    assign('dismissed_at', dismissedAt);
    // Not for me replaces Sent, as on the dashboard.
    if (dismissedAt && !('sent' in input)) { sentAt = null; assign('sent_at', null); }
    if (!dismissedAt) assign('dismiss_reason', null);
  }
  if (typeof input.reason === 'string' && dismissedAt) assign('dismiss_reason', input.reason.trim().slice(0, 200) || null);
  if ('outcome' in input) {
    if (input.outcome !== null && !sentAt) {
      return { error: { code: 'not_sent', message: 'Mark the lead as sent before recording what happened.', status: 409 } };
    }
    assign('outcome', input.outcome);
    assign('outcome_at', input.outcome === null ? null : now);
  } else if (!sentAt && current.outcome) {
    // Undoing Sent also clears what happened next.
    assign('outcome', null); assign('outcome_at', null);
  }
  if (typeof input.notes === 'string') { assign('notes', input.notes.slice(0, 4000)); assign('notes_at', now); }
  if ('tier' in input) assign('tier', ['A', 'B', 'C'].includes(input.tier) ? input.tier : null);

  if (set.length) await db.prepare(`UPDATE leads SET ${set.join(', ')} WHERE id = ? AND user_id = ?`).bind(...values, id, userId).run();
  return { lead: toLead(await db.prepare(`${LEAD_SELECT} WHERE l.id = ? AND l.user_id = ?`).bind(id, userId).first()) };
}

// History: every lead ever shown, newest first, filtered the way the
// dashboard's History screen filters. Leads are never deleted.
export const HISTORY_FILTERS = {
  all: '1 = 1',
  new: 'l.sent_at IS NULL AND l.dismissed_at IS NULL',
  waiting: 'l.sent_at IS NOT NULL AND l.outcome IS NULL AND l.dismissed_at IS NULL',
  call: "l.outcome = 'call'",
  closed: "l.outcome IN ('rejected', 'no_reply')",
  not_for_me: 'l.dismissed_at IS NOT NULL'
};

export async function leadHistory(db, userId, { status = 'all', limit = 50, before = null } = {}) {
  const where = ['l.user_id = ?', HISTORY_FILTERS[status]];
  const values = [userId];
  if (before) { where.push('l.id < ?'); values.push(before); }
  const size = Math.min(Math.max(1, limit), 200);
  const { results } = await db.prepare(`${LEAD_SELECT} WHERE ${where.join(' AND ')} ORDER BY l.id DESC LIMIT ?`).bind(...values, size + 1).all();
  const page = results.slice(0, size).map(toLead);
  const counts = {};
  for (const [key, condition] of Object.entries(HISTORY_FILTERS)) {
    counts[key] = (await db.prepare(`SELECT COUNT(*) AS n FROM leads l WHERE l.user_id = ? AND ${condition}`).bind(userId).first()).n;
  }
  return { leads: page, counts, next_before: results.length > size ? page[page.length - 1].id : null };
}
