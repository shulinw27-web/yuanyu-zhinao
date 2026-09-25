const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { exportSemanticReport, REPORT_ROOT_DIR_NAME } = require('../electron/report-exporter.cjs');

test('exports governed report only under the dedicated documents folder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-report-'));
  const receipt = exportSemanticReport({ documentsPath: root, name: '../运营:检查', format: 'json', content: { status: 'passed' } });
  assert.equal(receipt.destination, 'semantic_reports');
  assert.ok(receipt.path.startsWith(path.join(root, '元域智营报告')));
  // 2026-09-26：批量改名曾把「元域语义运营报告」替换成「元域元域智营报告」（前缀重复），
  // 产生的目录名至今仍会出现在用户文档目录里。这里按**精确目录名**锁死，
  // 避免下一次改名再次静默拼出重复前缀（沿用 test/workspace-layout 的反向锁死做法）。
  assert.equal(path.basename(path.dirname(receipt.path)), '元域智营报告');
  // 目录名常量必须与导入方共享同一份（main.cjs 的 semantic-ops:show-report 用它做路径校验），
  // 两侧各写一份字面量正是这次回归的成因。
  assert.equal(REPORT_ROOT_DIR_NAME, '元域智营报告');
  assert.match(receipt.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(fs.readFileSync(receipt.path, 'utf8')), { status: 'passed' });
});

test('rejects executable formats and oversized reports', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-report-'));
  assert.throws(() => exportSemanticReport({ documentsPath: root, format: 'exe', content: 'x' }), /REPORT_FORMAT_NOT_ALLOWED/);
  assert.throws(() => exportSemanticReport({ documentsPath: root, format: 'md', content: 'x'.repeat(2 * 1024 * 1024 + 1) }), /REPORT_SIZE_INVALID/);
});

test('the report folder name has exactly one definition, and it has no duplicated prefix', () => {
  // main.cjs 需要 electron 运行时，无法在 node:test 里加载，因此按源码取证。
  // 这是「同一常量被抄成两份」这类回归唯一能在单测里锁死的位置。
  const mainSource = fs.readFileSync(path.resolve(__dirname, '../electron/main.cjs'), 'utf8');
  assert.ok(mainSource.includes('REPORT_ROOT_DIR_NAME'), 'main.cjs 必须引用共享常量而不是自写字面量');
  assert.ok(!mainSource.includes("'元域智营报告'"), 'main.cjs 不应再出现硬编码的报告目录名');
  assert.ok(!/元域元域/.test(mainSource), 'main.cjs 不应出现重复前缀（元域元域…）');
  assert.ok(!/元域元域/.test(REPORT_ROOT_DIR_NAME), '报告目录名不应出现重复前缀（元域元域…）');
});
