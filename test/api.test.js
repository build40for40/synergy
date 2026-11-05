import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { upsertCompanies } from '../worker/store.js';
import { syncCompanies } from '../worker/sync.js';
import { TOKEN_URL } from '../worker/dealroom.js';
import { company, database } from './helpers.js';

const call = (env, path, init) => worker.fetch(new Request(`http://api${path}`, init), env);

test('profile round-trips', async () => {
  const env = { DB: database() };
  assert.equal((await (await call(env, '/profile')).json()).updated_at, null);
  const saved = await call(env, '/profile', { method: 'PUT', body: JSON.stringify({ who: ' Deal originator ', offer: 'Growth capital', looking_for: 'UK founders', dealroom_filter: '' }) });
  assert.equal(saved.status, 200);
  const profile = await (await call(env, '/profile')).json();
  assert.equal(profile.who, 'Deal originator');
  assert.equal(profile.dealroom_filter, null);
});

test('serves 10 leads a day, never repeats a company, records feedback', async () => {
  const env = { DB: database() };
  await upsertCompanies(env.DB, Array.from({ length: 25 }, (_, i) => company(i + 1)));
  await upsertCompanies(env.DB, [company(99, { status: 'closed' })]);

  const first = await (await call(env, '/leads/today')).json();
  assert.equal(first.leads.length, 10);
  assert.equal(first.leads[0].name, 'Company 25'); // fastest headcount growth first
  assert.equal(first.leads[0].reached_out, null);
  assert.ok(!first.leads.some(lead => lead.name === 'Company 99'));

  const again = await (await call(env, '/leads/today')).json();
  assert.deepEqual(again.leads.map(lead => lead.id), first.leads.map(lead => lead.id));

  const patched = await call(env, `/leads/${first.leads[0].id}`, { method: 'PATCH', body: JSON.stringify({ reached_out: true, tier: 'A', notes: 'Succession angle' }) });
  const lead = await patched.json();
  assert.equal(lead.reached_out, true);
  assert.equal(lead.tier, 'A');
  assert.equal(lead.notes, 'Succession angle');
  assert.equal((await call(env, '/leads/9999', { method: 'PATCH', body: '{}' })).status, 404);
});

test('sync pulls pages into D1 and logs the run', async () => {
  const env = { DB: database(), DEALROOM_CLIENT_ID: 'id', DEALROOM_API_KEY: 'secret' };
  const pages = [
    { data: [company(1), company(2)], page: { next_cursor: 'p2' } },
    { data: [company(3)], page: { next_cursor: null } }
  ];
  let page = 0;
  const fetch = async url => String(url) === TOKEN_URL
    ? Response.json({ access_token: 'tok' })
    : new Response(JSON.stringify(pages[page++]), { headers: { 'X-Credits-Used': '4' } });
  const result = await syncCompanies(env, { fetch, maxPages: 5 });
  assert.deepEqual(result, { status: 'ok', companies: 3, credits: 8 });
  const health = await (await call(env, '/health')).json();
  assert.equal(health.companies, 3);
  assert.equal(health.last_sync.status, 'ok');
});

test('a failed sync is recorded, not swallowed', async () => {
  const env = { DB: database(), DEALROOM_CLIENT_ID: 'id', DEALROOM_API_KEY: 'secret' };
  const fetch = async () => new Response('{}', { status: 401 });
  await assert.rejects(syncCompanies(env, { fetch }));
  const health = await (await call(env, '/health')).json();
  assert.equal(health.last_sync.status, 'failed');
});
