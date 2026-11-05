import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { handle } from '../worker/index.js';
import { upsertCompanies } from '../worker/store.js';
import { asUser, company, database } from './helpers.js';
import { identify } from '../worker/user.js';

const as = async (user, env, path, init = {}) => handle(
  new Request(`http://api${path}`, { ...init, headers: { ...init.headers, ...(user ? asUser(user) : {}) } }),
  env);

async function stocked() {
  const env = { DB: database() };
  await upsertCompanies(env.DB, Array.from({ length: 25 }, (_, i) => company(i + 1)));
  return env;
}

test('every data route needs an install id', async () => {
  const env = await stocked();
  for (const [path, method] of [['/profile', 'GET'], ['/profile', 'PUT'], ['/leads/today', 'GET'], ['/leads', 'GET'], ['/leads/1', 'PATCH'], ['/vcs/today', 'GET']]) {
    const response = await as(null, env, path, { method, body: method === 'GET' ? undefined : '{}' });
    assert.equal(response.status, 400, `${method} ${path}`);
    assert.equal((await response.json()).error.code, 'install_id_required');
  }
});

test('only a v4 UUID is accepted as an install id, and it never becomes "unclaimed"', () => {
  const req = id => new Request('http://api/', { headers: id ? { 'X-Synergy-User': id } : {} });
  const id = '3f2b8c1e-5a4d-4e6f-9a1b-2c3d4e5f6a7b';
  assert.deepEqual(identify(req(id)), { userId: `install_${id}` });
  assert.deepEqual(identify(req(id.toUpperCase())), { userId: `install_${id}` });
  for (const bad of [null, 'unclaimed', 'user_abc', `${id}x`, '3f2b8c1e-5a4d-1e6f-9a1b-2c3d4e5f6a7b']) assert.equal(identify(req(bad)).status, 400, String(bad));
});

test('health and CORS preflight stay open, and the preflight allows the install id header', async () => {
  const env = await stocked();
  assert.equal((await as(null, env, '/health')).status, 200);
  const preflight = await as(null, env, '/leads/today', { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('Access-Control-Allow-Headers'), /X-Synergy-User/);
});

test('the deployed worker serves data with no sign-in configured', async () => {
  const env = await stocked();
  const response = await worker.fetch(new Request('http://api/leads/today', { headers: asUser('user_alice') }), env);
  assert.equal(response.status, 200);
});

test('each user gets their own leads, and can see the same company as someone else', async () => {
  const env = await stocked();
  const alice = await (await as('user_alice', env, '/leads/today')).json();
  const bob = await (await as('user_bob', env, '/leads/today')).json();
  assert.equal(alice.leads.length, 10);
  assert.equal(bob.leads.length, 10);
  assert.deepEqual(bob.leads.map(lead => lead.uuid), alice.leads.map(lead => lead.uuid), 'the same ranking, served to each user separately');
  assert.ok(alice.leads.every(lead => !bob.leads.some(other => other.id === lead.id)), 'but as separate lead rows');
});

test("a user can't read or change someone else's lead", async () => {
  const env = await stocked();
  const alice = await (await as('user_alice', env, '/leads/today')).json();
  await as('user_bob', env, '/leads/today');
  const target = alice.leads[0].id;

  const patched = await as('user_bob', env, `/leads/${target}`, { method: 'PATCH', body: JSON.stringify({ sent: true, notes: 'not mine' }) });
  assert.equal(patched.status, 404, "another user's lead looks missing, not forbidden");

  await as('user_alice', env, `/leads/${target}`, { method: 'PATCH', body: JSON.stringify({ sent: true }) });
  const aliceHistory = await (await as('user_alice', env, '/leads?status=waiting')).json();
  const bobHistory = await (await as('user_bob', env, '/leads?status=waiting')).json();
  assert.deepEqual(aliceHistory.leads.map(lead => lead.id), [target]);
  assert.equal(aliceHistory.leads[0].notes, '');
  assert.equal(bobHistory.leads.length, 0);
  assert.equal(bobHistory.counts.all, 10);
});

test('profiles are per user', async () => {
  const env = await stocked();
  await as('user_alice', env, '/profile', { method: 'PUT', body: JSON.stringify({ who: 'Broker A' }) });
  assert.equal((await (await as('user_alice', env, '/profile')).json()).who, 'Broker A');
  const bob = await (await as('user_bob', env, '/profile')).json();
  assert.equal(bob.who, '');
  assert.equal(bob.updated_at, null);
});

test('the 0006 migration moves an existing profile and leads to "unclaimed", keeping their feedback', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { readdirSync, readFileSync } = await import('node:fs');
  const dir = new URL('../migrations/', import.meta.url);
  const files = readdirSync(dir).filter(name => name.endsWith('.sql')).sort();
  const sqlite = new DatabaseSync(':memory:');
  for (const file of files.filter(name => name < '0006')) sqlite.exec(readFileSync(new URL(file, dir), 'utf8'));
  sqlite.exec(`INSERT INTO profile (id, who, offer, looking_for, updated_at) VALUES (1, 'Old broker', '', '', '2026-11-05T09:00:00Z');
    INSERT INTO companies (uuid, name, raw_json, fetched_at) VALUES ('c1', 'Co 1', '{}', 'now'), ('c2', 'Co 2', '{}', 'now');
    INSERT INTO leads (company_uuid, lead_date, sent_at, outcome, notes) VALUES ('c1', '2026-11-05', '2026-11-05T10:00:00Z', 'call', 'Met at dinner'), ('c2', '2026-11-05', NULL, NULL, '');`);
  for (const file of files.filter(name => name >= '0006')) sqlite.exec(readFileSync(new URL(file, dir), 'utf8'));
  assert.equal(sqlite.prepare("SELECT who FROM profiles WHERE user_id = 'unclaimed'").get().who, 'Old broker');
  const leads = sqlite.prepare('SELECT user_id, company_uuid, outcome, notes FROM leads ORDER BY id').all();
  assert.deepEqual(leads.map(row => ({ ...row })), [
    { user_id: 'unclaimed', company_uuid: 'c1', outcome: 'call', notes: 'Met at dinner' },
    { user_id: 'unclaimed', company_uuid: 'c2', outcome: null, notes: '' }
  ]);
  // A new user can now be offered the same companies.
  sqlite.exec("INSERT INTO leads (user_id, company_uuid, lead_date) VALUES ('user_new', 'c1', '2026-11-06')");
  assert.throws(() => sqlite.exec("INSERT INTO leads (user_id, company_uuid, lead_date) VALUES ('user_new', 'c1', '2026-11-07')"), /UNIQUE/);
});

test('VC leads, feedback and streaks are per user', async () => {
  const { readFileSync } = await import('node:fs');
  const env = { DB: database() };
  env.DB.raw.exec(readFileSync(new URL('./fixtures/ui-vcs.sql', import.meta.url), 'utf8'));
  const alice = await (await as('user_alice', env, '/vcs/today')).json();
  assert.ok(alice.leads.length > 0);
  const target = alice.leads[0].uuid;
  assert.equal((await as('user_alice', env, `/vcs/${target}`, { method: 'PATCH', body: JSON.stringify({ sent: true, notes: 'Alice only' }) })).status, 200);

  // Bob hasn't been shown anything yet, so Alice's VC isn't his to change.
  assert.equal((await as('user_bob', env, `/vcs/${target}`, { method: 'PATCH', body: JSON.stringify({ notes: 'not mine' }) })).status, 404);
  const bob = await (await as('user_bob', env, '/vcs/today')).json();
  const bobsCopy = bob.leads.find(lead => lead.uuid === target);
  assert.equal(bobsCopy.status, 'new', 'the same VC is new for Bob');
  assert.equal(bobsCopy.notes, '');
  const bobHistory = await (await as('user_bob', env, '/vcs/history?status=waiting')).json();
  assert.equal(bobHistory.counts.waiting, 0);
  const aliceHistory = await (await as('user_alice', env, '/vcs/history?status=waiting')).json();
  assert.equal(aliceHistory.leads[0].notes, 'Alice only');

  // Leads a day is per user too.
  await as('user_bob', env, '/profile', { method: 'PUT', body: JSON.stringify({ leads_per_day: 5 }) });
  assert.equal((await (await as('user_bob', env, '/profile')).json()).leads_per_day, 5);
  assert.equal((await (await as('user_alice', env, '/profile')).json()).leads_per_day, 10);
});

test('the 0006 migration keeps existing VC feedback and streak days, under "unclaimed"', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { readdirSync, readFileSync } = await import('node:fs');
  const dir = new URL('../migrations/', import.meta.url);
  const files = readdirSync(dir).filter(name => name.endsWith('.sql')).sort();
  const sqlite = new DatabaseSync(':memory:');
  for (const file of files.filter(name => name < '0006')) sqlite.exec(readFileSync(new URL(file, dir), 'utf8'));
  sqlite.exec(`INSERT INTO investors (uuid, name, currency, raw_json, fetched_at) VALUES ('i1', 'VC One', 'GBP', '{}', 'now');
    INSERT INTO vc_leads (investor_uuid, first_shown, sent_at, notes, contact_email) VALUES ('i1', '2026-11-05', '2026-11-05T10:00:00Z', 'Call Tue', 'p@vc.example');
    INSERT INTO streak_days (day) VALUES ('2026-11-05');
    INSERT INTO profile (id, who, offer, looking_for, leads_per_day, updated_at) VALUES (1, 'Me', '', '', 5, 'now');`);
  for (const file of files.filter(name => name >= '0006')) sqlite.exec(readFileSync(new URL(file, dir), 'utf8'));
  assert.deepEqual({ ...sqlite.prepare('SELECT user_id, investor_uuid, notes, contact_email FROM vc_leads').get() },
    { user_id: 'unclaimed', investor_uuid: 'i1', notes: 'Call Tue', contact_email: 'p@vc.example' });
  assert.deepEqual({ ...sqlite.prepare('SELECT user_id, day FROM streak_days').get() }, { user_id: 'unclaimed', day: '2026-11-05' });
  assert.equal(sqlite.prepare("SELECT leads_per_day FROM profiles WHERE user_id = 'unclaimed'").get().leads_per_day, 5);
  sqlite.exec("INSERT INTO vc_leads (user_id, investor_uuid, first_shown) VALUES ('user_new', 'i1', '2026-11-06')");
});
