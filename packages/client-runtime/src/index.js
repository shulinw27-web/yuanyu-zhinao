export { createKnowledgeClient } from './knowledge-client.js';

const parseVersion = (value) => {
  const match = String(value || '').trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  return match ? match.slice(1).map(Number) : null;
};

export function compareClientVersions(left, right) {
  const a = parseVersion(left); const b = parseVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  return 0;
}

export function evaluateClientCompatibility({ version, minimumVersion, recommendedVersion }) {
  const minimumComparison = compareClientVersions(version, minimumVersion);
  if (minimumComparison === null) return { allowed: false, status: 'invalid_version', upgradeRequired: true };
  if (minimumComparison < 0) return { allowed: false, status: 'upgrade_required', upgradeRequired: true, minimumVersion };
  const recommendedComparison = compareClientVersions(version, recommendedVersion || minimumVersion);
  return { allowed: true, status: recommendedComparison !== null && recommendedComparison < 0 ? 'upgrade_recommended' : 'compatible', upgradeRequired: false, minimumVersion, recommendedVersion: recommendedVersion || minimumVersion };
}

const retryableStatuses = new Set([408, 425, 429, 502, 503, 504]);
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function resilientFetch(url, options = {}, policy = {}) {
  const fetchImpl = policy.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch is not available.');
  const method = String(options.method || 'GET').toUpperCase();
  const retrySafe = ['GET', 'HEAD', 'OPTIONS'].includes(method) || options.retryable === true;
  const attempts = retrySafe ? Math.min(Math.max(Number(policy.attempts) || 3, 1), 5) : 1;
  const baseDelayMs = Math.min(Math.max(Number(policy.baseDelayMs) || 150, 0), 5_000);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, options);
      if (!retryableStatuses.has(response.status) || attempt === attempts) return response;
      lastError = new Error(`retryable HTTP ${response.status}`);
      if (typeof policy.onRetry === 'function') policy.onRetry({ attempt, reason: `http_${response.status}` });
    } catch (error) {
      if (options.signal?.aborted || attempt === attempts) throw error;
      lastError = error;
      if (typeof policy.onRetry === 'function') policy.onRetry({ attempt, reason: 'network_error' });
    }
    await (policy.wait || wait)(baseDelayMs * (2 ** (attempt - 1)));
  }
  throw lastError;
}

export function createConnectivityState(runtime = globalThis) {
  let online = runtime.navigator?.onLine !== false;
  const listeners = new Set();
  const update = (value) => { online = value; listeners.forEach((listener) => listener({ online, changedAt: new Date().toISOString() })); };
  runtime.addEventListener?.('online', () => update(true));
  runtime.addEventListener?.('offline', () => update(false));
  return { get online() { return online; }, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
}
