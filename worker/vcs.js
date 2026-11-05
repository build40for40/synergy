// VC leads: each investor with its current partners and the portfolio
// companies that match the brief. Read-only; scripts/vc-pull.mjs fills it.

const parse = value => (value ? JSON.parse(value) : null);

export async function listVcLeads(db) {
  const { results: investors } = await db.prepare(`SELECT i.uuid, i.name, i.website, i.linkedin, i.dealroom_url, i.tagline, i.hq_city, i.hq_country,
    i.investor_types_json, i.deal_size_min, i.deal_size_max, i.investments_count, i.last_investment_date, i.currency,
    COUNT(m.company_uuid) AS matching_companies
    FROM investors i JOIN portfolio_matches m ON m.investor_uuid = i.uuid
    GROUP BY i.uuid ORDER BY matching_companies DESC, i.name`).all();
  if (!investors.length) return [];
  const { results: partners } = await db.prepare(`SELECT investor_uuid, person_uuid, name, title, linkedin, dealroom_url, email
    FROM investor_partners ORDER BY name`).all();
  const { results: companies } = await db.prepare(`SELECT m.investor_uuid, m.is_lead, m.rounds_count, m.ebitda_over_1m, m.series_a_plus,
    c.uuid, c.name, c.domain, c.website, c.linkedin, c.dealroom_url, c.tagline, c.hq_city, c.hq_country, c.launch_year,
    c.employees, c.employee_growth_1y, c.funding_total, c.funding_rounds, c.revenue, c.revenue_year, c.ebitda, c.ebitda_year,
    c.profit, c.profit_year, c.last_round_date, c.last_round_label, c.last_round_amount, c.currency, c.founders_json, c.industries_json
    FROM portfolio_matches m JOIN companies c ON c.uuid = m.company_uuid
    ORDER BY c.ebitda IS NULL, c.ebitda DESC, c.employee_growth_1y DESC`).all();
  return investors.map(({ investor_types_json, ...investor }) => ({
    ...investor,
    investor_types: parse(investor_types_json),
    partners: partners.filter(partner => partner.investor_uuid === investor.uuid).map(({ investor_uuid, ...partner }) => partner),
    companies: companies.filter(company => company.investor_uuid === investor.uuid)
      .map(({ investor_uuid, founders_json, industries_json, ebitda_over_1m, series_a_plus, is_lead, ...company }) => ({
        ...company,
        is_lead: is_lead === null ? null : is_lead === 1,
        matched_on: [ebitda_over_1m && 'ebitda_over_1m', series_a_plus && 'series_a_no_raise_2y'].filter(Boolean),
        founders: parse(founders_json),
        industries: parse(industries_json)
      }))
  }));
}
