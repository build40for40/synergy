import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../worker/index.js';
import { upsertCompanies } from '../worker/store.js';
import { company, database, issuer, keys, signToken } from './helpers.js';

// Signed in as user_test unless a test says otherwise (tokens from test/helpers.js stand in for WorkOS).
const call = async (env, path, init = {}, user = 'user_test') => handle(
  new Request(`http://api${path}`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${await signToken(user)}` } }),
  env, { keys, issuer });
const patch = (env, id, body) => call(env, `/leads/${id}`, { method: 'PATCH', body: JSON.stringify(body) });

async function setup() {
  const env = { DB: database() };
  await upsertCompanies(env.DB, Array.from({ length: 12 }, (_, i) => company(i + 1)));
  const { leads } = await (await call(env, '/leads/today')).json();
  return { env, ids: leads.map(lead => lead.id) };
}

test('new leads start as new, with no feedback', async () => {
  const { env } = await setup();
  const { leads } = await (await call(env, '/leads/today')).json();
  assert.ok(leads.every(lead => lead.status === 'new' && lead.sent_at === null && lead.outcome === null && lead.dismissed_at === null));
});

test('sent, then what happened next, with dates', async () => {
  const { env, ids } = await setup();
  const sent = await (await patch(env, ids[0], { sent: true })).json();
  assert.equal(sent.status, 'sent');
  assert.ok(sent.sent_at);

  const call1 = await (await patch(env, ids[0], { outcome: 'call' })).json();
  assert.equal(call1.status, 'call');
  assert.ok(call1.outcome_at);
  assert.equal(call1.sent_at, sent.sent_at, 'sending again keeps the first date');

  const rejected = await (await patch(env, ids[0], { outcome: 'rejected' })).json();
  assert.equal(rejected.status, 'rejected');
  const waiting = await (await patch(env, ids[0], { outcome: null })).json();
  assert.equal(waiting.status, 'sent');
  assert.equal(waiting.outcome_at, null);
});

test('an outcome needs the lead to be sent first', async () => {
  const { env, ids } = await setup();
  const response = await patch(env, ids[0], { outcome: 'call' });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'not_sent');
  assert.equal((await patch(env, ids[0], { sent: true, outcome: 'call' })).status, 200, 'both in one request is fine');
});

test('rejects an unknown outcome', async () => {
  const { env, ids } = await setup();
  const response = await patch(env, ids[0], { sent: true, outcome: 'maybe' });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'invalid_outcome');
});

test('not for me, with an optional reason, replaces sent and can be undone', async () => {
  const { env, ids } = await setup();
  await patch(env, ids[1], { sent: true });
  const dismissed = await (await patch(env, ids[1], { not_for_me: true, reason: '  Portfolio too young ' })).json();
  assert.equal(dismissed.status, 'not_for_me');
  assert.equal(dismissed.dismiss_reason, 'Portfolio too young');
  assert.equal(dismissed.sent_at, null);

  const undone = await (await patch(env, ids[1], { not_for_me: false })).json();
  assert.equal(undone.status, 'new');
  assert.equal(undone.dismiss_reason, null);
});

test('undoing sent clears what happened next', async () => {
  const { env, ids } = await setup();
  await patch(env, ids[2], { sent: true, outcome: 'no_reply' });
  const undone = await (await patch(env, ids[2], { sent: false })).json();
  assert.equal(undone.status, 'new');
  assert.equal(undone.outcome, null);
});

test('notes save with the time they were edited', async () => {
  const { env, ids } = await setup();
  const lead = await (await patch(env, ids[3], { notes: 'Met Helen at the BVCA dinner. Call Tue 10am.' })).json();
  assert.equal(lead.notes, 'Met Helen at the BVCA dinner. Call Tue 10am.');
  assert.ok(lead.notes_at);
});

test("the extension's yes/no still works, and yes counts as sent", async () => {
  const { env, ids } = await setup();
  const yes = await (await patch(env, ids[4], { reached_out: true })).json();
  assert.equal(yes.reached_out, true);
  assert.equal(yes.status, 'sent');
  const no = await (await patch(env, ids[4], { reached_out: false })).json();
  assert.equal(no.reached_out, false);
  assert.equal(no.status, 'new');
});

test('history lists every lead by outcome, newest first, with counts', async () => {
  const { env, ids } = await setup();
  await patch(env, ids[0], { sent: true, outcome: 'call' });
  await patch(env, ids[1], { sent: true });
  await patch(env, ids[2], { sent: true, outcome: 'rejected' });
  await patch(env, ids[3], { sent: true, outcome: 'no_reply' });
  await patch(env, ids[4], { not_for_me: true, reason: 'Wrong sector' });

  const all = await (await call(env, '/leads')).json();
  assert.equal(all.leads.length, 10);
  assert.deepEqual(all.leads.map(lead => lead.id), [...ids].sort((a, b) => b - a));
  assert.deepEqual(all.counts, { all: 10, new: 5, waiting: 1, call: 1, closed: 2, not_for_me: 1 });

  const closed = await (await call(env, '/leads?status=closed')).json();
  assert.deepEqual(closed.leads.map(lead => lead.status).sort(), ['no_reply', 'rejected']);
  const nope = await (await call(env, '/leads?status=not_for_me')).json();
  assert.equal(nope.leads[0].dismiss_reason, 'Wrong sector');
});

test('history pages with limit and before', async () => {
  const { env } = await setup();
  const first = await (await call(env, '/leads?limit=4')).json();
  assert.equal(first.leads.length, 4);
  assert.ok(first.next_before);
  const second = await (await call(env, `/leads?limit=4&before=${first.next_before}`)).json();
  assert.ok(second.leads.every(lead => lead.id < first.next_before));
  const last = await (await call(env, `/leads?limit=4&before=${second.next_before}`)).json();
  assert.equal(last.leads.length, 2);
  assert.equal(last.next_before, null);
});

test('history rejects unknown filters', async () => {
  const { env } = await setup();
  assert.equal((await call(env, '/leads?status=maybe')).status, 400);
  assert.equal((await call(env, '/leads?limit=ten')).status, 400);
});

test('earlier yes answers carry over as sent when the migration runs', async () => {
  // The migration's backfill: reached_out = 1 becomes sent_at = feedback_at.
  const { env, ids } = await setup();
  await env.DB.prepare('UPDATE leads SET reached_out = 1, feedback_at = ?, sent_at = NULL WHERE id = ?').bind('2026-11-05T09:00:00Z', ids[5]).run();
  await env.DB.prepare('UPDATE leads SET sent_at = feedback_at WHERE reached_out = 1 AND sent_at IS NULL').run();
  const { leads } = await (await call(env, '/leads?status=waiting')).json();
  assert.equal(leads[0].sent_at, '2026-11-05T09:00:00Z');
});
