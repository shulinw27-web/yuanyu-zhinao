// 系统物料补充 + 大模型理解专项测试（2026-10-07，需求 2）。
//
// 覆盖：
//   1. 已接入（connected）系统补充文档：提取文本追加 + 补充记录
//   2. 补充说明（note）与警告记录
//   3. 生命周期门禁：未登记系统码 404、退回 draft 状态 409
//   4. 输入门禁：空请求体拒绝、超限文档拒绝
//   5. 大模型理解：POST regenerate → Mock 模式受控摘要（source='mock'，不编造）+ 缓存
//   6. 大模型理解：GET 读缓存（不重算）
//   7. 大模型理解：未知系统码 404
import test from 'node:test';
import assert from 'node:assert/strict';
import { resetRuntimeState } from '../src/repositories/runtime-state-repository.js';
import { runWithSemanticTenant } from '../src/services/semantic-tenant-context.js';
import { registerTenantCustomSystem, transitionSystemConnection } from '../src/services/system-registry-service.js';
import { getSystemDocumentTexts } from '../src/services/system-access-service.js';
import { supplementSystemMaterials, getSystemUnderstanding } from '../src/services/system-material-service.js';

if (process.env.NODE_ENV !== 'test' || process.env.RUNTIME_STORE_DRIVER !== 'memory') throw new Error('Use the runtime-test-bootstrap memory store.');

const NAMESPACES = ['system_access_runtime', 'system_registry_runtime', 'key_center', 'system_monitoring_runtime', 'system_material_runtime'];
const identity = tenantId => ({ tenantId, subjectId: 'material-tester', deviceId: 'device-1' });
const within = (tenant, work) => runWithSemanticTenant(identity(tenant), work);

const baseMaterials = (overrides = {}) => ({
  name: '物料补充测试系统',
  domain: '供应链',
  description: '管理供应商数据的外部平台，覆盖寻源到付款全流程。',
  keyEntities: ['供应商档案'],
  dataDomains: ['production', 'internal'],
  accessIntention: '读取供应商资质与绩效数据，支撑采购风险分析。',
  businessOwner: '采购负责人',
  heartbeat: { endpoint: 'https://api.example.com/health', method: 'GET', expectedStatus: 200 },
  auth: { scheme: 'user_token_passthrough', writeApprovalRequired: true },
  ...overrides
});

const csvDocument = (rows = '字段,类型,主键\n供应商编码,string,true\n供应商名称,string,false') => ({
  mimeType: 'text/csv',
  dataUrl: `data:text/csv;base64,${Buffer.from(rows, 'utf8').toString('base64')}`
});

function registerAndConnect(tenant, code, overrides = {}) {
  within(tenant, () => registerTenantCustomSystem({ materials: baseMaterials({ code, ...overrides }), actor: { id: 'tester' } }));
  within(tenant, () => transitionSystemConnection({ code, to: 'authorized', reason: '授权通过', actor: { id: 'tester' } }));
  within(tenant, () => transitionSystemConnection({ code, to: 'connected', reason: '测试接通', actor: { id: 'tester' } }));
}

test.beforeEach(() => resetRuntimeState(NAMESPACES));

test('已接入系统补充文档：提取文本追加 + 补充记录', async () => {
  await within('mat-a', async () => {
    registerAndConnect('mat-a', 'MATA');
    const before = getSystemDocumentTexts('MATA').documents.length;
    const result = await supplementSystemMaterials({
      code: 'MATA',
      body: { attachmentDocuments: [csvDocument()], note: '补充供应商主键定义' },
      identityScope: identity('mat-a')
    });
    assert.equal(result.error, undefined, `补充应成功：${result.error || ''}`);
    assert.equal(result.documentTexts.added, 1, '应追加 1 份文档');
    assert.equal(result.documentTexts.total, before + 1, '追加后总量应 +1');
    assert.equal(result.supplement.documentCount, 1);
    assert.equal(result.supplement.note, '补充供应商主键定义');
    const stored = getSystemDocumentTexts('MATA');
    assert.equal(stored.documents.length, before + 1, '系统文档提取文本应已追加');
  });
});

test('仅补充说明（无文档）也成功；解析告警写入补充记录', async () => {
  await within('mat-b', async () => {
    registerAndConnect('mat-b', 'MATB');
    const result = await supplementSystemMaterials({
      code: 'MATB',
      body: { note: '本次仅补充文字说明，说明对账口径。' },
      identityScope: identity('mat-b')
    });
    assert.equal(result.error, undefined);
    assert.equal(result.documentTexts.added, 0);
    assert.equal(result.supplement.note, '本次仅补充文字说明，说明对账口径。');
  });
});

test('生命周期门禁：未登记系统码 404、退回 draft 状态 409', async () => {
  await within('mat-c', async () => {
    const missing = await supplementSystemMaterials({ code: 'NOSUCH', body: { note: 'x' }, identityScope: identity('mat-c') });
    assert.equal(missing.code, 'SYSTEM_NOT_REGISTERED');
    assert.equal(missing.status, 404);
    // 登记后退回 draft → 状态门禁拒绝
    within('mat-c', () => registerTenantCustomSystem({ materials: baseMaterials({ code: 'MATC' }), actor: { id: 'tester' } }));
    within('mat-c', () => transitionSystemConnection({ code: 'MATC', to: 'draft', reason: '退回重新登记', actor: { id: 'tester' } }));
    const rejected = await supplementSystemMaterials({ code: 'MATC', body: { note: 'x' }, identityScope: identity('mat-c') });
    assert.equal(rejected.code, 'SYSTEM_MATERIALS_SUPPLEMENT_STATE_REJECTED');
    assert.equal(rejected.status, 409);
  });
});

test('输入门禁：空请求体拒绝、超限文档拒绝、dataUrl 形式拒绝', async () => {
  await within('mat-d', async () => {
    registerAndConnect('mat-d', 'MATD');
    const empty = await supplementSystemMaterials({ code: 'MATD', body: {}, identityScope: identity('mat-d') });
    assert.equal(empty.code, 'SYSTEM_MATERIALS_SUPPLEMENT_EMPTY');
    const tooMany = await supplementSystemMaterials({
      code: 'MATD',
      body: { attachmentDocuments: Array.from({ length: 9 }, () => csvDocument()) },
      identityScope: identity('mat-d')
    });
    assert.equal(tooMany.code, 'SYSTEM_MATERIALS_SUPPLEMENT_INPUT_INVALID');
    assert.ok(Array.isArray(tooMany.issues), '应逐字段返回 issues');
    const badUrl = await supplementSystemMaterials({
      code: 'MATD',
      body: { attachmentDocuments: [{ mimeType: 'text/csv', dataUrl: 'not-a-data-url' }] },
      identityScope: identity('mat-d')
    });
    assert.equal(badUrl.code, 'SYSTEM_MATERIALS_SUPPLEMENT_INPUT_INVALID');
  });
});

test('大模型理解：POST regenerate → Mock 模式受控摘要 + 缓存；GET 读缓存', async () => {
  await within('mat-e', async () => {
    registerAndConnect('mat-e', 'MATE');
    await supplementSystemMaterials({ code: 'MATE', body: { note: '对账口径以供应商编码为准。' }, identityScope: identity('mat-e') });
    const generated = await getSystemUnderstanding({ code: 'MATE', regenerate: true, identityScope: identity('mat-e') });
    assert.equal(generated.error, undefined, `理解应生成成功：${generated.error || ''}`);
    assert.equal(generated.cached, false);
    assert.ok(generated.understanding.answer.includes('受控摘要'), 'Mock 模式应为受控摘要（不编造）');
    assert.ok(generated.understanding.answer.includes('供应商档案'), '摘要应引用登记的核心对象');
    assert.equal(generated.understanding.modelMode, 'mock');
    assert.equal(generated.understanding.sourceFacts.lastProbeStatus, null, '尚无探测记录');
    assert.equal(generated.understanding.sourceFacts.supplementCount, 1);
    // GET 读缓存（不重算）
    const cached = await getSystemUnderstanding({ code: 'MATE', regenerate: false, identityScope: identity('mat-e') });
    assert.equal(cached.cached, true);
    assert.equal(cached.understanding.generatedAt, generated.understanding.generatedAt, 'GET 应返回缓存而非重算');
  });
});

test('大模型理解：未生成时 GET 返回指引；未知系统码 404', async () => {
  await within('mat-f', async () => {
    registerAndConnect('mat-f', 'MATF');
    const notGenerated = await getSystemUnderstanding({ code: 'MATF', regenerate: false, identityScope: identity('mat-f') });
    assert.equal(notGenerated.understanding, null);
    assert.ok(notGenerated.howToGenerate, '应返回生成指引');
    const missing = await getSystemUnderstanding({ code: 'NOSUCH', regenerate: false, identityScope: identity('mat-f') });
    assert.equal(missing.code, 'SYSTEM_NOT_REGISTERED');
    assert.equal(missing.status, 404);
  });
});

test('补充物料会使同一租户同一系统的旧理解失效，避免把过期摘要当作最新事实', async () => {
  await within('mat-cache', async () => {
    registerAndConnect('mat-cache', 'MATCACHE');
    const first = await getSystemUnderstanding({ code: 'MATCACHE', regenerate: true, identityScope: identity('mat-cache') });
    assert.ok(first.understanding?.answer);
    const supplemented = await supplementSystemMaterials({
      code: 'MATCACHE', body: { note: '新增：接口字段 supplier_level 代表供应商分级。' }, identityScope: identity('mat-cache')
    });
    assert.equal(supplemented.understandingInvalidated, true);
    const stale = await getSystemUnderstanding({ code: 'MATCACHE', regenerate: false, identityScope: identity('mat-cache') });
    assert.equal(stale.cached, false);
    assert.equal(stale.understanding, null);
  });
});
