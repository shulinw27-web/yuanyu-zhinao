// Credentials may be loaded from an external private file. --check uses only a synthetic greeting and an
// isolated memory store; normal startup preserves the existing workspace store.
import { ARK_DEFAULT_BASE_URL, isAllowedArkEndpoint } from '../backend/src/services/ark-model-config.js';
import { validateModelSelection } from '../backend/src/services/model-governance-service.js';
import { loadArkFileConfig } from './ark-file-config.mjs';

const checkOnly = process.argv.includes('--check');
const runtimeMode = process.env.AGENT_RUNTIME_MODE || 'ark';
if (runtimeMode === 'ark') {
  try {
    loadArkFileConfig();
  } catch {
    console.error(JSON.stringify({ status: 'blocked', provider: 'ark', reason: 'ARK_CONFIG_FILE_INVALID', modelActuallyUsed: false }));
    process.exit(2);
  }
}
process.env.AGENT_RUNTIME_MODE = runtimeMode;
process.env.AGENT_MODEL_CONFIG_SOURCE = 'environment';
process.env.ARK_BASE_URL ||= ARK_DEFAULT_BASE_URL;
process.env.AGENT_EXTERNAL_DATA_MODE ||= 'redacted';
process.env.AGENT_EXTERNAL_MULTIMODAL_MODE ||= 'metadata_only';
const missing = [];
if (runtimeMode === 'ark') {
  if (!process.env.ARK_API_KEY?.trim()) missing.push('ARK_API_KEY');
  if (!process.env.ARK_MODEL?.trim()) missing.push('ARK_MODEL');
  if (!isAllowedArkEndpoint(process.env.ARK_BASE_URL)) missing.push('ARK_BASE_URL: rejected endpoint');
  if (!validateModelSelection('ark', process.env.ARK_MODEL).allowed) missing.push('MODEL_ALLOWLIST_JSON.ark: exact model approval required');
}

if (missing.length) {
  console.error(JSON.stringify({ status: 'blocked', provider: runtimeMode, missing, modelActuallyUsed: false }));
  process.exitCode = 2;
} else if (checkOnly) {
  process.env.NODE_ENV = 'test';
  process.env.RUNTIME_STORE_DRIVER = 'memory';
  const { generateModelSummary } = await import('../backend/src/services/local-model-gateway.js');
  const response = await generateModelSummary({ prompt: '这是一条合成连通测试。请用中文说明你能协助整理工作，但没有执行任何操作。', fallback: '本次测试未取得可用的模型回答。', safetyIdentifier: 'ark-synthetic-preflight' });
  const passed = response.source === runtimeMode;
  console.log(JSON.stringify({ status: passed ? 'passed' : 'failed', provider: runtimeMode, modelActuallyUsed: passed, inferenceSource: response.source, warning: response.warning || null, qualityConclusion: 'connectivity_and_output_contract_only' }));
  process.exitCode = passed ? 0 : 1;
} else {
  await import('../backend/src/app.js');
}
