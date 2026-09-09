const DEFAULT_POLICY = Object.freeze({
  web: { minimumVersion: '0.1.0', recommendedVersion: '0.1.0' },
  desktop: { minimumVersion: '0.3.0', recommendedVersion: '0.3.0' },
  mobile: { minimumVersion: '0.3.0', recommendedVersion: '0.3.0' },
  'dingtalk-mobile': { minimumVersion: '0.3.0', recommendedVersion: '0.3.0' },
  'dingtalk-pc': { minimumVersion: '0.3.0', recommendedVersion: '0.3.0' },
  'semantic-web': { minimumVersion: '0.2.0', recommendedVersion: '0.2.0' },
  'semantic-desktop': { minimumVersion: '0.2.0', recommendedVersion: '0.2.0' }
});
const parse = (value) => {
  const match = String(value || '').trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  return match ? match.slice(1).map(Number) : null;
};
const compare = (left, right) => {
  const a = parse(left); const b = parse(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  return 0;
};
export function getClientVersionPolicy(env = process.env) {
  if (!String(env.CLIENT_VERSION_POLICY_JSON || '').trim()) return structuredClone(DEFAULT_POLICY);
  try {
    const configured = JSON.parse(env.CLIENT_VERSION_POLICY_JSON);
    return Object.fromEntries(Object.entries(DEFAULT_POLICY).map(([platform, fallback]) => [platform, { ...fallback, ...(configured?.[platform] || {}) }]));
  } catch { return structuredClone(DEFAULT_POLICY); }
}
export function evaluateClientRequest(headers = {}, { production = process.env.NODE_ENV === 'production', env = process.env } = {}) {
  const platform = String(headers['x-client-platform'] || '').trim().toLowerCase();
  const version = String(headers['x-client-version'] || '').trim();
  const selected = getClientVersionPolicy(env)[platform];
  if (!platform || !selected) return production ? { allowed: false, status: 426, code: 'CLIENT_PLATFORM_UNSUPPORTED', message: '生产环境要求受支持的客户端平台标识。' } : { allowed: true, status: 'unmanaged_client' };
  const comparison = compare(version, selected.minimumVersion);
  if (comparison === null) return production ? { allowed: false, status: 426, code: 'CLIENT_VERSION_REQUIRED', message: '生产环境要求有效的客户端版本。', ...selected } : { allowed: true, status: 'version_unavailable', ...selected };
  if (comparison < 0) return { allowed: false, status: 426, code: 'CLIENT_UPGRADE_REQUIRED', message: `客户端版本过低，最低支持版本为 ${selected.minimumVersion}。`, ...selected };
  return { allowed: true, status: compare(version, selected.recommendedVersion) < 0 ? 'upgrade_recommended' : 'compatible', platform, version, ...selected };
}
