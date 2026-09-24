#!/usr/bin/env node
// 架构基线生成器：扫描仓库当前状态，输出可粘贴进 backend/test/architecture-baseline.js 的基线数据。
//
// 用法：
//   node scripts/architecture-baseline.mjs            # 打印当前基线摘要
//   node scripts/architecture-baseline.mjs --edges    # 仅打印跨领域边清单
//
// 该脚本只读，不修改任何文件；刻意不自动写回基线文件，
// 以避免「为了让测试通过而放宽基线」的静默劣化。

import { readdir, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SERVICE_DOMAIN_PREFIXES = [
  'agent', 'anomaly', 'ark', 'assistant', 'audit', 'business', 'client', 'conversation', 'core', 'decision',
  'desktop', 'device', 'dingtalk', 'domain', 'enterprise', 'iam', 'identity', 'key', 'knowledge', 'local',
  'meta', 'mock', 'model', 'multimodal', 'permission', 'private', 'procurement', 'prompt', 'published',
  'read', 'request', 'risk', 'role', 'security', 'semantic', 'semantica', 'siem', 'system', 'temporal',
  'tenant', 'visual', 'weknora', 'workbuddy', 'world', 'zhinao'
];

const countDomainExports = (source) => {
  let count = 0;
  for (const match of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    count += match[1].split(',').map((name) => name.trim()).filter(Boolean).length;
  }
  for (const _ of source.matchAll(/export\s+(?:async\s+)?(?:const|let|function|class)\s+[A-Za-z0-9_$]+/g)) count += 1;
  return count;
};

async function collectDomainExports() {
  const domainsRoot = resolve(workspaceRoot, 'backend/src/domains');
  const entries = await readdir(domainsRoot, { withFileTypes: true });
  const result = {};
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const source = await readFile(resolve(domainsRoot, entry.name, 'public-api.js'), 'utf8');
      result[entry.name] = countDomainExports(source);
    } catch {
      // 无 public-api.js 的目录按基础设施处理，跳过。
    }
  }
  return result;
}

async function collectCrossDomainEdges() {
  const servicesRoot = resolve(workspaceRoot, 'backend/src/services');
  const serviceFiles = (await readdir(servicesRoot)).filter((name) => name.endsWith('.js'));
  const edges = new Set();
  for (const serviceFile of serviceFiles) {
    const source = await readFile(resolve(servicesRoot, serviceFile), 'utf8');
    const own = SERVICE_DOMAIN_PREFIXES.find((prefix) => serviceFile.startsWith(`${prefix}-`));
    if (!own) continue;
    for (const match of source.matchAll(/from ['"]\.\/([a-z0-9-]+)\.js['"]/g)) {
      const target = match[1];
      const targetDomain = SERVICE_DOMAIN_PREFIXES.find((prefix) => target.startsWith(`${prefix}-`));
      if (!targetDomain || targetDomain === own) continue;
      edges.add(`${serviceFile} -> ${target}.js`);
    }
  }
  return [...edges].sort();
}

const argument = process.argv[2];
if (argument === '--edges') {
  const edges = await collectCrossDomainEdges();
  console.log(edges.join('\n'));
  console.log(`\n共 ${edges.length} 条跨领域边。`);
} else {
  const exports = await collectDomainExports();
  const edges = await collectCrossDomainEdges();
  console.log('=== 领域 public-api 导出计数（棘轮上限候选）===');
  for (const [domain, count] of Object.entries(exports).sort()) console.log(`  ${domain}: ${count}`);
  console.log(`\n=== 跨领域服务依赖：${edges.length} 条 ===`);
  console.log('（完整清单请使用 --edges）');
}
