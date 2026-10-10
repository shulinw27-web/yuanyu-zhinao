import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { resolveRegistryLicense } from './license-registry.mjs';

const workspaceRoot = resolve(import.meta.dirname, '..');
const lock = JSON.parse(await readFile(resolve(workspaceRoot, 'package-lock.json'), 'utf8'));
const inventory = [];
const registryEnabled = process.argv.includes('--registry');
const requireKnown = process.argv.includes('--require-known');
if (process.argv.slice(2).some(argument => !['--registry', '--require-known'].includes(argument))) throw new Error('Unsupported license inventory option.');
for (const [path, value] of Object.entries(lock.packages || {})) {
  if (!path.startsWith('node_modules/') || !value?.version) continue;
  let metadata;
  try { metadata = JSON.parse(await readFile(resolve(workspaceRoot, path, 'package.json'), 'utf8')); } catch { metadata = {}; }
  const declared = value.license || metadata.license || (Array.isArray(metadata.licenses) ? metadata.licenses.map((item) => item.type || item).join(' OR ') : null);
  const license = typeof declared === 'string' && declared.trim() ? declared.trim() : 'UNKNOWN';
  inventory.push({
    name: metadata.name || value.name || path.split('node_modules/').at(-1),
    version: value.version,
    license,
    developmentOnly: Boolean(value.dev)
  });
}
inventory.sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
if (registryEnabled) {
  const queue = inventory.filter(item => item.license === 'UNKNOWN').slice(0, 100);
  let cursor = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (cursor < queue.length) {
      const item = queue[cursor++]; const resolved = await resolveRegistryLicense(item);
      if (resolved) { item.license = resolved.license; item.licenseSource = resolved.source; }
    }
  }));
}

await mkdir(resolve(workspaceRoot, 'output'), { recursive: true });
await writeFile(resolve(workspaceRoot, 'output', 'third-party-licenses.json'), `${JSON.stringify({ generatedAt: new Date().toISOString(), inventory }, null, 2)}\n`);
const unknown = inventory.filter((item) => item.license === 'UNKNOWN');
const prohibited = inventory.filter((item) => /\b(?:AGPL|SSPL)(?:-|\b)/i.test(item.license));
console.log(JSON.stringify({ packages: inventory.length, unknownLicenses: unknown.length, prohibitedLicenses: prohibited.length, output: 'output/third-party-licenses.json' }));
if (prohibited.length || requireKnown && unknown.length) process.exitCode = 1;
