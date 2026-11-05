// The side panel's daily list of VC leads, the user's feedback on them, their
// history and the streak. VC data (partners, matching companies) comes from
// listVcLeads; this module adds what the user did with each VC. Every row
// belongs to one user (worker/user.js); VC data stays shared.
import { listVcLeads } from './vcs.js';

export const OUTCOMES = ['call', 'rejected', 'no_reply'];
const FEEDBACK = `l.first_shown, l.sent_at, l.dismissed_at, l.dismiss_reason, l.outcome, l.outcome_at,
  l.notes, l.notes_at, l.contact_name, l.contact_email, l.contact_at`;

// new -> sent (waiting) -> call | rejected | no_reply, or new -> not_for_me.
export function vcStatus(row) {
  if (row.dismissed_at) return 'not_for_me';
  if (row.outcome) return row.outcome;
  if (row.sent_at) return 'sent';
  return 'new';
}

// Tier 1: a matching company filed EBITDA over the threshold. Tier 2: two or
// more matching companies. Tier 3: the rest.
export function vcTier(vc) {
  if (vc.companies?.some(company => company.matched_on?.includes('ebitda'))) return 1;
  if ((vc.companies?.length ?? 0) >= 2) return 2;
  return 3;
}

const day = iso => (iso ? iso.slice(0, 10) : null);
const isWeekend = date => [0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay());
function previousWorkingDay(date) {
  const d = new Date(`${date}T12:00:00Z`);
  do d.setUTCDate(d.getUTCDate() - 1); while ([0, 6].includes(d.getUTCDay()));
  return d.toISOString().slice(0, 10);
}

// Current streak: consecutive working days ending today (if done) or on the
// last working day before today. Best: the longest such run ever.
export function streakFrom(days, today) {
  const done = new Set(days);
  let current = 0;
  // A day not yet finished doesn't break the run: count back from the last working day.
  let cursor = done.has(today) ? today : previousWorkingDay(today);
  while (done.has(cursor)) { current += 1; cursor = previousWorkingDay(cursor); }
  let best = 0;
  for (const start of [...done].sort()) {
    if (done.has(previousWorkingDay(start))) continue;
    let run = 0;
    let d = start;
    while (done.has(d)) {
      run += 1;
      const next = new Date(`${d}T12:00:00Z`);
      do next.setUTCDate(next.getUTCDate() + 1); while ([0, 6].includes(next.getUTCDay()));
      d = next.toISOString().slice(0, 10);
    }
    best = Math.max(best, run);
  }
  return { current, best: Math.max(best, current), today_done: done.has(today) };
}

async function feedbackRows(db, userId) {
  const { results } = await db.prepare(`SELECT l.investor_uuid, ${FEEDBACK} FROM vc_leads l WHERE l.user_id = ?`).bind(userId).all();
  return new Map(results.map(row => [row.investor_uuid, row]));
}

// VC data for leads that no longer match the criteria (they stay in history).
async function basicInvestors(db, uuids) {
  if (!uuids.length) return new Map();
  const { results } = await db.prepare(`SELECT uuid, name, website, linkedin, dealroom_url, tagline, hq_city, hq_country, currency
    FROM investors WHERE uuid IN (${uuids.map(() => '?').join(', ')})`).bind(...uuids).all();
  return new Map(results.map(row => [row.uuid, { ...row, partners: [], companies: [], matching_companies: 0 }]));
}

function present(vc, row) {
  const { investor_uuid, ...feedback } = row;
  return { ...vc, tier: vcTier(vc), status: vcStatus(row), ...feedback };
}

// Today's list. Unsent leads from earlier days come first (oldest first), then
// anything handled today, then new VCs to fill up to `perDay`.
export async function vcLeadsToday(db, userId, criteria, { perDay = 10, date, now = new Date() } = {}) {
  const vcs = await listVcLeads(db, criteria, now);
  const byUuid = new Map(vcs.map(vc => [vc.uuid, vc]));
  const rows = await feedbackRows(db, userId);
  const isNew = row => !row.sent_at && !row.dismissed_at;
  const handledToday = row => day(row.sent_at) === date || day(row.dismissed_at) === date;

  const carried = [...rows.values()].filter(row => row.first_shown < date && isNew(row) && byUuid.has(row.investor_uuid))
    .sort((a, b) => a.first_shown.localeCompare(b.first_shown));
  const todays = [...rows.values()].filter(row => byUuid.has(row.investor_uuid) && !carried.includes(row)
    && (row.first_shown === date || handledToday(row)));
  let list = [...carried, ...todays].slice(0, perDay);

  if (list.length < perDay) {
    const fresh = vcs.filter(vc => !rows.has(vc.uuid)).slice(0, perDay - list.length);
    if (fresh.length) {
      await db.batch(fresh.map(vc => db.prepare('INSERT OR IGNORE INTO vc_leads (user_id, investor_uuid, first_shown) VALUES (?, ?, ?)').bind(userId, vc.uuid, date)));
      const added = await feedbackRows(db, userId);
      list = [...list, ...fresh.map(vc => added.get(vc.uuid))];
    }
  }

  const leads = list.map(row => ({ ...present(byUuid.get(row.investor_uuid), row), carried_from: row.first_shown < date ? row.first_shown : null }));
  if (leads.length && leads.every(lead => lead.sent_at || lead.dismissed_at) && !isWeekend(date)) {
    await db.prepare('INSERT OR IGNORE INTO streak_days (user_id, day) VALUES (?, ?)').bind(userId, date).run();
  }

  // In play: sent on an earlier day, newest first. Rejected and no-reply stay
  // visible (crossed out on the dashboard) but never return to the list.
  const listed = new Set(leads.map(lead => lead.uuid));
  const playRows = [...rows.values()].filter(row => row.sent_at && !row.dismissed_at && !listed.has(row.investor_uuid))
    .sort((a, b) => b.sent_at.localeCompare(a.sent_at));
  const missing = playRows.map(row => row.investor_uuid).filter(uuid => !byUuid.has(uuid));
  const basics = await basicInvestors(db, missing);
  const vcFor = row => byUuid.get(row.investor_uuid) ?? basics.get(row.investor_uuid);
  const in_play = playRows.filter(vcFor).map(row => present(vcFor(row), row));

  const { results: streakRows } = await db.prepare('SELECT day FROM streak_days WHERE user_id = ?').bind(userId).all();
  return { date, leads_per_day: perDay, leads, in_play, streak: streakFrom(streakRows.map(r => r.day), date), pool_empty: leads.length < perDay };
}

// Applies feedback to one VC lead. Every field is optional:
//   sent, not_for_me (+ reason), outcome ('call' | 'rejected' | 'no_reply' | null),
//   notes, contact_name, contact_email (null clears an edit, back to Dealroom's).
// Returns { lead } or { error: { code, message, status } }.
export async function updateVcLead(db, userId, uuid, input, now = new Date().toISOString()) {
  const current = await db.prepare('SELECT investor_uuid, sent_at, dismissed_at, outcome FROM vc_leads WHERE investor_uuid = ? AND user_id = ?').bind(uuid, userId).first();
  if (!current) return { error: { code: 'not_found', message: 'That VC is not in your leads.', status: 404 } };
  if ('outcome' in input && input.outcome !== null && !OUTCOMES.includes(input.outcome)) {
    return { error: { code: 'invalid_outcome', message: `outcome must be one of ${OUTCOMES.join(', ')}, or null.`, status: 400 } };
  }
  const email = input.contact_email;
  if (typeof email === 'string' && email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return { error: { code: 'invalid_email', message: 'That email address doesn\'t look right.', status: 400 } };
  }

  const set = [];
  const values = [];
  const assign = (column, value) => { set.push(`${column} = ?`); values.push(value); };
  let sentAt = current.sent_at;
  let dismissedAt = current.dismissed_at;

  if ('sent' in input) {
    sentAt = input.sent ? (sentAt ?? now) : null;
    assign('sent_at', sentAt);
    if (sentAt) { dismissedAt = null; assign('dismissed_at', null); assign('dismiss_reason', null); }
  }
  if ('not_for_me' in input) {
    dismissedAt = input.not_for_me ? (dismissedAt ?? now) : null;
    assign('dismissed_at', dismissedAt);
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
    assign('outcome', null); assign('outcome_at', null);
  }
  if (typeof input.notes === 'string') { assign('notes', input.notes.slice(0, 4000)); assign('notes_at', now); }
  const contact = (key, max) => {
    if (!(key in input)) return;
    const value = typeof input[key] === 'string' ? input[key].trim().slice(0, max) : null;
    assign(key, value || null);
    assign('contact_at', now);
  };
  contact('contact_name', 200);
  contact('contact_email', 320);

  if (set.length) await db.prepare(`UPDATE vc_leads SET ${set.join(', ')} WHERE investor_uuid = ? AND user_id = ?`).bind(...values, uuid, userId).run();
  const row = await db.prepare(`SELECT l.investor_uuid, ${FEEDBACK} FROM vc_leads l WHERE l.investor_uuid = ? AND l.user_id = ?`).bind(uuid, userId).first();
  return { lead: { uuid, status: vcStatus(row), ...row, investor_uuid: undefined } };
}

export const VC_HISTORY_FILTERS = {
  all: () => true,
  waiting: row => vcStatus(row) === 'sent',
  call: row => row.outcome === 'call' && !row.dismissed_at,
  closed: row => ['rejected', 'no_reply'].includes(row.outcome) && !row.dismissed_at,
  not_for_me: row => Boolean(row.dismissed_at)
};

// Every VC ever shown, most recent activity first, with counts per filter.
export async function vcLeadHistory(db, userId, criteria, { status = 'all', now = new Date() } = {}) {
  const rows = [...(await feedbackRows(db, userId)).values()];
  const counts = Object.fromEntries(Object.entries(VC_HISTORY_FILTERS).map(([key, keep]) => [key, rows.filter(keep).length]));
  const latest = row => [row.outcome_at, row.sent_at, row.dismissed_at, row.first_shown].filter(Boolean).sort().at(-1);
  const picked = rows.filter(VC_HISTORY_FILTERS[status]).sort((a, b) => latest(b).localeCompare(latest(a)));
  const vcs = new Map((await listVcLeads(db, criteria, now)).map(vc => [vc.uuid, vc]));
  const basics = await basicInvestors(db, picked.map(row => row.investor_uuid).filter(uuid => !vcs.has(uuid)));
  const vcFor = row => vcs.get(row.investor_uuid) ?? basics.get(row.investor_uuid);
  const leads = picked.filter(vcFor).map(row => present(vcFor(row), row));
  return { leads, counts };
}
