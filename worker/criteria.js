// The user's matching rules, and the query that applies them to the Dealroom
// facts. Criteria are data (profile.criteria_json), never SQL. Setting a rule
// to null switches it off.

export const DEFAULT_CRITERIA = Object.freeze({
  investor_countries: ['United Kingdom', 'Spain'],
  company_countries: ['United Kingdom', 'Spain'],
  launched_by: 2018,
  employees_min: 10,
  employees_max: 1000,
  growing: true,
  no_raise_months: 24,
  exclude_exited: true,
  // A company qualifies on either of these (OR). If both are null, every
  // company that passes the rules above qualifies.
  ebitda_min_gbp: 1_000_000,
  ebitda_within_years: 3,
  series_a_plus: true
});

const COUNTRY_LIST = value => Array.isArray(value) && value.length <= 50 && value.every(item => typeof item === 'string' && item.length <= 100);
const NUMBER = value => typeof value === 'number' && Number.isFinite(value);
const RULES = {
  investor_countries: COUNTRY_LIST,
  company_countries: COUNTRY_LIST,
  launched_by: NUMBER,
  employees_min: NUMBER,
  employees_max: NUMBER,
  growing: value => typeof value === 'boolean',
  no_raise_months: NUMBER,
  exclude_exited: value => typeof value === 'boolean',
  ebitda_min_gbp: NUMBER,
  ebitda_within_years: NUMBER,
  series_a_plus: value => typeof value === 'boolean'
};

// Defaults, overlaid with whichever known keys the input sets validly.
// Unknown keys and invalid values are dropped; null switches a rule off.
export function normalizeCriteria(input) {
  const criteria = { ...DEFAULT_CRITERIA };
  if (!input || typeof input !== 'object') return criteria;
  for (const [key, valid] of Object.entries(RULES)) {
    if (!(key in input)) continue;
    if (input[key] === null) criteria[key] = null;
    else if (valid(input[key])) criteria[key] = input[key];
  }
  return criteria;
}

// The month `months` before `now`, as Dealroom's YYYY-MM.
export function monthsBefore(now, months) {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

// SQL selecting (investor_uuid, company_uuid, ebitda_ok, series_ok) for every
// investment that matches, with its bind values. Use it as a subquery.
export function matchQuery(criteria, now = new Date()) {
  const where = [];
  const binds = [];
  const list = (column, values) => { where.push(`${column} IN (${values.map(() => '?').join(', ')})`); binds.push(...values); };
  if (criteria.investor_countries?.length) list('i.hq_country', criteria.investor_countries);
  if (criteria.company_countries?.length) list('c.hq_country', criteria.company_countries);
  where.push("c.status = 'operational'");
  if (criteria.launched_by !== null) { where.push('c.launch_year <= ?'); binds.push(criteria.launched_by); }
  if (criteria.employees_min !== null) { where.push('c.employees >= ?'); binds.push(criteria.employees_min); }
  if (criteria.employees_max !== null) { where.push('c.employees <= ?'); binds.push(criteria.employees_max); }
  if (criteria.growing) where.push('c.employee_growth_1y > 0');
  if (criteria.exclude_exited) {
    where.push(`NOT EXISTS (SELECT 1 FROM funding_rounds r WHERE r.company_uuid = c.uuid AND r.is_exit = 1)`);
    where.push(`COALESCE(c.classifications_json, '') NOT LIKE '%"exited"%' AND COALESCE(c.classifications_json, '') NOT LIKE '%"pe_owned"%'`);
  }
  if (criteria.no_raise_months !== null) {
    where.push(`c.rounds_fetched_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM funding_rounds r WHERE r.company_uuid = c.uuid
      AND COALESCE(r.is_exit, 0) = 0 AND r.announced_date >= ?)`);
    binds.push(monthsBefore(now, criteria.no_raise_months));
  }

  const ebitdaOn = criteria.ebitda_min_gbp !== null;
  const ebitda = ebitdaOn
    ? `EXISTS (SELECT 1 FROM company_financials f WHERE f.company_uuid = c.uuid AND f.currency = 'GBP' AND f.carried_forward = 0
        AND f.ebitda > ?${criteria.ebitda_within_years !== null ? ' AND f.year >= ?' : ''})`
    : '0';
  const ebitdaBinds = ebitdaOn ? [criteria.ebitda_min_gbp, ...(criteria.ebitda_within_years !== null ? [now.getUTCFullYear() - criteria.ebitda_within_years] : [])] : [];
  const series = criteria.series_a_plus
    ? `EXISTS (SELECT 1 FROM funding_rounds r WHERE r.company_uuid = c.uuid AND r.standardized_round LIKE 'Series %')`
    : '0';
  if (ebitdaOn || criteria.series_a_plus) { where.push(`(${ebitda} OR ${series})`); binds.push(...ebitdaBinds); }

  return {
    sql: `SELECT m.investor_uuid, m.company_uuid, ${ebitda} AS ebitda_ok, ${series} AS series_ok
      FROM investments m JOIN investors i ON i.uuid = m.investor_uuid JOIN companies c ON c.uuid = m.company_uuid
      WHERE ${where.join('\n      AND ')}`,
    binds: [...ebitdaBinds, ...binds]
  };
}
