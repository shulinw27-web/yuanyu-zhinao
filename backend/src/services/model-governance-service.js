import { createHash, randomUUID } from 'node:crypto';
import { readWorkBuddyCloudConfiguration } from './workbuddy-cloud-config.js';

const DEFAULT_ALLOWLIST = Object.freeze({
  mock: ['deterministic-demo'],
  local: ['qwen2.5:14b-instruct', 'Qwen3-8B-Q4_K_M.gguf'],
  openai: ['gpt-5.6-sol'],
  deepseek: ['deepseek-v4-pro'],
  compatible: [],
  ark: [],
  workbuddy: []
});
// WorkBuddy 云服务按积分计量（非 USD 输入单价），此处保持 0，不计入成本估算口径。
const DEFAULT_COST_PER_MILLION_INPUT_TOKENS_USD = Object.freeze({ mock: 0, local: 0, openai: 2, deepseek: 0.5, compatible: 0, ark: 0, workbuddy: 0 });
const activeLeases = new Map();
const subjectUsage = new Map();
const telemetry = { acceptedCalls: 0, rejectedSelection: 0, rejectedConcurrency: 0, rejectedQuota: 0, estimatedInputTokens: 0, estimatedReservedOutputTokens: 0, estimatedCostUsd: 0, lastRejectionAt: null, lastRejectionReason: null };

const boundedInteger = (value, fallback, minimum, maximum) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
};
const parseObject = (value, fallback) => {
  if (!String(value || '').trim()) return fallback;
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback; } catch { return fallback; }
};
const estimateTokens = (value) => Math.max(1, Math.ceil(String(value || '').length / 4));
const subjectKey = (value) => createHash('sha256').update(String(value || 'enterprise-agent')).digest('hex').slice(0, 24);
const dayBucket = () => new Date().toISOString().slice(0, 10);

export function getModelGovernancePolicy(env = process.env) {
  const hasConfiguredAllowlist = Boolean(String(env.MODEL_ALLOWLIST_JSON || '').trim());
  const configuredAllowlist = parseObject(env.MODEL_ALLOWLIST_JSON, hasConfiguredAllowlist ? {} : DEFAULT_ALLOWLIST);
  const allowlist = Object.fromEntries(Object.entries(DEFAULT_ALLOWLIST).map(([provider, defaults]) => [provider, [...new Set((Array.isArray(configuredAllowlist[provider]) ? configuredAllowlist[provider] : (hasConfiguredAllowlist ? [] : defaults)).map(String).filter(Boolean))]]));
  // WorkBuddy 云服务：环境完全未声明模型白名单时，以配置文件固定的精确模型版本作为准入；
  // 一旦环境显式提供 MODEL_ALLOWLIST_JSON，就完全按环境执行（未声明 workbuddy 即视为拒绝）。
  if (!hasConfiguredAllowlist) {
    const workBuddyConfig = readWorkBuddyCloudConfiguration(env);
    if (workBuddyConfig) allowlist.workbuddy = [...workBuddyConfig.allowedModels];
  }
  const configuredCosts = parseObject(env.MODEL_INPUT_COST_PER_MILLION_USD_JSON, DEFAULT_COST_PER_MILLION_INPUT_TOKENS_USD);
  return {
    allowlist,
    exactVersionPinning: true,
    maxConcurrent: boundedInteger(env.MODEL_MAX_CONCURRENT, 4, 1, 128),
    dailyCallLimitPerSubject: boundedInteger(env.MODEL_DAILY_CALL_LIMIT, 200, 1, 100_000),
    dailyTokenLimitPerSubject: boundedInteger(env.MODEL_DAILY_TOKEN_LIMIT, 500_000, 1_000, 100_000_000),
    maxReservedOutputTokens: boundedInteger(env.MODEL_MAX_RESERVED_OUTPUT_TOKENS, 4096, 64, 32_768),
    inputCostPerMillionTokensUsd: Object.fromEntries(Object.keys(DEFAULT_ALLOWLIST).map((provider) => [provider, Math.max(0, Number(configuredCosts[provider]) || 0)])),
    upgradeGate: { required: true, minimumControlEvaluationPassRate: '100%', silentProviderVersionChangesAllowed: false }
  };
}

// local 通道的 model 字段是模型文件路径（gguf 等）；精确版本判据是「文件名」而非完整路径——
// 同一份受控工件在不同机器上的挂载路径不同，按完整路径精确匹配会让 local 通道永远无法准入
// （实测：运行时管理员配置 model='D:\LLM\Models\Qwen\Qwen3-8B-Q4_K_M.gguf'，白名单存裸文件名）。
// 提取 basename（兼容 / 与 \ 分隔符）后与白名单精确比对——文件名即受控工件的精确版本，仍是精确固定。
const localModelBasename = (value) => String(value || '').trim().split(/[\\/]/).pop() || '';

export function validateModelSelection(provider, model, env = process.env) {
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  const normalizedModel = String(model || '').trim();
  const policy = getModelGovernancePolicy(env);
  const allowedModels = policy.allowlist[normalizedProvider];
  if (!allowedModels) return { allowed: false, code: 'MODEL_PROVIDER_NOT_ALLOWED', message: '模型提供方不在准入范围内。' };
  // local 通道按文件名比对（model 字段是模型文件路径，basename 才是受控工件的精确版本）；
  // 其余 provider 仍按完整字符串精确匹配，版本准入语义不变。
  const candidates = normalizedProvider === 'local'
    ? [...new Set([normalizedModel, localModelBasename(normalizedModel)].filter(Boolean))]
    : [normalizedModel];
  if (!candidates.some((candidate) => allowedModels.includes(candidate))) {
    return { allowed: false, code: 'MODEL_VERSION_NOT_ALLOWED', message: `模型 ${normalizedModel || '(empty)'} 未在 ${normalizedProvider} 的精确版本白名单中。`, allowedModels };
  }
  return { allowed: true, provider: normalizedProvider, model: normalizedModel, versionPinned: true };
}

const reject = (kind, code, message) => {
  telemetry[kind] += 1;
  telemetry.lastRejectionAt = new Date().toISOString();
  telemetry.lastRejectionReason = code;
  return { allowed: false, code, message };
};

export function beginModelInvocation({ provider, model, safetyIdentifier, prompt = '', attachmentCount = 0 }, env = process.env) {
  const selection = validateModelSelection(provider, model, env);
  if (!selection.allowed) return reject('rejectedSelection', selection.code, selection.message);
  const policy = getModelGovernancePolicy(env);
  if (activeLeases.size >= policy.maxConcurrent) return reject('rejectedConcurrency', 'MODEL_CONCURRENCY_LIMIT', '模型并发已达到受控上限，本次请求已降级。');
  const key = `${dayBucket()}:${subjectKey(safetyIdentifier)}`;
  const usage = subjectUsage.get(key) || { calls: 0, tokens: 0 };
  const inputTokens = estimateTokens(prompt) + Math.max(0, Number(attachmentCount) || 0) * 64;
  const reservedTokens = inputTokens + policy.maxReservedOutputTokens;
  if (usage.calls + 1 > policy.dailyCallLimitPerSubject || usage.tokens + reservedTokens > policy.dailyTokenLimitPerSubject) {
    return reject('rejectedQuota', 'MODEL_DAILY_QUOTA_EXCEEDED', '当前主体的模型调用或 Token 日配额已用尽，本次请求已降级。');
  }
  usage.calls += 1;
  usage.tokens += reservedTokens;
  subjectUsage.set(key, usage);
  const leaseId = randomUUID();
  activeLeases.set(leaseId, { provider: selection.provider, startedAt: Date.now(), inputTokens, reservedTokens });
  telemetry.acceptedCalls += 1;
  telemetry.estimatedInputTokens += inputTokens;
  telemetry.estimatedReservedOutputTokens += policy.maxReservedOutputTokens;
  telemetry.estimatedCostUsd += (inputTokens / 1_000_000) * policy.inputCostPerMillionTokensUsd[selection.provider];
  return { allowed: true, leaseId, inputTokens, reservedTokens, policy: { maxConcurrent: policy.maxConcurrent, dailyCallLimitPerSubject: policy.dailyCallLimitPerSubject, dailyTokenLimitPerSubject: policy.dailyTokenLimitPerSubject } };
}

export function completeModelInvocation(leaseId) {
  if (!leaseId) return false;
  return activeLeases.delete(leaseId);
}

export function getModelGovernanceObservability(env = process.env) {
  const policy = getModelGovernancePolicy(env);
  return {
    ...telemetry,
    activeRequests: activeLeases.size,
    estimatedCostUsd: Number(telemetry.estimatedCostUsd.toFixed(6)),
    trackedSubjectDays: subjectUsage.size,
    policy: {
      exactVersionPinning: policy.exactVersionPinning,
      maxConcurrent: policy.maxConcurrent,
      dailyCallLimitPerSubject: policy.dailyCallLimitPerSubject,
      dailyTokenLimitPerSubject: policy.dailyTokenLimitPerSubject,
      upgradeGate: policy.upgradeGate,
      allowlist: policy.allowlist
    }
  };
}

export function resetModelGovernanceForTest() {
  activeLeases.clear();
  subjectUsage.clear();
  Object.assign(telemetry, { acceptedCalls: 0, rejectedSelection: 0, rejectedConcurrency: 0, rejectedQuota: 0, estimatedInputTokens: 0, estimatedReservedOutputTokens: 0, estimatedCostUsd: 0, lastRejectionAt: null, lastRejectionReason: null });
}
