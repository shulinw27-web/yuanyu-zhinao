import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resetRuntimeState, writeState, readState } from '../src/repositories/runtime-state-repository.js';
import { asyncRuntimeStateRepository } from '../src/repositories/async-runtime-state-repository.js';
import { configureSemanticGovernanceRepository, mutateSemanticGovernanceState, readSemanticGovernanceState } from '../src/services/semantic-governance-store.js';
import { getRole } from '../src/services/authorization-service.js';
import { claimDueSemanticInspection, completeSemanticInspection, controlSemanticInspectionSchedule, createSemanticInspectionSchedule, listSemanticInspectionSchedules, runSemanticInspectionCycle, runRegisteredSemanticInspectionCycle } from '../src/services/semantic-inspection-schedule-service.js';
import { inspectSemanticReadOnly } from '../src/services/semantic-read-only-inspection.js';
import { getOAMetaModelDraft, saveOAMetaModelDraft } from '../src/services/meta-model-service.js';
import { createSemanticOperationsNotification, listSemanticOperationsNotifications, readSemanticOperationsNotification } from '../src/services/semantic-operations-notification-service.js';
import { semanticOperationsPrincipalKey, semanticOperationsOwnerMatches } from '../src/services/semantic-operations-identity.js';
import { extendSemanticMaterials, loadSemanticMaterials } from '../src/services/semantic-material-workspace-service.js';
import { runWithSemanticTenant, currentSemanticModel } from '../src/services/semantic-tenant-context.js';
import { semanticModelRegistry } from '../src/services/semantic-model-registry.js';
import { loadInspectionWorkerBinding, runInspectionWorkerCycle } from '../../services/semantic-inspection-worker/runtime.js';
import { createTenantIAMWorkspace } from '../src/services/iam-workspace-model.js';

const identity = { tenantId: 'inspection-tenant', subjectId: 'inspection-user', deviceId: 'inspection-device', platform: 'test' };

test('worker binding rejects absent production, malformed files and unresolved IAM identities without fallback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'inspection-binding-'));
  const path = join(directory, 'binding.json');
  try {
    await assert.rejects(loadInspectionWorkerBinding({ NODE_ENV: 'production' }), { code: 'SEMANTIC_INSPECTION_BINDING_REQUIRED' });
    assert.equal(await loadInspectionWorkerBinding({ NODE_ENV: 'test' }), null);
    for (const input of [null, [], { version: 1, tenantId: 'demo-enterprise', subjectId: 'usr-001', modelIds: ['finance', 'finance'] },
      { version: 1, tenantId: 'demo-enterprise', subjectId: 'usr-001', modelIds: ['finance'], roleId: 'executive' }]) {
      await writeFile(path, JSON.stringify(input));
      await assert.rejects(loadInspectionWorkerBinding({ SEMANTIC_INSPECTION_BINDING_FILE: path }), { code: 'SEMANTIC_INSPECTION_BINDING_INVALID' });
    }
    await writeFile(path, JSON.stringify({ version: 1, tenantId: 'demo-enterprise', subjectId: 'not-an-existing-user', modelIds: ['finance'] }));
    await assert.rejects(runInspectionWorkerCycle({ env: { SEMANTIC_INSPECTION_BINDING_FILE: path }, executeInspection: () => assert.fail('No authority, no dispatch') }), { code: 'SEMANTIC_INSPECTION_BINDING_FORBIDDEN' });
    await assert.rejects(loadInspectionWorkerBinding({ SEMANTIC_INSPECTION_BINDING_FILE: 'relative.json' }), { code: 'SEMANTIC_INSPECTION_BINDING_INVALID' });
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('actual SQLite Worker restores independent plans across restarts and rejects revoked bindings', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'inspection-worker-restart-'));
  const path = join(directory, 'binding.json');
  const env = { ...process.env, NODE_ENV: 'test', RUNTIME_STORE_DRIVER: 'sqlite', RUNTIME_SQLITE_PATH: join(directory, 'runtime.db'),
    SEMANTIC_INSPECTION_BINDING_FILE: path, SEMANTICA_BRIDGE_ENABLED: 'false' };
  const execute = promisify(execFile);
  const helper = mode => execute(process.execPath, ['backend/test/helpers/inspection-model-worker.mjs', mode], { env, windowsHide: true });
  const worker = () => execute(process.execPath, ['services/semantic-inspection-worker/app.js', '--once'], { env, windowsHide: true });
  try {
    await writeFile(path, JSON.stringify({ version: 1, tenantId: 'demo-enterprise', subjectId: 'usr-001', modelIds: ['finance', 'production'], maxRuns: 2 }));
    await helper('seed');
    assert.equal(JSON.parse((await worker()).stdout).processed, 2);
    await helper('verify');
    assert.equal(JSON.parse((await worker()).stdout).processed, 0);
    await helper('due');
    assert.equal(JSON.parse((await worker()).stdout).processed, 2);
    await helper('verify-again');
    await helper('revoke');
    await assert.rejects(worker(), error => error.code === 1 && /MODEL_REGISTRY_NOT_FOUND/.test(error.stderr));
    await writeFile(path, '{ invalid-private-fixture');
    await assert.rejects(worker(), error => error.code === 1 && /SEMANTIC_INSPECTION_BINDING_INVALID/.test(error.stderr) && !/invalid-private-fixture/.test(error.stderr));
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('worker rechecks its real IAM principal and discards results when permission is revoked in flight', async () => {
  resetRuntimeState(['iam', 'semantic_model_registry', 'semantic_inspection_schedules', 'semantic_operations_notifications']);
  const directory = await mkdtemp(join(tmpdir(), 'inspection-iam-revocation-'));
  const path = join(directory, 'binding.json');
  const principal = { tenantId: 'demo-enterprise', subjectId: 'usr-001' }; const role = getRole('executive');
  try {
    writeState('iam', 'workspace', createTenantIAMWorkspace(principal.tenantId));
    await writeFile(path, JSON.stringify({ version: 1, ...principal, modelIds: ['finance'] }));
    await runWithSemanticTenant(principal, async () => {
      await semanticModelRegistry.register({ role, identityScope: principal, body: { id: 'finance', label: '财务模型', expectedRevision: 0 } });
      await semanticModelRegistry.withWorkspace({ role, identityScope: principal, modelId: 'finance', work: () => createSemanticInspectionSchedule({ body: { checks: ['schema_integrity'] }, role, identityScope: principal }) });
    });
    await assert.rejects(runInspectionWorkerCycle({ env: { SEMANTIC_INSPECTION_BINDING_FILE: path }, executeInspection: async () => {
      const iam = readState('iam', 'workspace'); iam.users.find(user => user.id === 'usr-001').status = 'disabled'; writeState('iam', 'workspace', iam);
      return { severity: 'info', summary: 'Must not accept', findings: [] };
    } }), { code: 'SEMANTIC_INSPECTION_BINDING_FORBIDDEN' });
    await runWithSemanticTenant(principal, () => semanticModelRegistry.withWorkspace({ role, identityScope: principal, modelId: 'finance', work: async () => {
      const schedule = (await listSemanticInspectionSchedules({ identityScope: principal }))[0];
      assert.equal(schedule.lastRun.status, 'failed'); assert.equal(schedule.lastRun.result, null);
    } }));
  } finally {
    resetRuntimeState(['iam']);
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('explicit registered inspections use each model draft, honor total budget and do not scan default', async () => {
  resetRuntimeState(['semantic_model_registry', 'oa_meta_model_runtime', 'semantic_inspection_schedules', 'semantic_operations_notifications']);
  const role = getRole('executive');
  await runWithSemanticTenant(identity, async () => {
    const workspace = (modelId, work) => semanticModelRegistry.withWorkspace({ role, identityScope: identity, modelId, work });
    for (const [expectedRevision, modelId] of ['finance', 'production'].entries()) {
      await semanticModelRegistry.register({ role, identityScope: identity, body: { id: modelId, label: `${modelId}模型`, expectedRevision } });
      await workspace(modelId, async () => {
        const draft = await getOAMetaModelDraft();
        const objectTypes = draft.objectTypes.slice(0, expectedRevision + 1);
        const ids = new Set(objectTypes.map(item => item.id));
        const saved = await saveOAMetaModelDraft({ objectTypes, relationshipTypes: draft.relationshipTypes.filter(item => ids.has(item.from) && ids.has(item.to)) }, role);
        assert.equal(saved.error, undefined);
        for (let i = 0; i < 2; i++) {
          const created = await createSemanticInspectionSchedule({ body: { checks: ['schema_integrity', 'mapping_coverage'] }, role, identityScope: identity });
          assert.equal(created.schedule.modelId, modelId);
        }
      });
    }
    const seen = [];
    const cycle = await runRegisteredSemanticInspectionCycle({ role, identityScope: identity, modelIds: ['finance', 'production'], maxRuns: 2,
      executeInspection: async schedule => { seen.push(currentSemanticModel()); return inspectSemanticReadOnly(schedule); } });
    assert.equal(cycle.processed, 2); assert.deepEqual(seen, ['finance', 'production']);
    for (const [i, modelId] of ['finance', 'production'].entries()) await workspace(modelId, async () => {
      const completed = (await listSemanticInspectionSchedules({ identityScope: identity })).find(schedule => schedule.lastRun);
      assert.match(completed.lastRun.result.findings[0].metric, new RegExp(`^${i + 1} objects`));
      assert.equal(completed.lastRun.status === 'failed', false);
    });
    const remaining = await runRegisteredSemanticInspectionCycle({ role, identityScope: identity, modelIds: ['production', 'finance'], maxRuns: 10, executeInspection: inspectSemanticReadOnly });
    assert.equal(remaining.processed, 2);
    assert.equal((await listSemanticInspectionSchedules({ identityScope: identity })).length, 0);
  });
});

test('registered inspection preflight rejects malformed, unknown or unprivileged bindings before claiming work', async () => {
  resetRuntimeState(['semantic_model_registry', 'semantic_inspection_schedules']);
  const role = getRole('executive');
  await runWithSemanticTenant(identity, async () => {
    await semanticModelRegistry.register({ role, identityScope: identity, body: { id: 'finance', label: '财务模型', expectedRevision: 0 } });
    await semanticModelRegistry.withWorkspace({ role, identityScope: identity, modelId: 'finance', work: () => createSemanticInspectionSchedule({ body: { checks: ['schema_integrity'] }, role, identityScope: identity }) });
    const run = extra => runRegisteredSemanticInspectionCycle({ role, identityScope: identity, modelIds: ['finance'], executeInspection: () => assert.fail('Preflight must reject'), ...extra });
    assert.equal((await run({ modelIds: ['finance', 'missing'] })).code, 'MODEL_REGISTRY_NOT_FOUND');
    for (const modelIds of [[], ['finance', 'finance'], ['../finance'], ['finance', null]]) assert.equal((await run({ modelIds })).code, 'SEMANTIC_INSPECTION_BINDING_INVALID');
    assert.equal((await run({ role: getRole('quality_manager') })).code, 'MODEL_REGISTRY_FORBIDDEN');
    await semanticModelRegistry.withWorkspace({ role, identityScope: identity, modelId: 'finance', work: async () => {
      assert.equal((await run({})).code, 'SEMANTIC_INSPECTION_BINDING_INVALID');
      assert.equal((await listSemanticInspectionSchedules({ identityScope: identity }))[0].lastRun, null);
      for (const checks of [['source_readiness'], ['deployment_drift'], ['schema_integrity', 'unsupported']]) {
        assert.equal((await createSemanticInspectionSchedule({ body: { checks }, role, identityScope: identity })).code, 'SEMANTIC_MODEL_INSPECTION_CHECK_UNSUPPORTED');
        await assert.rejects(inspectSemanticReadOnly({ modelId: 'finance', roleId: role.id, checks }), /BINDING_INVALID/);
      }
      await assert.rejects(inspectSemanticReadOnly({ modelId: 'production', roleId: role.id, checks: ['schema_integrity'] }), /BINDING_INVALID/);
    } });
  });
});

test('notification model references are stamped, isolated and never select a different workspace', async () => {
  resetRuntimeState(['semantic_model_registry', 'semantic_operations_notifications']);
  const role = getRole('executive');
  await runWithSemanticTenant(identity, async () => {
    for (const [expectedRevision, id] of ['finance', 'production'].entries()) await semanticModelRegistry.register({ role, identityScope: identity, body: { id, label: `${id}模型`, expectedRevision } });
    const workspace = (modelId, work) => semanticModelRegistry.withWorkspace({ role, identityScope: identity, modelId, work });
    const notice = await workspace('finance', () => createSemanticOperationsNotification({ identityScope: identity, action: { type: 'open_inspection', id: 'same-id' } }));
    assert.equal(notice.modelId, 'finance'); assert.equal(notice.action.modelId, 'finance');
    assert.equal((await workspace('production', () => listSemanticOperationsNotifications({ identityScope: identity }))).length, 0);
    assert.equal((await listSemanticOperationsNotifications({ identityScope: identity })).length, 0);
    await workspace('finance', async () => {
      await assert.rejects(createSemanticOperationsNotification({ identityScope: identity, action: { type: 'open_inspection', modelId: 'production' } }), /MODEL_MISMATCH/);
      await mutateSemanticGovernanceState('semantic_operations_notifications', 'index', {}, index => {
        index[notice.id].action.modelId = 'production';
        index.legacy = { id: 'legacy', owner: notice.owner, createdAt: notice.createdAt };
        return { value: index };
      });
      assert.equal((await listSemanticOperationsNotifications({ identityScope: identity })).length, 0);
      assert.equal((await readSemanticOperationsNotification({ id: notice.id, identityScope: identity })).code, 'SEMANTIC_NOTIFICATION_NOT_FOUND');
    });
  });
});

test('inspection wrong-model references cannot be listed, controlled, claimed or completed', async () => {
  resetRuntimeState(['semantic_inspection_schedules', 'semantic_operations_notifications']);
  const role = getRole('executive');
  assert.equal((await createSemanticInspectionSchedule({ body: { checks: ['schema_integrity'], modelId: 'finance' }, role, identityScope: identity })).code, 'SEMANTIC_INSPECTION_MODEL_MISMATCH');
  const created = await createSemanticInspectionSchedule({ body: { checks: ['schema_integrity'] }, role, identityScope: identity });
  assert.equal(created.schedule.modelId, 'oa-governance');
  const claimed = await claimDueSemanticInspection({ workerId: 'model-worker' });
  await mutateSemanticGovernanceState('semantic_inspection_schedules', 'index', {}, index => { index[created.schedule.id].modelId = 'finance'; return { value: index }; });
  assert.equal((await listSemanticInspectionSchedules({ identityScope: identity })).length, 0);
  assert.equal((await controlSemanticInspectionSchedule({ id: created.schedule.id, action: 'cancel', identityScope: identity })).code, 'SEMANTIC_INSPECTION_NOT_FOUND');
  assert.equal(await claimDueSemanticInspection({ workerId: 'another-worker' }), null);
  assert.equal(await completeSemanticInspection({ id: created.schedule.id, workerId: 'model-worker', leaseToken: claimed.lease.token, result: { severity: 'warning', summary: 'wrong model', findings: [] } }), null);
  assert.equal((await listSemanticOperationsNotifications({ identityScope: identity })).length, 0);
});

test('internal inspection recovery keeps the admitted model and rejects registration revocation during execution', async () => {
  resetRuntimeState(['semantic_model_registry', 'semantic_inspection_schedules', 'semantic_operations_notifications']);
  const role = getRole('executive');
  await runWithSemanticTenant(identity, async () => {
    await semanticModelRegistry.register({ role, identityScope: identity, body: { id: 'finance', label: '财务模型', expectedRevision: 0 } });
    const workspace = work => semanticModelRegistry.withWorkspace({ role, identityScope: identity, modelId: 'finance', work });
    await workspace(async () => {
      // Source/deployment checks remain unavailable for independent workspaces.
      assert.equal((await createSemanticInspectionSchedule({ body: { checks: ['source_readiness'] }, role, identityScope: identity })).code, 'SEMANTIC_MODEL_INSPECTION_CHECK_UNSUPPORTED');
      await mutateSemanticGovernanceState('semantic_inspection_schedules', 'index', {}, () => ({ value: { recovery: {
        id: 'recovery', modelId: 'finance', owner: semanticOperationsPrincipalKey(identity), identityScope: identity,
        roleId: role.id, checks: ['schema_integrity'], status: 'active', intervalMinutes: 15,
        createdAt: '2000-01-01T00:00:00.000Z', nextRunAt: '2000-01-01T00:00:00.000Z', lease: null
      } } }));
      const cycle = await runSemanticInspectionCycle({ executeInspection: async () => {
        assert.equal(currentSemanticModel(), 'finance');
        await mutateSemanticGovernanceState('semantic_model_registry', 'index', { models: [] }, state => { state.models[0].lifecycle = 'disabled'; return { value: state }; });
        return { severity: 'info', summary: 'not accepted', findings: [] };
      } });
      assert.equal(cycle.processed, 1);
      const state = await readSemanticGovernanceState('semantic_inspection_schedules', 'index', {});
      assert.equal(state.recovery.lastRun.status, 'failed'); assert.equal(state.recovery.lastRun.result, null);
      const notices = await listSemanticOperationsNotifications({ identityScope: identity });
      assert.equal(notices[0].modelId, 'finance'); assert.equal(notices[0].action.modelId, 'finance');
      await controlSemanticInspectionSchedule({ id: 'recovery', action: 'run-now', identityScope: identity });
      assert.equal((await runSemanticInspectionCycle({ executeInspection: () => assert.fail('Revoked registration must block dispatch') })).processed, 1);
      assert.equal((await readSemanticGovernanceState('semantic_inspection_schedules', 'index', {})).recovery.lastRun.status, 'failed');
    });
    assert.equal((await listSemanticOperationsNotifications({ identityScope: identity })).length, 0);
    assert.equal((await runSemanticInspectionCycle({ executeInspection: () => assert.fail('No default fallback') })).processed, 0);
  });
});

test('delimiter-bearing tenants and subjects cannot share notices or schedule ownership', async () => {
  resetRuntimeState(['semantic_operations_notifications', 'semantic_inspection_schedules']);
  const a = { tenantId: 'company:a', subjectId: 'b' }; const b = { tenantId: 'company', subjectId: 'a:b' };
  assert.notEqual(semanticOperationsPrincipalKey(a), semanticOperationsPrincipalKey(b));
  await createSemanticOperationsNotification({ identityScope: a, message: 'A ONLY' });
  const created = await createSemanticInspectionSchedule({ body: { checks: ['schema_integrity'] }, role: getRole('executive'), identityScope: a });
  assert.equal((await listSemanticOperationsNotifications({ identityScope: b })).length, 0);
  assert.equal((await listSemanticInspectionSchedules({ identityScope: b })).length, 0);
  assert.equal((await controlSemanticInspectionSchedule({ id: created.schedule.id, action: 'cancel', identityScope: b })).code, 'SEMANTIC_INSPECTION_NOT_FOUND');
});

test('semantic review notifications reach same-tenant reviewers and reject other tenants or roles', async () => {
  resetRuntimeState(['semantic_operations_notifications']);
  const author = { tenantId: 'review-tenant', subjectId: 'author' };
  const reviewer = { tenantId: 'review-tenant', subjectId: 'reviewer' };
  const outsider = { tenantId: 'other-tenant', subjectId: 'reviewer' };
  const notice = await createSemanticOperationsNotification({
    identityScope: author,
    audiencePermissionId: 'meta_model.draft.review',
    title: '语义模型待审核',
    action: { type: 'open_semantic_task', taskId: 'task-1' }
  });
  const reviewerAccess = { buttonPermissionIds: ['meta_model.draft.review', 'meta_model.draft.save'] };
  assert.equal((await listSemanticOperationsNotifications({ identityScope: reviewer, accessContext: reviewerAccess })).length, 1);
  assert.equal((await listSemanticOperationsNotifications({ identityScope: reviewer, accessContext: { buttonPermissionIds: ['meta_model.draft.save'] } })).length, 0);
  assert.equal((await listSemanticOperationsNotifications({ identityScope: outsider, accessContext: reviewerAccess })).length, 0);
  assert.equal((await readSemanticOperationsNotification({ id: notice.id, identityScope: outsider, accessContext: reviewerAccess })).code, 'SEMANTIC_NOTIFICATION_NOT_FOUND');
  assert.ok((await readSemanticOperationsNotification({ id: notice.id, identityScope: reviewer, accessContext: reviewerAccess })).readAt);
});

test('legacy unambiguous owners remain readable; ambiguous and device owners fail closed', () => {
  assert.equal(semanticOperationsOwnerMatches('company:user', { tenantId: 'company', subjectId: 'user' }), true);
  assert.equal(semanticOperationsOwnerMatches('company:a:b', { tenantId: 'company:a', subjectId: 'b' }), false);
  assert.equal(semanticOperationsOwnerMatches('company:a:b', { tenantId: 'company', subjectId: 'a:b' }), false);
  assert.equal(semanticOperationsOwnerMatches('company:user:device', { tenantId: 'company', subjectId: 'user', deviceId: 'device' }), false);
});

test('material references isolate delimiter-bearing identities and preserve safe legacy reads', async () => {
  resetRuntimeState(['semantic_material_artifacts']);
  const a = { tenantId: 'company:a', subjectId: 'b' }; const b = { tenantId: 'company', subjectId: 'a:b' };
  const stored = await extendSemanticMaterials({ identityScope: a, roleId: 'executive', content: { documents: [{ name: 'synthetic.txt', mimeType: 'text/plain', text: 'A only' }] } });
  await assert.rejects(loadSemanticMaterials(stored.refs, b, 'executive'), /SEMANTIC_MATERIAL_ACCESS_DENIED/);
  assert.equal((await loadSemanticMaterials(stored.refs, a, 'executive'))[0].text, 'A only');
  writeState('semantic_material_artifacts', 'legacy-ref', { owner: 'company:user', roleId: 'executive', document: { text: 'legacy' } });
  assert.equal((await loadSemanticMaterials(['legacy-ref'], { tenantId: 'company', subjectId: 'user' }, 'executive'))[0].text, 'legacy');
});

test('SQLite rolls back a failed notification row and both records survive process restart', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'semantic-notice-atomic-'));
  const env = { ...process.env, NODE_ENV: 'test', RUNTIME_STORE_DRIVER: 'sqlite', RUNTIME_SQLITE_PATH: join(directory, 'runtime.db') };
  try {
    for (const mode of ['write', 'read']) {
      const result = await promisify(execFile)(process.execPath, ['backend/test/helpers/inspection-atomic-worker.mjs', mode], { env, windowsHide: true });
      assert.deepEqual(JSON.parse(result.stdout), { status: 'passed', schedules: 1, notifications: 1 });
    }
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('inspection result and notification roll back together, then retry creates one notice', async () => {
  resetRuntimeState(['semantic_inspection_schedules', 'semantic_operations_notifications']);
  await createSemanticInspectionSchedule({ body: { checks: ['schema_integrity'] }, role: getRole('executive'), identityScope: identity });
  const schedule = await claimDueSemanticInspection({ workerId: 'atomic-worker' });
  const completion = { id: schedule.id, workerId: 'atomic-worker', leaseToken: schedule.lease.token, result: { severity: 'warning', summary: '合成告警', findings: [] } };
  configureSemanticGovernanceRepository({ ...asyncRuntimeStateRepository,
    mutateState: async (...args) => { if (args[0] === 'semantic_operations_notifications') throw new Error('simulated commit failure'); return asyncRuntimeStateRepository.mutateState(...args); },
    mutateStates: async (entries, work) => asyncRuntimeStateRepository.mutateStates(entries, (...args) => { work(...args); throw new Error('simulated commit failure'); })
  });
  try {
    await assert.rejects(completeSemanticInspection(completion), /simulated commit failure/);
    assert.equal((await listSemanticInspectionSchedules({ identityScope: identity }))[0].lastRun, null);
    assert.equal((await listSemanticOperationsNotifications({ identityScope: identity })).length, 0);
  } finally { configureSemanticGovernanceRepository(null); }
  assert.equal((await completeSemanticInspection(completion)).lastRun.status, 'warning');
  assert.equal(await completeSemanticInspection(completion), null);
  assert.equal((await listSemanticOperationsNotifications({ identityScope: identity })).length, 1);
});

test('notification retention cannot evict another tenant or another subject', async () => {
  resetRuntimeState(['semantic_operations_notifications']);
  const other = { tenantId: 'other-company', subjectId: 'other-user' };
  const saved = await createSemanticOperationsNotification({ identityScope: other, message: '必须保留' });
  const sameCompany = await createSemanticOperationsNotification({ identityScope: { ...identity, subjectId: 'colleague' }, message: '同企业其他人的通知' });
  const index = readState('semantic_operations_notifications', 'index');
  for (let i = 0; i < 500; i++) index[`synthetic-${i}`] = { id: `synthetic-${i}`, owner: i % 2 ? semanticOperationsPrincipalKey(identity) : `${identity.tenantId}:${identity.subjectId}`, createdAt: '2000-01-01T00:00:00.000Z' };
  // Ensure old notices from other principals would be evicted by a global cap.
  index[saved.id].createdAt = '1999-01-01T00:00:00.000Z'; index[sameCompany.id].createdAt = index[saved.id].createdAt;
  writeState('semantic_operations_notifications', 'index', index);
  const latest = await createSemanticOperationsNotification({ identityScope: identity, message: '最新通知' });
  const after = readState('semantic_operations_notifications', 'index');
  assert.ok(after[saved.id]); assert.ok(after[sameCompany.id]); assert.ok(after[latest.id]);
  assert.equal(Object.values(after).filter(item => semanticOperationsOwnerMatches(item.owner, identity)).length, 500);
});

test('semantic schedules execute only declared read-only checks and notify findings', async () => {
  resetRuntimeState(['semantic_inspection_schedules', 'semantic_operations_notifications']);
  const created = await createSemanticInspectionSchedule({ body: { checks: ['schema_integrity', 'not_allowed'], intervalMinutes: 1, runNow: true }, role: getRole('executive'), identityScope: identity });
  assert.deepEqual(created.schedule.checks, ['schema_integrity']);
  assert.equal(created.schedule.intervalMinutes, 15);
  const cycle = await runSemanticInspectionCycle({ workerId: 'test-worker', executeInspection: async (schedule) => ({ severity: 'warning', summary: '发现映射待复核。', findings: schedule.checks }) });
  assert.equal(cycle.processed, 1);
  const schedules = await listSemanticInspectionSchedules({ identityScope: identity });
  assert.equal(schedules[0].lastRun.status, 'warning');
  const notices = await listSemanticOperationsNotifications({ identityScope: identity });
  assert.equal(notices.length, 1);
  assert.match(notices[0].message, /待复核/);
});

test('inspection completion rejects another worker lease', async () => {
  assert.equal(await completeSemanticInspection({ id: 'missing', workerId: 'other', result: {} }), null);
});

test('an empty or malformed inspection response is never reported as passed', async () => {
  for (const result of [undefined, {}, { severity: 'info', summary: '缺少检查项' }, { severity: 'error', summary: '错误', findings: [] }]) {
    resetRuntimeState(['semantic_inspection_schedules', 'semantic_operations_notifications']);
    await createSemanticInspectionSchedule({ body: { checks: ['schema_integrity'] }, role: getRole('executive'), identityScope: identity });
    await runSemanticInspectionCycle({ executeInspection: async () => result });
    const last = (await listSemanticInspectionSchedules({ identityScope: identity }))[0].lastRun;
    assert.equal(last.status, 'failed'); assert.equal(last.result, null);
  }
});

test('inspection rejects expired and same-worker prior leases and hides lease tokens from users', async () => {
  resetRuntimeState(['semantic_inspection_schedules', 'semantic_operations_notifications']);
  const created = await createSemanticInspectionSchedule({ body: { checks: ['schema_integrity'] }, role: getRole('executive'), identityScope: identity });
  const start = Date.now();
  const first = await claimDueSemanticInspection({ workerId: 'reused-worker', nowAt: start, leaseMs: 10000 });
  assert.equal(await completeSemanticInspection({ id: created.schedule.id, workerId: 'reused-worker', leaseToken: first.lease?.token, nowAt: start + 10000, result: { severity: 'warning', summary: '过期结果' } }), null);
  const second = await claimDueSemanticInspection({ workerId: 'reused-worker', nowAt: start + 10001 });
  assert.notEqual(first.lease?.token, second.lease?.token);
  assert.equal(await completeSemanticInspection({ id: created.schedule.id, workerId: 'reused-worker', leaseToken: first.lease?.token, nowAt: start + 10002, result: { severity: 'warning', summary: '旧结果' } }), null);
  assert.equal((await listSemanticOperationsNotifications({ identityScope: identity })).length, 0);
  assert.equal(Object.hasOwn((await listSemanticInspectionSchedules({ identityScope: identity }))[0], 'lease'), false);
});

test('cancelled inspection cannot be resumed or run-now; in-flight result creates no notification', async () => {
  resetRuntimeState(['semantic_inspection_schedules', 'semantic_operations_notifications']);
  const created = await createSemanticInspectionSchedule({ body: { checks: ['schema_integrity'] }, role: getRole('executive'), identityScope: identity });
  await runSemanticInspectionCycle({ workerId: 'cancel-worker', executeInspection: async () => {
    await controlSemanticInspectionSchedule({ id: created.schedule.id, action: 'cancel', identityScope: identity });
    return { severity: 'warning', summary: '迟到结果', findings: [] };
  } });
  assert.equal((await listSemanticInspectionSchedules({ identityScope: identity }))[0].lastRun, null);
  assert.equal((await listSemanticOperationsNotifications({ identityScope: identity })).length, 0);
  for (const action of ['resume', 'run-now']) assert.equal((await controlSemanticInspectionSchedule({ id: created.schedule.id, action, identityScope: identity })).code, 'SEMANTIC_INSPECTION_STATE_CONFLICT');
});

test('inspection error messages do not persist provider secrets or arbitrary stack text', async () => {
  resetRuntimeState(['semantic_inspection_schedules', 'semantic_operations_notifications']);
  await createSemanticInspectionSchedule({ body: { checks: ['schema_integrity'] }, role: getRole('executive'), identityScope: identity });
  await runSemanticInspectionCycle({ executeInspection: async () => { throw new Error('synthetic-secret-in-provider-message'); } });
  const schedules = await listSemanticInspectionSchedules({ identityScope: identity });
  assert.equal(schedules[0].lastRun.status, 'failed');
  assert.doesNotMatch(JSON.stringify(schedules), /synthetic-secret/);
  assert.doesNotMatch(JSON.stringify(await listSemanticOperationsNotifications({ identityScope: identity })), /synthetic-secret/);
});
