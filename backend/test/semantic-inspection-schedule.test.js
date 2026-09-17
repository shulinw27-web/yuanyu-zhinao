import assert from 'node:assert/strict';
import test from 'node:test';
import { resetRuntimeState } from '../src/repositories/runtime-state-repository.js';
import { getRole } from '../src/services/authorization-service.js';
import { claimDueSemanticInspection, completeSemanticInspection, controlSemanticInspectionSchedule, createSemanticInspectionSchedule, listSemanticInspectionSchedules, runSemanticInspectionCycle } from '../src/services/semantic-inspection-schedule-service.js';
import { listSemanticOperationsNotifications } from '../src/services/semantic-operations-notification-service.js';

const identity = { tenantId: 'inspection-tenant', subjectId: 'inspection-user', deviceId: 'inspection-device', platform: 'test' };

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
