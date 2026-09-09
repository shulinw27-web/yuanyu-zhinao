import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
const shortString = (value, limit = 256) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit;

export function readDingTalkConfiguration(env = process.env) {
  if (env.DINGTALK_ENABLED !== 'true') throw new Error('钉钉接入尚未启用。');
  if (!isAbsolute(env.DINGTALK_CONFIG_FILE || '')) throw new Error('需配置钉钉服务端配置文件的绝对路径。');
  if (statSync(env.DINGTALK_CONFIG_FILE).size > 128 * 1024) throw new Error('钉钉配置文件过大。');
  const text = readFileSync(env.DINGTALK_CONFIG_FILE, 'utf8');
  if (Buffer.byteLength(text) > 128 * 1024) throw new Error('钉钉配置文件过大。');
  const config = JSON.parse(text.replace(/^\uFEFF/, ''));
  if (!['corpId', 'clientId', 'clientSecret', 'tenantId'].every((key) => shortString(config[key]) && !config[key].startsWith('REPLACE_WITH_'))) throw new Error('钉钉企业、应用、密钥和平台租户配置不完整。');
  if (!Array.isArray(config.allowedOrigins) || !config.allowedOrigins.length || config.allowedOrigins.some((origin) => {
    try {
      const url = new URL(origin);
      return url.origin !== origin || !(url.protocol === 'https:' || (env.NODE_ENV !== 'production' && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)));
    } catch { return true; }
  })) throw new Error('钉钉入口需配置精确 HTTPS 来源（开发仅允许回环 HTTP）。');
  if (!Array.isArray(config.userBindings) || config.userBindings.some((binding) => !shortString(binding?.userId) || !shortString(binding?.account))) throw new Error('钉钉用户映射格式不正确。');
  if (new Set(config.userBindings.map((binding) => binding.userId)).size !== config.userBindings.length) throw new Error('钉钉用户映射存在重复。');
  if (new Set(config.userBindings.map((binding) => binding.account.trim().toLowerCase())).size !== config.userBindings.length) throw new Error('不得将多个钉钉成员绑定到同一平台账号。');
  return config;
}
