import { getProfile, leadsFor, saveProfile, updateLead } from './store.js';
import { listVcLeads } from './vcs.js';

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
      return json({ vcs: await listVcLeads(env.DB) });
    }

    if (pathname === '/leads/today' && method === 'GET') {
      return json({ date: today(), leads: await leadsFor(env.DB, today()) });
    }

    const leadMatch = pathname.match(/^\/leads\/(\d+)$/);
    if (leadMatch && method === 'PATCH') {
      const body = await readJson(request);
      if (!body || typeof body !== 'object') return error('invalid_json', 'Send a JSON object.', 400);
      const lead = await updateLead(env.DB, Number(leadMatch[1]), body);
      return lead ? json(lead) : error('not_found', 'No such lead.', 404);
    }

    return error('not_found', 'Not found.', 404);
  }
};
