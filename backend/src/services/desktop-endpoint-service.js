import { mutateState, readState } from '../repositories/runtime-state-repository.js';
import { createHash, createPublicKey, verify } from 'node:crypto';

const ENDPOINT_NAMESPACE = 'desktop_endpoint_heartbeats';
const HEARTBEAT_TTL_MS = 75_000;
const MAX_CLOCK_SKEW_MS = 120_000;
const ALLOWED_FIELDS = new Set(['protocolVersion', 'endpointId', 'appVersion', 'platform', 'packaged', 'trustClaim', 'keyProtection', 'capabilityManifestHash', 'observedAt', 'publicKey', 'signature']);

const normalizeIdentity = (identityScope = {}) => ({
  tenantId: String(identityScope.tenantId || 'demo-enterprise').slice(0, 120),
  subjectId: String(identityScope.subjectId || '').slice(0, 180),
  sessionId: String(identityScope.sessionId || identityScope.source || '').slice(0, 180),
  deviceId: String(identityScope.deviceId || '').slice(0, 180),
  platform: String(identityScope.platform || '').slice(0, 80)
});
const endpointKey = (identity) => JSON.stringify([identity.tenantId, identity.subjectId, identity.sessionId, identity.deviceId]);

const parseVersion = (value) => {
  const match = String(value || '').match(/^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/u);
  return match ? match.slice(1).map(Number) : null;
};
const versionAtLeast = (actual, minimum) => {
  const left = parseVersion(actual);
  const right = parseVersion(minimum);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] > right[index]) return true;
    if (left[index] < right[index]) return false;
  }
  return true;
};
const minimumVersion = () => String(process.env.ZHINAO_MIN_ENDPOINT_VERSION || '0.3.0');
const trustedManifests = () => new Set(String(process.env.ZHINAO_TRUSTED_ENDPOINT_MANIFESTS || '').split(',').map((item) => item.trim().toLowerCase()).filter((item) => /^[a-f0-9]{64}$/u.test(item)));
const trustedEndpointKeys = () => new Set(String(process.env.ZHINAO_TRUSTED_ENDPOINT_KEYS || '').split(',').map((item) => item.trim().toLowerCase()).filter((item) => /^[a-f0-9]{64}$/u.test(item)));
const heartbeatPayload = (heartbeat) => JSON.stringify([
  heartbeat.protocolVersion,
  heartbeat.endpointId,
  heartbeat.appVersion,
  heartbeat.platform,
  heartbeat.packaged,
  heartbeat.trustClaim,
  heartbeat.keyProtection,
  heartbeat.capabilityManifestHash,
  heartbeat.observedAt
]);
const verifyHeartbeatSignature = (heartbeat) => {
  try {
    const publicKeyBytes = Buffer.from(String(heartbeat.publicKey || ''), 'base64url');
    const signature = Buffer.from(String(heartbeat.signature || ''), 'base64url');
    if (publicKeyBytes.length < 32 || publicKeyBytes.length > 128 || signature.length !== 64) return null;
    const publicKey = createPublicKey({ key: publicKeyBytes, format: 'der', type: 'spki' });
    if (!verify(null, Buffer.from(heartbeatPayload(heartbeat)), publicKey, signature)) return null;
    return createHash('sha256').update(publicKeyBytes).digest('hex');
  } catch {
    return null;
  }
};

const validateHeartbeat = (identity, heartbeat, nowAt) => {
  if (!identity.subjectId || !identity.sessionId || !identity.deviceId || identity.platform !== 'desktop') return { error: '端侧心跳缺少已认证的桌面设备身份。', code: 'DESKTOP_ENDPOINT_IDENTITY_REQUIRED' };
  if (!heartbeat || typeof heartbeat !== 'object' || Array.isArray(heartbeat)) return { error: '端侧心跳格式无效。', code: 'DESKTOP_ENDPOINT_HEARTBEAT_INVALID' };
  if (Object.keys(heartbeat).some((key) => !ALLOWED_FIELDS.has(key))) return { error: '端侧心跳包含未授权字段。', code: 'DESKTOP_ENDPOINT_HEARTBEAT_ADDITIONAL_PROPERTY' };
  if (heartbeat.protocolVersion !== 'endpoint-runtime.v1') return { error: '端侧运行协议版本不受支持。', code: 'DESKTOP_ENDPOINT_PROTOCOL_UNSUPPORTED' };
  if (!/^endpoint-[0-9a-f-]{36}$/u.test(String(heartbeat.endpointId || ''))) return { error: '端侧实例标识无效。', code: 'DESKTOP_ENDPOINT_ID_INVALID' };
  if (!parseVersion(heartbeat.appVersion)) return { error: '桌面应用版本格式无效。', code: 'DESKTOP_ENDPOINT_VERSION_INVALID' };
  if (!['win32', 'darwin', 'linux'].includes(heartbeat.platform)) return { error: '端侧平台不受支持。', code: 'DESKTOP_ENDPOINT_PLATFORM_INVALID' };
  if (typeof heartbeat.packaged !== 'boolean') return { error: '端侧打包状态无效。', code: 'DESKTOP_ENDPOINT_PACKAGE_STATE_INVALID' };
  if (!['development_untrusted', 'packaged_unverified'].includes(heartbeat.trustClaim) || (heartbeat.packaged ? heartbeat.trustClaim !== 'packaged_unverified' : heartbeat.trustClaim !== 'development_untrusted')) {
    return { error: '端侧信任声明与运行状态不一致。', code: 'DESKTOP_ENDPOINT_TRUST_CLAIM_INVALID' };
  }
  if (!['file_system', 'os_user_bound'].includes(heartbeat.keyProtection)) return { error: '端侧私钥保护声明无效。', code: 'DESKTOP_ENDPOINT_KEY_PROTECTION_INVALID' };
  if (!/^[a-f0-9]{64}$/u.test(String(heartbeat.capabilityManifestHash || ''))) return { error: '端侧能力清单指纹无效。', code: 'DESKTOP_ENDPOINT_MANIFEST_INVALID' };
  const observedAt = new Date(heartbeat.observedAt || '').getTime();
  if (!Number.isFinite(observedAt) || Math.abs(nowAt - observedAt) > MAX_CLOCK_SKEW_MS) return { error: '端侧心跳时间无效或已经过期。', code: 'DESKTOP_ENDPOINT_CLOCK_INVALID' };
  const publicKeyFingerprint = verifyHeartbeatSignature(heartbeat);
  if (!publicKeyFingerprint) return { error: '端侧心跳签名无效。', code: 'DESKTOP_ENDPOINT_SIGNATURE_INVALID' };
  return { valid: true, publicKeyFingerprint };
};

const evaluateTrust = (heartbeat, publicKeyFingerprint) => {
  const versionCompatible = versionAtLeast(heartbeat.appVersion, minimumVersion());
  if (!versionCompatible) return { allowed: false, trustState: 'version_blocked', reason: `桌面端版本低于最低要求 ${minimumVersion()}。` };
  if (process.env.NODE_ENV !== 'production') {
    return { allowed: true, trustState: heartbeat.packaged ? 'packaged_demo_allowed' : 'development_allowed', reason: '本地开发环境允许已认证设备进行受控验证。' };
  }
  if (!heartbeat.packaged) return { allowed: false, trustState: 'development_rejected', reason: '生产环境不接受开发构建。' };
  if (heartbeat.keyProtection !== 'os_user_bound') return { allowed: false, trustState: 'key_protection_required', reason: '生产环境要求终端签名私钥使用操作系统用户绑定加密。' };
  if (!trustedEndpointKeys().has(publicKeyFingerprint)) return { allowed: false, trustState: 'endpoint_key_untrusted', reason: '该设备签名公钥尚未在生产环境登记。' };
  if (!trustedManifests().has(heartbeat.capabilityManifestHash)) return { allowed: false, trustState: 'manifest_untrusted', reason: '该端侧能力清单尚未加入生产信任列表。' };
  return { allowed: true, trustState: 'enterprise_trusted', reason: '打包状态、最低版本和服务器能力清单信任校验通过。' };
};

export function registerDesktopEndpointHeartbeat({ identityScope, heartbeat, nowAt = Date.now() }) {
  const identity = normalizeIdentity(identityScope);
  const validation = validateHeartbeat(identity, heartbeat, nowAt);
  if (!validation.valid) return validation;
  const trust = evaluateTrust(heartbeat, validation.publicKeyFingerprint);
  const lastSeenAt = new Date(nowAt).toISOString();
  const endpoint = {
    endpointId: heartbeat.endpointId,
    appVersion: heartbeat.appVersion,
    platform: heartbeat.platform,
    packaged: heartbeat.packaged,
    keyProtection: heartbeat.keyProtection,
    capabilityManifestHash: heartbeat.capabilityManifestHash,
    publicKeyFingerprint: validation.publicKeyFingerprint,
    trustState: trust.trustState,
    allowed: trust.allowed,
    reason: trust.reason,
    minimumVersion: minimumVersion(),
    lastSeenAt,
    expiresAt: new Date(nowAt + HEARTBEAT_TTL_MS).toISOString()
  };
  mutateState(ENDPOINT_NAMESPACE, endpointKey(identity), null, () => ({ value: endpoint, result: endpoint }));
  return { connected: true, ...structuredClone(endpoint) };
}

export function getDesktopEndpointStatus(identityScope, nowAt = Date.now()) {
  const identity = normalizeIdentity(identityScope);
  if (!identity.subjectId || !identity.sessionId || !identity.deviceId || identity.platform !== 'desktop') {
    return { connected: false, allowed: false, trustState: 'identity_missing', reason: '当前请求不是已认证的桌面设备。', minimumVersion: minimumVersion() };
  }
  const endpoint = readState(ENDPOINT_NAMESPACE, endpointKey(identity));
  if (!endpoint) return { connected: false, allowed: false, trustState: 'heartbeat_missing', reason: '当前设备尚未登记 Endpoint Runtime 心跳。', minimumVersion: minimumVersion() };
  if (new Date(endpoint.expiresAt).getTime() <= nowAt) return { ...structuredClone(endpoint), connected: false, allowed: false, trustState: 'heartbeat_stale', reason: '当前设备心跳已过期，请保持桌面端在线。' };
  return { connected: true, ...structuredClone(endpoint) };
}

export function authorizeDesktopEndpoint(identityScope, nowAt = Date.now()) {
  const status = getDesktopEndpointStatus(identityScope, nowAt);
  if (status.connected && status.allowed) return { allowed: true, status };
  return { allowed: false, status, error: `无法派发本机操作：${status.reason}`, code: `DESKTOP_ENDPOINT_${String(status.trustState || 'DENIED').toUpperCase()}` };
}
