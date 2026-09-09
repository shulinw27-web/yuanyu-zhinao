import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workspaceSource = await readFile(new URL('../src/components/SemanticAgentWorkspace.vue', import.meta.url), 'utf8');
const shellStyles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
const electronSource = await readFile(new URL('../electron/main.cjs', import.meta.url), 'utf8');

test('conversation content and composer use independent layout regions', () => {
  assert.match(workspaceSource, /ref="transcript" class="task-transcript"/);
  assert.match(workspaceSource, /class="task-input-dock"/);
  assert.match(workspaceSource, /\.task-conversation\{display:grid;grid-template-rows:minmax\(0,1fr\) auto;/);
  assert.match(workspaceSource, /\.task-transcript\{[^}]*overflow-y:auto;/);
});

test('composer stays docked instead of following long transcript content', () => {
  assert.match(workspaceSource, /\.task-composer\{position:static;/);
  assert.doesNotMatch(workspaceSource, /\.task-composer\{position:absolute;/);
  assert.match(workspaceSource, /\.task-input-dock\{position:relative;/);
});

test('ordinary conversation does not duplicate its response in the bottom status bar', () => {
  assert.match(workspaceSource, /\['conversation', 'needs_clarification', 'unsupported_operation', 'permission_denied'\]\.includes\(task\.intent\)\s*\? ''/);
});

test('desktop shell covers common compact, standard, and ultra-wide viewports', () => {
  assert.match(shellStyles, /@media \(max-width: 1180px\)/);
  assert.match(shellStyles, /@media \(max-width: 1366px\)/);
  assert.match(shellStyles, /@media \(min-width: 2200px\)/);
  assert.match(shellStyles, /@media \(max-height: 800px\) and \(min-width: 1181px\)/);
  assert.match(shellStyles, /min-height: 100dvh/);
});

test('unassigned candidate sources remain editable before server validation', () => {
  assert.match(workspaceSource, /来源系统<input[^>]*:disabled="!canEditProposal \|\| busy"/);
  assert.match(workspaceSource, /object.sourceSystems = \$event.target.value.split/);
  assert.match(workspaceSource, /value.toUpperCase\(\)\); markEditorDirty\(\)/);
});

test('desktop window can shrink to a 1024-wide effective viewport', () => {
  assert.match(electronSource, /minWidth: 960/);
  assert.match(electronSource, /minHeight: 640/);
});
