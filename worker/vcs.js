// VC leads: each investor with its partners and the portfolio companies that
// match the user's criteria. Computed from the Dealroom facts on every call.
import { matchQuery } from './criteria.js';

const parse = value => (value ? JSON.parse(value) : null);

// Dealroom has duplicate person records; keep one per name, preferring one with LinkedIn.
export function uniqueByName(people) {
  const byName = new Map();
  for (const person of people) {
    const key = person.name.trim().toLowerCase();
    const seen = byName.get(key);
    if (!seen || (!seen.linkedin && person.linkedin)) byName.set(key, person);
  }
  return [...byName.values()];
}

export async function listVcLeads(db, criteria, now = new Date()) {
  const match = matchQuery(criteria, now);
  const { results: companies } = await db.prepare(`WITH matches AS (${match.sql})
    SELECT m.investor_uuid, m.ebitda_ok, m.series_ok, inv.is_lead, inv.rounds_count,
      c.uuid, c.name, c.domain, c.website, c.linkedin, c.dealroom_url, c.tagline, c.hq_city, c.hq_country, c.launch_year,
      c.employees, c.employee_growth_1y, c.funding_total, c.funding_rounds, c.revenue, c.revenue_year, c.ebitda, c.ebitda_year,
      c.profit, c.profit_year, c.currency, c.founders_json, c.industries_json,
      r.announced_date AS last_round_date, COALESCE(r.standardized_round, r.round_type) AS last_round_label, r.amount AS last_round_amount
    FROM matches m
    JOIN companies c ON c.uuid = m.company_uuid
    JOIN investments inv ON inv.investor_uuid = m.investor_uuid AND inv.company_uuid = m.company_uuid
    LEFT JOIN funding_rounds r ON r.id = (SELECT id FROM funding_rounds WHERE company_uuid = c.uuid AND COALESCE(is_exit, 0) = 0
      ORDER BY announced_date DESC, id DESC LIMIT 1)
    ORDER BY c.ebitda IS NULL, c.ebitda DESC, c.employee_growth_1y DESC`).bind(...match.binds).all();
  if (!companies.length) return [];

  const ids = [...new Set(companies.map(company => company.investor_uuid))];
  const marks = ids.map(() => '?').join(', ');
  const { results: investors } = await db.prepare(`SELECT uuid, name, website, linkedin, dealroom_url, tagline, hq_city, hq_country,
    investor_types_json, deal_size_min, deal_size_max, investments_count, last_investment_date, currency
    FROM investors WHERE uuid IN (${marks})`).bind(...ids).all();
  const { results: team } = await db.prepare(`SELECT investor_uuid, person_uuid, name, title, linkedin, dealroom_url, email
    FROM investor_team WHERE investor_uuid IN (${marks}) AND is_partner = 1 AND COALESCE(is_past, 0) = 0 ORDER BY name`).bind(...ids).all();

  return investors.map(({ investor_types_json, ...investor }) => {
    const matched = companies.filter(company => company.investor_uuid === investor.uuid)
      .map(({ investor_uuid, founders_json, industries_json, ebitda_ok, series_ok, is_lead, ...company }) => ({
        ...company,
        is_lead: is_lead === null ? null : is_lead === 1,
        matched_on: [ebitda_ok && 'ebitda', series_ok && 'series_a_plus'].filter(Boolean),
        founders: parse(founders_json),
        industries: parse(industries_json)
      }));
    return {
      ...investor,
      investor_types: parse(investor_types_json),
      matching_companies: matched.length,
      partners: uniqueByName(team.filter(person => person.investor_uuid === investor.uuid)).map(({ investor_uuid, ...person }) => person),
      companies: matched
    };
  }).sort((a, b) => b.matching_companies - a.matching_companies || a.name.localeCompare(b.name));
}
