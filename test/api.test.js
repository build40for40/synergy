import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../worker/index.js';
import { upsertCompanies } from '../worker/store.js';
import { company, database, issuer, keys, signToken } from './helpers.js';

// Signed in as user_test unless a test says otherwise (tokens from test/helpers.js stand in for WorkOS).
const call = async (env, path, init = {}, user = 'user_test') => handle(
  new Request(`http://api${path}`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${await signToken(user)}` } }),
  env, { keys, issuer });

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

test('ranks filed positive EBITDA first, then no funding, then growth', async () => {
  const env = { DB: database() };
  await upsertCompanies(env.DB, [
    company(1, { employee_count_1y_growth: 90, funding: { total: 5e6, rounds_count: 2 } }),
    company(2, { employee_count_1y_growth: 5 }),
    company(3, { employee_count_1y_growth: 50 }),
    company(4, { employee_count_1y_growth: -10 })
  ]);
  await env.DB.prepare("UPDATE companies SET ebitda = 1000000, ebitda_year = 2024 WHERE name = 'Company 2'").run();
  const { leads } = await (await call(env, '/leads/today')).json();
  assert.deepEqual(leads.map(lead => lead.name), ['Company 2', 'Company 3', 'Company 4', 'Company 1']);
  assert.equal(leads[0].ebitda, 1000000);
  assert.equal(leads[0].ebitda_year, 2024);
});
