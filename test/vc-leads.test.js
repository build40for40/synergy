import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../worker/index.js';
import { DEFAULT_CRITERIA } from '../worker/criteria.js';
import { streakFrom, updateVcLead, vcLeadHistory, vcLeadsToday } from '../worker/vc-leads.js';
import { database } from './helpers.js';

// Runs against the VC UI fixture: 10 real UK and Spanish VCs, their partners
// and matching portfolio companies.
const NOW = new Date('2026-11-05T12:00:00Z');
function fixture() {
  const db = database();
  db.raw.exec(readFileSync(new URL('./fixtures/ui-vcs.sql', import.meta.url), 'utf8'));
  return db;
}
const today = (db, date, perDay = 10) => vcLeadsToday(db, DEFAULT_CRITERIA, { perDay, date, now: NOW });

test('the first day shows 10 VCs, each with a tier, partners and matching companies', async () => {
  const db = fixture();
  const day = await today(db, '2026-11-05');
  assert.equal(day.leads.length, 10);
  for (const lead of day.leads) {
    assert.equal(lead.status, 'new');
    assert.ok([1, 2, 3].includes(lead.tier));
    assert.ok(lead.partners.length > 0 && lead.companies.length > 0, lead.name);
    assert.equal(lead.first_shown, '2026-11-05');
    assert.equal(lead.carried_from, null);
  }
  assert.deepEqual(day.in_play, []);
  assert.deepEqual(day.streak, { current: 0, best: 0, today_done: false });
});

test('5 a day shows 5, and the same day gives the same list', async () => {
  const db = fixture();
  const first = await today(db, '2026-11-05', 5);
  const again = await today(db, '2026-11-05', 5);
  assert.equal(first.leads.length, 5);
  assert.deepEqual(again.leads.map(lead => lead.uuid), first.leads.map(lead => lead.uuid));
});

test('unsent leads roll over to the next day, oldest first; sent ones move to In play', async () => {
  const db = fixture();
  const thu = await today(db, '2026-11-05', 5);
  for (const lead of thu.leads.slice(0, 3)) await updateVcLead(db, lead.uuid, { sent: true }, '2026-11-05T10:00:00Z');
  const fri = await today(db, '2026-11-06', 5);
  assert.deepEqual(fri.leads.slice(0, 2).map(lead => lead.uuid), thu.leads.slice(3).map(lead => lead.uuid));
  assert.ok(fri.leads.slice(0, 2).every(lead => lead.carried_from === '2026-11-05'));
  assert.ok(fri.leads.slice(2).every(lead => lead.carried_from === null && lead.first_shown === '2026-11-06'));
  assert.equal(fri.in_play.length, 3);
  assert.ok(fri.in_play.every(lead => lead.status === 'sent'));
});

test('feedback: sent, outcome, not for me with a reason, notes and contact edits', async () => {
  const db = fixture();
  const [a, b] = (await today(db, '2026-11-05')).leads;
  assert.equal((await updateVcLead(db, a.uuid, { outcome: 'call' })).error.code, 'not_sent');
  const called = (await updateVcLead(db, a.uuid, { sent: true, outcome: 'call', notes: 'Met at BVCA' })).lead;
  assert.equal(called.status, 'call');
  assert.equal(called.notes, 'Met at BVCA');
  const nope = (await updateVcLead(db, b.uuid, { not_for_me: true, reason: 'Portfolio too young' })).lead;
  assert.equal(nope.status, 'not_for_me');
  assert.equal(nope.dismiss_reason, 'Portfolio too young');
  const contact = (await updateVcLead(db, b.uuid, { contact_name: ' Jane Partner ', contact_email: 'jane@example.com' })).lead;
  assert.equal(contact.contact_name, 'Jane Partner');
  assert.equal(contact.contact_email, 'jane@example.com');
  assert.equal((await updateVcLead(db, b.uuid, { contact_email: 'not an email' })).error.code, 'invalid_email');
  const reset = (await updateVcLead(db, b.uuid, { contact_name: null, contact_email: null })).lead;
  assert.equal(reset.contact_name, null);
  assert.equal((await updateVcLead(db, '00000000-0000-0000-0000-000000000000', { sent: true })).error.code, 'not_found');
});

test('finishing every lead on a working day adds a day to the streak', async () => {
  const db = fixture();
  const day = await today(db, '2026-11-05', 5);
  for (const [i, lead] of day.leads.entries()) await updateVcLead(db, lead.uuid, i % 2 ? { not_for_me: true } : { sent: true }, '2026-11-05T10:00:00Z');
  const after = await today(db, '2026-11-05', 5);
  assert.deepEqual(after.streak, { current: 1, best: 1, today_done: true });
});

test('streaks count working days and skip weekends', () => {
  assert.deepEqual(streakFrom(['2026-11-05', '2026-11-06', '2026-11-09'], '2026-11-10'), { current: 3, best: 3, today_done: false });
  assert.deepEqual(streakFrom(['2026-11-05', '2026-11-06', '2026-11-09'], '2026-11-11'), { current: 0, best: 3, today_done: false });
  assert.deepEqual(streakFrom(['2026-11-06'], '2026-11-07'), { current: 1, best: 1, today_done: false });
});

test('history filters by outcome with counts', async () => {
  const db = fixture();
  const leads = (await today(db, '2026-11-05')).leads;
  await updateVcLead(db, leads[0].uuid, { sent: true, outcome: 'call' });
  await updateVcLead(db, leads[1].uuid, { sent: true });
  await updateVcLead(db, leads[2].uuid, { sent: true, outcome: 'rejected' });
  await updateVcLead(db, leads[3].uuid, { not_for_me: true, reason: 'Wrong sector' });
  const all = await vcLeadHistory(db, DEFAULT_CRITERIA, { now: NOW });
  assert.deepEqual(all.counts, { all: 10, waiting: 1, call: 1, closed: 1, not_for_me: 1 });
  const closed = await vcLeadHistory(db, DEFAULT_CRITERIA, { status: 'closed', now: NOW });
  assert.deepEqual(closed.leads.map(lead => lead.status), ['rejected']);
});

test('the routes: /vcs/today, PATCH /vcs/:uuid, /vcs/history and leads a day', async () => {
  const env = { DB: fixture() };
  const call = (path, init) => worker.fetch(new Request(`http://api${path}`, init), env);
  await call('/profile', { method: 'PUT', body: JSON.stringify({ who: 'Broker', leads_per_day: 5 }) });
  assert.equal((await (await call('/profile')).json()).leads_per_day, 5);
  const day = await (await call('/vcs/today')).json();
  assert.equal(day.leads.length, day.pool_empty ? day.leads.length : 5);
  const uuid = day.leads[0].uuid;
  const patched = await call(`/vcs/${uuid}`, { method: 'PATCH', body: JSON.stringify({ sent: true }) });
  assert.equal(patched.status, 200);
  assert.equal((await patched.json()).status, 'sent');
  assert.equal((await call('/vcs/history?status=maybe')).status, 400);
  assert.equal((await call(`/vcs/${uuid}`, { method: 'PATCH', body: '[]' })).status, 400);
});
