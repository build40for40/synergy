import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';

// The UI fixture must fill every companies column. When a migration adds a
// column, this fails until the fixture is regenerated with it.
test('the UI fixture has 10 companies with every column filled', () => {
  const sqlite = new DatabaseSync(':memory:');
  const dir = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(dir).filter(name => name.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(file, dir), 'utf8'));
  sqlite.exec(readFileSync(new URL('./fixtures/ui-companies.sql', import.meta.url), 'utf8'));
  const rows = sqlite.prepare('SELECT * FROM companies').all();
  assert.equal(rows.length, 10);
  const empty = rows.flatMap(row => Object.entries(row).filter(([, value]) => value === null || value === '').map(([column]) => `${row.name}.${column}`));
  assert.deepEqual(empty, []);
});
