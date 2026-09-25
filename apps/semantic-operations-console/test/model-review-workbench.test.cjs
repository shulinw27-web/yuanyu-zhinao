const test = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { resolve, dirname } = require('node:path');

// 组件源码已上提到 @healthcare-ai/agent-ui，按包的声明式入口解析目录。
const sourcePath = resolve(dirname(require.resolve('@healthcare-ai/agent-ui/meta-model')), 'OAMetaModelStudio.vue');

test('human review exposes guided object, relation, and issue workspaces', async () => {
  const source = await readFile(sourcePath, 'utf8');
  assert.match(source, /reviewMode === 'objects'/);
  assert.match(source, /reviewMode === 'relations'/);
  assert.match(source, /class="review-issue-board"/);
  assert.match(source, /人工校对完成度/);
});

test('review readiness is derived from visible object and relation checks', async () => {
  const source = await readFile(sourcePath, 'utf8');
  assert.match(source, /const objectHealth = \(item\) =>/);
  assert.match(source, /const invalidRelations = computed/);
  assert.match(source, /const reviewIssues = computed/);
  assert.match(source, /const reviewProgress = computed/);
});

test('review workbench has responsive three-column and compact layouts', async () => {
  const source = await readFile(sourcePath, 'utf8');
  assert.match(source, /grid-template-columns:230px minmax\(330px,1fr\) minmax\(330px,\.95fr\)/);
  assert.match(source, /@media\(max-width:1180px\)/);
  assert.match(source, /@media\(max-width:760px\)/);
});
