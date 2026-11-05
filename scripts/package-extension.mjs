// Build the Chrome Web Store ZIP into dist/ from an explicit runtime allowlist.
//
//   npm run extension:package          store build: live API only, ready to upload
//   npm run extension:package -- --dev same files, but keeps localhost for local testing
//
// The store build rewrites the development defaults so the person installing it gets a
// working dashboard with no setup: localhost is removed from host_permissions, the
// dashboard's DEFAULT_API points at the live Worker (set SYNERGY_API_URL to override it),
// sign-in uses the production WorkOS client instead of staging, and the manifest's `key`
// (which pins the unpacked extension's ID for the sign-in redirect) is dropped, because
// the Chrome Web Store assigns the store item its own ID.
// Update the allowlist whenever the extension gains files; anything unlisted stops the build.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RUNTIME_FILES = [
  'manifest.json', 'background.js', 'dashboard.html', 'dashboard.css', 'dashboard.js', 'auth.js',
  'icons/icon-16.png', 'icons/icon-32.png', 'icons/icon-48.png', 'icons/icon-128.png',
  'fonts/bodoni-moda-latin-opsz-normal.woff2', 'fonts/bodoni-moda-latin-opsz-italic.woff2',
  'fonts/courier-prime-latin-400-normal.woff2', 'fonts/courier-prime-latin-700-normal.woff2',
];
export const LIVE_API = 'https://synergy-api.40for40.workers.dev';
// The same WorkOS environments as Joyo and the Naughty List: staging for local builds, production for the store.
export const WORKOS_CLIENTS = { staging: 'client_01M6E5ZDCH31RFHPJTD8N5JQZY', production: 'client_01M6E5ZDQ9XBYYE28XYN7H3XTJ' };
const DEV_CLIENT_LINE = /^const CLIENT_ID = 'client_01M6E5ZDCH31RFHPJTD8N5JQZY';$/m;
const DEV_API_LINE = /^const DEFAULT_API = 'http:\/\/localhost:8787';$/m;
const VERSION = /^(0|[1-9][0-9]{0,4})(\.(0|[1-9][0-9]{0,4})){0,3}$/;

export function storeManifest(manifest) {
  const out = structuredClone(manifest);
  out.host_permissions = (out.host_permissions ?? []).filter(origin => !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(origin));
  delete out.key;
  return out;
}

export function storeAuth(source) {
  if (!DEV_CLIENT_LINE.test(source)) {
    throw new Error(`auth.js no longer has \`const CLIENT_ID = '${WORKOS_CLIENTS.staging}';\`. Update the store rewrite in scripts/package-extension.mjs.`);
  }
  return source.replace(DEV_CLIENT_LINE, `const CLIENT_ID = '${WORKOS_CLIENTS.production}';`);
}

export function storeDashboard(source, api = LIVE_API) {
  if (!DEV_API_LINE.test(source)) {
    throw new Error("dashboard.js no longer has `const DEFAULT_API = 'http://localhost:8787';`. Update the store rewrite in scripts/package-extension.mjs.");
  }
  if (!/^https:\/\/[^/\s']+$/.test(api)) throw new Error(`SYNERGY_API_URL must be an https origin with no path: ${api}`);
  return source.replace(DEV_API_LINE, `const DEFAULT_API = '${api}';`);
}

export function checkManifest(manifest) {
  const problems = [];
  if (manifest.manifest_version !== 3) problems.push('manifest_version must be 3');
  if (!VERSION.test(manifest.version ?? '') || manifest.version.split('.').every(part => Number(part) === 0)) problems.push('version must be a nonzero Chrome version such as 0.1.0');
  if (!manifest.name || manifest.name.length > 75) problems.push('name is required and at most 75 characters');
  if (!manifest.description || manifest.description.length > 132) problems.push('description is required and at most 132 characters (Chrome Web Store limit)');
  for (const size of ['16', '32', '48', '128']) {
    if (manifest.icons?.[size] !== `icons/icon-${size}.png`) problems.push(`icons.${size} must be icons/icon-${size}.png`);
  }
  const panel = manifest.side_panel?.default_path;
  if (panel && !RUNTIME_FILES.includes(panel)) problems.push(`side_panel.default_path ${panel} is not in the package allowlist`);
  if (panel && !manifest.permissions?.includes('sidePanel')) problems.push('side_panel needs the sidePanel permission');
  return problems;
}

export function buildPackage({ root, dev = false, api = process.env.SYNERGY_API_URL || LIVE_API, outDir = join(root, 'dist') }) {
  const source = join(root, 'extension');

  // Nothing unreviewed, and no symlinks, may reach the ZIP.
  const found = [];
  (function walk(dir, prefix) {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name), rel = prefix ? `${prefix}/${name}` : name;
      if (lstatSync(path).isSymbolicLink()) throw new Error(`Runtime files must not be symbolic links: ${rel}`);
      lstatSync(path).isDirectory() ? walk(path, rel) : found.push(rel);
    }
  })(source, '');
  const unexpected = found.filter(rel => !RUNTIME_FILES.includes(rel) && rel !== '.DS_Store' && !rel.endsWith('/.DS_Store'));
  if (unexpected.length) throw new Error(`Review the runtime allowlist before packaging: ${unexpected.join(', ')}`);
  const missing = RUNTIME_FILES.filter(rel => !existsSync(join(source, rel)));
  if (missing.length) throw new Error(`Missing runtime files: ${missing.join(', ')}`);

  let manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'));
  const problems = checkManifest(manifest);
  if (problems.length) throw new Error(`Fix the manifest before packaging:\n- ${problems.join('\n- ')}`);
  let dashboard = readFileSync(join(source, 'dashboard.js'), 'utf8');
  let auth = readFileSync(join(source, 'auth.js'), 'utf8');
  if (!dev) {
    manifest = storeManifest(manifest);
    dashboard = storeDashboard(dashboard, api);
    auth = storeAuth(auth);
    if (!manifest.host_permissions.some(origin => origin.startsWith(api))) {
      throw new Error(`host_permissions has no entry for ${api}. Add "${api}/*" to extension/manifest.json.`);
    }
  }

  const staging = mkdtempSync(join(tmpdir(), 'synergy-extension-'));
  try {
    for (const rel of RUNTIME_FILES) {
      mkdirSync(dirname(join(staging, rel)), { recursive: true });
      cpSync(join(source, rel), join(staging, rel));
    }
    writeFileSync(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(join(staging, 'dashboard.js'), dashboard);
    writeFileSync(join(staging, 'auth.js'), auth);
    if (existsSync(join(root, 'LICENSE'))) cpSync(join(root, 'LICENSE'), join(staging, 'LICENSE'));
    const entries = [...RUNTIME_FILES, ...(existsSync(join(staging, 'LICENSE')) ? ['LICENSE'] : [])];
    mkdirSync(outDir, { recursive: true });
    const zip = join(outDir, `synergy-chrome-${manifest.version}${dev ? '-dev' : ''}.zip`);
    rmSync(zip, { force: true });
    execFileSync('zip', ['-X', '-q', zip, ...entries], { cwd: staging });
    return { zip, manifest };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const dev = process.argv.includes('--dev');
  const { zip, manifest } = buildPackage({ root, dev });
  console.log(zip);
  console.log(dev
    ? 'Development build: keeps localhost. Do not upload this one.'
    : `Store build ${manifest.version}: API ${process.env.SYNERGY_API_URL || LIVE_API}. Run through publishing/README.md before uploading.`);
}
