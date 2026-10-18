import { loadModelKeysConfig } from './model-keys-config.mjs';

let selected;
try { selected = loadModelKeysConfig(); }
catch {
  console.error('MODEL_KEYS_CONFIG_INVALID: fill the selected provider in private models.json; no server started, no key displayed.');
  process.exit(2);
}
if (process.argv.includes('--check-config')) {
  console.log(JSON.stringify({ status: 'configured', ...selected, networkCalled: false }));
} else {
  process.env.AGENT_RUNTIME_MODE = selected.provider;
  process.env.AGENT_MODEL_CONFIG_SOURCE = 'environment';
  process.env.AGENT_EXTERNAL_DATA_MODE ||= 'redacted';
  process.env.AGENT_EXTERNAL_MULTIMODAL_MODE ||= 'metadata_only';
  await import('../backend/src/app.js');
}
