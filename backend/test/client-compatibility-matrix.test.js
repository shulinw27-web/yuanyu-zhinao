import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
test('business workbench and semantic operations console cover mobile, compact desktop, standard and ultra-wide layouts', async () => {
  const businessCss = await readFile(resolve(root, 'packages/agent-workbench/src/style.css'), 'utf8');
  const semanticCss = await readFile(resolve(root, 'apps/semantic-operations-console/src/styles.css'), 'utf8');
  const semanticWorkspace = await readFile(resolve(root, 'apps/semantic-operations-console/src/components/SemanticAgentWorkspace.vue'), 'utf8');
  for (const breakpoint of ['1120', '900', '520']) assert.match(businessCss, new RegExp(`max-width:\\s*${breakpoint}px`));
  for (const breakpoint of ['2200', '1500', '1366', '1100', '900']) assert.match(semanticCss, new RegExp(`(?:min|max)-width:\\s*${breakpoint}px`));
  assert.match(semanticWorkspace, /max-width:760px/);
  assert.match(businessCss, /prefers-reduced-motion:\s*reduce/);
  assert.match(semanticWorkspace, /focus-visible/);
});
