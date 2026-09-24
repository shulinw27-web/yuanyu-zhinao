// WorkBuddy 云服务（免密钥 LLM）配置读取。
// publishableKey 是应用级公开凭据，不带业务权限，按云服务契约允许保存在应用配置中；
// 真正的模型服务凭据保存在 WorkBuddy 服务端，永远不会下发。
import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const defaultConfigFile = resolve(moduleDir, '../../../config/workbuddy-cloud.json');
const MAX_CONFIG_BYTES = 64 * 1024;
const shortString = (value, limit = 256) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit;

export function isAllowedWorkBuddyCloudEndpoint(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && !url.port && !url.username && !url.password && !url.search && !url.hash
      && (url.hostname.endsWith('.workbuddy.host') || url.hostname.endsWith('.workbuddy.link'));
  } catch { return false; }
}

const modelIdValid = (value) => /^[\w.:-]{1,64}$/.test(String(value || ''));
const publishableKeyValid = (value) => /^wbpk_[A-Za-z0-9_-]{16,}$/.test(String(value || ''));

// 缺失或非法一律返回 null，由网关按“未配置”处理，不在请求路径抛出文件异常。
export function readWorkBuddyCloudConfiguration(env = process.env) {
  let file = defaultConfigFile;
  if (env.WORKBUDDY_CLOUD_CONFIG_FILE && isAbsolute(env.WORKBUDDY_CLOUD_CONFIG_FILE)) file = env.WORKBUDDY_CLOUD_CONFIG_FILE;
  let raw;
  try {
    if (statSync(file).size > MAX_CONFIG_BYTES) return null;
    raw = readFileSync(file, 'utf8');
  } catch { return null; }
  let config;
  try { config = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch { return null; }
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  if (!shortString(config.endpoint) || !isAllowedWorkBuddyCloudEndpoint(config.endpoint)) return null;
  if (!publishableKeyValid(config.publishableKey)) return null;
  if (!modelIdValid(config.model)) return null;
  const allowedModels = Array.isArray(config.allowedModels) ? config.allowedModels.filter(modelIdValid) : [];
  const pinned = [config.model, ...allowedModels.map(String)];
  return {
    version: Number.isInteger(config.version) ? config.version : 1,
    resourceId: shortString(config.resourceId) ? config.resourceId : null,
    applicationId: shortString(config.applicationId) ? config.applicationId : null,
    endpoint: config.endpoint,
    publishableKey: config.publishableKey,
    model: config.model,
    allowedModels: [...new Set(pinned)]
  };
}

export function workBuddyCloudModelIsConfigured(config, model) {
  return Boolean(config && modelIdValid(model) && config.allowedModels.includes(String(model)));
}
