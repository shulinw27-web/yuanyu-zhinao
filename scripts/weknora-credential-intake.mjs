// Explicitly launched, single-use loopback form. Never logs or returns submitted credentials.
// This does not create upstream keys or grant access: the operator supplies an approved binding.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { writeFile, lstat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function startCredentialIntake({ save, binding, lifetimeMs = 300000, listen = server => new Promise((resolve, reject) => {
  server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
}) }) {
  const nonce = randomBytes(32).toString('hex');
  let used = false; let origin;
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    // Preserve same-origin form Origin; no-referrer makes Chromium submit Origin: null.
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    const reply = (status, text) => { res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(text); };
    // Test listener readiness can probe before the origin is initialized. No form,
    // nonce or credential processing is available at this stage.
    if (!origin) return reply(503, 'Not ready');
    if (req.headers.host !== new URL(origin).host || req.url !== `/${nonce}` || used) return reply(403, 'Unavailable');
    if (req.method === 'GET') return reply(200, '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>WeKnora 私有配置保存</title><h1>保存专用只读密钥</h1><p>仅写入仓库外的 weknora.local.json，不显示密钥，不覆盖已有文件。</p><form method="post" autocomplete="off"><label>专用 WeKnora Key <input name="key" type="password" autocomplete="off" required maxlength="4096"></label><button type="submit">确认保存到本机私有配置</button></form></html>');
    if (req.method !== 'POST' || req.headers.origin !== origin
      || req.headers['content-type'] !== 'application/x-www-form-urlencoded') return reply(403, 'Rejected');
    try {
      let size = 0; const parts = [];
      for await (const part of req) {
        size += part.length;
        if (size > 16384) { reply(413, 'Too large'); req.destroy(); return; }
        parts.push(part);
      }
      const form = new URLSearchParams(Buffer.concat(parts).toString('utf8'));
      const key = form.get('key');
      if ([...form.keys()].length !== 1 || !key || key.length < 8 || key.length > 4096 || /\s/.test(key)) return reply(400, 'Invalid key');
      if (used) return reply(409, 'Already submitted');
      used = true;
      await save({ schemaVersion: 1, enabled: true, baseUrl: 'http://127.0.0.1:18081', apiKey: key,
        timeoutMs: 5000, retrievalMode: 'keyword_only', bindings: [binding] });
      reply(200, '<h1>已保存私有配置</h1><p>密钥未显示；默认仅关键词检索。可以关闭此页。</p>');
      res.on('finish', () => { clearTimeout(timer); server.close(); });
    } catch { used = true; reply(500, 'Save failed; no credential details returned'); clearTimeout(timer); server.close(); }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  await listen(server);
  origin = `http://127.0.0.1:${server.address().port}`;
  const timer = setTimeout(() => { server.closeAllConnections(); server.close(); }, lifetimeMs);
  return { url: `${origin}/${nonce}`, close: () => { clearTimeout(timer); server.closeAllConnections(); server.close(); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let stage = 'acl';
  try {
    if (process.platform !== 'win32') throw new Error('Windows private ACL required');
    const directory = 'D:\\wsl\\private\\yuanyu-zhinao';
    const target = `${directory}\\weknora.local.json`;
    const aclScript = "$ErrorActionPreference='Stop'; $wkPath='D:\\wsl\\private\\yuanyu-zhinao'; if ((Get-Item -LiteralPath $wkPath).Attributes -band [IO.FileAttributes]::ReparsePoint) {throw 'Invalid directory'}; $wkAcl=Get-Acl -LiteralPath $wkPath; $wkSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; if (-not $wkAcl.AreAccessRulesProtected -or $wkAcl.Access.Count -eq 0) {throw 'Invalid ACL'}; foreach ($wkRule in $wkAcl.Access) {if ($wkRule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $wkSid) {throw 'Invalid ACL'}}";
    // PowerShell 7's inherited module path can break Windows PowerShell 5's Get-Acl.
    const shellEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PSMODULEPATH'));
    execFileSync('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(aclScript, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'ignore', env: shellEnv });
    stage = 'target';
    const existing = await lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (existing) throw new Error('Existing configuration');
    stage = 'binding';
    const binding = JSON.parse(process.env.WEKNORA_SETUP_BINDING || 'null');
    if (!binding || !/^[a-f0-9]{64}$/.test(binding.principalKey) || !Number.isSafeInteger(binding.tenantId) || binding.tenantId < 1
      || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(binding.knowledgeBaseId) || !Array.isArray(binding.knowledgeIds)
      || binding.knowledgeIds.length < 1 || binding.knowledgeIds.length > 32
      || !binding.knowledgeIds.every(id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(id))
      || Object.keys(binding).some(key => !['principalKey', 'tenantId', 'knowledgeBaseId', 'knowledgeIds'].includes(key))) throw new Error('Invalid binding');
    stage = 'listen';
    const intake = await startCredentialIntake({ binding, save: config => writeFile(target, JSON.stringify(config, null, 2), { flag: 'wx', mode: 0o600 }) });
    console.log(`One-use local save form (expires in 5 minutes): ${intake.url}`);
  } catch (error) { console.error(`Private configuration setup rejected at ${stage}; status=${Number.isInteger(error.status) ? error.status : 'n/a'}; code=${['ENOENT', 'EACCES', 'EPERM', 'EINVAL'].includes(error.code) ? error.code : 'rejected'}; no key displayed.`); process.exitCode = 1; }
}
