import { randomUUID } from 'node:crypto';
import { getKmsAdapterStatus, issueOpaqueCredential } from './kms-adapter.js';
import { readState, writeState } from '../../repositories/runtime-state-repository.js';

const initialPolicies = [
  { id: 'kc-erp-broker', name: 'ERP 采购草稿凭据', connectorId: 'mcp-erp', operations: ['create_procurement_draft', 'approve_procurement'], secretRef: 'kms://integration/erp-read-write', keyRef: 'hsm://health-prod/keys/erp-broker', classification: '供应链受限', maxTtlSeconds: 120, rotationDays: 30, version: 3, status: 'active' },
  { id: 'kc-wms-reader', name: 'WMS 仓储只读凭据', connectorId: 'mcp-wms', operations: ['read_inventory_lot', 'read_inbound_receipt'], secretRef: 'kms://integration/wms-readonly', keyRef: 'hsm://health-prod/keys/wms-reader', classification: '仓储运营受限', maxTtlSeconds: 180, rotationDays: 45, version: 1, status: 'active' },
  { id: 'kc-oa-broker', name: 'OA 审批上下文凭据', connectorId: 'mcp-oa', operations: ['read_approval_context'], secretRef: 'kms://identity/oa-service-principal', keyRef: 'hsm://health-prod/keys/oa-broker', classification: '组织与审批受限', maxTtlSeconds: 180, rotationDays: 30, version: 2, status: 'active' },
  { id: 'kc-lims-reader', name: 'LIMS 质量只读凭据', connectorId: 'mcp-lims', operations: ['read_release_status', 'read_coa'], secretRef: 'kms://integration/lims-readonly', keyRef: 'hsm://health-prod/keys/lims-reader', classification: '质量受限', maxTtlSeconds: 180, rotationDays: 45, version: 4, status: 'active' },
  { id: 'kc-mes-reader', name: 'MES 生产只读凭据', connectorId: 'mcp-mes', operations: ['read_production_plan', 'read_equipment_status'], secretRef: 'kms://integration/mes-readonly', keyRef: 'hsm://health-prod/keys/mes-reader', classification: '生产受限', maxTtlSeconds: 180, rotationDays: 45, version: 2, status: 'active' },
  { id: 'kc-qms-reader', name: 'QMS 质量只读凭据', connectorId: 'mcp-qms', operations: ['read_capa_status', 'read_quality_event'], secretRef: 'kms://integration/qms-readonly', keyRef: 'hsm://health-prod/keys/qms-reader', classification: '质量受限', maxTtlSeconds: 180, rotationDays: 45, version: 1, status: 'active' },
  { id: 'kc-oms-reader', name: 'OMS 订单与门店只读凭据', connectorId: 'mcp-oms', operations: ['read_store_status', 'read_order_fulfillment'], secretRef: 'kms://integration/oms-desensitized', keyRef: 'hsm://health-prod/keys/oms-reader', classification: '订单与门店运营受限', maxTtlSeconds: 180, rotationDays: 45, version: 2, status: 'active' },
  { id: 'kc-model-gateway', name: '模型网关服务凭据', connectorId: 'model-gateway', operations: ['inference'], secretRef: 'kms://models/agent-gateway', keyRef: 'hsm://health-prod/keys/model-gateway', classification: '模型调用受限', maxTtlSeconds: 60, rotationDays: 30, version: 5, status: 'active' }
];

const restoredState = readState('key_center', 'workspace', { policies: initialPolicies, activeLeases: [], auditEvents: [] });
let policySchemaMigrated = false;
const policies = (restoredState.policies || []).map((policy) => {
  if (policy.id !== 'kc-oms-reader' || policy.operations?.includes('read_store_status')) return policy;
  policySchemaMigrated = true;
  return {
    ...policy,
    name: 'OMS 订单与门店只读凭据',
    operations: [...new Set([...(policy.operations || []), 'read_store_status'])],
    classification: '订单与门店运营受限',
    version: Math.max(1, Number(policy.version) || 1) + 1
  };
});
if (!policies.some((policy) => policy.id === 'kc-oms-reader')) {
  policies.push(structuredClone(initialPolicies.find((policy) => policy.id === 'kc-oms-reader')));
  policySchemaMigrated = true;
}
if (!policies.some((policy) => policy.id === 'kc-wms-reader')) {
  policies.push(structuredClone(initialPolicies.find((policy) => policy.id === 'kc-wms-reader')));
  policySchemaMigrated = true;
}
const activeLeases = new Map(restoredState.activeLeases.map((lease) => [lease.id, lease]));
const auditEvents = restoredState.auditEvents;
const persistState = () => writeState('key_center', 'workspace', { policies, activeLeases: [...activeLeases.values()], auditEvents });
if (policySchemaMigrated) persistState();
const MAX_AUDIT_EVENTS = 80;
const connectorDomains = { 'mcp-erp': ['production', 'internal'], 'mcp-wms': ['production', 'internal'], 'mcp-oa': ['internal'], 'mcp-lims': ['production'], 'mcp-mes': ['production'], 'mcp-qms': ['production'], 'mcp-oms': ['marketing'], 'model-gateway': ['production', 'marketing', 'internal'] };
const workflowRequirements = { create_procurement_draft: 'launch_procurement', approve_procurement: 'approve_procurement' };

const now = () => new Date();
const iso = () => now().toISOString();
const cleanupExpiredLeases = () => {
  const timestamp = now().getTime();
  let changed = false;
  for (const lease of activeLeases.values()) {
    if (new Date(lease.expiresAt).getTime() <= timestamp && lease.status === 'active') {
      lease.status = 'expired';
      lease.updatedAt = iso();
      addAudit('lease_expired', lease, { reason: 'ttl_elapsed' });
      changed = true;
    }
  }
  if (changed) persistState();
};
const addAudit = (event, leaseOrPolicy, extra = {}) => {
  auditEvents.unshift({
    id: `kca-${randomUUID()}`,
    event,
    time: iso(),
    policyId: leaseOrPolicy?.policyId || leaseOrPolicy?.id || null,
    leaseId: leaseOrPolicy?.id?.startsWith('kcl-') ? leaseOrPolicy.id : null,
    connectorId: leaseOrPolicy?.connectorId || null,
    principalId: leaseOrPolicy?.principalId || null,
    roleId: leaseOrPolicy?.roleId || null,
    ...extra
  });
  if (auditEvents.length > MAX_AUDIT_EVENTS) auditEvents.length = MAX_AUDIT_EVENTS;
};

const publicPolicy = (policy, { redactReferences = false } = {}) => ({
  id: policy.id,
  name: policy.name,
  connectorId: policy.connectorId,
  operations: policy.operations,
  secretRef: redactReferences ? 'managed-reference (administrator only)' : policy.secretRef,
  keyRef: redactReferences ? 'managed-key (administrator only)' : policy.keyRef,
  classification: policy.classification,
  maxTtlSeconds: policy.maxTtlSeconds,
  rotationDays: policy.rotationDays,
  version: policy.version,
  status: policy.status
});

const publicLease = (lease) => ({
  id: lease.id,
  policyId: lease.policyId,
  connectorId: lease.connectorId,
  operation: lease.operation,
  purpose: lease.purpose,
  roleId: lease.roleId,
  principalId: lease.principalId,
  status: lease.status,
  issuedAt: lease.issuedAt,
  expiresAt: lease.expiresAt,
  credentialHandle: lease.credentialHandle,
  materialExposed: false
});

const findPolicy = ({ connectorId, operation }) => policies.find((policy) => policy.connectorId === connectorId && policy.operations.includes(operation));

export async function requestKeyLease({ connectorId, operation, purpose, role, authorization, taskId, ttlSeconds }) {
  cleanupExpiredLeases();
  const policy = findPolicy({ connectorId, operation });
  if (!policy || policy.status !== 'active') return { error: '未找到可用的密钥策略，或该策略当前已停用。' };
  if (!authorization || authorization.decision !== 'ALLOW_BY_POLICY') return { error: '智脑未获得本次任务的有效授权，密钥中心拒绝签发凭据。' };
  if (!role?.id || !purpose || !taskId) return { error: '密钥租约缺少主体、用途或任务标识，已拒绝签发。' };
  if (!(connectorDomains[connectorId] || []).some((domain) => (authorization.grantedDomains || []).includes(domain))) return { error: '当前任务未获该连接器所属数据域授权，密钥中心拒绝签发凭据。' };
  const requiredWorkflow = workflowRequirements[operation];
  if (requiredWorkflow && !(authorization.allowedWorkflowTools || []).includes(requiredWorkflow)) return { error: '当前任务未获对应写入工作流授权，密钥中心拒绝签发凭据。' };
  const ttl = Math.max(30, Math.min(Number(ttlSeconds) || policy.maxTtlSeconds, policy.maxTtlSeconds));
  const issuedAt = iso();
  const expiresAt = new Date(now().getTime() + ttl * 1000).toISOString();
  const lease = {
    id: `kcl-${randomUUID()}`,
    policyId: policy.id,
    connectorId,
    operation,
    purpose,
    taskId,
    roleId: role.id,
    principalId: authorization.principal?.id || 'unknown-principal',
    status: 'active',
    issuedAt,
    expiresAt,
    updatedAt: issuedAt,
    credentialHandle: null
  };
  let credential;
  try { credential = await issueOpaqueCredential({ secretRef: policy.secretRef, leaseId: lease.id, expiresAt }); }
  catch (error) { return { error: '密钥供应商当前不可用，凭据租约未签发。', code: error.code || 'KMS_PROVIDER_UNAVAILABLE' }; }
  lease.credentialHandle = credential.handle;
  activeLeases.set(lease.id, lease);
  addAudit('lease_issued', lease, { ttlSeconds: ttl, materialExposed: false });
  persistState();
  return { lease: publicLease(lease), credential: { handle: credential.handle, provider: credential.provider, materialExposed: false } };
}

export function revokeKeyLease(leaseId, role) {
  cleanupExpiredLeases();
  const lease = activeLeases.get(leaseId);
  if (!lease) return { error: '未找到该租约。' };
  if (role?.id !== 'executive' && lease.roleId !== role?.id) return { error: '当前角色无权吊销其他主体的租约。' };
  if (lease.status !== 'active') return { lease: publicLease(lease), unchanged: true };
  lease.status = 'revoked';
  lease.updatedAt = iso();
  addAudit('lease_revoked', lease, { actorRoleId: role.id });
  persistState();
  return { lease: publicLease(lease) };
}

export function rotateKeyPolicy(policyId, role) {
  if (role?.id !== 'executive') return { error: '仅平台管理角色可以发起密钥策略轮换。' };
  const policy = policies.find((item) => item.id === policyId);
  if (!policy) return { error: '未找到密钥策略。' };
  policy.version += 1;
  policy.lastRotatedAt = iso();
  addAudit('policy_rotated', policy, { actorRoleId: role.id, version: policy.version });
  persistState();
  return { policy: publicPolicy(policy) };
}

export function getKeyCenterOverview(roleId) {
  cleanupExpiredLeases();
  const isAdmin = roleId === 'executive';
  const leases = [...activeLeases.values()].filter((lease) => isAdmin || lease.roleId === roleId).map(publicLease);
  return {
    service: 'key-center',
    version: '0.1.0',
    status: 'healthy',
    architecture: 'microservice_ready_control_plane',
    adapter: getKmsAdapterStatus(),
    policy: '密钥材料不离开 KMS/HSM 边界；业务服务只获取绑定用途、主体、任务与 TTL 的不透明租约句柄。',
    policies: (isAdmin ? policies : policies.filter((policy) => policy.status === 'active')).map((policy) => publicPolicy(policy, { redactReferences: !isAdmin })),
    leases,
    auditEvents: auditEvents.filter((event) => isAdmin || event.roleId === roleId).slice(0, 12),
    metrics: {
      activeLeaseCount: [...activeLeases.values()].filter((lease) => lease.status === 'active').length,
      policyCount: policies.length,
      auditEventCount: auditEvents.length,
      rotationDueCount: 0
    }
  };
}

export function getKeyLeasePolicyForConnector(connectorId) {
  const policy = policies.find((item) => item.connectorId === connectorId && item.status === 'active');
  return policy ? { id: policy.id, maxTtlSeconds: policy.maxTtlSeconds, rotationDays: policy.rotationDays, version: policy.version } : null;
}
