import { toCompanyRow } from './dealroom.js';

export const LEADS_PER_DAY = 10;
const COMPANY_COLUMNS = ['uuid', 'name', 'domain', 'website', 'linkedin', 'dealroom_url', 'tagline', 'hq_city', 'hq_country',
  'launch_year', 'employees', 'employee_growth_1y', 'funding_total', 'funding_rounds', 'revenue', 'revenue_year', 'status',
  'founders_json', 'raw_json', 'fetched_at'];
const UPSERT_COMPANY = `INSERT INTO companies (${COMPANY_COLUMNS.join(', ')}) VALUES (${COMPANY_COLUMNS.map(() => '?').join(', ')})
  ON CONFLICT(uuid) DO UPDATE SET ${COMPANY_COLUMNS.slice(1).map(column => `${column}=excluded.${column}`).join(', ')}`;

export function upsertCompanies(db, companies, fetchedAt = new Date().toISOString()) {
  if (!companies.length) return Promise.resolve([]);
  return db.batch(companies.map(company => {
    const row = toCompanyRow(company, fetchedAt);
    return db.prepare(UPSERT_COMPANY).bind(...COMPANY_COLUMNS.map(column => row[column]));
  }));
}

export async function getProfile(db) {
  return await db.prepare('SELECT who, offer, looking_for, dealroom_filter, dealroom_sort, updated_at FROM profile WHERE id = 1').first()
    ?? { who: '', offer: '', looking_for: '', dealroom_filter: null, dealroom_sort: null, updated_at: null };
}

export async function saveProfile(db, input, now = new Date().toISOString()) {
  const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
  const optional = (value, max) => text(value, max) || null;
  const profile = {
    who: text(input.who, 2000),
    offer: text(input.offer, 2000),
    looking_for: text(input.looking_for, 2000),
    dealroom_filter: optional(input.dealroom_filter, 2000),
    dealroom_sort: optional(input.dealroom_sort, 200)
  };
  await db.prepare(`INSERT INTO profile (id, who, offer, looking_for, dealroom_filter, dealroom_sort, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET who=excluded.who, offer=excluded.offer, looking_for=excluded.looking_for,
    dealroom_filter=excluded.dealroom_filter, dealroom_sort=excluded.dealroom_sort, updated_at=excluded.updated_at`)
    .bind(profile.who, profile.offer, profile.looking_for, profile.dealroom_filter, profile.dealroom_sort, now).run();
  return { ...profile, updated_at: now };
}

const LEAD_SELECT = `SELECT l.id, l.lead_date, l.tier, l.notes, l.reached_out, l.feedback_at,
  c.uuid, c.name, c.domain, c.website, c.linkedin, c.dealroom_url, c.tagline, c.hq_city, c.hq_country, c.launch_year,
  c.employees, c.employee_growth_1y, c.funding_total, c.funding_rounds, c.revenue, c.revenue_year, c.status, c.founders_json
  FROM leads l JOIN companies c ON c.uuid = l.company_uuid`;

function toLead(row) {
  const { founders_json, ...lead } = row;
  return { ...lead, reached_out: row.reached_out === null ? null : row.reached_out === 1, founders: founders_json ? JSON.parse(founders_json) : null };
}

// Today's leads. Tops up to 10 from companies never offered before, so a
// company is never shown twice. Ranking is deliberately simple for now.
export async function leadsFor(db, date) {
  const existing = await db.prepare('SELECT COUNT(*) AS n FROM leads WHERE lead_date = ?').bind(date).first();
  const missing = LEADS_PER_DAY - (existing?.n ?? 0);
  if (missing > 0) {
    await db.prepare(`INSERT INTO leads (company_uuid, lead_date)
      SELECT uuid, ? FROM companies c WHERE NOT EXISTS (SELECT 1 FROM leads l WHERE l.company_uuid = c.uuid)
      AND (status IS NULL OR status = 'operational')
      ORDER BY employee_growth_1y IS NULL, employee_growth_1y DESC, name LIMIT ?`).bind(date, missing).run();
  }
  const { results } = await db.prepare(`${LEAD_SELECT} WHERE l.lead_date = ? ORDER BY l.id`).bind(date).all();
  return results.map(toLead);
}

export async function updateLead(db, id, input, now = new Date().toISOString()) {
  const lead = await db.prepare('SELECT id FROM leads WHERE id = ?').bind(id).first();
  if (!lead) return null;
  if ('reached_out' in input) {
    await db.prepare('UPDATE leads SET reached_out = ?, feedback_at = ? WHERE id = ?')
      .bind(input.reached_out === null ? null : input.reached_out ? 1 : 0, now, id).run();
  }
  if (typeof input.notes === 'string') await db.prepare('UPDATE leads SET notes = ? WHERE id = ?').bind(input.notes.slice(0, 4000), id).run();
  if ('tier' in input) await db.prepare('UPDATE leads SET tier = ? WHERE id = ?').bind(['A', 'B', 'C'].includes(input.tier) ? input.tier : null, id).run();
  return toLead(await db.prepare(`${LEAD_SELECT} WHERE l.id = ?`).bind(id).first());
}
