import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';

function loadFixture() {
  const sqlite = new DatabaseSync(':memory:');
  const dir = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(dir).filter(name => name.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(file, dir), 'utf8'));
  sqlite.exec(readFileSync(new URL('./fixtures/ui-vcs.sql', import.meta.url), 'utf8'));
  return sqlite;
}

// The UI fixture: 10 VC leads from the UK and Spain, each with partners and
// matching companies based in the UK or Spain. Regenerate it with
// scripts/export-ui-fixture.mjs when a migration adds a column.
test('the UI fixture has 10 UK and Spanish VCs, each with partners and matches', () => {
  const sqlite = loadFixture();
  const vcs = sqlite.prepare(`SELECT i.name, i.hq_country,
    (SELECT COUNT(*) FROM investor_partners p WHERE p.investor_uuid = i.uuid) partners,
    (SELECT COUNT(*) FROM portfolio_matches m WHERE m.investor_uuid = i.uuid) matches FROM investors i`).all();
  assert.equal(vcs.length, 10);
  assert.deepEqual([...new Set(vcs.map(vc => vc.hq_country))].sort(), ['Spain', 'United Kingdom']);
  for (const vc of vcs) assert.ok(vc.partners > 0 && vc.matches > 0, vc.name);
  const countries = sqlite.prepare('SELECT DISTINCT hq_country FROM companies').all().map(row => row.hq_country).sort();
  assert.deepEqual(countries, ['Spain', 'United Kingdom']);
});

test('every company field is filled for at least one fixture company, so the UI shows them all', () => {
  const sqlite = loadFixture();
  const columns = sqlite.prepare('PRAGMA table_info(companies)').all().map(column => column.name);
  const never = columns.filter(column => !sqlite.prepare(`SELECT 1 FROM companies WHERE ${column} IS NOT NULL AND ${column} != '' LIMIT 1`).get());
  assert.deepEqual(never, []);
});
