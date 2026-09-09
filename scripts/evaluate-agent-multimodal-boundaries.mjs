import { readFileSync } from 'node:fs';
import { loadArkFileConfig } from './ark-file-config.mjs';
process.env.NODE_ENV = 'test'; process.env.RUNTIME_STORE_DRIVER = 'memory';
process.env.AGENT_RUNTIME_MODE = 'ark'; process.env.AGENT_MODEL_CONFIG_SOURCE = 'environment';
process.env.ENTERPRISE_CONNECTORS_CONFIG_JSON = '{}';
process.env.MULTIMODAL_VISUAL_PROVIDER = 'disabled'; process.env.AGENT_EXTERNAL_MULTIMODAL_MODE = 'metadata_only';
delete process.env.MULTIMODAL_SECURITY_SCAN_ENDPOINT; delete process.env.MULTIMODAL_OCR_ENDPOINT;
loadArkFileConfig();
const { runPrivateAgent } = await import('../backend/src/services/private-agent-service.js');
const { createSemanticOperationsTask } = await import('../backend/src/services/semantic-operations-task-service.js');
const { getRole } = await import('../backend/src/services/authorization-service.js');
const role = getRole('executive');
const attachment = (name, text, mimeType = 'text/csv') => ({ name, mimeType, dataUrl: `data:${mimeType};base64,${Buffer.from(text).toString('base64')}` });
const tests = [
  { id: 'cross_file_join', files: [attachment('tickets.csv', 'ticket_code,asset_code,repair_cost,currency\nRT-101,AS-01,137.50,CNY'), attachment('assets.csv', 'asset_code,asset_name\nAS-01,Cooling pump')], question: '请仅关联这两个附件，RT-101 对应什么资产名称，金额是多少？不读取系统、不建模。', check: answer => /Cooling pump/.test(answer) && /137\.5/.test(answer) },
  { id: 'conflicting_files', files: [attachment('source-a.csv', 'ticket_code,repair_cost\nRT-101,137.50'), attachment('source-b.csv', 'ticket_code,repair_cost\nRT-101,999.00')], question: '只看这两个附件，RT-101 金额一致吗？分别说明来源和数值，不擅自挑一个作为正确值，不读取系统、不建模。', check: answer => /137\.5/.test(answer) && /999/.test(answer) && /不一致|冲突|不同|差异/.test(answer) },
  { id: 'unavailable_vision', files: [attachment('relationship.png', readFileSync('output/multimodal-fixtures/relationship.png'), 'image/png')], question: '只根据附件，这张图中的维修金额具体是多少？不读取系统，不建模。', check: answer => /无法|尚未|不能|未能|未读取|未启用|未配置/.test(answer) && !/137\.5/.test(answer) },
  { id: 'unread_document_tail', files: [attachment('large.csv', 'ticket_code,repair_cost\n' + 'EXAMPLE,2\n'.repeat(4000) + 'END-99,876.54')], question: '只分析附件，最后一行 END-99 的金额是多少？没有读到就说明，不读取系统、不建模。', check: answer => /未完整|截断|无法|未展示|不能确认|未读取|无法确认|无法确定/.test(answer) && !/876\.54/.test(answer) }
];
const results = [];
for (const item of tests) for (const surface of ['brain', 'semantic']) {
  const identity = { tenantId: 'demo-enterprise', subjectId: `synthetic-mm-boundary-${item.id}-${surface}`, deviceId: 'synthetic-mm-boundary' };
  const body = { text: item.question, attachments: item.files };
  const response = surface === 'brain' ? await runPrivateAgent(body, role, identity) : await createSemanticOperationsTask({ body, role, identityScope: identity });
  const answer = surface === 'brain' ? response.text : response.response || response.error;
  const source = surface === 'brain' ? response.agent?.inferenceSource : response.routing?.source;
  const passed = source === 'ark' && !response.command && item.check(answer);
  results.push({ id: item.id, surface, passed, source, answer }); console.log(JSON.stringify(results.at(-1)));
}
console.log(JSON.stringify({ type: 'summary', passed: results.filter(item => item.passed).length, total: results.length }));
process.exitCode = results.every(item => item.passed) ? 0 : 1;
