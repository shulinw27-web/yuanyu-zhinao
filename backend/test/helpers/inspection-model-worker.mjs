import assert from 'node:assert/strict';
import { getRole } from '../../src/services/authorization-service.js';
import { runWithSemanticTenant } from '../../src/services/semantic-tenant-context.js';
import { semanticModelRegistry } from '../../src/services/semantic-model-registry.js';
import { createSemanticInspectionSchedule, listSemanticInspectionSchedules, controlSemanticInspectionSchedule } from '../../src/services/semantic-inspection-schedule-service.js';
import { listSemanticOperationsNotifications } from '../../src/services/semantic-operations-notification-service.js';
import { mutateSemanticGovernanceState } from '../../src/services/semantic-governance-store.js';

assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.RUNTIME_STORE_DRIVER, 'sqlite');
const role = getRole('executive'); const identityScope = { tenantId: 'demo-enterprise', subjectId: 'usr-001' };
const mode = process.argv[2];
await runWithSemanticTenant(identityScope, async () => {
  if (mode === 'seed') {
    await createSemanticInspectionSchedule({ body: { checks: ['schema_integrity'] }, role, identityScope });
    for (const [expectedRevision, modelId] of ['finance', 'production'].entries()) {
      await semanticModelRegistry.register({ role, identityScope, body: { id: modelId, label: `${modelId}模型`, expectedRevision } });
      await semanticModelRegistry.withWorkspace({ role, identityScope, modelId, work: async () => {
        await createSemanticInspectionSchedule({ body: { checks: ['schema_integrity', 'mapping_coverage'] }, role, identityScope });
      } });
    }
  } else if (mode === 'revoke') {
    await mutateSemanticGovernanceState('semantic_model_registry', 'index', {}, state => { state.models[0].lifecycle = 'disabled'; return { value: state }; });
  } else {
    assert.ok(['verify', 'due', 'verify-again'].includes(mode));
    const defaultSchedules = await listSemanticInspectionSchedules({ identityScope });
    assert.equal(defaultSchedules[0].lastRun, null);
    for (const modelId of ['finance', 'production']) await semanticModelRegistry.withWorkspace({ role, identityScope, modelId, work: async () => {
      const schedules = await listSemanticInspectionSchedules({ identityScope });
      assert.equal(schedules.length, 1); assert.equal(schedules[0].modelId, modelId); assert.equal(schedules[0].lastRun.status, 'passed');
      const notices = await listSemanticOperationsNotifications({ identityScope });
      assert.equal(notices.length, 0);
      assert.ok(notices.every(notice => notice.modelId === modelId && notice.action.modelId === modelId));
      if (mode === 'due') await controlSemanticInspectionSchedule({ id: schedules[0].id, action: 'run-now', identityScope });
    } });
  }
});
process.stdout.write(JSON.stringify({ status: 'passed', mode }));
