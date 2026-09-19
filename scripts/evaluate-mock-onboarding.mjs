import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { installOfflineNetworkGuard } from './lib/offline-network-guard.mjs';
import { startMockOnboardingHTTP } from './lib/mock-onboarding-http.mjs';
import { onboardingMaterials, syntheticEnterprises } from '../examples/mock-onboarding/materials.mjs';
import { onboardingAlignment } from '../examples/mock-onboarding/alignment.mjs';

if (process.env.NODE_ENV === 'production') throw new Error('Do not run synthetic onboarding in a production process.');
if (process.argv.slice(2).some(arg => arg !== '--no-artifacts')) throw new Error('Supported option: --no-artifacts');
Object.assign(process.env, { NODE_ENV: 'test', NODE_TEST_CONTEXT: 'mock-onboarding-runner', RUNTIME_STORE_DRIVER: 'memory',
  IDENTITY_SESSION_STORE_DRIVER: 'runtime', IAM_STORE_DRIVER: 'runtime', SEMANTIC_GOVERNANCE_STORE_DRIVER: 'runtime',
  IDENTITY_PROVIDERS_FILE: '', DEMO_ALLOW_ROLE_HEADER: 'false', TENANT_RUNTIME_CONTROL_REQUIRED: 'false' });
const guard = installOfflineNetworkGuard();
const report = { schemaVersion: 'mock-onboarding-assessment.v1', mode: 'synthetic', startedAt: new Date().toISOString(),
  scope: 'authenticated material preparation, embedded local Mock HTTP and scoped human alignment', store: 'isolated-memory', externalCallsAllowed: false,
  modelInvoked: false, realSystemsVerified: false, modelPublished: null, checks: [], preparations: [], notTested: [
    'real enterprise ontology-query.v1 adapter', 'Agent-generated executable model', 'Semantica publication', 'Zhinao business answers', 'production enrollment'
  ] };
let server;
const check = async (name, action) => {
  try { await action(); report.checks.push({ name, passed: true }); }
  catch (error) { report.checks.push({ name, passed: false, code: error.code || 'ASSERTION_FAILED' }); throw error; }
};
try {
  await check('network guard rejects cloud and unrelated loopback endpoints', async () => {
    await assert.rejects(fetch('https://example.invalid/never-contact'), { code: 'MOCK_NETWORK_BLOCKED' });
    await assert.rejects(fetch('http://127.0.0.1:18080/never-contact'), { code: 'MOCK_NETWORK_BLOCKED' });
  });
  server = await startMockOnboardingHTTP(guard);
  await check('unauthenticated forged tenant and role are rejected', async () => {
    assert.equal((await server.call(null, '', undefined, { 'x-tenant-id': 'mock-onboarding-a', 'x-demo-role': 'executive' })).status, 401);
  });
  const projects = {};
  for (const enterprise of syntheticEnterprises) {
    const { tenantId, name, scenarioId } = enterprise;
    await check(`${tenantId}: empty authenticated workspace`, async () => {
      const result = await server.call(tenantId); assert.equal(result.status, 200); assert.deepEqual(result.body.projects, []);
    });
    await check(`${tenantId}: create project without prebuilt model`, async () => {
      const result = await server.call(tenantId, '', { name, scenarioId }); assert.equal(result.status, 201);
      projects[tenantId] = result.body.project;
      assert.equal(result.body.project.readiness.completed, 0); assert.equal(result.body.project.readiness.missing.length, 5);
    });
    for (const material of onboardingMaterials(scenarioId, tenantId)) {
      await check(`${tenantId}: submit ${material.kind}`, async () => {
        const current = projects[tenantId];
        const result = await server.call(tenantId, `/${current.id}/materials`, { ...material, expectedRevision: current.revision });
        assert.equal(result.status, 200); projects[tenantId] = result.body.project;
        assert.ok(result.body.project.revision > current.revision);
      });
    }
    await check(`${tenantId}: preparation ready is not connection or publication`, async () => {
      const project = projects[tenantId];
      report.preparations.push({ tenantId, readiness: project.readiness });
      assert.equal(project.readiness.status, 'ready_for_review');
      assert.equal(project.readiness.completed, 5);
      for (const id of ['connection', 'model']) assert.equal(project.milestones.find(step => step.id === id)?.status, 'pending');
      assert.ok(project.materials.every(material => !Object.hasOwn(material, 'text')));
    });
  }
  await check('cross-tenant project ID and forged tenant header do not disclose data', async () => {
    const a = projects['mock-onboarding-a'];
    assert.equal((await server.call('mock-onboarding-b', `/${a.id}`, undefined, { 'x-tenant-id': 'mock-onboarding-a' })).status, 404);
    const b = await server.call('mock-onboarding-b'); assert.equal(b.body.projects.length, 1);
    assert.equal(b.body.projects[0].id, projects['mock-onboarding-b'].id);
  });
  await check('stale revision cannot overwrite accepted materials', async () => {
    const a = projects['mock-onboarding-a'];
    const result = await server.call('mock-onboarding-a', `/${a.id}/materials`, { ...onboardingMaterials('fulfillment', 'mock-onboarding-a')[0], expectedRevision: a.revision - 1 });
    assert.equal(result.status, 409);
    assert.equal((await server.call('mock-onboarding-a', `/${a.id}`)).body.project.revision, a.revision);
  });
  await check('duplicate event material is not silently accepted as a unique-key snapshot', async () => {
    const tenant = 'mock-onboarding-a'; const prior = projects[tenant];
    const raw = onboardingMaterials('fulfillment', tenant, { includeDuplicateDeliveries: true }).find(item => item.kind === 'samples');
    const duplicate = await server.call(tenant, `/${prior.id}/materials`, { ...raw, expectedRevision: prior.revision });
    assert.equal(duplicate.status, 200); assert.equal(duplicate.body.project.readiness.status, 'collecting');
    assert.ok(duplicate.body.project.readiness.issues.some(issue => issue.includes('重复')));
    const fixed = await server.call(tenant, `/${prior.id}/materials`, { ...onboardingMaterials('fulfillment', tenant)[3], expectedRevision: duplicate.body.project.revision });
    assert.equal(fixed.status, 200); assert.equal(fixed.body.project.readiness.status, 'ready_for_review');
    projects[tenant] = fixed.body.project;
  });
  await check('invalid replacement removes readiness until corrected', async () => {
    const tenant = 'mock-onboarding-a'; const prior = projects[tenant];
    const broken = await server.call(tenant, `/${prior.id}/materials`, { kind: 'dictionary', name: 'broken.json', text: '{"tables":[]}', expectedRevision: prior.revision });
    assert.equal(broken.status, 200); assert.equal(broken.body.project.readiness.status, 'collecting');
    assert.ok(broken.body.project.readiness.issues.length);
    const fixed = await server.call(tenant, `/${prior.id}/materials`, { ...onboardingMaterials('fulfillment', tenant)[2], expectedRevision: broken.body.project.revision });
    assert.equal(fixed.status, 200); assert.equal(fixed.body.project.readiness.status, 'ready_for_review');
    projects[tenant] = fixed.body.project;
  });
  const connect = async (tenant, faultMode = 'none') => {
    const project = projects[tenant];
    const result = await server.call(tenant, `/${project.id}/connection`, { expectedRevision: project.revision, faultMode });
    assert.equal(result.status, 200); assert.ok(result.body.project.revision > project.revision);
    projects[tenant] = result.body.project; return result.body.project;
  };
  report.connections = [];
  for (const enterprise of syntheticEnterprises) {
    const { tenantId, scenarioId } = enterprise;
    await check(`${tenantId}: local HTTP pages verified against the supplied dictionary`, async () => {
      const project = await connect(tenantId);
      assert.equal(project.connection.status, 'verified'); assert.equal(project.connection.sourceKind, 'local_mock_http');
      assert.equal(project.connection.recordCount, scenarioId === 'fulfillment' ? 34 : 77);
      assert.equal(project.connection.pageCount, scenarioId === 'fulfillment' ? 3 : 5);
      assert.equal(project.milestones.find(step => step.id === 'connection').status, 'complete');
      assert.equal(project.milestones.find(step => step.id === 'model').status, 'pending');
      report.connections.push({ tenantId, ...project.connection });
    });
    await check(`${tenantId}: preview exposes bounded declared fields for every source object`, async () => {
      const project = projects[tenantId];
      const tables = JSON.parse(onboardingMaterials(scenarioId, tenantId)[2].text).tables;
      for (const table of tables) {
        const result = await server.call(tenantId, `/${project.id}/preview?objectType=${encodeURIComponent(table.name)}`);
        assert.equal(result.status, 200); assert.equal(result.body.revision, project.revision);
        assert.equal(result.body.objectType, table.name); assert.equal(result.body.system, table.system);
        assert.ok(result.body.rows.length > 0 && result.body.rows.length <= 10);
        assert.equal(result.body.objects.length, tables.length);
        for (const row of result.body.rows) assert.ok(Object.keys(row).every(key => table.fields.some(field => field.name === key)));
      }
    });
  }
  await check('connection and preview cannot cross tenants or accept a client-provided destination', async () => {
    const a = projects['mock-onboarding-a'];
    assert.equal((await server.call('mock-onboarding-b', `/${a.id}/preview`)).status, 404);
    assert.equal((await server.call('mock-onboarding-b', `/${a.id}/connection`, { expectedRevision: a.revision, faultMode: 'none' })).status, 404);
    const bad = await server.call('mock-onboarding-a', `/${a.id}/connection`, { expectedRevision: a.revision, faultMode: 'none', url: 'http://127.0.0.1:18080/private' });
    assert.equal(bad.status, 400);
  });
  for (const faultMode of ['rate_limited', 'timeout', 'malformed', 'cross_tenant', 'incomplete', 'schema_drift']) {
    await check(`fault ${faultMode}: failed connection exposes no partial preview`, async () => {
      const project = await connect('mock-onboarding-a', faultMode);
      assert.equal(project.connection.status, 'failed'); assert.ok(project.connection.issue?.code);
      assert.equal((await server.call('mock-onboarding-a', `/${project.id}/preview`)).status, 409);
      assert.ok(!JSON.stringify(project).includes('synthetic-foreign-tenant'));
    });
  }
  await check('clean retry restores the connection after injected faults', async () => {
    assert.equal((await connect('mock-onboarding-a')).connection.status, 'verified');
  });
  await check('editing material invalidates the preview; source does not echo edited uploaded samples', async () => {
    const tenant = 'mock-onboarding-a'; const project = projects[tenant];
    const material = onboardingMaterials('fulfillment', tenant)[3];
    const samples = JSON.parse(material.text); const table = JSON.parse(onboardingMaterials('fulfillment', tenant)[2].text).tables.find(table => table.fields.some(field => field.name === 'name'));
    const row = samples.records.find(row => row.objectType === table.name); const originalName = row.payload.name;
    row.payload.name = '仅修改上传材料，不应成为接口返回值'; material.text = JSON.stringify(samples);
    const saved = await server.call(tenant, `/${project.id}/materials`, { ...material, expectedRevision: project.revision });
    assert.equal(saved.status, 200); projects[tenant] = saved.body.project; assert.equal(saved.body.project.connection, null);
    assert.equal((await server.call(tenant, `/${project.id}/preview`)).status, 409);
    const verified = await connect(tenant); assert.equal(verified.connection.status, 'verified');
    const preview = await server.call(tenant, `/${project.id}/preview?objectType=${table.name}`);
    assert.equal(preview.status, 200);
    assert.equal(preview.body.rows.find(item => item[table.primaryKey] === row.payload[table.primaryKey]).name, originalName);
    const stale = await server.call(tenant, `/${project.id}/connection`, { expectedRevision: project.revision, faultMode: 'none' });
    assert.equal(stale.status, 409);
  });
  report.alignments = [];
  const saveAlignment = async (tenant, config) => {
    const project = projects[tenant];
    const result = await server.call(tenant, `/${project.id}/alignment`, { expectedRevision: project.revision, config });
    assert.equal(result.status, 200); projects[tenant] = result.body.project;
    assert.equal(result.body.project.connection, null); assert.equal(result.body.project.alignment.status, 'pending');
  };
  for (const { tenantId, scenarioId } of syntheticEnterprises) await check(`${tenantId}: explicit human alignment is evaluated on fresh complete source data`, async () => {
    await saveAlignment(tenantId, onboardingAlignment(scenarioId));
    const project = await connect(tenantId); assert.equal(project.alignment.status, 'validated_scope');
    const response = await server.call(tenantId, `/${project.id}/alignment`); assert.equal(response.status, 200);
    const mapping = response.body.report;
    assert.equal(mapping.revision, project.revision); assert.equal(mapping.scope, 'configured_rules_only');
    assert.deepEqual(mapping.previews.units.map(row => row.value), scenarioId === 'fulfillment' ? [230, 40] : [120000, 80000]);
    assert.ok(mapping.unconfiguredObjects.length > 0);
    assert.equal(project.milestones.find(step => step.id === 'model').status, 'pending');
    report.alignments.push({ tenantId, ...mapping });
  });
  await check('alignment evidence is tenant private and invalid dimensions cannot overwrite config', async () => {
    const project = projects['mock-onboarding-a'];
    assert.equal((await server.call('mock-onboarding-b', `/${project.id}/alignment`)).status, 404);
    const config = onboardingAlignment('fulfillment');
    assert.equal((await server.call('mock-onboarding-b', `/${project.id}/alignment`, { expectedRevision: project.revision, config })).status, 404);
    config.units[0].targetUnit = 'kg';
    assert.equal((await server.call('mock-onboarding-a', `/${project.id}/alignment`, { expectedRevision: project.revision, config })).status, 400);
    assert.equal((await server.call('mock-onboarding-a', `/${project.id}`)).body.project.revision, project.revision);
  });
  await check('transport success cannot hide missing state mapping; correction restores only the configured scope', async () => {
    const tenant = 'mock-onboarding-a'; const config = onboardingAlignment('fulfillment'); config.states[0].values.pop();
    await saveAlignment(tenant, config); let project = await connect(tenant);
    assert.equal(project.connection.status, 'verified'); assert.equal(project.alignment.status, 'needs_review');
    const response = await server.call(tenant, `/${project.id}/alignment`);
    assert.ok(response.body.report.issues.some(issue => issue.code === 'STATE_UNMAPPED')); assert.deepEqual(response.body.report.previews.units, []);
    await saveAlignment(tenant, onboardingAlignment('fulfillment')); project = await connect(tenant);
    assert.equal(project.alignment.status, 'validated_scope');
  });
  await check('material replacement invalidates alignment reports without silently accepting old evidence', async () => {
    const tenant = 'mock-onboarding-a'; const project = projects[tenant];
    const result = await server.call(tenant, `/${project.id}/materials`, { ...onboardingMaterials('fulfillment', tenant)[4], expectedRevision: project.revision });
    assert.equal(result.status, 200); projects[tenant] = result.body.project;
    assert.equal(result.body.project.alignment.status, 'pending');
    assert.equal((await server.call(tenant, `/${project.id}/alignment`)).body.report, null);
  });
  await check('no unexpected network attempts occurred', () => assert.equal(guard.deniedAttempts, 2));
  await check('preparation and Mock reads have not written any model, publication or Agent task state', async () => {
    const { listState } = await import('../backend/src/repositories/runtime-state-repository.js');
    const namespaces = ['oa_meta_model_runtime', 'ontology_publication', 'semantic_operations_agent_proposals', 'semantic_operations_agent_tasks'];
    report.untouchedModelNamespaces = namespaces.map(namespace => ({ namespace, entries: listState(namespace).length }));
    assert.ok(report.untouchedModelNamespaces.every(item => item.entries === 0));
    report.modelPublished = false;
  });
  report.handoffs = [];
  for (const { tenantId, scenarioId } of syntheticEnterprises) await check(`${tenantId}: cited mappings hand off through authenticated HTTP without adoption or publication`, async () => {
    let project = projects[tenantId];
    const evidence = (await server.call(tenantId, `/${project.id}/alignment`)).body.evidenceSources.find(source => source.kind === 'rules');
    const config = onboardingAlignment(scenarioId);
    for (const category of ['identities', 'units', 'states']) for (const rule of config[category]) rule.materialEvidence = { kind: 'rules', digest: evidence.digest, quote: evidence.text.slice(0, 80) };
    await saveAlignment(tenantId, config); project = await connect(tenantId);
    const result = await server.call(tenantId, `/${project.id}/handoff`, { expectedRevision: project.revision });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.reused, false); assert.equal(result.body.project.handoff.current, true);
    projects[tenantId] = result.body.project;
    const repeated = await server.call(tenantId, `/${project.id}/handoff`, { expectedRevision: result.body.project.revision });
    assert.equal(repeated.body.reused, true); assert.equal(repeated.body.taskId, result.body.taskId);
    const otherTenant = tenantId === 'mock-onboarding-a' ? 'mock-onboarding-b' : 'mock-onboarding-a';
    assert.equal((await server.call(otherTenant, `/${project.id}/handoff`, { expectedRevision: result.body.project.revision })).status, 404);
    report.handoffs.push({ tenantId, taskId: result.body.taskId, proposalId: result.body.proposalId });
  });
  await check('handoff commits two isolated pending tasks but no model publication', async () => {
    const { listState } = await import('../backend/src/repositories/runtime-state-repository.js');
    const tasks = Object.values(listState('semantic_operations_agent_tasks')[0].value);
    assert.equal(tasks.length, 2); assert.ok(tasks.every(task => task.status === 'waiting_confirmation' && task.confirmation.state === 'not_issued'));
    assert.ok(tasks.every(task => task.proposal.critic.status === 'passed' && task.proposal.mappingValidation.status === 'passed'));
    assert.equal(listState('semantic_operations_agent_proposals').length, 2); assert.equal(listState('ontology_publication').length, 0);
    assert.equal(guard.deniedAttempts, 2);
    report.handoffBoundary = '确定性材料提取与待审阅任务；读取现有或初始化基础租户草稿以计算合并 Diff，但未采纳或发布。未验证大模型推理和智脑问答。';
  });
} catch (error) {
  report.failureCode = error.code || 'MOCK_ONBOARDING_FAILED';
  process.exitCode = 1;
} finally {
  if (server) await server.close();
  report.blockedNetworkAttempts = guard.deniedAttempts;
  guard.restore();
  report.finishedAt = new Date().toISOString();
  report.passed = !process.exitCode && report.checks.every(item => item.passed);
  if (!process.argv.includes('--no-artifacts')) {
    const directory = resolve('output/mock-onboarding', `${report.startedAt.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
    await mkdir(directory, { recursive: true });
    for (const enterprise of syntheticEnterprises) {
      const destination = join(directory, enterprise.tenantId, 'materials'); await mkdir(destination, { recursive: true });
      for (const material of onboardingMaterials(enterprise.scenarioId, enterprise.tenantId)) await writeFile(join(destination, material.name), material.text, { encoding: 'utf8', flag: 'wx' });
      await writeFile(join(directory, enterprise.tenantId, 'alignment.manual.json'), JSON.stringify(onboardingAlignment(enterprise.scenarioId), null, 2), { encoding: 'utf8', flag: 'wx' });
    }
    await writeFile(join(directory, 'assessment.json'), JSON.stringify(report, null, 2), { encoding: 'utf8', flag: 'wx' });
    report.artifacts = directory;
  }
  console.log(JSON.stringify(report, null, 2));
}
