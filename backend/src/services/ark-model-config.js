// Standard Ark inference API, not a Coding Plan subscription endpoint.
export const ARK_DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';

export function isAllowedArkEndpoint(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'ark.cn-beijing.volces.com'
      && !url.port && !url.username && !url.password && !url.search && !url.hash
      && url.pathname.replace(/\/$/, '') === '/api/v3';
  } catch { return false; }
}

export function getArkRequestOptions(env = process.env) {
  const parsed = Number(env.ARK_MAX_TOKENS || 2048);
  const reservation = Number(env.MODEL_MAX_RESERVED_OUTPUT_TOKENS || 4096);
  const maxTokens = Number.isInteger(parsed) && parsed >= 64 && parsed <= 16384 ? parsed : 2048;
  return {
    max_tokens: Math.min(maxTokens, Number.isInteger(reservation) && reservation >= 64 && reservation <= 32768 ? reservation : 4096),
    // JSON mode has wider compatibility than strict JSON Schema. The local
    // agent-summary validator still rejects actions, fake receipts and junk.
    response_format: { type: 'json_object' },
    thinking: { type: env.ARK_THINKING_MODE === 'enabled' ? 'enabled' : 'disabled' }
  };
}
