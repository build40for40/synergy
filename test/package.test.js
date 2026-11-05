import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPackage, checkManifest, LIVE_API, RUNTIME_FILES, storeDashboard, storeManifest } from '../scripts/package-extension.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const list = zip => execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' });
const read = (zip, file) => execFileSync('unzip', ['-p', zip, file], { encoding: 'utf8' });

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'synergy-pkg-test-'));
  cpSync(join(root, 'extension'), join(dir, 'extension'), { recursive: true });
  return dir;
}

test('the real extension passes the manifest checks', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'extension/manifest.json'), 'utf8'));
  assert.deepEqual(checkManifest(manifest), []);
});

test('store build contains exactly the allowlist, points at the live API and drops localhost', () => {
  const dir = sandbox();
  try {
    const { zip } = buildPackage({ root: dir, outDir: join(dir, 'dist') });
    const listed = list(zip).trim().split('\n').sort();
    assert.deepEqual(listed, [...RUNTIME_FILES].sort());
    const manifest = JSON.parse(read(zip, 'manifest.json'));
    assert.ok(manifest.host_permissions.every(origin => !origin.includes('localhost')));
    assert.ok(manifest.host_permissions.includes(`${LIVE_API}/*`));
    const dashboard = read(zip, 'dashboard.js');
    assert.match(dashboard, new RegExp(`const DEFAULT_API = '${LIVE_API}';`));
    assert.doesNotMatch(dashboard, /localhost/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('dev build keeps localhost and is named so it is not uploaded by mistake', () => {
  const dir = sandbox();
  try {
    const { zip } = buildPackage({ root: dir, dev: true, outDir: join(dir, 'dist') });
    assert.match(zip, /-dev\.zip$/);
    assert.match(read(zip, 'dashboard.js'), /localhost:8787/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an unlisted file in extension/ stops the build', () => {
  const dir = sandbox();
  try {
    writeFileSync(join(dir, 'extension', 'notes.txt'), 'not for the store');
    assert.throws(() => buildPackage({ root: dir, outDir: join(dir, 'dist') }), /allowlist.*notes\.txt/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a changed DEFAULT_API line fails loudly instead of shipping localhost', () => {
  assert.throws(() => storeDashboard("const DEFAULT_API = 'http://localhost:9999';"), /DEFAULT_API/);
  assert.throws(() => storeDashboard("const DEFAULT_API = 'http://localhost:8787';", 'http://insecure.example'), /https/);
});

test('storeManifest only removes local origins', () => {
  const out = storeManifest({ host_permissions: ['http://localhost:8787/*', 'http://127.0.0.1:8787/*', `${LIVE_API}/*`] });
  assert.deepEqual(out.host_permissions, [`${LIVE_API}/*`]);
});

test('manifest checks catch store-blocking problems', () => {
  const problems = checkManifest({ manifest_version: 2, version: '0.0.0', name: 'S', description: 'x'.repeat(133), icons: {} });
  assert.equal(problems.length, 7);
});

test('the dashboard opens in the side panel, and the panel page ships in the ZIP', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'extension/manifest.json'), 'utf8'));
  assert.equal(manifest.side_panel.default_path, 'dashboard.html');
  assert.ok(manifest.permissions.includes('sidePanel'));
  assert.ok(RUNTIME_FILES.includes(manifest.side_panel.default_path));
  const broken = { ...manifest, side_panel: { default_path: 'panel.html' }, permissions: ['storage'] };
  assert.equal(checkManifest(broken).length, 2);
});
