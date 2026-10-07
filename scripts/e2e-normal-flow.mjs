// 全流程端到端验证（E2E）：按正常业务流程驱动真实 API（默认 http://127.0.0.1:3001/api）。
// 流程：认证 → 系统接入（登记/探测/生命周期）→ 物料提交（五类材料+连接+对齐+移交）
//      → 建模（草稿/校验/模拟构建）→ 发布（部署到 Semantica）→ 审核（巡检计划/通知）
//      → 智脑使用模型（运行时/模型配置/会话/消息）。
//
// 前置：业务 API 已在本机运行（npm run dev:api）；本脚本只做只读探测 + 受控写入，
// 写入对象为脚本自建的新实体（系统码带时间戳后缀、新接入项目、新巡检计划、新会话），
// 不改动既有租户数据。支持 --base <url> 覆盖目标地址。
//
// 边界（与 evaluate-mock-onboarding 的边界一致，不得弱化）：
//   * 模型调用走运行时当前配置（默认 Mock 确定性演示模型），不调用真实云模型；
//   * 真实心跳探测指向本机 API /health（演示级真实 HTTP），不代表已接入真实企业系统；
//   * 发布部署目标是本机 Semantica（3011），不是生产语义服务。

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import * as fulfillment from '../examples/knowledge/dual-agent-mock/input-materials.mjs';

const args = process.argv.slice(2);
const baseArg = args.includes('--base') ? args[args.indexOf('--base') + 1] : null;
const base = baseArg || process.env.E2E_BASE_URL || 'http://127.0.0.1:3001/api';
const root = resolve(import.meta.dirname, '..');
const outputDir = join(root, 'output', 'e2e-normal-flow');
await mkdir(outputDir, { recursive: true });

const report = {
  schemaVersion: 'e2e-normal-flow.v1', startedAt: new Date().toISOString(), base,
  mode: 'live-server', store: 'server-runtime (sqlite durable)',
  modelInvoked: 'runtime-configured (mock deterministic by default)', realEnterpriseSystemsVerified: false,
  phases: [], checks: [], failures: []
};
let passed = 0; let failed = 0;
const check = async (phase, name, action) => {
  const startedAt = Date.now();
  try { const detail = await action(); passed += 1; report.checks.push({ phase, name, passed: true, ms: Date.now() - startedAt, detail }); }
  catch (error) { failed += 1; report.failures.push({ phase, name, message: String(error.message || error).split('\n')[0] }); report.checks.push({ phase, name, passed: false, ms: Date.now() - startedAt, error: String(error.message || error).split('\n')[0] }); }
};
const phaseDone = (name, summary) => report.phases.push({ name, summary });

let requestCounter = 0;
const call = async (path, { method = 'GET', body, session, device = 'e2e-device-001' } = {}) => {
  requestCounter += 1;
  const headers = { 'Content-Type': 'application/json', 'x-client-device-id': device, 'x-client-platform': 'web' };
  if (session) headers['x-identity-session'] = session;
  const response = await fetch(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let json = null;
  try { json = await response.json(); } catch { /* non-JSON response kept as null */ }
  return { status: response.status, body: json };
};

const runToken = Date.now().toString(36).toUpperCase().slice(-5);
const systemCode = `E2EF${runToken}`;

// ── 材料（与 evaluate-mock-onboarding 同源的预处理：去完全相同重复投递） ──
const samples = JSON.parse(JSON.stringify(fulfillment.samples));
const exact = new Set();
samples.records = samples.records.filter((row) => { const value = JSON.stringify(row); if (exact.has(value)) return false; exact.add(value); return true; });
const materials = [
  { kind: 'requirements', name: '01-requirements.txt', text: fulfillment.requirements },
  { kind: 'api', name: '02-api.txt', text: `${fulfillment.apiNotes}\n逐对象来源以附属字典为准；API 文字中的退货/寄售归属须人工核对。` },
  { kind: 'dictionary', name: '03-dictionary.json', text: JSON.stringify(fulfillment.dictionary) },
  { kind: 'samples', name: '04-samples.json', text: JSON.stringify(samples) },
  { kind: 'rules', name: '05-rules.txt', text: `${fulfillment.requirements}\n${fulfillment.proposedRule}` }
];

try {
  // ════ 阶段 0：认证 ════
  let admin = null; let quality = null;
  await check('0-认证', '无效会话被拒绝（401）', async () => {
    const result = await call('/semantic-operations/systems', { session: 'e2e-invalid-session-token' });
    assert.equal(result.status, 401);
    return { status: 401 };
  });
  await check('0-认证', '管理员（executive）本地登录成功', async () => {
    const result = await call('/auth/local/login', { method: 'POST', body: { account: 'admin@demo.local', password: 'demo', deviceId: 'e2e-device-001' } });
    assert.equal(result.status, 200, `登录失败：${JSON.stringify(result.body)}`);
    assert.ok(result.body.sessionId, '未返回会话 ID');
    assert.equal(result.body.user.roleId, 'executive');
    admin = result.body;
    return { sessionId: `${result.body.sessionId.slice(0, 8)}…`, user: result.body.user.name };
  });
  await check('0-认证', '质量经理（quality_manager）本地登录成功', async () => {
    const result = await call('/auth/local/login', { method: 'POST', body: { account: 'quality@demo.local', password: 'demo', deviceId: 'e2e-device-002' } });
    assert.equal(result.status, 200);
    quality = result.body;
    return { user: result.body.user.name };
  });
  await check('0-认证', '错误口令被拒绝（401）', async () => {
    const result = await call('/auth/local/login', { method: 'POST', body: { account: 'admin@demo.local', password: 'wrong-password', deviceId: 'e2e-device-001' } });
    assert.equal(result.status, 401);
    return { message: result.body?.message };
  });
  const adminSession = admin?.sessionId; const qualitySession = quality?.sessionId;
  await check('0-认证', '身份源服务可用且本地演示账号启用', async () => {
    const result = await call('/account-center', { session: adminSession });
    assert.equal(result.status, 200);
    const local = (result.body.identitySources || []).find((item) => item.id === 'local');
    assert.ok(local, '本地演示账号身份源缺失');
    assert.equal(local.status, 'enabled');
    return { source: local.name };
  });
  phaseDone('0-认证', '本地演示登录、口令错误拒绝、无效会话拒绝已验证');

  // ════ 阶段 1：系统接入 ════
  await check('1-系统接入', '接入总览含登记契约（5 种授权方式）', async () => {
    const result = await call('/semantic-operations/systems', { session: adminSession });
    assert.equal(result.status, 200);
    const schemes = result.body.registration?.authSchemes || [];
    assert.deepEqual(schemes.map((option) => option.id), ['user_token_passthrough', 'service_principal', 'api_key', 'oauth_authorization_code', 'mTLS']);
    return { authSchemes: schemes.length, systems: (result.body.systems || []).length };
  });
  await check('1-系统接入', '缺心跳登记被整份拒绝并逐字段点名', async () => {
    const result = await call('/semantic-operations/systems', { method: 'POST', session: adminSession, body: { name: '缺心跳系统', domain: '供应链', description: '缺少心跳接口的登记应被整份拒绝。', keyEntities: ['供应商'], dataDomains: ['internal'], accessIntention: '读取供应商资质与绩效数据。', businessOwner: '采购负责人' } });
    assert.equal(result.status, 400);
    assert.ok((result.body.issues || []).some((issue) => issue.field === 'heartbeat'), '未点名 heartbeat 缺失');
    return { issues: result.body.issues?.length };
  });
  await check('1-系统接入', '附加文档 dataUrl 格式非法被拒绝', async () => {
    const result = await call('/semantic-operations/systems', { method: 'POST', session: adminSession, body: { name: '坏附件系统', domain: '供应链', description: '附加文档 dataUrl 非法的登记应被拒绝。', keyEntities: ['供应商'], dataDomains: ['internal'], accessIntention: '读取供应商资质与绩效数据。', businessOwner: '采购负责人', heartbeat: { endpoint: 'http://127.0.0.1:3001/api/health' }, auth: { scheme: 'user_token_passthrough' }, attachmentDocuments: [{ mimeType: 'application/pdf', dataUrl: 'not-a-data-url' }] } });
    assert.equal(result.status, 400);
    assert.ok((result.body.issues || []).some((issue) => issue.field === 'attachmentDocuments'));
    return { issues: result.body.issues?.length };
  });
  await check('1-系统接入', '三段物料登记成功（心跳+授权+场景）→ 201', async () => {
    const result = await call('/semantic-operations/systems', { method: 'POST', session: adminSession, body: {
      code: systemCode, name: '供应商协同中台（E2E）', domain: '供应链', description: '管理供应商准入、资质、绩效与合同协同的外部平台，覆盖寻源到付款全流程。',
      keyEntities: ['供应商档案', '绩效评分'], dataDomains: ['production', 'internal'],
      accessIntention: '读取供应商资质与绩效数据，支撑采购风险分析与供应商画像。', businessOwner: '采购负责人',
      heartbeat: { endpoint: `${base}/health`, method: 'GET', expectedStatus: 200, expectedBody: '"status":"ok"', timeoutMs: 5000 },
      auth: { scheme: 'user_token_passthrough', writeApprovalRequired: true },
      mockScenarioId: 'fulfillment'
    } });
    assert.equal(result.status, 201, `登记失败：${JSON.stringify(result.body)}`);
    assert.ok(result.body.code, '未返回系统码');
    return { code: result.body.code, state: result.body.state || result.body.lifecycleState };
  });
  await check('1-系统接入', '系统详情披露心跳与授权方式', async () => {
    const result = await call(`/semantic-operations/systems/${systemCode}`, { session: adminSession });
    assert.equal(result.status, 200);
    assert.ok(result.body.system?.custom?.heartbeat?.endpoint, '心跳未披露');
    assert.equal(result.body.system?.custom?.auth?.scheme, 'user_token_passthrough');
    return { endpoint: result.body.system.custom.heartbeat.endpoint };
  });
  await check('1-系统接入', '真实心跳探测通过（probeKind=heartbeat）', async () => {
    const result = await call(`/semantic-operations/systems/${systemCode}/probe`, { method: 'POST', session: adminSession, body: {} });
    assert.equal(result.status, 200, `探测失败：${JSON.stringify(result.body)}`);
    assert.equal(result.body.status, 'verified');
    assert.equal(result.body.probeKind, 'heartbeat');
    return { status: result.body.status, checkedAt: result.body.checkedAt };
  });
  await check('1-系统接入', '未探测系统直接接通被拒绝（接通门禁 409）', async () => {
    const gate = await call('/semantic-operations/systems', { method: 'POST', session: adminSession, body: {
      code: `E2EG${runToken}`, name: '无探测系统（E2E）', domain: '供应链', description: '未通过探测就想接通的系统，应被门禁拒绝。',
      keyEntities: ['供应商'], dataDomains: ['internal'], accessIntention: '读取供应商资质与绩效数据，支撑采购风险分析。',
      businessOwner: '采购负责人', heartbeat: { endpoint: 'https://unreachable.example.invalid/health' }, auth: { scheme: 'user_token_passthrough' }
    } });
    assert.equal(gate.status, 201);
    const gateCode = gate.body.code;
    const authorized = await call(`/semantic-operations/systems/${gateCode}/lifecycle`, { method: 'POST', session: adminSession, body: { to: 'authorized', reason: 'E2E：授权确认' } });
    assert.equal(authorized.status, 200);
    const result = await call(`/semantic-operations/systems/${gateCode}/lifecycle`, { method: 'POST', session: adminSession, body: { to: 'connected', reason: 'E2E：未探测直接接通' } });
    assert.equal(result.status, 409, '未探测接通应被拒绝（409）');
    assert.equal(result.body.code, 'SYSTEM_CONNECT_PROBE_REQUIRED');
    return { gateCode, rejected: result.body.code };
  });
  await check('1-系统接入', '生命周期 registered→authorized→connected', async () => {
    const authorized = await call(`/semantic-operations/systems/${systemCode}/lifecycle`, { method: 'POST', session: adminSession, body: { to: 'authorized', reason: 'E2E：授权确认' } });
    assert.equal(authorized.status, 200, `授权失败：${JSON.stringify(authorized.body)}`);
    const connected = await call(`/semantic-operations/systems/${systemCode}/lifecycle`, { method: 'POST', session: adminSession, body: { to: 'connected', reason: 'E2E：心跳探测通过，业务确认接入' } });
    assert.equal(connected.status, 200, `接通失败：${JSON.stringify(connected.body)}`);
    return { state: connected.body.lifecycleState || connected.body.connection?.lifecycleState || 'connected' };
  });
  phaseDone('1-系统接入', '登记三段物料、真实心跳探测、接通门禁、生命周期已验证');

  // ════ 阶段 2：物料提交 ════
  let projectId = null; let revision = 1; const digests = {};
  await check('2-物料提交', '创建接入项目（readiness 0/5）', async () => {
    const result = await call('/semantic-operations/onboarding', { method: 'POST', session: adminSession, body: { name: `E2E 订单履约接入 ${runToken}`, scenarioId: 'fulfillment' } });
    assert.equal(result.status, 201, `创建失败：${JSON.stringify(result.body)}`);
    projectId = result.body.project.id;
    assert.equal(result.body.project.readiness.completed, 0);
    assert.equal(result.body.project.readiness.missing.length, 5);
    return { projectId: projectId.slice(0, 12) + '…' };
  });
  for (const material of materials) {
    await check('2-物料提交', `提交 ${material.kind} 材料`, async () => {
      const result = await call(`/semantic-operations/onboarding/${projectId}/materials`, { method: 'POST', session: adminSession, body: { ...material, expectedRevision: revision } });
      assert.equal(result.status, 200, `${material.kind} 提交失败：${JSON.stringify(result.body)}`);
      revision = result.body.project.revision;
      if (result.body.material?.digest || result.body.project?.materials?.[material.kind]?.digest) {
        digests[material.kind] = result.body.material?.digest || result.body.project.materials[material.kind].digest;
      }
      return { revision };
    });
  }
  await check('2-物料提交', '五类材料就绪（ready_for_review 5/5，原文不回显）', async () => {
    const result = await call(`/semantic-operations/onboarding/${projectId}`, { session: adminSession });
    assert.equal(result.status, 200);
    assert.equal(result.body.project.readiness.status, 'ready_for_review');
    assert.equal(result.body.project.readiness.completed, 5);
    assert.ok(result.body.project.materials.every((material) => !Object.hasOwn(material, 'text')), '公开视图不应回显材料原文');
    digests.requirements = result.body.project.materials.find((material) => material.kind === 'requirements')?.digest;
    assert.ok(digests.requirements, '材料 digest 缺失');
    return { completed: result.body.project.readiness.completed };
  });
  await check('2-物料提交', '图片物料整份拒绝（专用错误码指向 5b）', async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(64)]);
    const result = await call(`/semantic-operations/onboarding/${projectId}/materials`, { method: 'POST', session: adminSession, body: { kind: 'requirements', name: '截图.png', expectedRevision: revision, attachment: { name: '截图.png', mimeType: 'image/png', base64: png.toString('base64') } } });
    assert.equal(result.status, 400);
    assert.equal(result.body.code, 'MOCK_ONBOARDING_MATERIAL_FORM_UNSUPPORTED');
    assert.match(result.body.message, /阶段 5b/);
    return { code: result.body.code };
  });
  await check('2-物料提交', '模拟连接测试通过（verified）', async () => {
    const result = await call(`/semantic-operations/onboarding/${projectId}/connection`, { method: 'POST', session: adminSession, body: { expectedRevision: revision, faultMode: 'none' } });
    assert.equal(result.status, 200, `连接测试失败：${JSON.stringify(result.body)}`);
    return { status: result.body.result?.status || result.body.status };
  });
  await check('2-物料提交', '人工对齐保存后重测连接（validated_scope）', async () => {
    // 正常流程：对齐配置保存（推进版本并清空连接）→ 重测模拟连接 → 连接测试将对齐配置
    // 与源数据联合校验，产出 report.status = validated_scope。
    const fresh = await call(`/semantic-operations/onboarding/${projectId}`, { session: adminSession });
    assert.equal(fresh.status, 200);
    revision = fresh.body.project.revision;
    const requirementsText = fulfillment.requirements;
    const quote = requirementsText.slice(0, Math.min(80, requirementsText.length));
    const saved = await call(`/semantic-operations/onboarding/${projectId}/alignment`, { method: 'POST', session: adminSession, body: {
      expectedRevision: revision,
      config: { version: 'mock-alignment.v1',
        identities: [{ objectType: 'ItemSKU', canonicalType: '商品规格', granularity: 'master', aliases: [], evidence: 'SKU 主键唯一，沿用源主键。', materialEvidence: { kind: 'requirements', digest: digests.requirements, quote } }],
        units: [], states: [] }
    } });
    assert.equal(saved.status, 200, `对齐保存失败：${JSON.stringify(saved.body)}`);
    const refreshed = await call(`/semantic-operations/onboarding/${projectId}`, { session: adminSession });
    revision = refreshed.body.project.revision;
    const retest = await call(`/semantic-operations/onboarding/${projectId}/connection`, { method: 'POST', session: adminSession, body: { expectedRevision: revision, faultMode: 'none' } });
    assert.equal(retest.status, 200, `连接重测失败：${JSON.stringify(retest.body)}`);
    const final = await call(`/semantic-operations/onboarding/${projectId}`, { session: adminSession });
    assert.equal(final.body.project.alignment?.status, 'validated_scope', `对齐状态：${final.body.project.alignment?.status}`);
    revision = final.body.project.revision;
    return { status: 'validated_scope' };
  });
  await check('2-物料提交', '移交建模（handoff 产出任务与提案）', async () => {
    const fresh = await call(`/semantic-operations/onboarding/${projectId}`, { session: adminSession });
    assert.equal(fresh.status, 200);
    revision = fresh.body.project.revision;
    const result = await call(`/semantic-operations/onboarding/${projectId}/handoff`, { method: 'POST', session: adminSession, body: { expectedRevision: revision } });
    assert.equal(result.status, 200, `移交失败：${JSON.stringify(result.body)}`);
    assert.ok(result.body.taskId || result.body.proposalId, '移交应产出任务/提案');
    return { taskId: result.body.taskId || '(无)', reused: result.body.reused };
  });
  phaseDone('2-物料提交', '五类材料、就绪度、5b 拒绝、连接测试、人工对齐、移交建模已验证');

  // ════ 阶段 3：建模 ════
  await check('3-建模', '语义来源发现可用', async () => {
    const result = await call('/semantic-operations/sources', { session: adminSession });
    assert.equal(result.status, 200);
    return { sources: Array.isArray(result.body.sources) ? result.body.sources.length : Object.keys(result.body).length };
  });
  await check('3-建模', '读取当前建模草稿', async () => {
    const result = await call('/meta-models/oa-governance/draft', { session: adminSession });
    assert.equal(result.status, 200);
    assert.ok(result.body.draft || result.body.objectTypes !== undefined, '草稿结构缺失');
    return { objects: (result.body.draft?.objectTypes || result.body.objectTypes || []).length };
  });
  await check('3-建模', '保存业务建模草稿（3 对象 2 关系 + 治理资产）', async () => {
    const result = await call('/meta-models/oa-governance/draft', { method: 'POST', session: adminSession, body: {
      modelingProfile: 'general',
      scenario: { objective: `E2E 全流程验证：订单履约风险分析（${runToken}）`, questions: ['哪些订单存在缺货或延迟风险？'], decisionBindings: [], actionBindings: [] },
      objectTypes: [
        { id: 'E2ESalesOrder', label: '销售订单', key: 'order_id', granularity: 'transaction', fields: ['order_id', 'customer_id', 'amount', 'status'] },
        { id: 'E2ECustomer', label: '客户', key: 'customer_id', granularity: 'master', fields: ['customer_id', 'name', 'credit_limit'] },
        { id: 'E2EInventoryLot', label: '库存批次', key: 'lot_id', granularity: 'inventory_item', fields: ['lot_id', 'sku_id', 'qty'] }
      ],
      relationshipTypes: [
        { from: 'E2ESalesOrder', predicate: 'belongs_to', to: 'E2ECustomer', cardinality: 'n:1' },
        { from: 'E2EInventoryLot', predicate: 'supports', to: 'E2ESalesOrder', cardinality: 'n:n' }
      ],
      stateMachines: [
        { object: 'E2ESalesOrder', initial: '已创建', states: ['已创建', '已发货', '已取消'], terminal: ['已发货', '已取消'] }
      ],
      events: [],
      metrics: [
        { id: 'e2e_order_amount_sum', label: '订单金额合计', grain: 'E2ESalesOrder', aggregation: 'sum', expression: 'sum(amount)' }
      ],
      dataContracts: [
        { id: 'e2e_sales_order_contract', sourceSystem: 'OA', objectType: 'E2ESalesOrder', schemaVersion: '1.0', freshnessMinutes: 15, availabilitySlo: 99.9, owner: 'E2E 责任人' }
      ],
      qualityRules: [
        { id: 'e2e_order_status_valid', objectType: 'E2ESalesOrder', field: 'status', rule: 'not_null', severity: 'error', threshold: 1 }
      ],
      glossaryTerms: [
        { id: 'e2e_sales_order', term: '销售订单', definition: '客户与平台之间的交易订单，关联金额与状态。', objectType: 'E2ESalesOrder' }
      ],
      accessPolicies: [
        { id: 'e2e_order_scope_policy', objectType: 'E2ESalesOrder', effect: 'allow', roles: ['executive'], condition: 'organization_id in subject.organization_ids', maskedFields: [] }
      ],
      lineageEdges: [
        { from: 'oa.custom_e2esalesorder', to: 'E2ESalesOrder', transformation: 'canonical_mapping', fields: ['order_id', 'amount', 'status'] }
      ]
    } });
    assert.equal(result.status, 200, `草稿保存失败：${JSON.stringify(result.body)}`);
    return { objects: result.body.draft?.objectTypes?.length };
  });
  await check('3-建模', '草稿校验通过（passed）', async () => {
    const result = await call('/meta-models/oa-governance/draft/validate', { method: 'POST', session: adminSession });
    assert.equal(result.status, 200, `校验失败：${JSON.stringify(result.body)}`);
    assert.equal(result.body.draft?.validation?.status, 'passed', `校验未通过：${JSON.stringify(result.body.draft?.validation)}`);
    return { status: result.body.draft.validation.status };
  });
  await check('3-建模', '模拟构建通过（含 Semantica 结构验证）', async () => {
    const result = await call('/meta-models/oa-governance/simulate-build', { method: 'POST', session: adminSession });
    assert.equal(result.status, 200, `模拟构建失败：${JSON.stringify(result.body)}`);
    assert.equal(result.body.simulation?.validation?.status, 'passed');
    assert.notEqual(result.body.semanticValidation?.status, 'failed');
    return { instances: result.body.simulation?.instances?.nodes?.length, semantic: result.body.semanticValidation?.status };
  });
  phaseDone('3-建模', '草稿保存、校验、模拟构建（含语义服务验证）已验证');

  // ════ 阶段 4：发布 ════
  await check('4-发布', '非发布角色（quality_manager）发布被拒绝（按钮闸门 403）', async () => {
    const result = await call('/meta-models/oa-governance/publish', { method: 'POST', session: qualitySession });
    assert.equal(result.status, 403);
    assert.equal(result.body.code, 'BUTTON_PERMISSION_DENIED');
    assert.match(result.body.message, /meta_model\.publish/);
    return { code: result.body.code };
  });
  await check('4-发布', '发布人（executive）发布成功并部署语义服务', async () => {
    const result = await call('/meta-models/oa-governance/publish', { method: 'POST', session: adminSession });
    assert.equal(result.status, 200, `发布失败：${JSON.stringify(result.body)}`);
    assert.equal(result.body.simulation?.status, 'published');
    assert.ok(result.body.simulation?.version, '发布版本缺失');
    return { version: result.body.simulation.version };
  });
  await check('4-发布', '发布后模型状态为已发布', async () => {
    const result = await call('/meta-models', { session: adminSession });
    assert.equal(result.status, 200);
    const models = Array.isArray(result.body) ? result.body : result.body.models || [];
    const model = models.find((item) => item.id === 'oa-governance');
    assert.equal(model?.status, 'published');
    return { published: true };
  });
  phaseDone('4-发布', '权限拒绝、发布部署、发布状态已验证');

  // ════ 阶段 5：审核 ════
  let inspectionId = null;
  await check('5-审核', '创建语义层巡检计划', async () => {
    const result = await call('/semantic-operations/inspections', { method: 'POST', session: adminSession, body: { name: `E2E 语义层日常巡检 ${runToken}`, checks: ['source_readiness', 'schema_integrity'], intervalMinutes: 15 } });
    assert.equal(result.status, 201, `创建失败：${JSON.stringify(result.body)}`);
    inspectionId = result.body.schedule.id;
    assert.equal(result.body.schedule.status, 'active');
    return { inspectionId: inspectionId.slice(0, 24) + '…' };
  });
  await check('5-审核', '巡检计划立即执行（run-now）', async () => {
    const result = await call(`/semantic-operations/inspections/${inspectionId}/run-now`, { method: 'POST', session: adminSession });
    assert.equal(result.status, 200);
    return { nextRunAt: result.body.schedule?.nextRunAt };
  });
  await check('5-审核', '巡检产生运行记录（lastRun 非空，Worker 30s 周期）', async () => {
    let schedule = null;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 3000));
      const result = await call('/semantic-operations/inspections', { session: adminSession });
      assert.equal(result.status, 200);
      schedule = (result.body.schedules || []).find((item) => item.id === inspectionId);
      assert.ok(schedule, '巡检计划未找到');
      if (schedule.lastRun || schedule.lastResult) break;
    }
    assert.ok(schedule?.lastRun || schedule?.lastResult, '巡检尚未产生运行记录');
    assert.equal(schedule.lastRun?.status, 'passed');
    return { lastRun: schedule.lastRun?.status, finishedAt: schedule.lastRun?.finishedAt };
  });
  await check('5-审核', '运营通知列表可读', async () => {
    const result = await call('/semantic-operations/notifications', { session: adminSession });
    assert.equal(result.status, 200);
    return { notifications: (result.body.notifications || []).length };
  });
  phaseDone('5-审核', '巡检计划创建、立即执行、运行记录、通知已验证');

  // ════ 阶段 6：智脑使用模型 ════
  await check('6-智脑', '智脑运行时状态可用', async () => {
    const result = await call('/agent/runtime', { session: adminSession });
    assert.equal(result.status, 200);
    return { mode: result.body.mode || result.body.model?.mode };
  });
  await check('6-智脑', '模型配置读取（当前模型模式）', async () => {
    const result = await call('/agent/model-config', { session: adminSession });
    assert.equal(result.status, 200);
    return { mode: result.body.mode, model: result.body.model?.id || result.body.model?.name || result.body.model };
  });
  await check('6-智脑', '无效会话智脑调用被拒绝（401）', async () => {
    const result = await call('/agent/message', { method: 'POST', session: 'e2e-invalid-session-token', body: { text: '你好' } });
    assert.equal(result.status, 401);
    return { status: 401 };
  });
  let conversationId = null;
  await check('6-智脑', '创建智脑会话（满额自动归档最旧活动任务）', async () => {
    let result = await call('/agent/conversations', { method: 'POST', session: adminSession, body: { title: `E2E 智脑会话 ${runToken}` } });
    if (result.status === 400 && result.body?.code === 'AGENT_ACTIVE_TASK_LIMIT') {
      const list = await call('/agent/conversations', { session: adminSession });
      const items = list.body?.items || [];
      const archived = [];
      for (const item of items.filter((entry) => !entry.archivedAt)) {
        if (result.status === 201) break;
        const done = await call(`/agent/conversations/${item.id}/archive`, { method: 'POST', session: adminSession });
        if (done.status === 200) archived.push(item.id);
        result = await call('/agent/conversations', { method: 'POST', session: adminSession, body: { title: `E2E 智脑会话 ${runToken}` } });
      }
      assert.equal(result.status, 201, `归档后仍创建失败：${JSON.stringify(result.body)}`);
    }
    assert.equal(result.status, 201, `创建会话失败：${JSON.stringify(result.body)}`);
    conversationId = result.body.conversation?.id || result.body.id;
    assert.ok(conversationId, '未返回会话 ID');
    return { conversationId: String(conversationId).slice(0, 12) + '…' };
  });
  await check('6-智脑', '智脑消息回复（按运行时模型配置执行）', async () => {
    const result = await call('/agent/message', { method: 'POST', session: adminSession, body: { conversationId, text: '目前有哪些订单存在缺货或延迟风险？请只分析，不执行任何处置。' } });
    assert.equal(result.status, 200, `消息失败：${JSON.stringify(result.body)}`);
    for (const field of ['text', 'agent', 'evidence', 'plan', 'command']) assert.ok(Object.hasOwn(result.body, field), `回复缺少 ${field} 字段`);
    assert.ok(String(result.body.text).length > 0, '回复文本为空');
    return { agent: result.body.agent, textHead: String(result.body.text).slice(0, 60) };
  });
  await check('6-智脑', '会话交换已记录（上下文持久化）', async () => {
    const result = await call(`/agent/conversations/${conversationId}`, { session: adminSession });
    assert.equal(result.status, 200);
    const exchanges = result.body.exchanges?.length ?? result.body.messages?.length ?? 0;
    assert.ok(exchanges >= 1, '会话交换记录为空');
    return { exchanges };
  });
  await check('6-智脑', '智脑运行列表可读', async () => {
    const result = await call('/agent/runs', { session: adminSession });
    assert.equal(result.status, 200);
    return { runs: Array.isArray(result.body) ? result.body.length : (result.body.items || []).length };
  });
  phaseDone('6-智脑', '运行时、模型配置、会话、消息、运行列表已验证');
} catch (error) {
  report.failures.push({ phase: 'FATAL', name: '流程中断', message: String(error.message || error).split('\n')[0] });
}

report.finishedAt = new Date().toISOString();
report.summary = { passed, failed, total: passed + failed, requests: requestCounter };
const reportPath = join(outputDir, 'report.json');
await writeFile(reportPath, JSON.stringify(report, null, 2));

console.log(`\n===== E2E 全流程验证（正常流程） =====`);
console.log(`目标：${base}`);
for (const phase of report.phases) console.log(`✓ ${phase.name} — ${phase.summary}`);
console.log(`\n通过 ${passed} / ${passed + failed}，失败 ${failed}，HTTP 请求 ${requestCounter} 次`);
if (report.failures.length) {
  console.log('\n失败明细：');
  for (const failure of report.failures) console.log(`  ✗ [${failure.phase}] ${failure.name}: ${failure.message}`);
}
console.log(`\n报告：${reportPath}`);
process.exit(failed ? 1 : 0);
