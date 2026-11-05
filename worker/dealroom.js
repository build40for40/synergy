// Dealroom API client (docs: https://developers.dealroom.co, API version 2026-10-22).
// Auth is OAuth client credentials: exchange the client ID and secret for a
// one-hour bearer token, then send it with X-Client-Id on every request.

export const API_BASE = 'https://api.dealroom.app';
export const TOKEN_URL = 'https://accounts.dealroom.co/oauth/token';
export const API_VERSION = '2026-10-22';
const USER_AGENT = 'synergy/0.0.1 (+https://build40for40.com/synergy/)';

export class DealroomError extends Error {
  constructor(status, code, message, retryAfter = null) {
    super(message);
    this.name = 'DealroomError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export function createDealroomClient({ clientId, clientSecret, fetch: fetchImpl = fetch, now = Date.now }) {
  if (!clientId || !clientSecret) throw new Error('Set DEALROOM_CLIENT_ID and DEALROOM_API_KEY.');
  let token = null;
  let tokenExpiresAt = 0;

  async function accessToken() {
    // Refresh a minute early so a token never expires mid-request.
    if (token && now() < tokenExpiresAt - 60_000) return token;
    const response = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        audience: API_BASE,
        grant_type: 'client_credentials'
      })
    });
    if (!response.ok) throw new DealroomError(response.status, 'TOKEN_FAILED', `Dealroom token request failed (${response.status}).`);
    const body = await response.json();
    token = body.access_token;
    tokenExpiresAt = now() + (body.expires_in ?? 3600) * 1000;
    return token;
  }

  async function request(path, params = {}) {
    const url = new URL(path, API_BASE);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    const response = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        'X-Client-Id': clientId,
        'API-Version': API_VERSION,
        Accept: 'application/json',
        'User-Agent': USER_AGENT
      }
    });
    const credits = Number(response.headers.get('X-Credits-Used')) || 0;
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const retryAfter = Number(response.headers.get('Retry-After')) || null;
      throw new DealroomError(response.status, body.error?.code ?? 'HTTP_ERROR', body.error?.message ?? `Dealroom request failed (${response.status}).`, retryAfter);
    }
    return { body: await response.json(), credits };
  }

  return {
    // One page of companies. `filter` uses Dealroom's DSL, e.g.
    // "and(employees_count[gte]:50,launch_date[lte]:2015)".
    // Send `cursor` from the previous page's page.next_cursor, with the same filter and sort.
    async listCompanies({ filter, sort, limit = 50, cursor, view = 'full' } = {}) {
      const { body, credits } = await request('/data/companies', { filter, sort, limit: cursor ? undefined : limit, cursor, view });
      return { companies: body.data ?? [], nextCursor: body.page?.next_cursor ?? null, total: body.page?.total ?? null, credits };
    },
    async getCompany(uuid) {
      const { body, credits } = await request(`/data/companies/${encodeURIComponent(uuid)}`);
      return { company: body.data, credits };
    }
  };
}

const numberOrNull = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);

// Flatten a Dealroom Company object into a `companies` row. Missing data stays
// null so the dashboard can show what is known and what isn't.
export function toCompanyRow(company, fetchedAt = new Date().toISOString()) {
  const hq = company.locations?.find(location => location.role === 'hq') ?? null;
  const launchYear = Number.parseInt(String(company.launch_date ?? '').slice(0, 4), 10);
  const founders = company.founders?.items?.map(item => ({ uuid: item.person?.uuid ?? null, name: item.person?.name ?? null })) ?? null;
  return {
    uuid: company.uuid,
    name: company.name,
    domain: company.domain ?? null,
    website: company.links?.website ?? null,
    linkedin: company.links?.linkedin ?? null,
    dealroom_url: company.dealroom_url ?? null,
    tagline: company.tagline ?? null,
    hq_city: hq?.city?.name ?? null,
    hq_country: hq?.country?.name ?? null,
    launch_year: Number.isFinite(launchYear) ? launchYear : null,
    employees: numberOrNull(company.employees_count),
    employee_growth_1y: numberOrNull(company.employee_count_1y_growth),
    funding_total: numberOrNull(company.funding?.total),
    funding_rounds: numberOrNull(company.funding?.rounds_count),
    revenue: numberOrNull(company.revenue?.value),
    revenue_year: numberOrNull(company.revenue?.year),
    status: company.status ?? null,
    founders_json: founders ? JSON.stringify(founders) : null,
    raw_json: JSON.stringify(company),
    fetched_at: fetchedAt
  };
}
