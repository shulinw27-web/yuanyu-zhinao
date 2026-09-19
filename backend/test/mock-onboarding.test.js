import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readState, writeState, listState, resetRuntimeState } from '../src/repositories/runtime-state-repository.js';
import { createTenantIAMWorkspace, iamWorkspaceKey } from '../src/services/iam-workspace-model.js';
import { runWithIAMStoreContext } from '../src/services/iam-store.js';
import { runWithSemanticTenant } from '../src/services/semantic-tenant-context.js';
import { listMockOnboarding, createMockOnboardingProject, getMockOnboardingProject, saveMockOnboardingMaterial } from '../src/services/mock-onboarding-service.js';
import { handleGovernanceRoutes } from '../src/routes/governance-routes.js';
import { tenantRuntimeFeature } from '../src/services/tenant-runtime-control-service.js';

if (process.env.NODE_ENV !== 'test' || process.env.RUNTIME_STORE_DRIVER !== 'memory') throw new Error('Use runtime-test-bootstrap with the memory store.');
const identity = { tenantId: 'synthetic-onboarding', subjectId: 'alice', source: 'session' };
const scope = { identityScope: identity, role: 'executive' };
const dictionary = { tables: [{ name: 'Order', system: 'OMS', primaryKey: 'order_id', fields: [{ name: 'order_id', type: 'string', required: true }, { name: 'quantity', type: 'integer', required: true }] }] };
const samples = { records: [{ objectType: 'Order', payload: { order_id: 'SYN-001', quantity: 3 } }] };
const texts = { requirements: '需要核对订单缺货风险，范围限定合成订单，验收问题为订单数量与库存是否匹配。', api: 'GET /synthetic/orders 为只读接口，返回 order_id 和 quantity 字段，当前仅登记接口说明。', rules: '合成订单数量大于可用库存时标为待复核，异常由负责人人工审阅，禁止自动写回业务系统。', dictionary: JSON.stringify(dictionary), samples: JSON.stringify(samples) };
const within = (context, action) => runWithIAMStoreContext(action, context.identityScope?.tenantId);
const create = (context = scope, body = {}) => within(context, () => createMockOnboardingProject({ ...context, body: { scenarioId: 'fulfillment', name: '合成订单接入', ...body } }));
const get = (id, context = scope) => within(context, () => getMockOnboardingProject({ ...context, id }));
const list = (context = scope) => within(context, () => listMockOnboarding(context));
const save = (project, kind, text = texts[kind], context = scope, body = {}) => within(context, () => saveMockOnboardingMaterial({ ...context, id: project.id, body: { expectedRevision: project.revision, kind, name: `${kind}.txt`, text, ...body } }));
function seed(tenantId) {
  const state = createTenantIAMWorkspace('demo-enterprise');
  state.users = ['alice', 'bob', 'c', 'b:c'].map(subject => ({ ...state.users[0], id: subject, account: subject, roleIds: ['executive', 'quality_manager'] }));
  state.rolePolicies.quality_manager.buttonPermissionIds.push('meta_model.draft.save');
  writeState('iam', iamWorkspaceKey(tenantId), state);
}
test.beforeEach(() => { resetRuntimeState(['mock_onboarding_v1', 'iam']); seed(identity.tenantId); });

test('blank projects expose all five gaps and never contain preset business materials', async () => {
  assert.deepEqual((await list()).projects, []);
  const { project } = await create();
  assert.equal(project.mode, 'synthetic'); assert.equal(project.revision, 1);
  assert.deepEqual(project.materials, []); assert.equal(project.readiness.completed, 0);
  assert.equal(project.readiness.total, 5); assert.equal(project.readiness.missing.length, 5);
  assert.ok(project.readiness.missing.every(item => item.reason.length > 20));
  assert.match(project.boundary, /不调用大模型/);
  assert.match(project.boundary, /不自动采纳或发布模型/);
  assert.equal((await list()).scenarios.length, 2);
  const quality = await create(scope, { scenarioId: 'quality_incident', name: '合成异常' });
  assert.equal(quality.project.scenarioId, 'quality_incident');
  assert.equal((await create(scope, { scenarioId: 'unknown' })).code, 'MOCK_ONBOARDING_SCENARIO_INVALID');
});

test('materials revise in place, retain exact raw evidence privately, and stale concurrent writes cannot overwrite', async () => {
  const first = (await create()).project;
  const results = await Promise.all([save(first, 'requirements'), save(first, 'api')]);
  assert.equal(results.filter(item => item.project).length, 1);
  assert.equal(results.filter(item => item.status === 409).length, 1);
  const project = (await get(first.id)).project;
  assert.equal(project.revision, 2); assert.equal(project.materials.length, 1);
  const text = texts.requirements + ' 修订后按仓库逐项验收。';
  const replacement = (await save(project, 'requirements', text)).project;
  assert.equal(replacement.revision, 3); assert.equal(replacement.materials.length, 1);
  assert.equal(replacement.materials[0].digest, createHash('sha256').update(text).digest('hex'));
  const stored = listState('mock_onboarding_v1');
  assert.notEqual(stored[0].key, 'index');
  assert.equal(stored[0].value[first.id].materials.requirements.text, text);
  assert.equal(Object.hasOwn(replacement.materials[0], 'text'), false);
  assert.equal(JSON.stringify(await list()).includes(text), false);
});

test('malformed JSON, pretend dictionary, missing primary keys and unresolved foreign keys remain actionable issues', async () => {
  let project = (await create()).project;
  for (const [text, pattern] of [
    ['{bad json', /有效 JSON/],
    ['{"message":"schema ready"}', /tables/],
    [JSON.stringify({ tables: [{ name: 'Order', system: 'OMS', fields: [{ name: 'id', type: 'string' }] }] }), /primaryKey/],
    [JSON.stringify({ tables: [{ ...dictionary.tables[0], fields: [...dictionary.tables[0].fields, { name: 'customer_id', type: 'string', reference: 'Customer' }] }] }), /引用 Customer|目标表 Customer/]
  ]) {
    project = (await save(project, 'dictionary', text)).project;
    assert.match(project.materials.find(item => item.kind === 'dictionary').issues.join(' '), pattern);
    assert.equal(project.readiness.completed, 0); assert.equal(project.readiness.status, 'collecting');
  }
  const bad = (await save(project, 'requirements', 'OK')).project;
  assert.match(bad.readiness.issues.join(' '), /24/);
});

test('samples require dictionary contracts, nonempty records, declared types and present primary keys', async () => {
  let project = (await create()).project;
  project = (await save(project, 'samples')).project;
  assert.match(project.readiness.issues.join(' '), /先补充有效数据字典/);
  project = (await save(project, 'dictionary')).project;
  assert.equal(project.readiness.completed, 2);
  for (const [value, pattern] of [
    [{ records: [] }, /1–500/],
    [{ records: [{ objectType: 'Order', payload: { quantity: 3 } }] }, /缺少主键/],
    [{ records: [{ objectType: 'Order', payload: { order_id: '  ', quantity: 3 } }] }, /缺少主键/],
    [{ records: [{ objectType: 'Order', payload: { order_id: 'SYN-002', quantity: 'three' } }] }, /integer/],
    [{ records: [{ objectType: 'Invented', payload: { id: 1 } }] }, /字典中的 objectType/],
    [{ records: [...samples.records, ...samples.records] }, /主键重复/]
  ]) {
    project = (await save(project, 'samples', JSON.stringify(value))).project;
    assert.match(project.readiness.issues.join(' '), pattern);
  }
  project = (await save(project, 'samples', 'not json')).project;
  assert.match(project.readiness.issues.join(' '), /有效 JSON/);
  project = (await save(project, 'samples')).project;
  assert.equal(project.readiness.issues.length, 0);
  const numeric = structuredClone(dictionary);
  numeric.tables[0].fields[1].type = 'number';
  project = (await save(project, 'dictionary', JSON.stringify(numeric))).project;
  project = (await save(project, 'samples', '{"records":[{"objectType":"Order","payload":{"order_id":"SYN-001","quantity":1e999}}]}')).project;
  assert.match(project.readiness.issues.join(' '), /number/);
});

test('valid references check sample targets and dictionary replacements invalidate dependent samples', async () => {
  const linked = structuredClone(dictionary);
  linked.tables[0].fields.push({ name: 'customer_id', type: 'string', required: true, reference: 'Customer', referenceField: 'id' });
  linked.tables.push({ name: 'Customer', system: 'OMS', primaryKey: 'id', fields: [{ name: 'id', type: 'string' }] });
  let project = (await create()).project;
  project = (await save(project, 'dictionary', JSON.stringify(linked))).project;
  project = (await save(project, 'samples', JSON.stringify({ records: [{ objectType: 'Order', payload: { order_id: 'SYN-001', quantity: 3, customer_id: 'C-1' } }] }))).project;
  assert.match(project.readiness.issues.join(' '), /缺少对应 Customer/);
  project = (await save(project, 'dictionary')).project;
  assert.match(project.readiness.issues.join(' '), /未声明字段 customer_id/);
});

test('ready_for_review invokes no model or network and leaves all actual onboarding stages pending', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0; globalThis.fetch = () => { calls++; throw new Error('External request forbidden'); };
  try {
    let project = (await create()).project;
    for (const kind of Object.keys(texts)) project = (await save(project, kind)).project;
    assert.equal(project.readiness.status, 'ready_for_review'); assert.equal(project.readiness.completed, 5);
    assert.deepEqual(project.readiness.missing, []); assert.deepEqual(project.readiness.issues, []);
    assert.equal(project.milestones.find(item => item.id === 'review').status, 'ready');
    for (const id of ['connection', 'model']) assert.equal(project.milestones.find(item => item.id === id).status, 'pending');
    assert.equal(calls, 0);
    for (const namespace of ['ontology_publication', 'semantic_operations_tasks', 'oa_meta_model_runtime']) assert.equal(listState(namespace).length, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('tenant, subject and originating role are independent partitions; body claims cannot redirect ownership', async () => {
  const { project } = await create(scope, { tenantId: 'other', subjectId: 'bob', roleId: 'quality_manager' });
  seed('other');
  const others = [{ ...scope, identityScope: { ...identity, tenantId: 'other' } }, { ...scope, identityScope: { ...identity, subjectId: 'bob' } }, { ...scope, role: 'quality_manager' }];
  for (const other of others) {
    assert.deepEqual((await list(other)).projects, []);
    assert.equal((await get(project.id, other)).status, 404);
    assert.equal((await save(project, 'requirements', texts.requirements, other)).status, 404);
  }
  for (const tenant of ['a:b', 'a']) seed(tenant);
  const a = { ...scope, identityScope: { tenantId: 'a:b', subjectId: 'c' } };
  const b = { ...scope, identityScope: { tenantId: 'a', subjectId: 'b:c' } };
  const privateProject = (await create(a)).project;
  assert.equal((await get(privateProject.id, b)).status, 404);
  assert.deepEqual((await list(b)).projects, []);
  assert.equal((await get(project.id)).project.revision, 1);
});

test('service requires identity, real role membership and draft-save permission; production is always rejected', async () => {
  assert.equal((await listMockOnboarding({ role: 'executive' })).status, 403);
  const unregistered = { ...scope, identityScope: { ...identity, subjectId: 'unregistered' } };
  assert.equal((await create(unregistered)).code, 'MOCK_ONBOARDING_ROLE_DENIED');
  assert.equal((await create({ ...scope, role: 'marketing_manager' })).status, 403);
  const state = readState('iam', iamWorkspaceKey(identity.tenantId));
  state.rolePolicies.executive.buttonPermissionIds = [];
  writeState('iam', iamWorkspaceKey(identity.tenantId), state);
  assert.equal((await create()).code, 'MOCK_ONBOARDING_PERMISSION_DENIED');
  state.rolePolicies.executive.menuIds = [];
  state.rolePolicies.quality_manager.menuIds = [];
  writeState('iam', iamWorkspaceKey(identity.tenantId), state);
  assert.equal((await list()).code, 'MOCK_ONBOARDING_PAGE_DENIED');
  seed(identity.tenantId);
  await runWithSemanticTenant({ tenantId: 'other' }, async () => assert.equal((await list()).status, 403));
  const before = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try { assert.equal((await list()).code, 'MOCK_ONBOARDING_SANDBOX_ONLY'); assert.equal((await create()).status, 403); }
  finally { process.env.NODE_ENV = before; }
});

test('unknown kinds, missing revisions, blank text and bounded UTF-8 bytes reject without revision changes', async () => {
  const { project } = await create();
  assert.equal((await save(project, 'executable', 'text')).code, 'MOCK_ONBOARDING_KIND_INVALID');
  assert.equal((await save(project, 'requirements', texts.requirements, scope, { expectedRevision: undefined })).code, 'MOCK_ONBOARDING_REVISION_REQUIRED');
  assert.equal((await save(project, 'requirements', '   ')).status, 400);
  assert.equal((await save(project, 'requirements', '中'.repeat(22000))).status, 413);
  assert.equal((await get(project.id)).project.revision, 1);
  for (let index = 1; index < 20; index++) assert.ok((await create()).project);
  assert.equal((await create()).code, 'MOCK_ONBOARDING_PROJECT_LIMIT');
  assert.equal((await list()).projects.length, 20);
});

test('project and principal byte caps account for replacements without deleting previous material', async () => {
  const text = 'A'.repeat(65536);
  let first = (await create()).project;
  for (const kind of ['requirements', 'api', 'rules', 'dictionary']) first = (await save(first, kind, text)).project;
  assert.equal((await save(first, 'samples', '[]')).code, 'MOCK_ONBOARDING_TOTAL_LIMIT');
  assert.equal((await get(first.id)).project.revision, first.revision);
  for (let index = 0; index < 3; index++) {
    let project = (await create()).project;
    for (const kind of ['requirements', 'api', 'rules', 'dictionary']) project = (await save(project, kind, text)).project;
  }
  const fifth = (await create()).project;
  assert.equal((await save(fifth, 'requirements', texts.requirements)).code, 'MOCK_ONBOARDING_TOTAL_LIMIT');
  first = (await save(first, 'requirements', texts.requirements)).project;
  assert.ok((await save(fifth, 'requirements', texts.requirements)).project);
  assert.equal((await get(first.id)).project.materials.find(item => item.kind === 'requirements').bytes, Buffer.byteLength(texts.requirements));
});

async function request(method, path, body, allowed = true) {
  let response; let readCount = 0;
  await within(scope, () => handleGovernanceRoutes({ req: { method }, res: {}, url: new URL(`http://test${path}`), role: 'executive', agentIdentity: identity,
    selectActionRole: permission => { assert.equal(permission, 'meta_model.draft.save'); return allowed ? { id: 'executive' } : null; },
    denyButton: permission => { response = { status: 403, value: { permission } }; }, readBody: async () => { readCount++; return body; },
    send: (_res, status, value) => { response = { status, value }; } }));
  return { ...response, readCount };
}

test('governance routes return contracts and clear conflict errors, and deny writes before body consumption', async () => {
  const base = '/api/semantic-operations/onboarding';
  const empty = await request('GET', base);
  assert.equal(empty.status, 200); assert.deepEqual(empty.value.projects, []);
  const denied = await request('POST', base, {}, false);
  assert.equal(denied.status, 403); assert.equal(denied.readCount, 0);
  const made = await request('POST', base, { scenarioId: 'fulfillment', name: '路由合成项目' });
  assert.equal(made.status, 201);
  const url = `${base}/${made.value.project.id}`;
  assert.equal((await request('GET', url)).value.project.revision, 1);
  const body = { expectedRevision: 1, kind: 'requirements', name: '需求.txt', text: texts.requirements };
  assert.equal((await request('POST', `${url}/materials`, body)).status, 200);
  const stale = await request('POST', `${url}/materials`, body);
  assert.equal(stale.status, 409); assert.equal(stale.value.code, 'MOCK_ONBOARDING_REVISION_CONFLICT');
  assert.equal((await request('POST', `${url}/materials`, body, false)).readCount, 0);
  assert.equal((await request('GET', `${base}/missing`)).status, 404);
});

test('tenant runtime admits precisely onboarding semantic routes without opening other shared runtimes', () => {
  for (const path of ['/api/semantic-operations/onboarding', '/api/semantic-operations/onboarding/mock-id', '/api/semantic-operations/onboarding/mock-id/materials']) assert.equal(tenantRuntimeFeature(path), 'semantic');
  for (const path of ['/api/semantic-operations/onboarding-escape', '/api/semantic-operations/tasks', '/api/semantic-operations/inspections', '/api/semantic-operations/snapshots']) assert.equal(tenantRuntimeFeature(path), 'unverified_runtime');
});
