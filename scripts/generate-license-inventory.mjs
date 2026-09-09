import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const workspaceRoot = resolve(import.meta.dirname, '..');
const lock = JSON.parse(await readFile(resolve(workspaceRoot, 'package-lock.json'), 'utf8'));
const inventory = [];
for (const [path, value] of Object.entries(lock.packages || {})) {
  if (!path.startsWith('node_modules/') || !value?.version) continue;
  let metadata;
  try { metadata = JSON.parse(await readFile(resolve(workspaceRoot, path, 'package.json'), 'utf8')); } catch { metadata = {}; }
  const license = value.license || metadata.license || (Array.isArray(metadata.licenses) ? metadata.licenses.map((item) => item.type || item).join(' OR ') : null) || 'UNKNOWN';
  inventory.push({
    name: metadata.name || path.replace(/^node_modules\//, '').replace(/\/node_modules\//g, ' > '),
    version: value.version,
    license,
    developmentOnly: Boolean(value.dev)
  });
}
inventory.sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));

await mkdir(resolve(workspaceRoot, 'output'), { recursive: true });
await writeFile(resolve(workspaceRoot, 'output', 'third-party-licenses.json'), `${JSON.stringify({ generatedAt: new Date().toISOString(), inventory }, null, 2)}\n`);
const unknown = inventory.filter((item) => item.license === 'UNKNOWN');
const prohibited = inventory.filter((item) => /\b(?:AGPL|SSPL)(?:-|\b)/i.test(item.license));
console.log(JSON.stringify({ packages: inventory.length, unknownLicenses: unknown.length, prohibitedLicenses: prohibited.length, output: 'output/third-party-licenses.json' }));
if (prohibited.length) process.exitCode = 1;
