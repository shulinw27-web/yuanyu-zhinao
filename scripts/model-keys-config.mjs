import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { isAllowedArkEndpoint } from '../backend/src/services/ark-model-config.js';
import { validateModelSelection } from '../backend/src/services/model-governance-service.js';

export const DEFAULT_MODEL_KEYS_FILE = 'D:/wsl/private/yuanyu-zhinao/models.json';
const profiles = Object.freeze({ glm: 'compatible', ark: 'ark', deepseek: 'deepseek', qwen: 'compatible', kimi: 'compatible', compatible: 'compatible' });
const fail = () => { throw new Error('MODEL_KEYS_CONFIG_INVALID: check selected provider, key, model and HTTPS endpoint; contents withheld'); };

export function loadModelKeysConfig(env = process.env, platform = process.platform) {
  const file = env.MODEL_KEYS_FILE || (platform === 'win32' ? DEFAULT_MODEL_KEYS_FILE : null);
  if (!file || !isAbsolute(file)) fail();
  let config;
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > 65536) fail();
    config = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch { fail(); }
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || Object.keys(config).some(key => !['activeProvider', 'providers'].includes(key))
    || !Object.hasOwn(profiles, config.activeProvider)
    || !config.providers || typeof config.providers !== 'object' || Array.isArray(config.providers)
    || Object.keys(config.providers).some(key => !Object.hasOwn(profiles, key))) fail();
  for (const entry of Object.values(config.providers)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).some(key => !['apiKey', 'model', 'baseUrl'].includes(key))
      || !['apiKey', 'model', 'baseUrl'].every(key => typeof entry[key] === 'string')) fail();
  }
  const entry = config.providers[config.activeProvider];
  if (!entry || !/^[A-Za-z0-9._-]{20,512}$/u.test(entry.apiKey)
    || !/^[A-Za-z0-9._-]{1,256}$/u.test(entry.model)) fail();
  let url;
  try { url = new URL(entry.baseUrl); } catch { fail(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || entry.baseUrl.trim() !== entry.baseUrl || /[\u0000-\u0020]/u.test(entry.baseUrl)) fail();
  if (config.activeProvider === 'glm' && (entry.baseUrl !== 'https://open.bigmodel.cn/api/paas/v4' || !entry.model.startsWith('glm-'))) fail();
  if (config.activeProvider === 'ark' && !isAllowedArkEndpoint(entry.baseUrl)) fail();
  if (config.activeProvider === 'deepseek' && !['https://api.deepseek.com', 'https://api.deepseek.com/v1'].includes(entry.baseUrl)) fail();
  const provider = profiles[config.activeProvider];
  const prefix = provider === 'compatible' ? 'COMPATIBLE_LLM' : provider.toUpperCase();
  const values = { [`${prefix}_API_KEY`]: entry.apiKey, [`${prefix}_MODEL`]: entry.model, [`${prefix}_BASE_URL`]: entry.baseUrl.replace(/\/$/, '') };
  // Conflicting environment endpoints cannot receive the selected file's key.
  for (const [key, value] of Object.entries(values)) if (env[key] !== undefined && env[key] !== value) fail();
  const allowlist = env.MODEL_ALLOWLIST_JSON ?? JSON.stringify({ [provider]: [entry.model] });
  if (!validateModelSelection(provider, entry.model, { ...env, MODEL_ALLOWLIST_JSON: allowlist }).allowed) fail();
  Object.assign(env, values, { MODEL_ALLOWLIST_JSON: allowlist });
  return { provider, profile: config.activeProvider, model: entry.model };
}
