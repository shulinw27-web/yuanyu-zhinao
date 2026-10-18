import { loadGlmFileConfig } from './glm-file-config.mjs';
import { validateModelSelection } from '../backend/src/services/model-governance-service.js';

try {
  loadGlmFileConfig();
  if (process.env.COMPATIBLE_LLM_BASE_URL !== 'https://open.bigmodel.cn/api/paas/v4'
    || !process.env.COMPATIBLE_LLM_API_KEY?.trim()
    || !validateModelSelection('compatible', process.env.COMPATIBLE_LLM_MODEL).allowed) throw new Error('configuration rejected');
} catch {
  console.error('GLM_CONFIG_REJECTED: check private file and exact model allowlist; contents withheld.');
  process.exit(2);
}
if (process.argv.includes('--check-config')) {
  console.log(JSON.stringify({ status: 'configured', provider: 'compatible', model: process.env.COMPATIBLE_LLM_MODEL, networkCalled: false }));
} else {
  process.env.AGENT_RUNTIME_MODE = 'compatible';
  process.env.AGENT_MODEL_CONFIG_SOURCE = 'environment';
  process.env.AGENT_EXTERNAL_DATA_MODE ||= 'redacted';
  process.env.AGENT_EXTERNAL_MULTIMODAL_MODE ||= 'metadata_only';
  await import('../backend/src/app.js');
}
