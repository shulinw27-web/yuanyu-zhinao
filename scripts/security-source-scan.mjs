import { readdir, readFile } from 'node:fs/promises';
import { extname, relative, resolve } from 'node:path';

const workspaceRoot = resolve(import.meta.dirname, '..');
const ignoredDirectories = new Set(['.git', '.runtime', '.venv-semantica', '.venv-semantic-test', 'node_modules', 'output', 'tmp', 'dist']);
const sourceExtensions = new Set(['.cjs', '.js', '.json', '.md', '.mjs', '.py', '.ts', '.vue', '.yaml', '.yml']);
const findings = [];
const rules = [
  { id: 'private-key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { id: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/ },
  { id: 'openai-style-key', pattern: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { id: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ }
];

const visit = async (directory) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) { await visit(path); continue; }
    if (entry.name === '.env' || entry.name.endsWith('.pem') || entry.name.endsWith('.key')) findings.push({ rule: 'sensitive-file', path: relative(workspaceRoot, path) });
    if (!sourceExtensions.has(extname(entry.name).toLowerCase())) continue;
    const source = await readFile(path, 'utf8');
    for (const rule of rules) if (rule.pattern.test(source)) findings.push({ rule: rule.id, path: relative(workspaceRoot, path) });
  }
};

await visit(workspaceRoot);
if (findings.length) {
  console.error(JSON.stringify({ status: 'failed', findings }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ status: 'passed', rules: rules.map((item) => item.id), policy: 'No committed private keys, sensitive env files, or recognized provider tokens.' }));
}
