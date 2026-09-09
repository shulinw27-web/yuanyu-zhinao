import test from 'node:test';
import assert from 'node:assert/strict';
import { canExecuteSemanticTask } from '../src/task-guards.js';

const waitingTask = (command, proposal = null) => ({
  status: 'waiting_confirmation',
  confirmationRequired: true,
  command,
  proposal
});

test('non-proposal operational commands remain explicitly confirmable', () => {
  assert.equal(canExecuteSemanticTask({ task: waitingTask('validate_model') }), true);
  assert.equal(canExecuteSemanticTask({ task: waitingTask('simulate_model') }), true);
  assert.equal(canExecuteSemanticTask({ task: waitingTask('publish_model') }), true);
});

test('model adoption requires a clean, critic-passed, mapping-passed proposal', () => {
  const passed = waitingTask('apply_proposal', { critic: { status: 'passed' }, mappingValidation: { blocked: false } });
  assert.equal(canExecuteSemanticTask({ task: passed }), true);
  assert.equal(canExecuteSemanticTask({ task: passed, editorDirty: true }), false);
  assert.equal(canExecuteSemanticTask({ task: passed, busy: true }), false);
  assert.equal(canExecuteSemanticTask({ task: waitingTask('apply_proposal', { critic: { status: 'failed' }, mappingValidation: { blocked: false } }) }), false);
  assert.equal(canExecuteSemanticTask({ task: waitingTask('apply_proposal', { critic: { status: 'passed' }, mappingValidation: { blocked: true } }) }), false);
});

test('completed conversation and clarification records never expose an execute action', () => {
  assert.equal(canExecuteSemanticTask({ task: { status: 'completed', confirmationRequired: false, command: null } }), false);
  assert.equal(canExecuteSemanticTask({ task: null }), false);
});
