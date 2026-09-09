import { randomUUID } from 'node:crypto';
import { initialIAMAudits, initialOrganizations, initialRolePolicies, initialUsers } from '../data/iam-seed.js';

export const IAM_NAMESPACE = 'iam';
export const IAM_WORKSPACE_KEY = 'workspace';
export const CURRENT_IAM_SCHEMA_VERSION = 3;

const ALERTING_PERMISSION_MIGRATION = ['notification.delivery.retry', 'notification.policy.publish', 'notification.route.simulate', 'notification.voice.test', 'oncall.schedule.manage', 'notification.audit.view'];
const EVENT_OUTBOX_PERMISSION_MIGRATION = ['event.outbox.view'];
const clone = (value) => structuredClone(value);

export const createInitialIAMWorkspace = () => ({
  schemaVersion: CURRENT_IAM_SCHEMA_VERSION,
  configurationVersion: 1,
  organizations: clone(initialOrganizations),
  users: clone(initialUsers),
  rolePolicies: clone(initialRolePolicies),
  audits: clone(initialIAMAudits)
});

export function migrateIAMWorkspace(state, { createId = randomUUID, clock = () => new Date().toISOString() } = {}) {
  const currentSchemaVersion = Number(state.schemaVersion || 1);
  if (currentSchemaVersion >= CURRENT_IAM_SCHEMA_VERSION) return { migrated: false, workspace: state };
  const addedPermissions = [
    ...(currentSchemaVersion < 2 ? ALERTING_PERMISSION_MIGRATION : []),
    ...(currentSchemaVersion < 3 ? EVENT_OUTBOX_PERMISSION_MIGRATION : [])
  ];
  const executive = state.rolePolicies.executive;
  executive.buttonPermissionIds = [...new Set([...executive.buttonPermissionIds, ...addedPermissions])];
  executive.version += 1;
  state.configurationVersion += 1;
  state.schemaVersion = CURRENT_IAM_SCHEMA_VERSION;
  state.audits.unshift({
    id: `iam-audit-${createId()}`,
    action: 'IAM_SCHEMA_MIGRATED',
    targetType: 'iam',
    targetId: `schema-v${CURRENT_IAM_SCHEMA_VERSION}`,
    actorRoleId: 'system',
    actorSubjectId: 'migration',
    reason: '为现有管理角色补充告警编排和领域事件运维权限。',
    before: { schemaVersion: currentSchemaVersion },
    after: { schemaVersion: CURRENT_IAM_SCHEMA_VERSION, addedPermissions },
    result: 'success',
    createdAt: clock()
  });
  return { migrated: true, workspace: state };
}

export const normalizeIAMAccount = (value) => String(value || '').trim().toLowerCase();

