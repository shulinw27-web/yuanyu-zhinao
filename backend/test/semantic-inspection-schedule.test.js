import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resetRuntimeState, writeState, readState } from '../src/repositories/runtime-state-repository.js';
import { asyncRuntimeStateRepository } from '../src/repositories/async-runtime-state-repository.js';
import { configureSemanticGovernanceRepository } from '../src/services/semantic-governance-store.js';
import { getRole } from '../src/services/authorization-service.js';
import { claimDueSemanticInspection, completeSemanticInspection, controlSemanticInspectionSchedule, createSemanticInspectionSchedule, listSemanticInspectionSchedules, runSemanticInspectionCycle } from '../src/services/semantic-inspection-schedule-service.js';
import { createSemanticOperationsNotification, listSemanticOperationsNotifications, readSemanticOperationsNotification } from '../src/services/semantic-operations-notification-service.js';
import { semanticOperationsPrincipalKey, semanticOperationsOwnerMatches } from '../src/services/semantic-operations-identity.js';
import { extendSemanticMaterials, loadSemanticMaterials } from '../src/services/semantic-material-workspace-service.js';

const identity = { tenantId: 'inspection-tenant', subjectId: 'inspection-user', deviceId: 'inspection-device', platform: 'test' };

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
