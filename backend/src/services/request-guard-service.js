const buckets = new Map();

const integerFromEnv = (name, fallback) => {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

export const getRateLimitPolicy = (pathname) => {
  if (pathname.includes('/login')) return { limit: integerFromEnv('AUTH_RATE_LIMIT', 12), windowMs: 5 * 60_000 };
  if (pathname === '/api/agent/message') return { limit: integerFromEnv('AGENT_RATE_LIMIT', 45), windowMs: 60_000 };
  return { limit: integerFromEnv('API_RATE_LIMIT', 240), windowMs: 60_000 };
};

export const consumeRequestQuota = ({ key, policy, now = Date.now() }) => {
  const bucketKey = `${key}:${policy.windowMs}:${policy.limit}`;
  const current = buckets.get(bucketKey);
  const bucket = !current || now >= current.resetAt
    ? { count: 0, resetAt: now + policy.windowMs }
    : current;
  bucket.count += 1;
  buckets.set(bucketKey, bucket);
  return {
    allowed: bucket.count <= policy.limit,
    remaining: Math.max(0, policy.limit - bucket.count),
    retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
  };
};
