// Dealroom API client (docs: https://developers.dealroom.co, API version 2026-10-22).
// Auth is OAuth client credentials: exchange the client ID and secret for a
// one-hour bearer token, then send it with X-Client-Id on every request.

// Our key is for Dealroom's beta instance; the main api.dealroom.app audience rejects it.
export const API_BASE = 'https://api.beta.dealroom.app';
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

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

// `requestsPerSecond` spaces out request starts (Dealroom allows 5 a second per
// key). 429s and 5xx responses are retried up to `retries` times, waiting for
// Retry-After (capped at `maxWaitMs`) or a doubling backoff.
export function createDealroomClient({ clientId, clientSecret, fetch: fetchImpl = fetch, now = Date.now,
  requestsPerSecond = Infinity, retries = 0, maxWaitMs = 30_000, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (!clientId || !clientSecret) throw new Error('Set DEALROOM_CLIENT_ID and DEALROOM_API_KEY.');
  let token = null;
  let tokenExpiresAt = 0;
  let nextSlot = 0;
  let credits = 0;

  async function throttle() {
    if (!Number.isFinite(requestsPerSecond)) return;
    const slot = Math.max(now(), nextSlot);
    nextSlot = slot + 1000 / requestsPerSecond;
    if (slot > now()) await sleep(slot - now());
  }

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
    for (let attempt = 0; ; attempt++) {
      try {
        return await requestOnce(path, params);
      } catch (error) {
        if (!(error instanceof DealroomError) || !RETRYABLE.has(error.status) || attempt >= retries) throw error;
        await sleep(Math.min(maxWaitMs, error.retryAfter ? error.retryAfter * 1000 : 1000 * 2 ** attempt));
      }
    }
  }

  async function requestOnce(path, params) {
    const url = new URL(path, API_BASE);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    await throttle();
    const response = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        'X-Client-Id': clientId,
        'API-Version': API_VERSION,
        Accept: 'application/json',
        'User-Agent': USER_AGENT
      }
    });
    const used = Number(response.headers.get('X-Credits-Used')) || 0;
    credits += used;
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const retryAfter = Number(response.headers.get('Retry-After')) || null;
      throw new DealroomError(response.status, body.error?.code ?? 'HTTP_ERROR', body.error?.message ?? `Dealroom request failed (${response.status}).`, retryAfter);
    }
    return { body: await response.json(), credits: used };
  }

  return {
    // One page of companies. `filter` uses Dealroom's DSL, e.g.
    // "and(employees_count[gte]:50,launch_date[lte]:2015)".
    // Send `cursor` from the previous page's page.next_cursor, with the same filter and sort.
    async listCompanies({ filter, sort, limit = 50, cursor, view = 'full' } = {}) {
      const { body, credits } = await request('/data/companies', { filter, sort, limit: cursor ? undefined : limit, cursor, view });
      return { companies: body.data ?? [], nextCursor: body.page?.next_cursor ?? null, total: body.page?.total ?? null, credits };
    },
    // Filed revenue, EBITDA and profit by year, oldest first. About 2 credits a year.
    async getFinancials(uuid) {
      const { body, credits } = await request(`/data/companies/${encodeURIComponent(uuid)}/financials`);
      return { years: body.data ?? [], credits };
    },
    // Credits reported by X-Credits-Used across every request so far.
    creditsUsed: () => credits,
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
  // No founders listed means Dealroom doesn't know them, so store NULL rather than [].
  const founders = company.founders?.items?.length
    ? company.founders.items.map(item => ({ uuid: item.person?.uuid ?? null, name: item.person?.name ?? null }))
    : null;
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
    about: company.about ?? null,
    industries_json: company.taxonomy?.length ? JSON.stringify(company.taxonomy.map(tag => tag.name)) : null,
    classifications_json: company.classifications?.length ? JSON.stringify(company.classifications) : null,
    signal_rating: numberOrNull(company.signal_rating),
    monthly_visits: numberOrNull(company.traffic?.monthly_visits),
    is_hiring: typeof company.jobs?.is_hiring === 'boolean' ? (company.jobs.is_hiring ? 1 : 0) : null,
    open_jobs: numberOrNull(company.jobs?.open_count),
    valuation: numberOrNull(company.valuation?.value),
    raw_json: JSON.stringify(company),
    fetched_at: fetchedAt
  };
}

// The latest filed EBITDA and profit, plus every year as JSON. Years with no
// figures are dropped; no years at all leaves everything null. Dealroom
// repeats the last filed figure in later years, so a run of identical values
// is dated to its first year.
export function toFinancials(years, fetchedAt = new Date().toISOString()) {
  const latest = field => {
    const known = years.filter(year => numberOrNull(year[field]) !== null).sort((a, b) => a.year - b.year);
    let i = known.length - 1;
    while (i > 0 && known[i - 1][field] === known[i][field] && known[i - 1].year === known[i].year - 1) i--;
    return known[i] ?? null;
  };
  const ebitda = latest('ebitda');
  const profit = latest('profit');
  const filed = years.filter(year => ['revenue', 'ebitda', 'profit'].some(field => numberOrNull(year[field]) !== null));
  return {
    ebitda: ebitda?.ebitda ?? null,
    ebitda_year: ebitda?.year ?? null,
    profit: profit?.profit ?? null,
    profit_year: profit?.year ?? null,
    financials_json: filed.length ? JSON.stringify(filed) : null,
    financials_fetched_at: fetchedAt
  };
}
