const test = require('node:test'); const assert = require('node:assert/strict'); const { readFileSync } = require('node:fs'); const { resolve } = require('node:path');

test('non-current operational pages load lazily without changing Agent workbench ref readiness', () => {
  const source = readFileSync(resolve(__dirname, '../src/App.vue'), 'utf8');
  for (const name of ['SemanticOperationsCenter', 'SemanticOnboardingWorkspace', 'SystemAccessWorkspace', 'WorkflowSemanticCenter']) {
    assert.ok(source.includes(`const ${name} = defineAsyncComponent(() => import('./components/${name}.vue'))`));
    assert.doesNotMatch(source, new RegExp(`import ${name} from`));
  }
  assert.match(source, /import SemanticAgentWorkspace from/u);
});

test('bundle gate pins real entry manifest and exact unchanged 500kB budget', async () => {
  const { checkSemanticOpsBundle } = await import('../scripts/check-bundle.mjs');
  const read = () => JSON.stringify({ 'index.html': { file: 'assets/index-test.js', isEntry: true } });
  assert.equal(checkSemanticOpsBundle({ read, stat: () => ({ size: 386400 }) }).bytes, 386400);
  assert.equal(checkSemanticOpsBundle({ read, stat: () => ({ size: 500000 }) }).limitBytes, 500000);
  assert.throws(() => checkSemanticOpsBundle({ read, stat: () => ({ size: 500001 }) }), /SEMANTIC_ENTRY_SIZE_LIMIT/u);
  assert.throws(() => checkSemanticOpsBundle({ read, stat: () => ({ size: NaN }) }), /SEMANTIC_ENTRY_SIZE_LIMIT/u);
});

test('missing, foreign and non-entry manifests fail before reading an entry blob', async () => {
  const { checkSemanticOpsBundle } = await import('../scripts/check-bundle.mjs'); let stats = 0;
  for (const manifest of [{}, { 'index.html': { file: '../private/config.js', isEntry: true } }, { 'index.html': { file: 'assets/index.js', isEntry: false } }, { 'index.html': { file: 'assets/index.js', isEntry: 'true' } }]) {
    assert.throws(() => checkSemanticOpsBundle({ read: () => JSON.stringify(manifest), stat: () => { stats++; return { size: 1 }; } }), /SEMANTIC_ENTRY_MANIFEST_INVALID/u);
  }
  assert.equal(stats, 0);
});
