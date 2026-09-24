// WorkBuddy 云服务 LLM 传输适配层。
// 云服务仅提供 OpenAI 兼容的流式 SSE 接口（stream 必须为 true），本模块把流式分片
// 聚合为网关其余 Provider 使用的非流式 chat.completions 形态，供统一校验流程消费。
// 认证由 SDK 注入应用级公开凭据（publishableKey），本模块不接触任何服务端密钥。
import { createWorkBuddyCloud } from '@tencent-ai/workbuddy-cloud-sdk';
import { readWorkBuddyCloudConfiguration } from './workbuddy-cloud-config.js';

let clientFactoryOverride = null;
let cachedClient = null;
let cachedClientKey = null;

const resolveClient = (config) => {
  if (clientFactoryOverride) return clientFactoryOverride(config);
  const cacheKey = `${config.endpoint}|${config.publishableKey}`;
  if (!cachedClient || cachedClientKey !== cacheKey) {
    cachedClient = createWorkBuddyCloud({ endpoint: config.endpoint, publishableKey: config.publishableKey });
    cachedClientKey = cacheKey;
  }
  return cachedClient;
};

export function setWorkBuddyCloudClientFactoryForTests(factory) {
  clientFactoryOverride = typeof factory === 'function' ? factory : null;
  cachedClient = null;
  cachedClientKey = null;
}

// 与 ark-provider-failure 同一纪律：只暴露有界错误分类，不向遥测或用户透出上游原始报文。
const classifyWorkBuddyCloudFailure = (rawCode) => {
  const code = String(rawCode || '').replace(/[^\w.:-]/g, '').slice(0, 64);
  if (code.startsWith('request_')) return { code: 'REQUEST_REJECTED', message: '云服务拒绝了请求参数' };
  if (code.startsWith('auth_')) return { code: 'AUTH_REJECTED', message: '云服务凭据或来源校验未通过' };
  if (code === 'quota_rate_limited') return { code: 'QUOTA_RATE_LIMITED', message: '云服务限流，可稍后重试' };
  if (code.startsWith('quota_')) return { code: 'QUOTA_EXHAUSTED', message: '云服务配额不足' };
  if (code.startsWith('gateway_') || code.startsWith('model_')) return { code: 'MODEL_UNAVAILABLE', message: '云模型服务暂时不可用' };
  if (code.startsWith('internal_')) return { code: 'INTERNAL_FAILURE', message: '云服务内部错误' };
  return { code: 'PROVIDER_FAILURE', message: '云模型调用未完成' };
};

const normalizeError = (error) => {
  const bounded = classifyWorkBuddyCloudFailure(error?.error?.code || error?.code);
  const normalized = new Error(`WORKBUDDY_CLOUD_${bounded.code}: ${bounded.message}`);
  normalized.cause = error;
  return normalized;
};

// 与 fetchArkChat 相同的边界：仅模型推理，最多一次瞬态重试交给上层熔断统计，不重试业务写入。
export async function fetchWorkBuddyCloudChat({ model, messages, temperature, responseFormat, timeoutMs, timing }) {
  const config = readWorkBuddyCloudConfiguration();
  if (!config) throw new Error('WORKBUDDY_CLOUD_NOT_CONFIGURED: 云服务模型配置文件缺失或非法');
  const client = resolveClient(config);
  const startedAt = performance.now();
  try {
    const stream = client.llm.chat.completions.create({
      model,
      messages,
      stream: true,
      ...(Number.isFinite(temperature) ? { temperature } : {}),
      ...(responseFormat ? { response_format: responseFormat } : {}),
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {})
    });
    let content = '';
    let finishReason = null;
    let usage = null;
    for await (const chunk of stream) {
      const choice = chunk?.choices?.[0];
      if (choice?.delta?.content) content += choice.delta.content;
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (chunk?.usage) usage = chunk.usage;
    }
    timing?.attempts?.push({ elapsedMs: Math.round(performance.now() - startedAt), status: 200 });
    return { choices: [{ finish_reason: finishReason, message: { content } }], usage };
  } catch (error) {
    timing?.attempts?.push({ elapsedMs: Math.round(performance.now() - startedAt), code: 'WORKBUDDY_CLOUD_FAILURE' });
    throw normalizeError(error);
  }
}
