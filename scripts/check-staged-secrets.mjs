// Read the Git index, never log blob contents or credential values. No network.
import { execFileSync } from 'node:child_process';
import { loadArkFileConfig } from './ark-file-config.mjs';
const git = args => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 12 * 1024 * 1024, windowsHide: true });
const names = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']).split('\0').filter(Boolean);
const privateConfig = {}; loadArkFileConfig(privateConfig);
const secrets = [privateConfig.ARK_API_KEY, ...['ARK_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'COMPATIBLE_LLM_API_KEY'].map(k => process.env[k])].filter(s => s && s.length >= 20);
const patterns = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ['provider-key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b/],
  ['aws-key', /\bAKIA[0-9A-Z]{16}\b/]
];
const findings = [];
for (const path of names) {
  if (/(?:^|\/)(?:private|secrets|\.runtime|output|node_modules)\/|(?:^|\/)(?:ark\.json|\.env(?:\..*)?)$|\.(?:pem|key|p12|pfx|sqlite3?|db|gguf|safetensors)$/i.test(path) && !path.endsWith('.env.example')) findings.push({ path, rule: 'sensitive-path' });
  const size = Number(git(['cat-file', '-s', `:${path}`]).trim());
  if (size > 10 * 1024 * 1024) { findings.push({ path, rule: 'oversized-blob-needs-review' }); continue; }
  const source = git(['show', `:${path}`]);
  if (secrets.some(secret => source.includes(secret))) findings.push({ path, rule: 'configured-secret' });
  for (const [rule, pattern] of patterns) if (pattern.test(source)) findings.push({ path, rule });
}
console.log(JSON.stringify({ status: findings.length ? 'failed' : 'passed', stagedFiles: names.length, configuredSecretCheckAvailable: secrets.length > 0, findings }));
if (findings.length) process.exitCode = 1;
