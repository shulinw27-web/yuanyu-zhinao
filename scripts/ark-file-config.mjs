import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { ARK_DEFAULT_BASE_URL, isAllowedArkEndpoint } from '../backend/src/services/ark-model-config.js';

export const DEFAULT_ARK_CONFIG_FILE = 'D:/wsl/private/yuanyu-zhinao/ark.json';

// File contents and parser errors must never reach logs. The file is data, not
// executable dotenv/JavaScript, and cannot change arbitrary process settings.
export function loadArkFileConfig(env = process.env, platform = process.platform) {
  const explicit = Boolean(env.ARK_CONFIG_FILE);
  const path = env.ARK_CONFIG_FILE || (platform === 'win32' ? DEFAULT_ARK_CONFIG_FILE : null);
  if (!path) return { loaded: false };
  if (!isAbsolute(path)) throw new Error('ARK_CONFIG_FILE must be an absolute path');
  let config;
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 16384) throw new Error('invalid file');
    config = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    if (!explicit && error.code === 'ENOENT') return { loaded: false };
    // JSON parser errors can contain the credential; intentionally omit cause.
    // eslint-disable-next-line preserve-caught-error
    throw new Error('ARK_CONFIG_FILE unreadable or invalid; contents withheld');
  }
  const keys = ['apiKey', 'model', 'baseUrl', 'allowedModels'];
  const validString = value => typeof value === 'string' && /^[A-Za-z0-9._-]{1,256}$/.test(value);
  if (!config || Array.isArray(config) || typeof config !== 'object'
    || Object.keys(config).some(key => !keys.includes(key))
    || !validString(config.apiKey) || config.apiKey.length < 20
    || !validString(config.model)
    || !Array.isArray(config.allowedModels) || !config.allowedModels.length
    || config.allowedModels.some(model => !validString(model))
    || !config.allowedModels.includes(config.model)
    || !isAllowedArkEndpoint(config.baseUrl || ARK_DEFAULT_BASE_URL)) {
    throw new Error('ARK_CONFIG_FILE schema or model approval invalid; contents withheld');
  }
  const values = {
    ARK_API_KEY: config.apiKey,
    ARK_MODEL: config.model,
    ARK_BASE_URL: config.baseUrl || ARK_DEFAULT_BASE_URL,
    MODEL_ALLOWLIST_JSON: JSON.stringify({ ark: config.allowedModels })
  };
  for (const [key, value] of Object.entries(values)) {
    // Explicit environment settings win, including a deliberate empty value.
    if (env[key] === undefined) env[key] = value;
  }
  return { loaded: true };
}
