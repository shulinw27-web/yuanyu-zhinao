import { readFile } from 'node:fs/promises';
import { loadArkFileConfig } from './ark-file-config.mjs';

// Isolated synthetic evaluation: never use or mutate the user's SQLite store.
process.env.NODE_ENV = 'test';
process.env.RUNTIME_STORE_DRIVER = 'memory';
process.env.ENTERPRISE_CONNECTORS_CONFIG_JSON = '{}';
process.env.CONNECTOR_MOCK_MODE = 'enabled';
process.env.AGENT_MODEL_CONFIG_SOURCE = 'environment';
const mockContractOnly = process.argv.includes('--mock-contract-only');
if (mockContractOnly) process.env.AGENT_RUNTIME_MODE = 'mock';
if (!mockContractOnly && process.env.AGENT_RUNTIME_MODE === 'ark') {
  try { loadArkFileConfig(); } catch {
    console.error(JSON.stringify({ status: 'blocked', reason: 'ARK_CONFIG_FILE_INVALID' }));
    process.exit(2);
  }
}
const dataset = JSON.parse(await readFile(new URL('../examples/agent-evaluation/cases.json', import.meta.url), 'utf8'));
const { getLocalModelRuntime } = await import('../backend/src/services/local-model-gateway.js');
const runtime = getLocalModelRuntime();
const report = { schemaVersion: 'agent-evaluation-report.v1', evaluatedAt: new Date().toISOString(), mode: mockContractOnly ? 'mock_contract_only' : 'real_model', provider: runtime.mode, model: runtime.model, status: 'running', qualityConclusion: 'requires_human_rubric_review', cases: [], manualOnly: dataset.manualOnly };
if (!mockContractOnly) {
  if (runtime.mode === 'ark') {
    const { getModelConnectionConfiguration } = await import('../backend/src/services/local-model-gateway.js');
    if (!getModelConnectionConfiguration().providers.find((item) => item.id === 'ark')?.configured) {
      report.status = 'blocked'; report.reason = 'Ark key, endpoint, exact model and allowlist must be configured. No evaluation was run.';
    }
  } else if (runtime.mode !== 'local') {
    report.status = 'blocked'; report.reason = 'Set AGENT_RUNTIME_MODE=local or ark, the endpoint, exact model and its allowlist before evaluating.';
  } else {
    try {
      const endpoint = `${String(process.env.LOCAL_LLM_BASE_URL || 'http://127.0.0.1:11434/v1').replace(/\/$/, '')}/models`;
      const response = await fetch(endpoint, { headers: process.env.LOCAL_LLM_API_KEY ? { Authorization: `Bearer ${process.env.LOCAL_LLM_API_KEY}` } : {}, signal: AbortSignal.timeout(5000) });
      const payload = await response.json();
      if (!response.ok || !payload.data?.some((item) => item.id === runtime.model)) throw new Error('Exact model unavailable');
    } catch { report.status = 'blocked'; report.reason = 'The local endpoint did not advertise the exact configured model. No evaluation was run.'; }
  }
}
if (report.status !== 'blocked') {
  const { runPrivateAgent } = await import('../backend/src/services/private-agent-service.js');
  const { getRole } = await import('../backend/src/services/authorization-service.js');
  for (const item of dataset.cases) {
    const request = { text: item.text, ...(item.csv ? { attachments: [{ name: 'synthetic-cases.csv', mimeType: 'text/csv', dataUrl: `data:text/csv;base64,${Buffer.from(item.csv).toString('base64')}` }] } : {}) };
    const startedAt = Date.now();
    const response = await runPrivateAgent(request, getRole(item.roleId || 'executive'), { tenantId: 'demo-enterprise', subjectId: item.subjectId || 'admin@demo.local', sessionId: 'evaluation-session', deviceId: 'evaluation-device' });
    const checks = {
      noWriteProposal: !response.command,
      expectedLifecycle: !item.expectedLifecycle || response.lifecycle?.state === item.expectedLifecycle,
      requiredText: (item.mustInclude || []).every((value) => response.text.includes(value)),
      prohibitedText: !(item.mustExclude || []).some((value) => response.text.includes(value)),
      modelRequirementSatisfied: mockContractOnly || !item.requiresInference || response.agent?.inferenceSource === runtime.mode
    };
    report.cases.push({ id: item.id, milliseconds: Date.now() - startedAt, checks, passed: Object.values(checks).every(Boolean), modelActuallyUsed: !mockContractOnly && response.agent?.inferenceSource === runtime.mode, inferenceSource: response.agent?.inferenceSource || null, lifecycle: response.lifecycle?.state || null, answer: response.text, rubric: item.rubric });
  }
  report.status = report.cases.every((item) => item.passed) ? 'contract_checks_passed' : 'contract_checks_failed';
}
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.status === 'blocked' ? 2 : report.status === 'contract_checks_failed' ? 1 : 0;
