const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { exportSemanticReport } = require('../electron/report-exporter.cjs');

test('exports governed report only under the dedicated documents folder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-report-'));
  const receipt = exportSemanticReport({ documentsPath: root, name: '../运营:检查', format: 'json', content: { status: 'passed' } });
  assert.equal(receipt.destination, 'semantic_reports');
  assert.ok(receipt.path.startsWith(path.join(root, '元域语义运营报告')));
  assert.match(receipt.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(fs.readFileSync(receipt.path, 'utf8')), { status: 'passed' });
});

test('rejects executable formats and oversized reports', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-report-'));
  assert.throws(() => exportSemanticReport({ documentsPath: root, format: 'exe', content: 'x' }), /REPORT_FORMAT_NOT_ALLOWED/);
  assert.throws(() => exportSemanticReport({ documentsPath: root, format: 'md', content: 'x'.repeat(2 * 1024 * 1024 + 1) }), /REPORT_SIZE_INVALID/);
});
