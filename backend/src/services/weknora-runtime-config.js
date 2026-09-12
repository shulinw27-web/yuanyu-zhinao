import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createWeKnoraKnowledgeProvider, knowledgePrincipalKey } from './weknora-knowledge-provider.js';
import { knowledgeDigest, knowledgeFailure } from './knowledge-evidence-service.js';

// Credentials and resource grants belong to server-side private configuration.
// Re-read on each authorization check: removal/rotation must not be hidden by a cache.
export async function loadWeKnoraRuntimeProvider(context, file = process.env.WEKNORA_CONFIG_FILE) {
  const unavailable = code => ({ id: 'weknora_local', status: () => ({ provider: 'weknora_local', configured: false, readiness: code }),
    search: async () => knowledgeFailure(code, 503), read: async () => knowledgeFailure(code, 503) });
  if (!file) return unavailable('KNOWLEDGE_PROVIDER_NOT_CONFIGURED');
  async function load() {
    if (!isAbsolute(file)) throw new Error('invalid');
    const info = await stat(file);
    if (!info.isFile() || info.size > 65536) throw new Error('invalid');
    const raw = await readFile(file, 'utf8');
    if (Buffer.byteLength(raw) > 65536) throw new Error('invalid');
    const value = JSON.parse(raw);
    if (!value || value.schemaVersion !== 1 || value.enabled !== true
      || typeof value.apiKey !== 'string' || value.apiKey.length < 8 || value.apiKey.length > 4096
      || !Array.isArray(value.bindings) || value.bindings.length > 100
      || Object.keys(value).some(key => !['schemaVersion', 'enabled', 'baseUrl', 'apiKey', 'bindings', 'timeoutMs', 'retrievalMode'].includes(key))) throw new Error('invalid');
    return value;
  }
  try {
    const initial = await load();
    const connectionFingerprint = value => knowledgeDigest([value.apiKey, value.baseUrl, value.timeoutMs, value.retrievalMode]);
    const principalKey = knowledgePrincipalKey(context);
    const provider = createWeKnoraKnowledgeProvider({ context, apiKey: initial.apiKey, baseUrl: initial.baseUrl,
      timeoutMs: initial.timeoutMs ?? 2000, retrievalMode: initial.retrievalMode ?? 'keyword_only',
      resolveScope: async () => {
        const current = await load();
        if (connectionFingerprint(current) !== connectionFingerprint(initial)) return null;
        const matches = current.bindings.filter(binding => binding?.principalKey === principalKey);
        return matches.length === 1 ? matches[0] : null;
      }
    });
    return provider;
  } catch { return unavailable('KNOWLEDGE_CONFIGURATION_INVALID'); }
}
