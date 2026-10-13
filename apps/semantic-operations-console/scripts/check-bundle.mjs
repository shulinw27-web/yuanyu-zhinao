import { readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

// Check the actual Vite entry, not a filename guess or the vendor chunk. This
// measures build size only; it is not browser latency or a production SLA.
export function checkSemanticOpsBundle({ distRoot = resolve(import.meta.dirname, '../dist'), read = readFileSync, stat = statSync } = {}) {
  const root = resolve(distRoot); const manifest = JSON.parse(read(resolve(root, '.vite/manifest.json'), 'utf8'));
  const entry = manifest['index.html'];
  if (entry?.isEntry !== true || typeof entry.file !== 'string' || !/^assets\/[A-Za-z0-9_-]+\.js$/u.test(entry.file)) throw new Error('SEMANTIC_ENTRY_MANIFEST_INVALID');
  const target = resolve(root, entry.file);
  if (!target.startsWith(`${root}${sep}`)) throw new Error('SEMANTIC_ENTRY_PATH_INVALID');
  const bytes = stat(target).size;
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > 500_000) throw new Error('SEMANTIC_ENTRY_SIZE_LIMIT');
  return { status: 'passed', entry: entry.file, bytes, limitBytes: 500_000 };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(checkSemanticOpsBundle())); }
  catch (failure) { console.error(failure.message); process.exitCode = 1; }
}
