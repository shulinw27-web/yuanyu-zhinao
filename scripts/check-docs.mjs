import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const docsRoot = path.join(root, 'docs');
const ignored = new Set(['node_modules', 'dist', 'release', 'target', 'coverage', '.git', '.runtime', '.data', 'runtime-data', 'output', 'tmp', '.playwright-cli', '__pycache__']);
const issues = [];
const markdownFiles = [];
let checkedLinks = 0;

function scan(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    const relative = path.relative(root, full).split(path.sep).join('/');
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (relative.startsWith('docs/') && (ignored.has(entry.name) || /^\.(?:qa-|lo-|artifact-build)|^_manual_render$/.test(entry.name))) {
        issues.push(`${relative}: 文档目录不应保留运行数据或生成缓存`);
        continue;
      }
      if (ignored.has(entry.name) || entry.name.startsWith('.venv')) continue;
      scan(full);
    } else if (/\.(?:md|docx|pptx|pdf)$/i.test(entry.name)) {
      if (!relative.startsWith('docs/') && relative !== 'README.md' && !relative.startsWith('.github/')) {
        issues.push(`${relative}: 项目说明文档应集中在 docs/`);
      }
      if (/\.md$/i.test(entry.name) && (relative.startsWith('docs/') || relative === 'README.md')) markdownFiles.push(full);
    }
  }
}

function checkTarget(file, target, lineNumber) {
  const relative = path.relative(root, file).split(path.sep).join('/');
  if (/^(?:[a-z][a-z\d+.-]*:|#|\/\/)/i.test(target)) return;
  const filePart = target.split(/[?#]/)[0];
  if (!filePart) return;
  let decoded;
  try { decoded = decodeURIComponent(filePart).replace(/:\d+$/, ''); }
  catch { issues.push(`${relative}:${lineNumber}: 非法链接编码 ${target}`); return; }
  const resolved = path.resolve(path.dirname(file), decoded);
  const boundary = path.relative(root, resolved);
  checkedLinks += 1;
  if (boundary === '..' || boundary.startsWith(`..${path.sep}`) || path.isAbsolute(boundary)) {
    issues.push(`${relative}:${lineNumber}: 本地文档链接超出项目 ${target}`);
  } else if (!fs.existsSync(resolved)) {
    issues.push(`${relative}:${lineNumber}: 失效链接 ${target}`);
  }
}

if (!fs.existsSync(docsRoot) || !fs.existsSync(path.join(docsRoot, 'README.md'))) {
  console.error('缺少 docs/README.md 文档入口');
  process.exitCode = 1;
} else {
  scan(root);
  for (const file of markdownFiles) {
    let fence = null;
    let fenceLength = 0;
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    for (const [index, raw] of lines.entries()) {
      const marker = raw.match(/^\s*(`{3,}|~{3,})/);
      if (marker) {
        if (!fence) { fence = marker[1][0]; fenceLength = marker[1].length; }
        else if (marker[1][0] === fence && marker[1].length >= fenceLength) fence = null;
        continue;
      }
      if (fence) continue;
      const line = raw.replace(/`+[^`]*`+/g, '');
      for (const match of line.matchAll(/!?\[[^\]\n]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\s*\)/g)) {
        checkTarget(file, match[1] ?? match[2], index + 1);
      }
      const definition = line.match(/^\s*\[[^\]]+\]:\s*(?:<([^>]+)>|(\S+))/);
      if (definition) checkTarget(file, definition[1] ?? definition[2], index + 1);
    }
  }
  if (issues.length) {
    console.error(issues.join('\n'));
    console.error(`文档检查失败：${issues.length} 项问题。`);
    process.exitCode = 1;
  } else {
    console.log(`文档检查通过：${markdownFiles.length} 份 Markdown，${checkedLinks} 个本地链接；文档集中存放。`);
  }
}
