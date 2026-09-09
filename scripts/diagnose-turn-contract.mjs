// Synthetic prompts only. Never prints request bodies, credentials or raw responses.
import { loadArkFileConfig } from './ark-file-config.mjs';
process.env.NODE_ENV = 'test';
process.env.RUNTIME_STORE_DRIVER = 'memory';
process.env.AGENT_RUNTIME_MODE = 'ark';
process.env.AGENT_MODEL_CONFIG_SOURCE = 'environment';
loadArkFileConfig();
const originalFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  const response = await originalFetch(...args);
  if (response.ok) {
    const payload = await response.clone().json();
    const raw = payload.choices?.[0]?.message?.content || '';
    let outer; let inner;
    try { outer = JSON.parse(raw); } catch { /* report shape only */ }
    try { inner = JSON.parse(outer?.answer); } catch { /* report shape only */ }
    console.log(JSON.stringify({ kind: 'contract_shape', finish: payload.choices?.[0]?.finish_reason, outerKeys: Object.keys(outer || {}), outerSchema: outer?.schemaVersion, answerType: typeof outer?.answer, answerLength: outer?.answer?.length, claimsExecution: outer?.claimsExecution, actionNull: outer?.proposedAction === null, receiptNull: outer?.executionReceipt === null, innerKeys: Object.keys(inner || {}), innerSchema: inner?.schemaVersion, intent: inner?.intent, clarificationType: typeof inner?.needsClarification }));
  } else console.log(JSON.stringify({ kind: 'provider_status', status: response.status }));
  return response;
};
const { understandAgentTurn } = await import('../backend/src/services/agent-turn-understanding-service.js');
for (let run = 0; run < 6; run++) {
  const result = await understandAgentTurn({ surface: 'semantic', input: '验收测试：你好，请用一句话说明你能做什么。不要建模或修改任何草稿。', safetyIdentifier: 'synthetic-contract-diagnostic' });
  console.log(JSON.stringify({ run, ...result }));
}
