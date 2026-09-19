import test from 'node:test';
import assert from 'node:assert/strict';
import { readState, writeState, resetRuntimeState, listState } from '../src/repositories/runtime-state-repository.js';
import { createInitialIAMWorkspace, iamWorkspaceKey } from '../src/services/iam-workspace-model.js';
import { runWithIAMStoreContext } from '../src/services/iam-store.js';
import { createMockOnboardingProject, saveMockOnboardingMaterial, testMockOnboardingConnection, getMockOnboardingPreview, getMockOnboardingProject } from '../src/services/mock-onboarding-service.js';
import { handleGovernanceRoutes } from '../src/routes/governance-routes.js';
import { onboardingMaterials } from '../../examples/mock-onboarding/materials.mjs';

if (process.env.NODE_ENV !== 'test' || process.env.RUNTIME_STORE_DRIVER !== 'memory') throw new Error('Use runtime-test-bootstrap with memory storage.');
const scope = { identityScope: { tenantId: 'mock-onboarding-a', subjectId: 'alice' }, role: 'executive' };
const dictionary = { tables: [{ name: 'Order', system: 'OMS', primaryKey: 'order_id', fields: [{ name: 'order_id', type: 'string' }, { name: 'quantity', type: 'integer', required: true }] }] };
const texts = { requirements: '合成订单用于订单与库存字段校验，确认每笔订单主键和数量，后续业务判断需人工审阅。', api: 'GET /synthetic/orders 返回合成订单，包含order_id和quantity字段，范围只读且不访问真实系统。', dictionary: JSON.stringify(dictionary), samples: JSON.stringify({ records: [{ objectType: 'Order', payload: { order_id: 'UPLOADED-ONLY', quantity: 99 } }] }), rules: '数量必须为整数且订单主键不得为空或重复，异常记录需人工审阅，不执行任何业务写回动作。' };
const within = (context, work) => runWithIAMStoreContext(work, context.identityScope?.tenantId);
const create = (context = scope) => within(context, () => createMockOnboardingProject({ ...context, body: { scenarioId: 'fulfillment', name: '第二阶段合成项目' } }));
const save = (project, kind, text = texts[kind], context = scope) => within(context, () => saveMockOnboardingMaterial({ ...context, id: project.id, body: { expectedRevision: project.revision, kind, name: kind, text } }));
const get = (project, context = scope) => within(context, () => getMockOnboardingProject({ ...context, id: project.id }));
const preview = (project, context = scope, objectType) => within(context, () => getMockOnboardingPreview({ ...context, id: project.id, objectType }));
const source = (tenantId = scope.identityScope.tenantId, count = 1) => ({ sourceKind: 'local_mock_http', protocol: 'mock-onboarding-query.v1', snapshotId: 'synthetic-snapshot', systems: ['OMS'], requests: 1, pageCount: 1,
  records: Array.from({ length: count }, (_, index) => ({ tenantId, system: 'OMS', objectType: 'Order', payload: { order_id: `SOURCE-${index}`, quantity: index + 1 } })) });
const connect = (project, { context = scope, faultMode = 'none', readSource = async () => source(context.identityScope.tenantId), body = {} } = {}) => within(context,
  () => testMockOnboardingConnection({ ...context, id: project.id, body: { expectedRevision: project.revision, faultMode, ...body } }, { readSource }));
async function ready(context = scope, materials = Object.entries(texts).map(([kind, text]) => ({ kind, text }))) {
  let project = (await create(context)).project;
  for (const material of materials) project = (await save(project, material.kind, material.text, context)).project;
  assert.equal(project.readiness.status, 'ready_for_review'); return project;
}
function seed(tenantId) {
  const state = createInitialIAMWorkspace();
  state.users = ['alice', 'bob'].map(account => ({ ...state.users[0], account, id: account, roleIds: ['executive', 'quality_manager'] }));
  state.rolePolicies.quality_manager.buttonPermissionIds.push('meta_model.draft.save');
  writeState('iam', iamWorkspaceKey(tenantId), state);
}
test.beforeEach(() => { resetRuntimeState(['mock_onboarding_v1', 'iam']); seed(scope.identityScope.tenantId); });

test('connection rejects incomplete materials, stale revisions and custom destinations before source IO', async () => {
  const blank = (await create()).project;
  let calls = 0; const readSource = async () => { calls++; return source(); };
  assert.equal((await connect(blank, { readSource })).code, 'MOCK_ONBOARDING_MATERIALS_NOT_READY');
  const complete = await ready();
  assert.equal((await connect(complete, { readSource, body: { expectedRevision: 1 } })).status, 409);
  for (const body of [{ url: 'https://example.invalid/' }, { faultMode: 'arbitrary' }, { tenantId: 'someone-else' }]) assert.equal((await connect(complete, { readSource, body })).code, 'MOCK_ONBOARDING_CONNECTION_INPUT_INVALID');
  assert.equal(calls, 0); assert.equal((await get(complete)).project.revision, complete.revision);
});

test('verified connection previews independent source values, bounds rows and stays outside model publication', async () => {
  const before = await ready();
  const result = await connect(before, { readSource: async args => { assert.deepEqual(args, { scenarioId: 'fulfillment', tenantId: scope.identityScope.tenantId, projectId: before.id, faultMode: 'none' }); return source(undefined, 14); } });
  const project = result.project;
  assert.equal(project.connection.status, 'verified'); assert.equal(project.connection.materialRevision, before.revision);
  assert.equal(project.revision, before.revision + 1); assert.equal(project.connection.recordCount, 14);
  const view = await preview(project);
  assert.equal(view.rows.length, 10); assert.equal(view.totalRows, 14); assert.equal(view.truncated, true);
  assert.equal(view.rows[0].order_id, 'SOURCE-0'); assert.notEqual(view.rows[0].quantity, 99);
  assert.equal(view.revision, project.revision); assert.equal(view.sourceKind, 'local_mock_http');
  assert.deepEqual(view.objects, [{ objectType: 'Order', system: 'OMS', totalRows: 14 }]);
  assert.equal(view.fields[0].primaryKey, true);
  assert.equal((await preview(project, scope, 'Unknown')).status, 404);
  assert.equal(project.milestones.find(item => item.id === 'connection').status, 'complete');
  assert.equal(project.milestones.find(item => item.id === 'model').status, 'pending');
  assert.equal(JSON.stringify(project).includes('SOURCE-0'), false);
  for (const namespace of ['ontology_publication', 'oa_meta_model_runtime']) assert.deepEqual(listState(namespace), []);
});

test('material revisions revoke preview and successful retries keep the last material revision', async () => {
  const materials = await ready();
  let project = (await connect(materials)).project;
  project = (await connect(project)).project;
  assert.equal(project.connection.materialRevision, materials.revision);
  project = (await save(project, 'requirements', texts.requirements + ' 新增验收说明。')).project;
  assert.equal(project.connection, null); assert.equal((await preview(project)).status, 409);
  const storage = listState('mock_onboarding_v1')[0].value[project.id]; assert.equal(Object.hasOwn(storage, 'preview'), false);
  project = (await connect(project)).project;
  assert.equal(project.connection.materialRevision, materials.revision + 3);
  assert.equal((await preview(project)).rows.length, 1);
});

test('failed revalidation clears prior preview and never discloses raw source errors', async () => {
  let project = (await connect(await ready())).project;
  project = (await connect(project, { faultMode: 'timeout', readSource: async () => { throw Object.assign(new Error('private row and secret token'), { code: 'MOCK_SOURCE_TIMEOUT', requests: 2, pageCount: 1, records: source().records }); } })).project;
  assert.equal(project.connection.status, 'failed'); assert.equal(project.connection.issue.code, 'MOCK_SOURCE_TIMEOUT');
  assert.equal(project.connection.requests, 2); assert.equal(project.connection.pageCount, 1);
  assert.equal(project.connection.recordCount, 0); assert.deepEqual(project.connection.systems, []);
  assert.equal(JSON.stringify(project).includes('private row'), false); assert.equal((await preview(project)).status, 409);
  project = (await connect(project, { readSource: async () => { throw Object.assign(new Error('secret'), { code: 'UNTRUSTED_CODE' }); } })).project;
  assert.equal(project.connection.issue.code, 'MOCK_SOURCE_FAILED'); assert.equal(JSON.stringify(project).includes('secret'), false);
});

test('source tenant, system, protocol and field contracts fail closed', async () => {
  let project = await ready();
  for (const [mutate, expected] of [
    [value => { value.records[0].tenantId = 'foreign'; }, 'MOCK_SOURCE_TENANT_MISMATCH'],
    [value => { value.records[0].system = 'ERP'; }, 'MOCK_SOURCE_SCHEMA_DRIFT'],
    [value => { value.records[0].payload.extra = 'private row'; }, 'MOCK_SOURCE_SCHEMA_DRIFT'],
    [value => { value.records[0].payload.quantity = 'wrong type'; }, 'MOCK_SOURCE_SCHEMA_DRIFT'],
    [value => { delete value.records[0].payload.order_id; }, 'MOCK_SOURCE_SCHEMA_DRIFT'],
    [value => { value.records.push(structuredClone(value.records[0])); }, 'MOCK_SOURCE_SCHEMA_DRIFT'],
    [value => { value.protocol = 'ontology-query.v1'; }, 'MOCK_SOURCE_CONTRACT_INVALID']
  ]) {
    project = (await connect(project, { readSource: async () => { const value = source(); mutate(value); return value; } })).project;
    assert.equal(project.connection.status, 'failed'); assert.equal(project.connection.issue.code, expected);
    assert.equal((await preview(project)).status, 409); assert.equal(JSON.stringify(project).includes('private row'), false);
  }
});

test('other tenant, subject and role cannot connect or preview a known project ID', async () => {
  const project = (await connect(await ready())).project; seed('mock-onboarding-b');
  const others = [{ ...scope, identityScope: { ...scope.identityScope, tenantId: 'mock-onboarding-b' } }, { ...scope, identityScope: { ...scope.identityScope, subjectId: 'bob' } }, { ...scope, role: 'quality_manager' }];
  for (const context of others) {
    assert.equal((await connect(project, { context, readSource: () => { throw new Error('must not read'); } })).status, 404);
    assert.equal((await preview(project, context)).status, 404);
  }
});

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
test('late source completion cannot overwrite concurrent materials or another completed connection', async () => {
  let project = await ready();
  for (const concurrent of ['material', 'connection']) {
    const entered = deferred(); const release = deferred();
    const pending = connect(project, { readSource: async () => { entered.resolve(); await release.promise; return source(); } });
    await entered.promise;
    const latest = concurrent === 'material' ? (await save(project, 'rules')).project : (await connect(project)).project;
    release.resolve(); const late = await pending;
    assert.equal(late.status, 409); assert.equal(late.code, 'MOCK_ONBOARDING_REVISION_CONFLICT');
    project = (await get(project)).project; assert.equal(project.revision, latest.revision);
    assert.equal(project.connection?.status || null, concurrent === 'material' ? null : 'verified');
  }
});

test('permission revocation and IAM generation changes during IO reject completion without persisting', async () => {
  for (const change of ['revoke', 'generation']) {
    seed(scope.identityScope.tenantId);
    const project = await ready(); const entered = deferred(); const release = deferred();
    const pending = connect(project, { readSource: async () => { entered.resolve(); await release.promise; return source(); } });
    await entered.promise;
    const iam = readState('iam', iamWorkspaceKey(scope.identityScope.tenantId));
    if (change === 'revoke') iam.rolePolicies.executive.buttonPermissionIds = [];
    else iam.configurationVersion++;
    writeState('iam', iamWorkspaceKey(scope.identityScope.tenantId), iam);
    release.resolve(); const result = await pending;
    assert.equal(result.code, change === 'revoke' ? 'MOCK_ONBOARDING_PERMISSION_DENIED' : 'MOCK_ONBOARDING_AUTHORIZATION_CHANGED');
    assert.equal((await get(project)).project.revision, project.revision);
    assert.equal((await get(project)).project.connection, null);
  }
});

test('all fixed local HTTP faults persist safe failures; normal mode restores a current preview', { timeout: 20000 }, async () => {
  let project = await ready(scope, onboardingMaterials('fulfillment', scope.identityScope.tenantId));
  const expected = { rate_limited: 'RATE_LIMITED', timeout: 'TIMEOUT', malformed: 'MALFORMED', cross_tenant: 'TENANT_MISMATCH', incomplete: 'INCOMPLETE', schema_drift: 'SCHEMA_DRIFT' };
  for (const [faultMode, code] of Object.entries(expected)) {
    const result = await within(scope, () => testMockOnboardingConnection({ ...scope, id: project.id, body: { expectedRevision: project.revision, faultMode } }));
    project = result.project; assert.equal(project.connection.status, 'failed'); assert.equal(project.connection.issue.code, `MOCK_SOURCE_${code}`);
    assert.ok(project.connection.requests > 0); assert.equal((await preview(project)).status, 409);
  }
  project = (await within(scope, () => testMockOnboardingConnection({ ...scope, id: project.id, body: { expectedRevision: project.revision, faultMode: 'none' } }))).project;
  assert.equal(project.connection.status, 'verified'); assert.equal(project.connection.recordCount, 34); assert.equal(project.connection.pageCount, 3);
  const view = await preview(project); assert.equal(view.objects.length, 18); assert.ok(view.rows.length);
});

test('connection and preview routes use write authorization and return current project/preview contracts', async () => {
  const project = await ready(scope, onboardingMaterials('fulfillment', scope.identityScope.tenantId));
  const path = `/api/semantic-operations/onboarding/${project.id}`;
  const request = async (method, route, body, allowed = true) => {
    let response; let reads = 0;
    await within(scope, () => handleGovernanceRoutes({ req: { method }, res: {}, url: new URL(`http://test${route}`), role: scope.role, agentIdentity: scope.identityScope,
      selectActionRole: code => { assert.equal(code, 'meta_model.draft.save'); return allowed ? { id: scope.role } : null; },
      denyButton: () => { response = { status: 403 }; }, readBody: async () => { reads++; return body; }, send: (_res, status, value) => { response = { status, value }; } }));
    return { ...response, reads };
  };
  assert.equal((await request('GET', `${path}/preview`)).status, 409);
  const body = { expectedRevision: project.revision, faultMode: 'none' };
  assert.deepEqual(await request('POST', `${path}/connection`, body, false), { status: 403, reads: 0 });
  const connection = await request('POST', `${path}/connection`, body);
  assert.equal(connection.status, 200); assert.equal(connection.value.project.connection.status, 'verified');
  const view = await request('GET', `${path}/preview?objectType=SalesOrder`);
  assert.equal(view.status, 200); assert.equal(view.value.objectType, 'SalesOrder'); assert.equal(view.value.rows[0].order_id, 'ORD-T900');
});
