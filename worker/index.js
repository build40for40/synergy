import { HISTORY_FILTERS, getProfile, leadHistory, leadsFor, saveProfile, updateLead } from './store.js';
import { listVcLeads } from './vcs.js';
import { VC_HISTORY_FILTERS, updateVcLead, vcLeadHistory, vcLeadsToday } from './vc-leads.js';

// MVP is single-user with no sign-in. Anyone with the URL can read and write;
// add auth before this holds anything private.
const headers = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff'
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers });
const error = (code, message, status) => json({ error: { code, message } }, status);
const today = () => new Date().toISOString().slice(0, 10);

async function readJson(request) {
  const text = await request.text();
  if (text.length > 16_384) return null;
  try { return JSON.parse(text); } catch { return null; }
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const method = request.method;
    if (method === 'OPTIONS') return new Response(null, { status: 204, headers });

    if (pathname === '/health' && method === 'GET') {
      const lastSync = await env.DB.prepare('SELECT started_at, finished_at, status, companies, credits_used, error FROM sync_runs ORDER BY id DESC LIMIT 1').first();
      const companies = await env.DB.prepare('SELECT COUNT(*) AS n FROM companies').first();
      return json({ ok: true, companies: companies.n, last_sync: lastSync });
    }

    if (pathname === '/profile') {
      if (method === 'GET') return json(await getProfile(env.DB));
      if (method === 'PUT') {
        const body = await readJson(request);
        if (!body || typeof body !== 'object') return error('invalid_json', 'Send a JSON object.', 400);
        return json(await saveProfile(env.DB, body));
      }
    }

    if (pathname === '/vcs' && method === 'GET') {
      const { criteria } = await getProfile(env.DB);
      return json({ criteria, vcs: await listVcLeads(env.DB, criteria) });
    }

    // The side panel's list: today's 5 or 10 VC leads, what's in play and the streak.
    if (pathname === '/vcs/today' && method === 'GET') {
      const { criteria, leads_per_day } = await getProfile(env.DB);
      return json(await vcLeadsToday(env.DB, criteria, { perDay: leads_per_day, date: today() }));
    }

    // History of VC leads: GET /vcs/history?status=all|waiting|call|closed|not_for_me
    if (pathname === '/vcs/history' && method === 'GET') {
      const status = new URL(request.url).searchParams.get('status') ?? 'all';
      if (!(status in VC_HISTORY_FILTERS)) return error('invalid_status', `status must be one of ${Object.keys(VC_HISTORY_FILTERS).join(', ')}.`, 400);
      const { criteria } = await getProfile(env.DB);
      return json(await vcLeadHistory(env.DB, criteria, { status }));
    }

    // Feedback on one VC lead: sent, not_for_me + reason, outcome, notes, contact_name, contact_email.
    const vcMatch = pathname.match(/^\/vcs\/([0-9a-f-]{36})$/);
    if (vcMatch && method === 'PATCH') {
      const body = await readJson(request);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return error('invalid_json', 'Send a JSON object.', 400);
      const result = await updateVcLead(env.DB, vcMatch[1], body);
      return result.error ? error(result.error.code, result.error.message, result.error.status) : json(result.lead);
    }

    if (pathname === '/leads/today' && method === 'GET') {
      return json({ date: today(), leads: await leadsFor(env.DB, today()) });
    }

    // History: GET /leads?status=all|new|waiting|call|closed|not_for_me&limit=50&before=<id>
    if (pathname === '/leads' && method === 'GET') {
      const params = new URL(request.url).searchParams;
      const status = params.get('status') ?? 'all';
      if (!(status in HISTORY_FILTERS)) return error('invalid_status', `status must be one of ${Object.keys(HISTORY_FILTERS).join(', ')}.`, 400);
      const limit = Number(params.get('limit') ?? 50);
      const before = params.has('before') ? Number(params.get('before')) : null;
      if (!Number.isInteger(limit) || (before !== null && !Number.isInteger(before))) return error('invalid_query', 'limit and before must be whole numbers.', 400);
      return json(await leadHistory(env.DB, { status, limit, before }));
    }

    const leadMatch = pathname.match(/^\/leads\/(\d+)$/);
    if (leadMatch && method === 'PATCH') {
      const body = await readJson(request);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return error('invalid_json', 'Send a JSON object.', 400);
      const result = await updateLead(env.DB, Number(leadMatch[1]), body);
      return result.error ? error(result.error.code, result.error.message, result.error.status) : json(result.lead);
    }

    return error('not_found', 'Not found.', 404);
  }
};
