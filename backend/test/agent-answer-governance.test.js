import test from 'node:test';
import assert from 'node:assert/strict';
import { assessAgentAnswer } from '../src/services/agent-answer-governance-service.js';

test('citation count alone never certifies high-confidence answer correctness', () => {
  const result = assessAgentAnswer({ evidence: [{ id: 'one' }, { id: 'two' }], route: [{ id: 'quality-agent' }] });
  assert.equal(result.citationStatus, 'grounded');
  assert.equal(result.confidenceBand, 'medium');
  assert.equal(result.assessmentScope, 'evidence_presence_not_answer_truth');
  assert.equal(result.humanReviewRequired, false);
});

test('business answers without evidence expose uncertainty and require review', () => {
  const result = assessAgentAnswer({ evidence: [], route: [{ id: 'quality-agent' }] });
  assert.equal(result.citationStatus, 'missing');
  assert.equal(result.confidenceBand, 'low');
  assert.equal(result.humanReviewRequired, true);
  assert.match(result.uncertainty, /缺少足够/);
});

test('policy denials are explicit refusals while pending commands always require a human', () => {
  const refusal = assessAgentAnswer({ promptSecurity: { status: 'rejected' }, evidence: [] });
  assert.equal(refusal.refusal.active, true);
  const pending = assessAgentAnswer({ command: { requiresConfirmation: true }, lifecycle: { state: 'awaiting_confirmation' }, evidence: [{ id: 'one' }] });
  assert.equal(pending.humanReviewRequired, true);
});

test('partial verification remains low confidence even with many evidence references', () => {
  const result = assessAgentAnswer({ lifecycle: { state: 'analysis_incomplete' }, evidence: [{ id: 'one' }, { id: 'two' }, { id: 'three' }] });
  assert.equal(result.confidenceBand, 'low');
  assert.equal(result.humanReviewRequired, true);
});
