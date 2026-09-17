import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSemanticInspectionSchedule, claimDueSemanticInspection, completeSemanticInspection, listSemanticInspectionSchedules } from '../../src/services/semantic-inspection-schedule-service.js';
import { listSemanticOperationsNotifications } from '../../src/services/semantic-operations-notification-service.js';

if (process.env.NODE_ENV !== 'test' || process.env.RUNTIME_STORE_DRIVER !== 'sqlite' || !process.env.RUNTIME_SQLITE_PATH) throw new Error('Dedicated test SQLite required.');
const identityScope = { tenantId: 'atomic-test-tenant', subjectId: 'synthetic-reviewer' };
if (process.argv[2] === 'write') {
  await createSemanticInspectionSchedule({ body: { checks: ['schema_integrity'] }, role: { id: 'executive' }, identityScope });
  const schedule = await claimDueSemanticInspection({ workerId: 'sqlite-worker' });
  const input = { id: schedule.id, workerId: 'sqlite-worker', leaseToken: schedule.lease.token, result: { severity: 'warning', summary: 'Synthetic warning', findings: [] } };
  const database = new DatabaseSync(process.env.RUNTIME_SQLITE_PATH);
  try {
    // Fail the second row write after the schedule row has been changed inside
    // the transaction: this tests actual SQLite rollback, not a fake callback.
    database.exec("CREATE TRIGGER synthetic_notice_failure BEFORE INSERT ON runtime_state WHEN NEW.namespace = 'semantic_operations_notifications' BEGIN SELECT RAISE(ABORT, 'synthetic notification failure'); END");
    await assert.rejects(completeSemanticInspection(input), /synthetic notification failure/);
    assert.equal((await listSemanticInspectionSchedules({ identityScope }))[0].lastRun, null);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM runtime_state WHERE namespace = 'semantic_operations_notifications'").get().n, 0);
    database.exec('DROP TRIGGER synthetic_notice_failure');
    await completeSemanticInspection(input);
    assert.equal(await completeSemanticInspection(input), null);
  } finally { database.close(); }
} else if (process.argv[2] !== 'read') throw new Error('Invalid test mode.');
const schedules = await listSemanticInspectionSchedules({ identityScope });
const notifications = await listSemanticOperationsNotifications({ identityScope });
assert.equal(schedules.length, 1); assert.equal(schedules[0].lastRun.status, 'warning');
assert.equal(notifications.length, 1); assert.equal(notifications[0].sourceId, schedules[0].id);
process.stdout.write(JSON.stringify({ status: 'passed', schedules: schedules.length, notifications: notifications.length }));
