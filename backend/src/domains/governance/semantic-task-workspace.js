import { getSemanticOperationsTask, listSemanticOperationsTasks } from '../../services/semantic-operations-task-service.js';
import { currentIAMTenant, findIAMUserBySubject, getIAMUsers } from '../../services/iam-store.js';
import { getEffectiveAccess } from '../../services/access-control-service.js';
import { mutateSemanticGovernanceStates } from '../../services/semantic-governance-store.js';
import { semanticOperationsOwnerMatches } from '../../services/semantic-operations-identity.js';
import { buildSemanticOperationsNotification, insertSemanticOperationsNotification, SEMANTIC_NOTIFICATION_NAMESPACE } from '../../services/semantic-operations-notification-service.js';

const permissions = ['meta_model.draft.review', 'meta_model.draft.save'];
const allowed = access => access?.principalResolved && permissions.every(id => access.buttonPermissionIds.includes(id)) && access.pagePermissionIds.includes('page.semantic-operations.view');
const accessFor = identity => getEffectiveAccess(null, identity);
const failure = (code, status = 409) => ({ error: '审核指派未完成，请检查当前权限、任务状态和指派修订。', code, status });
const currentActor = identity => identity?.tenantId === currentIAMTenant() && allowed(accessFor(identity));
const candidates = identity => getIAMUsers().filter(user => user.status === 'active' && allowed(accessFor({ ...identity, subjectId: user.id }))).map(user => ({ subjectId: user.id, name: user.name }));

async function reviewers({ identityScope }) {
  if (!currentActor(identityScope)) return failure('SEMANTIC_REVIEW_ASSIGNMENT_FORBIDDEN', 403);
  return { reviewers: candidates(identityScope), actorSubjectId: findIAMUserBySubject(identityScope.subjectId).id };
}

async function assign({ taskId, identityScope, body }) {
  if (!currentActor(identityScope)) return failure('SEMANTIC_REVIEW_ASSIGNMENT_FORBIDDEN', 403);
  if (!body || Array.isArray(body) || Object.keys(body).some(key => !['subjectId', 'expectedRevision'].includes(key)) || !Number.isInteger(body.expectedRevision) || body.expectedRevision < 0 || !(body.subjectId === null || typeof body.subjectId === 'string' && body.subjectId.length <= 128)) return failure('SEMANTIC_REVIEW_ASSIGNMENT_INPUT_INVALID', 400);
  const actor = findIAMUserBySubject(identityScope.subjectId);
  const target = body.subjectId === null ? null : candidates(identityScope).find(user => user.subjectId === body.subjectId);
  if (body.subjectId !== null && !target) return failure('SEMANTIC_REVIEWER_UNAVAILABLE', 403);
  return mutateSemanticGovernanceStates([
    { name: 'tasks', namespace: 'semantic_operations_agent_tasks', key: 'index', initialValue: {} },
    { name: 'notices', namespace: SEMANTIC_NOTIFICATION_NAMESPACE, key: 'index', initialValue: {} }
  ], values => {
    // Resolve current authority inside the same synchronous mutation boundary.
    if (!currentActor(identityScope) || target && !candidates(identityScope).some(user => user.subjectId === target.subjectId)) return { commit: false, result: failure('SEMANTIC_REVIEW_ASSIGNMENT_FORBIDDEN', 403) };
    const task = values.tasks[taskId];
    let tenant; try { tenant = JSON.parse(task?.owner)[0]; } catch { /* invalid owner fails closed */ }
    if (!task || tenant !== identityScope.tenantId || !task.proposal || task.command !== 'apply_proposal') return { commit: false, result: failure('SEMANTIC_TASK_NOT_FOUND', 404) };
    if (task.archivedAt || task.status !== 'waiting_confirmation') return { commit: false, result: failure('SEMANTIC_REVIEW_ASSIGNMENT_STATE_CONFLICT') };
    const previous = task.reviewAssignment || { revision: 0, subjectId: null };
    if (previous.revision !== body.expectedRevision) return { commit: false, result: failure('SEMANTIC_REVIEW_ASSIGNMENT_REVISION_CONFLICT') };
    if (previous.subjectId && previous.subjectId !== actor.id && !semanticOperationsOwnerMatches(task.owner, identityScope)) return { commit: false, result: failure('SEMANTIC_REVIEW_ASSIGNMENT_FORBIDDEN', 403) };
    if ((target?.subjectId || null) === previous.subjectId) return { commit: false, result: failure('SEMANTIC_REVIEW_ASSIGNMENT_UNCHANGED') };
    const at = new Date().toISOString();
    task.reviewAssignment = { revision: previous.revision + 1, subjectId: target?.subjectId || null, name: target?.name || null, assignedAt: at, assignedBy: actor.id };
    task.confirmation = { state: 'not_issued' };
    task.updatedAt = at;
    task.events ||= [];
    task.events.push({ time: at, type: 'review_assignment_changed', detail: target ? `模型审核已指派给${target.name}，旧确认凭证失效。` : '模型审核已退回权限审核池，旧确认凭证失效。' });
    const notice = buildSemanticOperationsNotification({ identityScope: target ? { ...identityScope, subjectId: target.subjectId } : identityScope, audiencePermissionId: 'meta_model.draft.review', audienceSubjectId: target?.subjectId || null, title: '语义模型审核指派已更新', message: '请在Agent工作台查看当前待审核模型；指派不授予权限，不代表审核通过或发布。', severity: 'action_required', sourceType: 'semantic_model_review', sourceId: taskId, action: { type: 'open_semantic_task', taskId } });
    insertSemanticOperationsNotification(values.notices, notice);
    return { values, result: { assignment: structuredClone(task.reviewAssignment), confirmationInvalidated: true } };
  });
}

// Consolidates the former list/get exports rather than increasing the domain facade.
export const semanticTaskWorkspace = { list: listSemanticOperationsTasks, get: getSemanticOperationsTask, reviewers, assign };
