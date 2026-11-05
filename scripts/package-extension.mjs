// Build a runtime-only Chrome ZIP into dist/ from an explicit allowlist.
// Update the list whenever the extension gains files.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'extension');
const runtimeFiles = ['manifest.json', 'background.js', 'dashboard.html', 'dashboard.css', 'dashboard.js'];
const unexpected = readdirSync(source).filter(name => !runtimeFiles.includes(name));
if (unexpected.length) throw new Error(`Review the runtime allowlist before packaging: ${unexpected.join(', ')}`);
const { version } = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'));
mkdirSync(join(root, 'dist'), { recursive: true });
const zip = join(root, 'dist', `synergy-chrome-${version}.zip`);
rmSync(zip, { force: true });
execFileSync('zip', ['-X', '-q', zip, ...runtimeFiles], { cwd: source });
console.log(zip);
