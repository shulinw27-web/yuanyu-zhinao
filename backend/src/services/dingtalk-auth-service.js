import { identityProviders } from './identity-provider-service.js';
import { createHash, randomBytes } from 'node:crypto';
import { findIAMUserByAccount } from './iam-store.js';
import { getRole } from './authorization-service.js';
import { issueIdentitySession } from './identity-session-service.js';

const fail = (code, error, status = 401) => ({ code, error, status });
const shortString = (value, limit = 256) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit;


// Only fixed official endpoints are allowed. Provider bodies and credential URLs
// must never be returned to the client or logged, including on upstream errors.
export function createDingTalkAuthService({ getConfig = () => identityProviders.dingTalkConfiguration(), fetchImpl = globalThis.fetch, findUser = findIAMUserByAccount, issueSession = issueIdentitySession, clock = Date.now } = {}) {
  const challenges = new Map();
  const usedCodes = new Map();
  let tokenCache = null;
  const digest = (value) => createHash('sha256').update(value).digest('hex');
  const prune = () => {
    for (const entries of [challenges, usedCodes]) for (const [key, item] of entries) if (item.expiresAt <= clock()) entries.delete(key);
  };
  const configFingerprint = (config) => digest(JSON.stringify(config));
  const load = () => { try { return getConfig(); } catch { return null; } };
  const allowed = (config, origin, deviceId, platform) => config.allowedOrigins.includes(origin) && shortString(deviceId, 160) && ['dingtalk-mobile', 'dingtalk-pc'].includes(platform);
  const post = async (url, body) => {
    const response = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000), redirect: 'error' });
    if (!response.ok) throw new Error('provider_failed');
    const text = await response.text();
    if (Buffer.byteLength(text) > 65536) throw new Error('provider_response_too_large');
    return JSON.parse(text);
  };
  const connection = () => {
    const config = load();
    return config ? { enabled: true, configured: true, corpId: config.corpId, clientId: config.clientId, channel: 'dingtalk', note: '钉钉身份需映射到已启用的平台账号。' }
      : { enabled: false, configured: false, channel: 'dingtalk', note: '钉钉接入未配置完成，请联系管理员。' };
  };
  const challenge = ({ origin, deviceId, platform }) => {
    const config = load();
    if (!config) return fail('DINGTALK_NOT_CONFIGURED', '钉钉接入未配置完成。', 503);
    if (!allowed(config, origin, deviceId, platform)) return fail('DINGTALK_CLIENT_DENIED', '钉钉入口来源或设备信息不符合配置。', 403);
    prune();
    if (challenges.size >= 4096) return fail('DINGTALK_BUSY', '登录请求过多，请稍后重试。', 429);
    const id = randomBytes(32).toString('hex');
    challenges.set(id, { origin, deviceId, platform, fingerprint: configFingerprint(config), expiresAt: clock() + 120000 });
    return { challengeId: id, expiresIn: 120 };
  };
  const login = async ({ challengeId, code, corpId, origin, deviceId, platform }) => {
    const config = load();
    if (!config) return fail('DINGTALK_NOT_CONFIGURED', '钉钉接入未配置完成。', 503);
    if (!allowed(config, origin, deviceId, platform) || corpId !== config.corpId) return fail('DINGTALK_CLIENT_DENIED', '钉钉企业或入口信息不匹配。', 403);
    prune();
    const pending = challenges.get(challengeId);
    challenges.delete(challengeId);
    if (!pending || pending.deviceId !== deviceId || pending.origin !== origin || pending.platform !== platform || pending.fingerprint !== configFingerprint(config)) return fail('DINGTALK_CHALLENGE_INVALID', '登录请求已失效，请重新发起钉钉登录。');
    if (!shortString(code, 2048)) return fail('DINGTALK_CODE_INVALID', '未收到有效的钉钉免登码。');
    const codeHash = digest(`${config.corpId}:${code}`);
    if (usedCodes.has(codeHash)) return fail('DINGTALK_CODE_REPLAY', '此免登码已使用，请重新登录。');
    if (usedCodes.size >= 4096) return fail('DINGTALK_BUSY', '登录请求过多，请稍后重试。', 429);
    usedCodes.set(codeHash, { expiresAt: clock() + 10 * 60000 });
    try {
      const fingerprint = digest(`${config.clientId}:${config.clientSecret}`);
      if (!tokenCache || tokenCache.fingerprint !== fingerprint || tokenCache.expiresAt <= clock()) {
        const token = await post('https://api.dingtalk.com/v1.0/oauth2/accessToken', { appKey: config.clientId, appSecret: config.clientSecret });
        if (!shortString(token.accessToken, 4096) || !Number.isFinite(token.expireIn) || token.expireIn <= 60) throw new Error('invalid_token');
        tokenCache = { fingerprint, token: token.accessToken, expiresAt: clock() + Math.min(token.expireIn - 60, 7140) * 1000 };
      }
      const result = await post(`https://oapi.dingtalk.com/topapi/v2/user/getuserinfo?access_token=${encodeURIComponent(tokenCache.token)}`, { code });
      if (result.errcode !== 0 || !shortString(result.result?.userid)) throw new Error('invalid_identity');
      const binding = config.userBindings.find((item) => item.userId === result.result.userid);
      const user = binding ? findUser(binding.account) : null;
      if (!user || user.status !== 'active' || !user.roleIds?.includes(user.primaryRoleId)) return fail('DINGTALK_IAM_UNMAPPED', '当前钉钉成员尚未绑定已启用的平台账号，请联系管理员。', 403);
      const role = getRole(user.primaryRoleId);
      if (role.id !== user.primaryRoleId) return fail('DINGTALK_ROLE_INVALID', '平台账号角色配置无效。', 403);
      // No name, phone, admin flag, role or account supplied by the browser is trusted.
      const session = await issueSession({ source: 'dingtalk', tenantId: config.tenantId, account: user.account, userName: user.name, roleId: role.id, roleName: role.name, deviceId, platform, identityBinding: { corpId: config.corpId, clientId: config.clientId, userId: result.result.userid }, externalIdentity: { providerId: 'dingtalk', tenantId: config.tenantId, subjectId: result.result.userid } });
      return { sessionId: session.id, user: { id: user.id, account: user.account, name: user.name, roleId: role.id, roleName: role.name, source: 'dingtalk' } };
    } catch {
      tokenCache = null;
      return fail('DINGTALK_LOGIN_FAILED', '钉钉身份验证未完成，请重新登录；持续失败请检查应用凭据、权限和服务端网络。', 502);
    }
  };
  return Object.freeze({ connection, challenge, login });
}

export const dingTalkAuth = createDingTalkAuthService();
