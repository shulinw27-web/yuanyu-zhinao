import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export const DEFAULT_GLM_CONFIG_FILE = 'D:/wsl/private/yuanyu-zhinao/glm/glm.json';
export const GLM_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';

// Data only. Never print file contents, keys, or credential-bearing parse errors.
export function loadGlmFileConfig(env = process.env, platform = process.platform) {
  const file = env.GLM_CONFIG_FILE || (platform === 'win32' ? DEFAULT_GLM_CONFIG_FILE : null);
  if (!file || !isAbsolute(file)) throw new Error('GLM_CONFIG_FILE absolute path required');
  let config;
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > 16384) throw new Error('invalid file');
    config = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('GLM_CONFIG_FILE unreadable or invalid; contents withheld');
  }
  const validModel = value => typeof value === 'string' && /^glm-[a-z0-9._-]{1,80}$/u.test(value);
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || Object.keys(config).some(key => !['apiKey', 'model', 'baseUrl', 'allowedModels'].includes(key))
    || typeof config.apiKey !== 'string' || !/^[A-Za-z0-9._-]{20,512}$/u.test(config.apiKey)
    || !validModel(config.model) || config.baseUrl !== GLM_BASE_URL
    || !Array.isArray(config.allowedModels) || !config.allowedModels.length || config.allowedModels.length > 16
    || !config.allowedModels.every(validModel) || !config.allowedModels.includes(config.model)) {
    throw new Error('GLM_CONFIG_FILE schema or model approval invalid; contents withheld');
  }
  const values = { COMPATIBLE_LLM_API_KEY: config.apiKey, COMPATIBLE_LLM_MODEL: config.model,
    COMPATIBLE_LLM_BASE_URL: config.baseUrl, MODEL_ALLOWLIST_JSON: JSON.stringify({ compatible: config.allowedModels }) };
  for (const [key, value] of Object.entries(values)) if (env[key] === undefined) env[key] = value;
  return { loaded: true };
}
