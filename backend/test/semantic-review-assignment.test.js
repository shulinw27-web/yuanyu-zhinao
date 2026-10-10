import test from 'node:test';
import assert from 'node:assert/strict';
import { semanticTaskWorkspace as workspace } from '../src/domains/governance/public-api.js';
import { createTenantIAMWorkspace } from '../src/services/iam-workspace-model.js';
import { getEffectiveAccess } from '../src/services/access-control-service.js';
import { runWithIAMStoreContext } from '../src/services/iam-store.js';
import { resetRuntimeState, writeState, readState, mutateState, mutateStates } from '../src/repositories/runtime-state-repository.js';
import { semanticOperationsPrincipalKey } from '../src/services/semantic-operations-identity.js';
import { listSemanticOperationsNotifications } from '../src/services/semantic-operations-notification-service.js';
import { issueSemanticOperationsTaskConfirmation, executeSemanticOperationsTask, createSemanticOperationsTask, reviseSemanticOperationsTaskProposal, configureSemanticGovernanceRepository } from '../src/services/semantic-operations-task-service.js';
import { getRole } from '../src/services/authorization-service.js';
import { getOAMetaModelDraft } from '../src/services/meta-model-service.js';
import { semanticFingerprint } from '../src/services/semantic-model-fingerprint.js';
import { handleGovernanceRoutes } from '../src/routes/governance-routes.js';
const admin = { tenantId: 'demo-enterprise', subjectId: 'usr-001' };
const quality = { ...admin, subjectId: 'usr-003' };
const access = identity => getEffectiveAccess(null, identity);
const within = work => runWithIAMStoreContext(work, admin.tenantId);
const assignment = (identityScope, subjectId, expectedRevision = 0, extra = {}) => workspace.assign({ taskId: 'review-fixture', identityScope, body: { subjectId, expectedRevision, ...extra } });
test.beforeEach(async () => {
  configureSemanticGovernanceRepository(null);
  resetRuntimeState(['iam', 'semantic_operations_agent_tasks', 'semantic_operations_notifications', 'oa_meta_model_runtime']);
  const iam = createTenantIAMWorkspace(admin.tenantId);
  iam.rolePolicies.quality_manager.buttonPermissionIds.push('meta_model.draft.review', 'meta_model.draft.save');
  iam.rolePolicies.quality_manager.menuIds.push('semantic-operations');
  writeState('iam', 'workspace', iam);
  const at = new Date().toISOString();
  const fingerprint = semanticFingerprint(await getOAMetaModelDraft());
  writeState('semantic_operations_agent_tasks', 'index', { 'review-fixture': { id: 'review-fixture', owner: semanticOperationsPrincipalKey(admin), originRoleId: 'executive', createdAt: at, updatedAt: at, title: '合成模型审核', status: 'waiting_confirmation', command: 'apply_proposal', requiredPermission: 'meta_model.draft.save', reviewPermission: 'meta_model.draft.review', confirmationRequired: true, confirmation: { state: 'not_issued' }, proposal: { id: 'proposal-fixture', revision: 1, critic: { status: 'passed' }, mappingValidation: { blocked: false }, objectTypes: [], relationshipTypes: [] }, reviewContext: { draftFingerprint: fingerprint, proposalRevision: 1 }, events: [] } });
});
test.afterEach(() => configureSemanticGovernanceRepository(null));
test('assignment uses active tenant IAM reviewers, invalidates tokens and persists a targeted notice atomically', () => within(async () => {
  const roster = await workspace.reviewers({ identityScope: admin });
  assert.ok(roster.reviewers.some(user => user.subjectId === quality.subjectId));
  assert.ok(roster.reviewers.every(user => Object.keys(user).sort().join(',') === 'name,subjectId'));
  const token = await issueSemanticOperationsTaskConfirmation({ taskId: 'review-fixture', identityScope: admin, accessContext: access(admin) });
  assert.ok(token.confirmationToken);
  const assigned = await assignment(admin, quality.subjectId);
  assert.equal(assigned.assignment.revision, 1);
  assert.equal(readState('semantic_operations_agent_tasks', 'index', {})['review-fixture'].confirmation.tokenHash, undefined);
  assert.equal((await executeSemanticOperationsTask({ taskId: 'review-fixture', identityScope: admin, role: { id: 'executive' }, accessContext: access(admin), confirmationToken: token.confirmationToken })).code, 'SEMANTIC_TASK_REVIEW_ACCESS_DENIED');
  assert.equal((await workspace.list({ identityScope: quality, accessContext: access(quality) })).length, 1);
  const notices = await listSemanticOperationsNotifications({ identityScope: quality, accessContext: access(quality) });
  assert.equal(notices.length, 1);
  assert.equal((await listSemanticOperationsNotifications({ identityScope: admin, accessContext: access(admin) })).length, 0);
  assert.equal((await listSemanticOperationsNotifications({ identityScope: quality, accessContext: { subjectId: quality.subjectId, buttonPermissionIds: [] } })).length, 0);
  assert.ok((await issueSemanticOperationsTaskConfirmation({ taskId: 'review-fixture', identityScope: quality, accessContext: access(quality) })).confirmationToken);
  await assignment(quality, admin.subjectId, 1);
  assert.equal((await executeSemanticOperationsTask({ taskId: 'review-fixture', identityScope: admin, role: { id: 'executive' }, accessContext: access(admin), confirmationToken: token.confirmationToken })).code, 'SEMANTIC_TASK_CONFIRMATION_INVALID');
}));
test('transfer and return-to-pool require CAS and retain original task owner and history', () => within(async () => {
  await assignment(admin, quality.subjectId);
  assert.equal((await assignment(quality, admin.subjectId, 0)).code, 'SEMANTIC_REVIEW_ASSIGNMENT_REVISION_CONFLICT');
  const transfer = await assignment(quality, admin.subjectId, 1);
  assert.equal(transfer.assignment.revision, 2);
  assert.equal(await workspace.get({ taskId: 'review-fixture', identityScope: quality, accessContext: access(quality) }), null);
  assert.equal((await assignment(admin, null, 2)).assignment.revision, 3);
  assert.equal((await workspace.list({ identityScope: quality, accessContext: access(quality) })).length, 1);
  const task = readState('semantic_operations_agent_tasks', 'index', {})['review-fixture'];
  assert.equal(task.owner, semanticOperationsPrincipalKey(admin));
  assert.equal(task.events.length, 3);
}));
test('cross tenant, unprivileged, unknown reviewer, payload forgery and invalid states fail without writes', () => within(async () => {
  const before = readState('semantic_operations_agent_tasks', 'index', {});
  for (const [identity, subject, revision, extra, code] of [
    [{ ...admin, tenantId: 'other-company' }, quality.subjectId, 0, {}, 'SEMANTIC_REVIEW_ASSIGNMENT_FORBIDDEN'],
    [{ ...admin, subjectId: 'usr-004' }, quality.subjectId, 0, {}, 'SEMANTIC_REVIEW_ASSIGNMENT_FORBIDDEN'],
    [admin, 'usr-004', 0, {}, 'SEMANTIC_REVIEWER_UNAVAILABLE'],
    [admin, quality.subjectId, 0, { tenantId: 'other-company' }, 'SEMANTIC_REVIEW_ASSIGNMENT_INPUT_INVALID'],
    [admin, quality.subjectId, -1, {}, 'SEMANTIC_REVIEW_ASSIGNMENT_INPUT_INVALID']
  ]) assert.equal((await assignment(identity, subject, revision, extra)).code, code);
  assert.deepEqual(readState('semantic_operations_agent_tasks', 'index', {}), before);
  const task = before['review-fixture']; task.status = 'executing'; writeState('semantic_operations_agent_tasks', 'index', before);
  assert.equal((await assignment(admin, quality.subjectId)).code, 'SEMANTIC_REVIEW_ASSIGNMENT_STATE_CONFLICT');
}));
test('non-owner reviewers cannot transfer somebody else assigned task; revoked target cannot be assigned', () => within(async () => {
  await assignment(admin, admin.subjectId);
  assert.equal((await assignment(quality, quality.subjectId, 1)).code, 'SEMANTIC_REVIEW_ASSIGNMENT_FORBIDDEN');
  const iam = readState('iam', 'workspace', {}); iam.users.find(user => user.id === quality.subjectId).status = 'disabled'; writeState('iam', 'workspace', iam);
  assert.equal((await assignment(admin, quality.subjectId, 1)).code, 'SEMANTIC_REVIEWER_UNAVAILABLE');
}));

test('HTTP assignment denies review/save permissions before reading bodies and returns stable CAS failures', () => within(async () => {
  let reads = 0; let denied; let response;
  const context = { req: { method: 'POST' }, res: {}, url: new URL('http://local/api/semantic-operations/tasks/review-fixture/review-assignment'), role: 'executive', agentIdentity: admin, effectiveAccess: access(admin), selectActionRole: () => false, denyButton: id => { denied = id; }, readBody: async () => { reads++; return { subjectId: quality.subjectId, expectedRevision: 0 }; }, send: (_res, status, body) => { response = { status, body }; } };
  assert.equal(await handleGovernanceRoutes(context), true); assert.equal(denied, 'meta_model.draft.review'); assert.equal(reads, 0);
  await handleGovernanceRoutes({ ...context, selectActionRole: permission => permission === 'meta_model.draft.review' });
  assert.equal(denied, 'meta_model.draft.save'); assert.equal(reads, 0);
  await handleGovernanceRoutes({ ...context, selectActionRole: () => ({ id: 'executive' }) }); assert.equal(response.status, 200);
  await handleGovernanceRoutes({ ...context, selectActionRole: () => ({ id: 'executive' }) }); assert.equal(response.status, 409); assert.equal(response.body.code, 'SEMANTIC_REVIEW_ASSIGNMENT_REVISION_CONFLICT');
}));

test('concurrent creator revision preserves a newly assigned reviewer, notices and assignment audit', () => within(async () => {
  const role = getRole('executive');
  const task = await createSemanticOperationsTask({ body: { text: '建立供应商和采购订单语义模型。', systemCodes: ['ERP'] }, role, identityScope: admin, accessContext: access(admin) });
  assert.ok(task.proposal);
  let interleaved = false;
  configureSemanticGovernanceRepository({ readState: async (...args) => readState(...args), mutateStates: async (...args) => mutateStates(...args), mutateState: async (namespace, ...args) => {
    if (namespace === 'semantic_operations_agent_tasks' && !interleaved) {
      interleaved = true;
      assert.equal((await workspace.assign({ taskId: task.id, identityScope: admin, body: { subjectId: quality.subjectId, expectedRevision: 0 } })).assignment.revision, 1);
    }
    return mutateState(namespace, ...args);
  } });
  const objects = structuredClone(task.proposal.objectTypes); objects[0].label += '（人工修订）';
  const revised = await reviseSemanticOperationsTaskProposal({ taskId: task.id, body: { revision: task.proposal.revision, objectTypes: objects, relationshipTypes: task.proposal.relationshipTypes }, role, identityScope: admin });
  assert.ok(interleaved); assert.equal(revised.reviewAssignment.subjectId, quality.subjectId);
  assert.equal(revised.proposal.revision, task.proposal.revision + 1);
  assert.ok(revised.events.some(event => event.type === 'review_assignment_changed'));
  assert.equal(revised.confirmation.state, 'not_issued');
  assert.equal((await workspace.get({ taskId: task.id, identityScope: quality, accessContext: access(quality) })).reviewAssignment.revision, 1);
}));
