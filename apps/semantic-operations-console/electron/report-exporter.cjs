const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const safeName = (value) => String(value || '语义运营报告').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').slice(0, 80) || '语义运营报告';

function exportSemanticReport({ documentsPath, name, format = 'json', content }) {
  if (!['json', 'md', 'csv'].includes(format)) throw new Error('REPORT_FORMAT_NOT_ALLOWED');
  const buffer = Buffer.from(typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf8');
  if (!buffer.length || buffer.length > 2 * 1024 * 1024) throw new Error('REPORT_SIZE_INVALID');
  const root = path.resolve(documentsPath, '元域语义运营报告');
  fs.mkdirSync(root, { recursive: true });
  const base = safeName(name);
  let target = path.resolve(root, `${base}.${format}`); let index = 2;
  while (fs.existsSync(target)) target = path.resolve(root, `${base}-${index++}.${format}`);
  if (path.dirname(target) !== root) throw new Error('REPORT_PATH_INVALID');
  fs.writeFileSync(target, buffer, { flag: 'wx', mode: 0o600 });
  return { destination: 'semantic_reports', fileName: path.basename(target), path: target, bytes: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex'), createdAt: new Date().toISOString() };
}

module.exports = { exportSemanticReport, safeName };
