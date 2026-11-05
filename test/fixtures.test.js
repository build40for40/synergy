import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_CRITERIA } from '../worker/criteria.js';
import { listVcLeads } from '../worker/vcs.js';
import { database } from './helpers.js';

// The UI fixture: Dealroom facts for UK and Spanish VCs and their UK and
// Spanish portfolio companies. Regenerate it with scripts/export-ui-fixture.mjs.
async function loadFixture() {
  const db = database();
  const sql = readFileSync(new URL('./fixtures/ui-vcs.sql', import.meta.url), 'utf8');
  db.raw.exec(sql);
  return db;
}

test('under the default criteria the fixture gives 10 UK and Spanish VC leads, each with partners', async () => {
  const db = await loadFixture();
  const vcs = await listVcLeads(db, DEFAULT_CRITERIA, new Date('2026-11-05T12:00:00Z'));
  assert.equal(vcs.length, 10);
  assert.deepEqual([...new Set(vcs.map(vc => vc.hq_country))].sort(), ['Spain', 'United Kingdom']);
  for (const vc of vcs) assert.ok(vc.partners.length > 0 && vc.companies.length > 0, vc.name);
  const countries = new Set(vcs.flatMap(vc => vc.companies.map(company => company.hq_country)));
  assert.deepEqual([...countries].sort(), ['Spain', 'United Kingdom']);
});

test('every company field is filled for at least one fixture company, so the UI shows them all', async () => {
  const db = await loadFixture();
  const columns = db.raw.prepare('PRAGMA table_info(companies)').all().map(column => column.name).filter(name => name !== 'raw_json');
  const never = columns.filter(column => !db.raw.prepare(`SELECT 1 FROM companies WHERE ${column} IS NOT NULL AND ${column} != '' LIMIT 1`).get());
  assert.deepEqual(never, []);
});
