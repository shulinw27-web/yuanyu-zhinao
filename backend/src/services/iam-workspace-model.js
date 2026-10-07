import { randomUUID } from 'node:crypto';
import { initialIAMAudits, initialOrganizations, initialRolePolicies, initialUsers } from '../data/iam-seed.js';

export const IAM_NAMESPACE = 'iam';
export const IAM_WORKSPACE_KEY = 'workspace';
export const CURRENT_IAM_SCHEMA_VERSION = 4;

export function iamWorkspaceKey(tenantId = 'demo-enterprise') {
  if (typeof tenantId !== 'string' || !tenantId.trim() || tenantId !== tenantId.trim() || tenantId.length > 120 || /[\x00-\x1f\x7f]/.test(tenantId)) {
    throw Object.assign(new Error('Invalid IAM tenant.'), { code: 'IAM_TENANT_INVALID', status: 403 });
  }
  return tenantId === 'demo-enterprise' ? IAM_WORKSPACE_KEY : JSON.stringify(['iam-tenant-v1', tenantId, IAM_WORKSPACE_KEY]);
}

export function createTenantIAMWorkspace(tenantId = 'demo-enterprise') {
  iamWorkspaceKey(tenantId);
  // A new company must never inherit demo staff or administrator grants.
  return tenantId === 'demo-enterprise' ? createInitialIAMWorkspace() : {
    schemaVersion: CURRENT_IAM_SCHEMA_VERSION, configurationVersion: 1,
    organizations: [], users: [], rolePolicies: {}, audits: []
  };
}

const ALERTING_PERMISSION_MIGRATION = ['notification.delivery.retry', 'notification.policy.publish', 'notification.route.simulate', 'notification.voice.test', 'oncall.schedule.manage', 'notification.audit.view'];
const EVENT_OUTBOX_PERMISSION_MIGRATION = ['event.outbox.view'];
const WORLD_MENU_REMAP = { from: 'world', to: 'semantic-operations' };
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
  if (state.rolePolicies.executive) {
    state.rolePolicies.executive.buttonPermissionIds = [...new Set([...state.rolePolicies.executive.buttonPermissionIds, ...addedPermissions])];
    state.rolePolicies.executive.version += 1;
  }
  // schema-v4（ADR-030 权限语义独立）：旧工作区 menuIds 中的 world 引用在权限目录
  // 删除 menu.world 后不再映射任何页面权限，按接替关系迁到 semantic-operations。
  // 否则持久化权限策略会把既有角色锁死在旧目录之外（page.semantic-operations.view 永远缺失）。
  const remappedRoles = [];
  if (currentSchemaVersion < 4) {
    for (const policy of Object.values(state.rolePolicies || {})) {
      if (policy && Array.isArray(policy.menuIds) && policy.menuIds.includes(WORLD_MENU_REMAP.from)) {
        policy.menuIds = [...new Set(policy.menuIds.map((id) => (id === WORLD_MENU_REMAP.from ? WORLD_MENU_REMAP.to : id)))];
        policy.version += 1;
        remappedRoles.push(policy.roleId);
      }
    }
  }
  state.configurationVersion += 1;
  state.schemaVersion = CURRENT_IAM_SCHEMA_VERSION;
  state.audits.unshift({
    id: `iam-audit-${createId()}`,
    action: 'IAM_SCHEMA_MIGRATED',
    targetType: 'iam',
    targetId: `schema-v${CURRENT_IAM_SCHEMA_VERSION}`,
    actorRoleId: 'system',
    actorSubjectId: 'migration',
    reason: '为现有管理角色补充告警编排和领域事件运维权限；v4 将旧工作区的 menu.world 引用按 ADR-030 接替关系迁到 semantic-operations。',
    before: { schemaVersion: currentSchemaVersion },
    after: { schemaVersion: CURRENT_IAM_SCHEMA_VERSION, addedPermissions, remappedRoles },
    result: 'success',
    createdAt: clock()
  });
  return { migrated: true, workspace: state };
}

export const normalizeIAMAccount = (value) => String(value || '').trim().toLowerCase();
