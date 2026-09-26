const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// 导出根目录必须在导入方（main.cjs 的 semantic-ops:show-report 路径校验）与写出方之间
// 保持一致，否则校验恒失败。此前两侧各写一份字面量，2026-09-26 的批量改名把其中一份
// 拼成「元域元域智语报告」而另一份没有 → 这里收敛为唯一常量。
const REPORT_ROOT_DIR_NAME = '元域智语报告';

const safeName = (value) => String(value || REPORT_ROOT_DIR_NAME).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').slice(0, 80) || REPORT_ROOT_DIR_NAME;

function exportSemanticReport({ documentsPath, name, format = 'json', content }) {
  if (!['json', 'md', 'csv'].includes(format)) throw new Error('REPORT_FORMAT_NOT_ALLOWED');
  const buffer = Buffer.from(typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf8');
  if (!buffer.length || buffer.length > 2 * 1024 * 1024) throw new Error('REPORT_SIZE_INVALID');
  const root = path.resolve(documentsPath, REPORT_ROOT_DIR_NAME);
  fs.mkdirSync(root, { recursive: true });
  const base = safeName(name);
  let target = path.resolve(root, `${base}.${format}`); let index = 2;
  while (fs.existsSync(target)) target = path.resolve(root, `${base}-${index++}.${format}`);
  if (path.dirname(target) !== root) throw new Error('REPORT_PATH_INVALID');
  fs.writeFileSync(target, buffer, { flag: 'wx', mode: 0o600 });
  return { destination: 'semantic_reports', fileName: path.basename(target), path: target, bytes: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex'), createdAt: new Date().toISOString() };
}

module.exports = { exportSemanticReport, safeName, REPORT_ROOT_DIR_NAME };
