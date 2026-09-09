import test from 'node:test';
import assert from 'node:assert/strict';
import { beginModelInvocation, completeModelInvocation, getModelGovernanceObservability, resetModelGovernanceForTest, validateModelSelection } from '../src/services/model-governance-service.js';

test('model governance requires an exact provider and model version allowlist match', () => {
  const env = { MODEL_ALLOWLIST_JSON: JSON.stringify({ mock: ['deterministic-demo'], local: ['approved-model-v1'], openai: [], deepseek: [], compatible: [] }) };
  assert.equal(validateModelSelection('local', 'approved-model-v1', env).allowed, true);
  assert.equal(validateModelSelection('local', 'approved-model-latest', env).code, 'MODEL_VERSION_NOT_ALLOWED');
  assert.equal(validateModelSelection('openai', 'gpt-5.6-sol', { MODEL_ALLOWLIST_JSON: JSON.stringify({ local: ['approved-model-v1'] }) }).code, 'MODEL_VERSION_NOT_ALLOWED');
  assert.equal(validateModelSelection('unknown', 'model', env).code, 'MODEL_PROVIDER_NOT_ALLOWED');
});

test('model governance enforces concurrency and releases capacity deterministically', () => {
  resetModelGovernanceForTest();
  const env = { MODEL_MAX_CONCURRENT: '1', MODEL_DAILY_CALL_LIMIT: '10', MODEL_DAILY_TOKEN_LIMIT: '100000', MODEL_MAX_RESERVED_OUTPUT_TOKENS: '64' };
  const first = beginModelInvocation({ provider: 'mock', model: 'deterministic-demo', safetyIdentifier: 'user-1', prompt: 'first' }, env);
  assert.equal(first.allowed, true);
  assert.equal(beginModelInvocation({ provider: 'mock', model: 'deterministic-demo', safetyIdentifier: 'user-2', prompt: 'second' }, env).code, 'MODEL_CONCURRENCY_LIMIT');
  assert.equal(completeModelInvocation(first.leaseId), true);
  assert.equal(beginModelInvocation({ provider: 'mock', model: 'deterministic-demo', safetyIdentifier: 'user-2', prompt: 'second' }, env).allowed, true);
});

test('model governance enforces per-subject daily calls and reports privacy-safe aggregate cost metrics', () => {
  resetModelGovernanceForTest();
  const env = { MODEL_DAILY_CALL_LIMIT: '1', MODEL_DAILY_TOKEN_LIMIT: '100000', MODEL_MAX_RESERVED_OUTPUT_TOKENS: '64', MODEL_INPUT_COST_PER_MILLION_USD_JSON: JSON.stringify({ openai: 2 }) };
  const first = beginModelInvocation({ provider: 'openai', model: 'gpt-5.6-sol', safetyIdentifier: 'same-user', prompt: 'a controlled request' }, env);
  assert.equal(first.allowed, true);
  completeModelInvocation(first.leaseId);
  assert.equal(beginModelInvocation({ provider: 'openai', model: 'gpt-5.6-sol', safetyIdentifier: 'same-user', prompt: 'another request' }, env).code, 'MODEL_DAILY_QUOTA_EXCEEDED');
  const metrics = getModelGovernanceObservability(env);
  assert.equal(metrics.acceptedCalls, 1);
  assert.equal(metrics.rejectedQuota, 1);
  assert.equal(metrics.activeRequests, 0);
  assert.ok(metrics.estimatedCostUsd > 0);
  assert.equal(Object.hasOwn(metrics, 'subjects'), false);
});
