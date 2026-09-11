// Synthetic-only evaluation through the existing Agent service entry point.
// Never executes a proposal, changes the user's store, or calls enterprise URLs.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadArkFileConfig } from './ark-file-config.mjs';

process.env.NODE_ENV = 'test';
process.env.RUNTIME_STORE_DRIVER = 'memory';
process.env.SEMANTIC_GOVERNANCE_STORE_DRIVER = 'runtime';
process.env.AGENT_RUNTIME_MODE = 'ark';
process.env.AGENT_MODEL_CONFIG_SOURCE = 'environment';
process.env.ENTERPRISE_CONNECTORS_CONFIG_JSON = '{}';
process.env.SEMANTICA_DEMO_BRIDGE_ENABLED = 'false';
loadArkFileConfig();
const { createSemanticOperationsTask } = await import('../backend/src/services/semantic-operations-task-service.js');
const { getOAMetaModelDraft } = await import('../backend/src/services/meta-model-service.js');
const { semanticFingerprint } = await import('../backend/src/services/semantic-model-fingerprint.js');
const { getRole } = await import('../backend/src/services/authorization-service.js');
const role = getRole('executive');
// Existing seeded IAM principal in this isolated in-memory process only.
// An arbitrary subject is correctly denied organization-scoped sample access.
const identityScope = { tenantId: 'demo-enterprise', subjectId: 'admin@demo.local', deviceId: 'synthetic-manufacturing-evaluation' };
const root = resolve(import.meta.dirname, '..');
const inputDir = resolve(root, 'examples/semantic-schemas/manufacturing-case');
const outputDir = resolve(root, 'output/semantic-manufacturing-fixed');
await mkdir(outputDir, { recursive: true });
const expected = JSON.parse(await readFile(resolve(inputDir, 'expected-world-model.json'), 'utf8'));
const requirements = await readFile(resolve(root, 'docs/development/SEMANTIC_MANUFACTURING_REQUIREMENTS.md'), 'utf8');
const rules = requirements.split('## 3.')[1].split('## 4.')[0];
const initialFingerprint = semanticFingerprint(await getOAMetaModelDraft());
const results = [];
const attach = async name => ({ name, mimeType: 'application/json', dataUrl: `data:application/json;base64,${Buffer.from(JSON.stringify(JSON.parse(await readFile(resolve(inputDir, name), 'utf8')))).toString('base64')}` });
function assessProposal(task, expectedIds) {
  const proposal = task.proposal;
  if (!proposal) return { produced: false, error: task.error || task.response, expectedObjects: expectedIds.length };
  const objects = proposal.objectTypes || [];
  const relations = proposal.relationshipTypes || [];
  const target = expected.objects.filter(item => expectedIds.includes(item.id));
  const targetRelations = expected.relations.filter(item => expectedIds.includes(item.from) && expectedIds.includes(item.to));
  return { produced: true, expectedObjects: target.length, objectCount: objects.length,
    objectMatches: target.filter(item => objects.some(object => object.id === item.id)).length,
    keyMatches: target.filter(item => objects.some(object => object.id === item.id && object.key === item.key)).length,
    sourceMatches: target.filter(item => objects.some(object => object.id === item.id && object.sourceSystems?.length === 1 && object.sourceSystems[0] === item.sourceSystem)).length,
    granularityMatches: target.filter(item => objects.some(object => object.id === item.id && object.granularity === item.granularity)).length,
    expectedRelations: targetRelations.length, relationCount: relations.length,
    relationMatches: targetRelations.filter(item => relations.some(r => r.from === item.from && r.to === item.to && r.cardinality === item.cardinality)).length,
    unexpectedObjects: objects.filter(item => !expectedIds.includes(item.id)).map(item => item.id),
    supplierCore: objects.find(item => item.id === 'Supplier')?.coreObject || null,
    critic: proposal.critic, mapping: proposal.mappingValidation,
    scenarioPersisted: Boolean(proposal.scenario), stateMachinesPersisted: Boolean(proposal.stateMachines?.length) };
}
async function run(id, text, files = [], parent = null, expectedIds = null) {
  const start = Date.now();
  let task;
  try { task = await createSemanticOperationsTask({ body: { text, attachments: await Promise.all(files.map(attach)), ...(parent?.id ? { parentTaskId: parent.id } : {}) }, role, identityScope }); }
  catch (error) { task = { error: 'evaluation_call_failed', errorType: error.name }; }
  const row = { id, milliseconds: Date.now() - start, source: task.routing?.source || null, status: task.status, intent: task.intent,
    answer: task.response || task.error, command: task.command || null, materialReview: task.materialReview,
    ...(expectedIds ? { assessment: assessProposal(task, expectedIds) } : {}), task };
  results.push(row);
  await writeFile(resolve(outputDir, `${id}.json`), JSON.stringify(row, null, 2));
  console.log(JSON.stringify({ id, milliseconds: row.milliseconds, source: row.source, status: row.status, intent: row.intent, objects: row.assessment?.objectCount, sourcesCorrect: row.assessment?.sourceMatches, relationshipsCorrect: row.assessment?.relationMatches }));
  return task;
}
const all = expected.objects.map(item => item.id);
const firstIds = expected.objects.filter(item => ['ERP', 'WMS'].includes(item.sourceSystem)).map(item => item.id);
const start = Date.now();
if (process.argv.includes('--combined-only')) {
  await run('T6-api-dictionary-retry', `根据合成 API 和数据字典生成完整候选模型供校对，不采纳不发布。逐对象系统和粒度以材料明确声明为准，保留状态、单位、金额口径与外键关系。${rules}`, ['combined-openapi.json', 'data-dictionary.json'], null, all);
  console.log(JSON.stringify({ type: 'combined_retry_summary', draftUnchanged: semanticFingerprint(await getOAMetaModelDraft()) === initialFingerprint, executedWrites: 0 }));
} else if (process.argv.includes('--dictionary-only')) {
  await run('T9-dictionary-only', `根据 ERP/WMS/LIMS/QMS/MES/OA 数据字典生成13类对象的完整候选。逐表 system 与 granularity 已明确，必须保留；请保留17条外键关系和需求中的规则、状态、指标口径。只展示供校对，不采纳不发布。${rules}`, ['data-dictionary.json'], null, all);
  console.log(JSON.stringify({ type: 'dictionary_only_summary', draftUnchanged: semanticFingerprint(await getOAMetaModelDraft()) === initialFingerprint, executedWrites: 0 }));
} else {
const t1 = await run('T1-understand', `以下全是合成材料，仅讨论，不建模、不保存、不发布。请说明业务流和数据粒度，以及最重要的四条控制规则。${rules}`, ['data-dictionary.json']);
const t2 = await run('T2-calculate', '基于新增样本和上文规则，只做分析，不保存不发布。请计算 PO-SYN-001 金额CNY、去重换算后的累计收货kg、当前账面库存kg、可用库存kg，以及 MO-SYN-01 缺口kg；说明重复投递与120kg领料怎样处理。只使用附件，不能读取企业系统。', ['sample-events.json'], t1);
await run('T3-causal-boundary', '沿用前文：AP-SYN-01 已 approved，是否说明 LOT-SYN-B 已放行？是否有证据证明该异常批次被 MO-SYN-OLD 消耗？指出应核对的记录和字段。只分析，不执行任何操作。', [], t2);
await run('T4-context-build', '根据前面已上传的完整字典、需求和样本生成候选语义模型，保留13类对象、所属系统、对象粒度和外键关系；供人工校对，不采纳、不发布。', [], t2, all);
await run('T5-api-only', '根据附件 ERP/WMS/LIMS/QMS/MES/OA 综合 API 生成候选模型供校对，不采纳不发布。严格使用各对象声明的来源系统、粒度、主键、标量外键及描述；保留业务关系。', ['combined-openapi.json'], null, all);
await run('T6-api-dictionary', `根据合成 API 和数据字典生成完整候选模型供校对，不采纳不发布。逐对象系统和粒度以材料明确声明为准，保留状态、单位、金额口径与外键关系。${rules}`, ['combined-openapi.json', 'data-dictionary.json'], null, all);
const t7 = await run('T7-first-batch', '先根据 ERP、WMS 两个系统的 API 生成本批候选供校对，不采纳不发布。保留对象来源和明示外键，后面还会补其他系统。', ['erp-openapi.json', 'wms-openapi.json'], null, firstIds);
await run('T8-merge-batch', '继续前面的建模任务，补充 LIMS、QMS、MES、OA 四个系统的 API；请与前一批 ERP/WMS 候选合并，生成全部13类对象的完整候选，不能丢弃前一批对象。只展示，不采纳不发布。', ['lims-openapi.json', 'qms-openapi.json', 'mes-openapi.json', 'oa-openapi.json'], t7, all);
const summary = { timestamp: new Date().toISOString(), provider: 'ark', model: process.env.ARK_MODEL, syntheticOnly: true,
  scope: 'real_model_existing_service_entrypoints_not_browser_not_live_enterprise', durationMilliseconds: Date.now() - start,
  totalTurns: results.length, arkTurns: results.filter(row => row.source === 'ark').length,
  draftUnchanged: semanticFingerprint(await getOAMetaModelDraft()) === initialFingerprint,
  executedWrites: 0, productionCodeModified: true,
  rows: results.map(({ task: _task, ...row }) => row) };
await writeFile(resolve(outputDir, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ type: 'summary', totalTurns: summary.totalTurns, arkTurns: summary.arkTurns, draftUnchanged: summary.draftUnchanged, milliseconds: summary.durationMilliseconds }));
}
