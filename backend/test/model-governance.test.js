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

test('local channel admission matches by model file basename, not the machine mount path', () => {
  // local 的 model 字段是模型文件路径；文件名即受控工件的精确版本，挂载路径是机器差异
  const env = { MODEL_ALLOWLIST_JSON: JSON.stringify({ local: ['Qwen3-8B-Q4_K_M.gguf'] }) };
  const windowsPath = validateModelSelection('local', 'D:\\LLM\\Models\\Qwen\\Qwen3-8B-Q4_K_M.gguf', env);
  assert.equal(windowsPath.allowed, true, '完整路径按 basename 比对准入');
  assert.equal(windowsPath.versionPinned, true);
  assert.equal(validateModelSelection('local', '/opt/models/Qwen3-8B-Q4_K_M.gguf', env).allowed, true, 'POSIX 路径同样准入');
  assert.equal(validateModelSelection('local', 'Qwen3-8B-Q4_K_M.gguf', env).allowed, true, '裸文件名仍直接准入');
  assert.equal(validateModelSelection('local', 'D:\\LLM\\Models\\Other-8B.gguf', env).code, 'MODEL_VERSION_NOT_ALLOWED', '文件名不匹配仍拒绝');
  assert.equal(validateModelSelection('local', 'D:\\LLM\\Models\\Qwen3-8B-Q4_K_M.gguf.bak', env).code, 'MODEL_VERSION_NOT_ALLOWED', '后缀变体不冒充精确版本');
  // 非 local provider 不受 basename 语义影响
  const openaiEnv = { MODEL_ALLOWLIST_JSON: JSON.stringify({ openai: ['gpt-5.6-sol'] }) };
  assert.equal(validateModelSelection('openai', 'some/path/gpt-5.6-sol', openaiEnv).code, 'MODEL_VERSION_NOT_ALLOWED', 'openai 仍按完整字符串精确匹配');
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
