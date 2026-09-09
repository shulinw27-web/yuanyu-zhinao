import assert from 'node:assert/strict';
import test from 'node:test';
import { resetRuntimeState } from '../src/repositories/runtime-state-repository.js';
import { getRole } from '../src/services/authorization-service.js';
import { completeSemanticInspection, createSemanticInspectionSchedule, listSemanticInspectionSchedules, runSemanticInspectionCycle } from '../src/services/semantic-inspection-schedule-service.js';
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
