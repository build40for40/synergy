import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { handle } from '../worker/index.js';
import { upsertCompanies } from '../worker/store.js';
import { company, database, issuer, keys, signToken } from './helpers.js';

const as = async (user, env, path, init = {}) => handle(
  new Request(`http://api${path}`, { ...init, headers: { ...init.headers, ...(user ? { Authorization: `Bearer ${await signToken(user)}` } : {}) } }),
  env, { keys, issuer });

async function stocked() {
  const env = { DB: database() };
  await upsertCompanies(env.DB, Array.from({ length: 25 }, (_, i) => company(i + 1)));
  return env;
}

test('every data route needs a signed-in user', async () => {
  const env = await stocked();
  for (const [path, method] of [['/profile', 'GET'], ['/profile', 'PUT'], ['/leads/today', 'GET'], ['/leads', 'GET'], ['/leads/1', 'PATCH']]) {
    const response = await as(null, env, path, { method, body: method === 'GET' ? undefined : '{}' });
    assert.equal(response.status, 401, `${method} ${path}`);
    assert.equal((await response.json()).error.code, 'sign_in_required');
  }
});

test('health and CORS preflight stay open, and the preflight allows the Authorization header', async () => {
  const env = await stocked();
  assert.equal((await as(null, env, '/health')).status, 200);
  const preflight = await as(null, env, '/leads/today', { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('Access-Control-Allow-Headers'), /Authorization/);
});

test('without WorkOS configured the API says so instead of serving data', async () => {
  const env = await stocked();
  const response = await worker.fetch(new Request('http://api/leads/today'), env);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'auth_unavailable');
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

test('data from before sign-in is kept but belongs to nobody who can sign in', async () => {
  const env = { DB: database() };
  const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM profiles WHERE user_id = 'unclaimed'").first();
  assert.equal(rows.n, 0, 'a fresh database has nothing to carry over');
  assert.equal(await (await import('../worker/auth.js')).authenticate(
    new Request('http://api/', { headers: { Authorization: `Bearer ${await signToken('unclaimed')}` } }), keys, issuer), null,
  "'unclaimed' can't be a signed-in user");
});

test('the 0005 migration moves an existing profile and leads to "unclaimed", keeping their feedback', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { readdirSync, readFileSync } = await import('node:fs');
  const dir = new URL('../migrations/', import.meta.url);
  const files = readdirSync(dir).filter(name => name.endsWith('.sql')).sort();
  const sqlite = new DatabaseSync(':memory:');
  for (const file of files.filter(name => name < '0005')) sqlite.exec(readFileSync(new URL(file, dir), 'utf8'));
  sqlite.exec(`INSERT INTO profile (id, who, offer, looking_for, updated_at) VALUES (1, 'Old broker', '', '', '2026-11-05T09:00:00Z');
    INSERT INTO companies (uuid, name, raw_json, fetched_at) VALUES ('c1', 'Co 1', '{}', 'now'), ('c2', 'Co 2', '{}', 'now');
    INSERT INTO leads (company_uuid, lead_date, sent_at, outcome, notes) VALUES ('c1', '2026-11-05', '2026-11-05T10:00:00Z', 'call', 'Met at dinner'), ('c2', '2026-11-05', NULL, NULL, '');`);
  for (const file of files.filter(name => name >= '0005')) sqlite.exec(readFileSync(new URL(file, dir), 'utf8'));
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
