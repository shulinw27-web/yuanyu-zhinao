// Explicit opt-in: synthetic reports only, in-memory store and no persistent config changes.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadArkFileConfig } from './ark-file-config.mjs';
if (!process.argv.includes('--live-synthetic')) {
  console.log('No model calls. Pass --live-synthetic to evaluate three synthetic report extractions using the configured Ark account.');
} else {
  const out = resolve('output/anomaly-assistant', new Date().toISOString().replace(/[:.]/g, '-'));
  await mkdir(out, { recursive: true }); const checks = [];
  try {
    Object.assign(process.env, { NODE_ENV: 'test', RUNTIME_STORE_DRIVER: 'memory', AGENT_MODEL_CONFIG_SOURCE: 'environment', AGENT_RUNTIME_MODE: process.env.AGENT_RUNTIME_MODE || 'ark', ANOMALY_MODEL_ALLOWED_MODES: process.env.ANOMALY_MODEL_ALLOWED_MODES || 'ark' });
    if (process.env.AGENT_RUNTIME_MODE === 'ark') loadArkFileConfig();
    const { changeAnomalyReport, extractAnomalyReport, anomalyPolicy } = await import('../backend/src/services/anomaly-assistant-service.js');
    const context = { identityScope: { tenantId: 'synthetic-anomaly', subjectId: 'synthetic-reporter' }, roleId: 'executive' };
    const canRead = () => true; const active = anomalyPolicy();
    const cases = [
      { name: 'estimate', text: '二车间3号灌装机漏液，批次B240914，估计二十多箱受影响，员工报告已停机。', check: r => r.fields.location?.value.includes('二车间') && r.fields.phenomenon?.value.includes('漏液') && r.fields.quantity?.value.includes('二十多箱') && !r.fields.occurredAt },
      { name: 'correction', text: '更正此前的汇报：不是B240914，是B240913。地点仍为二车间，异常是漏液，发生时间未知。', check: r => r.fields.batch?.value === 'B240913' && !r.fields.occurredAt?.value?.match(/\d{2}:\d{2}/) },
      { name: 'uncertain', text: '三号仓库疑似有异味，具体批次不清楚，数量还没有统计，请现场核实。', check: r => r.fields.location?.value.includes('三号仓库') && r.fields.phenomenon?.value.includes('异味') && !r.fields.batch && !r.fields.quantity }
    ];
    for (const item of process.argv.includes('--single') ? cases.slice(0, 1) : cases) {
      const start = performance.now();
      const created = await changeAnomalyReport({ context, canRead, action: 'create', body: { requestId: item.name, expectedRevision: 0, source: { kind: 'mock_group', text: item.text } } });
      if (!created.report) throw new Error('SYNTHETIC_CREATE_FAILED');
      const result = await extractAnomalyReport({ context, canRead, id: created.report.id, body: { expectedRevision: 1, consent: { confirmed: true, provider: active.provider, model: active.model } } });
      const row = { name: item.name, passed: !!result.report && !!item.check(result.report) && result.report.understanding?.stale === false && result.report.understanding.insights.some(i => i.kind === 'understanding'), milliseconds: Math.round(performance.now() - start),
        code: result.error || null, diagnostics: result.diagnostics, fields: result.report?.fields || null, understanding: result.report?.understanding || null, status: result.report?.status || null, execution: result.execution || 'none' };
      checks.push(row); console.log(JSON.stringify({ name: row.name, passed: row.passed, code: row.code, milliseconds: row.milliseconds }));
    }
  } catch (error) { checks.push({ name: 'configuration_or_transport', passed: false, code: error && /^[A-Z_][A-Z0-9_:.-]{0,80}$/.test(error.message) ? error.message : 'HARNESS_OR_TRANSPORT_FAILURE' }); }
  const report = { syntheticOnly: true, browserTest: false, imageOrAudioTest: false, downstreamWrite: false, checks, passed: checks.filter(c => c.passed).length, total: checks.length };
  await writeFile(resolve(out, 'assessment.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, total: report.total, out })); if (report.passed !== report.total) process.exitCode = 1;
}
