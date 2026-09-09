import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const directory = resolve(import.meta.dirname, '../migrations/postgres');
const files = (await readdir(directory)).filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/u.test(name)).sort();
const versions = files.map((name) => Number.parseInt(name.slice(0, 3), 10));
if (!files.length || versions.some((version, index) => version !== index + 1)) throw new Error('PostgreSQL migration versions must be contiguous and start at 001.');
const manifest = [];
for (const [index, file] of files.entries()) {
  const sql = await readFile(resolve(directory, file), 'utf8');
  if (/\b(?:TRUNCATE|DROP\s+DATABASE|DROP\s+SCHEMA)\b/i.test(sql)) throw new Error(`Forward migration ${file} contains a prohibited destructive statement.`);
  if (!new RegExp(`platform_schema_migrations\\(version, name\\)[\\s\\S]*VALUES \\(${versions[index]},`, 'i').test(sql)) throw new Error(`Migration ${file} does not record its exact version.`);
  manifest.push({ version: versions[index], file, checksumSha256: createHash('sha256').update(sql).digest('hex') });
}
await readFile(resolve(directory, 'rollback', files.at(-1)), 'utf8');
process.stdout.write(`${JSON.stringify({ status: 'verified', latestVersion: versions.at(-1), migrations: manifest })}\n`);
