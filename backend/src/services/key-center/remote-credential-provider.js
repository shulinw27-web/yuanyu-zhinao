import { registerKmsCredentialProvider } from './kms-adapter.js';

const normalizeEndpoint = (value) => String(value || '').trim().replace(/\/$/, '');

export function createRemoteCredentialProvider({ endpoint, workloadId, bearerToken, timeoutMs = 5_000, fetchImpl = globalThis.fetch, production = process.env.NODE_ENV === 'production' } = {}) {
  const normalizedEndpoint = normalizeEndpoint(endpoint);
  let parsedEndpoint;
  try { parsedEndpoint = new URL(normalizedEndpoint); } catch { throw new Error('KEY_CENTER_PROVIDER_URL must be a valid HTTP(S) URL.'); }
  if (!['http:', 'https:'].includes(parsedEndpoint.protocol)) throw new Error('Remote credential provider URL must use HTTP(S).');
  if (production && parsedEndpoint.protocol !== 'https:') throw new Error('Production credential provider URL must use HTTPS.');
  if (typeof fetchImpl !== 'function') throw new Error('Remote credential provider requires a fetch implementation.');
  const safeWorkloadId = String(workloadId || '').trim();
  const headers = () => ({
    ...(safeWorkloadId ? { 'x-workload-id': safeWorkloadId } : {}),
    ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {})
  });

  const timedFetch = async (path, options = {}) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(500, Number(timeoutMs) || 5_000));
    try { return await fetchImpl(`${normalizedEndpoint}${path}`, { ...options, signal: controller.signal }); }
    finally { clearTimeout(timeout); }
  };

  return {
    async probe() {
      try {
        const response = await timedFetch('/health/ready', { method: 'GET', headers: headers() });
        return { ready: response.ok };
      } catch { return { ready: false }; }
    },
    async issueOpaqueCredential({ secretRef, leaseId, expiresAt }) {
      try {
        const response = await timedFetch('/v1/credential-handles', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...headers()
          },
          body: JSON.stringify({ secretRef, leaseId, expiresAt })
        });
        if (!response.ok) {
          const error = new Error('Remote credential provider rejected the handle request.');
          error.code = 'KMS_REMOTE_PROVIDER_REJECTED';
          throw error;
        }
        const payload = await response.json().catch(() => ({}));
        return { handle: payload.handle };
      } catch (cause) {
        if (cause?.code) throw cause;
        const error = new Error('Remote credential provider is unavailable.');
        error.code = cause?.name === 'AbortError' ? 'KMS_REMOTE_PROVIDER_TIMEOUT' : 'KMS_REMOTE_PROVIDER_UNAVAILABLE';
        throw error;
      }
    }
  };
}

export function registerConfiguredRemoteCredentialProvider(env = process.env, options = {}) {
  const provider = String(env.KEY_CENTER_PROVIDER || 'demo-kms').trim();
  if (provider === 'demo-kms') return null;
  const adapter = createRemoteCredentialProvider({
    endpoint: env.KEY_CENTER_PROVIDER_URL,
    workloadId: env.KEY_CENTER_WORKLOAD_ID,
    bearerToken: env.KEY_CENTER_PROVIDER_BEARER_TOKEN,
    timeoutMs: env.KEY_CENTER_PROVIDER_TIMEOUT_MS,
    production: String(env.NODE_ENV || '').toLowerCase() === 'production',
    ...options
  });
  registerKmsCredentialProvider(provider, adapter);
  return adapter;
}
