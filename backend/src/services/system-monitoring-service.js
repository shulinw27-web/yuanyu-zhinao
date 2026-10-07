// 系统接入监控服务（2026-10-07）：系统接入的**监控注册表 + 轮询周期 + 告警分派**。
//
// 职责边界（与注册表/接入服务的分界）：
//   * system-registry-service.js —— 生命周期状态机与接入事实源（本文件只读它的视图，不改状态机）。
//   * system-access-service.js  —— 探测实现（executeHeartbeatProbe / probeSystemConnection）。
//     本文件不复制任何探测逻辑，只消费其结果；不新增任何系统定义。
//   * 本文件（监控域）——「挂载集合」的唯一事实源：哪些系统在监控中、连续失败计数、
//     告警状态、挂载/解除事件日志。
//
// 两条核心逻辑（对应需求）：
//   1) 监控机制：syncSystemMonitoring 把挂载集合与接入生命周期对齐——
//      connected/degraded 自动挂载（接入成功即进入监控），suspended/退回/删除自动解除
//      （停用或删除的系统不再监控）；探测失败按阈值告警（邮件给系统管理员 + 站内通知）。
//   2) 轮询机制：runSystemMonitoringCycle 定时逐挂载系统探测（复用 system-access 的探测，
//      心跳优先、模拟数据源降级），失败按阈值自动降级 degraded（既有状态机规则），
//      恢复 verified 时提示人工裁定接通（不自动升级，与 ADR-023 人工签字纪律一致）。
//
// 告警通道：复用告警域（domains/alerting）的 dispatchAlert——告警按分类规则
// （system-connection-monitoring → P1）走既有升级策略，第 1 步 risk_owner（系统管理员）
// 渠道含 email，收件邮箱来自既有联系点（演示 admin@demo.local）；同时写元域智语站内通知。
// 邮件为 Mock 通道送达（与平台既有通知通道一致），真实邮件供应商属后续接入，不在本层伪装。
//
// 跨域消费采用动态 import（告警域 dispatchAlert、iam-store 管理员解析、站内通知服务），
// 与 registerSystemOnboarding 动态消费 multimodal-input-service 同模式：触发式消费方
// 不复制被依赖方，静态依赖图保持干净。
import { randomUUID } from 'node:crypto';
import { readState, mutateState } from '../repositories/runtime-state-repository.js';
import { semanticTenantStateKey, currentSemanticTenant } from './semantic-tenant-context.js';
import { getTenantSystemConnections } from './system-registry-service.js';
import { probeSystemConnection, transitionTenantSystemConnection, getSystemProbeResults } from './system-access-service.js';

const NAMESPACE = 'system_monitoring_runtime';
const MOUNTED_KEY = 'mounted';
const EVENTS_KEY = 'events';
const CYCLE_KEY = 'cycle-state';
const WORKER_LEASE_KEY = 'worker-lease';
const MAX_EVENTS = 200;

// 阈值：连续失败 N 次 → 告警（默认 2，避免单次抖动就邮件打扰）；连续失败 M 次 → 自动降级
// degraded（默认 3，与既有心跳 worker 的降级阈值一致）。
const DEFAULT_ALERT_THRESHOLD = Number(process.env.SYSTEM_MONITOR_ALERT_THRESHOLD) || 2;
const DEFAULT_DEGRADE_THRESHOLD = Number(process.env.SYSTEM_MONITOR_DEGRADE_THRESHOLD) || 3;
// 系统管理员：告警收件人按 IAM 的在役 executive 角色解析（演示种子 usr-001，联系点邮箱 admin@demo.local）。
const FALLBACK_ADMIN_ID = 'usr-001';

export const SYSTEM_MONITORING_BOUNDARY = '系统接入监控：接入成功（connected）即自动挂载监控，停用/退回/删除的系统自动解除监控；轮询按挂载集合探测（心跳优先、模拟数据源降级），连续失败按阈值告警并自动降级 degraded（不自动断开，需人工裁定）；告警邮件经告警域升级策略送达系统管理员（演示环境为 Mock 通道送达，真实邮件供应商属后续接入）；探测恢复不自动接通，恢复接通仍需人工签字。';

const now = () => new Date().toISOString();
const boundedDeliveryFailureCode = (error) => {
  const value = String(error?.code || error?.message || '');
  return /^[A-Z][A-Z0-9_]{2,95}$/u.test(value) ? value : 'SYSTEM_MONITOR_ALERT_DELIVERY_FAILED';
};
const readMounted = () => readState(NAMESPACE, semanticTenantStateKey(MOUNTED_KEY), {});
const readEvents = () => readState(NAMESPACE, semanticTenantStateKey(EVENTS_KEY), []);
const readCycleState = () => readState(NAMESPACE, semanticTenantStateKey(CYCLE_KEY), {});

/**
 * 每租户监控 Leader 租约。runtime-state 的 SQLite 实现使用 BEGIN IMMEDIATE，
 * 因此多个进程共享同一运行库时只有一个 worker 能在租约期内取得领导权。
 * 同一 worker 每轮续租；进程失联后由其他 worker 在 expiresAt 之后接管。
 */
export function acquireSystemMonitoringWorkerLease({ workerId, leaseMs = 600_000, nowAt = Date.now() } = {}) {
  const normalizedWorkerId = String(workerId || '').trim();
  if (!normalizedWorkerId || normalizedWorkerId.length > 160 || /[\u0000-\u001f]/u.test(normalizedWorkerId)) {
    throw new Error('SYSTEM_MONITOR_WORKER_ID_INVALID');
  }
  const boundedLeaseMs = Math.min(Math.max(Number(leaseMs) || 600_000, 30_000), 30 * 60_000);
  return mutateState(NAMESPACE, semanticTenantStateKey(WORKER_LEASE_KEY), null, (lease) => {
    const expiresAt = Date.parse(lease?.expiresAt || '');
    if (lease && lease.workerId !== normalizedWorkerId && Number.isFinite(expiresAt) && expiresAt > nowAt) {
      return { commit: false, result: { acquired: false, leaderWorkerId: lease.workerId, expiresAt: lease.expiresAt } };
    }
    const next = {
      workerId: normalizedWorkerId,
      acquiredAt: lease?.workerId === normalizedWorkerId ? lease.acquiredAt : new Date(nowAt).toISOString(),
      renewedAt: new Date(nowAt).toISOString(),
      expiresAt: new Date(nowAt + boundedLeaseMs).toISOString()
    };
    return { value: next, result: { acquired: true, leaderWorkerId: normalizedWorkerId, expiresAt: next.expiresAt } };
  });
}

/** 解析告警收件系统管理员：IAM 在役 executive 优先，回退演示种子 usr-001。 */
async function resolveAdminIdentity() {
  try {
    const { getIAMUsers } = await import('./iam-store.js');
    const admin = getIAMUsers().find((user) => user.status === 'active' && user.roleIds?.includes('executive'));
    return { subjectId: admin?.id || (currentSemanticTenant() === 'demo-enterprise' ? FALLBACK_ADMIN_ID : null) };
  } catch {
    return { subjectId: currentSemanticTenant() === 'demo-enterprise' ? FALLBACK_ADMIN_ID : null };
  }
}

/** 记录一条监控事件（挂载/解除/暂停/恢复），带容量上限。 */
function appendEvent(state, event) {
  state.unshift({ id: `sysmon-ev-${randomUUID()}`, at: now(), ...event });
  if (state.length > MAX_EVENTS) state.length = MAX_EVENTS;
}

/**
 * 挂载/解除集合与接入生命周期对齐（监控机制的挂载逻辑）：
 *   * connected / degraded → 必须在监控中（未挂载则自动挂载，source='auto_sync'）
 *   * suspended / registered / authorized / draft / 定义已删除 → 解除挂载
 * 同步过程产生的事件写入事件日志。幂等：重复调用不产生重复事件。
 */
export function syncSystemMonitoring({ now: nowFn = now } = {}) {
  const connections = getTenantSystemConnections();
  const shouldMonitor = new Map(
    connections
      .filter((conn) => conn.lifecycleState === 'connected' || conn.lifecycleState === 'degraded')
      .map((conn) => [conn.code, conn])
  );
  const events = [];
  mutateState(NAMESPACE, semanticTenantStateKey(MOUNTED_KEY), {}, (mounted) => {
    for (const conn of shouldMonitor.values()) {
      const existing = mounted[conn.code];
      if (existing && existing.lifecycleState === conn.lifecycleState) continue;
      if (!existing) {
        mounted[conn.code] = { code: conn.code, name: conn.name, mountedAt: nowFn(), mountedBy: 'system-monitoring', source: 'auto_sync', lifecycleState: conn.lifecycleState, paused: false };
        events.push({ code: conn.code, action: 'mounted', reason: `系统处于 ${conn.lifecycleState} 状态，自动挂载到接入监控。`, source: 'auto_sync' });
      } else {
        mounted[conn.code] = { ...existing, lifecycleState: conn.lifecycleState };
      }
    }
    for (const code of Object.keys(mounted)) {
      if (shouldMonitor.has(code)) continue;
      const removed = mounted[code];
      delete mounted[code];
      events.push({ code, action: 'unmounted', reason: `系统不再处于接通状态（${removed.lifecycleState || '定义已删除'}），解除监控。`, source: 'auto_sync' });
    }
    return { value: mounted };
  });
  if (events.length) {
    mutateState(NAMESPACE, semanticTenantStateKey(EVENTS_KEY), [], (state) => {
      for (const event of events.reverse()) appendEvent(state, event);
      return { value: state };
    });
  }
  return { mountedCount: Object.keys(readMounted()).length, events };
}

function setMounted(code, name, { source, lifecycleState }) {
  let action = null;
  mutateState(NAMESPACE, semanticTenantStateKey(MOUNTED_KEY), {}, (mounted) => {
    if (mounted[code]) return { value: mounted };
    mounted[code] = { code, name, mountedAt: now(), mountedBy: 'system-monitoring', source, lifecycleState: lifecycleState || 'connected', paused: false };
    action = 'mounted';
    return { value: mounted };
  });
  if (action) {
    mutateState(NAMESPACE, semanticTenantStateKey(EVENTS_KEY), [], (state) => {
      appendEvent(state, { code, action, reason: '系统接入成功，自动挂载到接入监控。', source });
      return { value: state };
    });
  }
  return action;
}

/** 显式挂载（接入成功事件钩子可用；一般由 syncSystemMonitoring 自动完成）。 */
export function mountSystemMonitoring({ code, name, source = 'manual', lifecycleState = 'connected' } = {}) {
  const normalized = String(code || '').toUpperCase();
  if (!normalized) return { error: '缺少系统码。', code: 'SYSTEM_MONITORING_CODE_REQUIRED' };
  return { code: normalized, action: setMounted(normalized, name || normalized, { source, lifecycleState }) || 'already_mounted' };
}

/** 显式解除（停用/删除事件钩子可用；一般由 syncSystemMonitoring 自动完成）。 */
export function unmountSystemMonitoring({ code, reason = '系统不再监控。' } = {}) {
  const normalized = String(code || '').toUpperCase();
  if (!normalized) return { error: '缺少系统码。', code: 'SYSTEM_MONITORING_CODE_REQUIRED' };
  let removed = null;
  mutateState(NAMESPACE, semanticTenantStateKey(MOUNTED_KEY), {}, (mounted) => {
    if (!mounted[normalized]) return { value: mounted };
    removed = mounted[normalized];
    delete mounted[normalized];
    return { value: mounted };
  });
  if (removed) {
    mutateState(NAMESPACE, semanticTenantStateKey(EVENTS_KEY), [], (state) => {
      appendEvent(state, { code: normalized, action: 'unmounted', reason, source: 'manual' });
      return { value: state };
    });
  }
  return { code: normalized, action: removed ? 'unmounted' : 'not_mounted' };
}

/** 单系统监控控制：pause / resume（暂停后轮询跳过该系统，挂载保留）。 */
export function controlSystemMonitoring({ code, action } = {}) {
  const normalized = String(code || '').toUpperCase();
  if (!['pause', 'resume'].includes(action)) return { error: `不支持的监控控制动作：${action}。`, code: 'SYSTEM_MONITORING_ACTION_INVALID' };
  return mutateState(NAMESPACE, semanticTenantStateKey(MOUNTED_KEY), {}, (mounted) => {
    const entry = mounted[normalized];
    if (!entry) return { commit: false, result: { error: `系统 ${normalized} 未挂载到接入监控。`, code: 'SYSTEM_MONITORING_NOT_MOUNTED' } };
    if (action === 'pause' && entry.paused) return { commit: false, result: { error: `系统 ${normalized} 的监控已处于暂停状态。`, code: 'SYSTEM_MONITORING_STATE_CONFLICT' } };
    if (action === 'resume' && !entry.paused) return { commit: false, result: { error: `系统 ${normalized} 的监控未处于暂停状态。`, code: 'SYSTEM_MONITORING_STATE_CONFLICT' } };
    entry.paused = action === 'pause';
    mounted[normalized] = entry;
    return { value: mounted, result: { code: normalized, paused: entry.paused } };
  });
}

/**
 * 记录一次探测结果并给出告警决策（监控机制的告警逻辑，纯决策、不发副作用）：
 *   * probeOutcome='verified' → 连续失败清零；若此前已告警 → recover=true（提示人工裁定恢复）
 *   * probeOutcome='failed'   → 连续失败 +1；达到告警阈值且未告警过 → alert=true（本次周期发邮件+通知）
 *                               达到降级阈值且当前仍是 connected → degrade=true（本次周期执行降级跃迁）
 *   * probeOutcome='skipped'  → 无可读数据集等「不可探测」结果：既不算失败也不清零计数，
 *                               只更新 lastProbeAt（避免演示环境缺数据时误报告警）。
 */
export function recordMonitoringProbeOutcome({ code, probeOutcome, lifecycleState, alertThreshold = DEFAULT_ALERT_THRESHOLD, degradeThreshold = DEFAULT_DEGRADE_THRESHOLD, now: nowFn = now } = {}) {
  const normalized = String(code || '').toUpperCase();
  const threshold = Math.max(1, Number(alertThreshold) || DEFAULT_ALERT_THRESHOLD);
  const degradeAt = Math.max(threshold, Number(degradeThreshold) || DEFAULT_DEGRADE_THRESHOLD);
  return mutateState(NAMESPACE, semanticTenantStateKey(CYCLE_KEY), {}, (state) => {
    const entry = state[normalized] || { consecutiveFailures: 0, alerted: false, alertPending: false, alertEventId: null, degradeAlertPending: false, degradeAlertEventId: null, lastAlertAt: null, lastAlertType: null, lastVerifiedAt: null, lastProbeAt: null };
    entry.lastProbeAt = nowFn();
    const decision = { code: normalized, consecutiveFailures: entry.consecutiveFailures, alert: false, degrade: false, degradeAlert: false, recover: false };
    if (probeOutcome === 'skipped') {
      state[normalized] = entry;
      return { value: state, result: decision };
    }
    if (probeOutcome === 'verified') {
      entry.consecutiveFailures = 0;
      entry.lastVerifiedAt = entry.lastProbeAt;
      entry.alertPending = false;
      entry.alertEventId = null;
      entry.degradeAlertPending = false;
      entry.degradeAlertEventId = null;
      if (entry.alerted) {
        entry.alerted = false;
        decision.recover = true;
      }
    } else {
      entry.consecutiveFailures += 1;
      decision.consecutiveFailures = entry.consecutiveFailures;
      if (entry.consecutiveFailures >= threshold && !entry.alerted) {
        entry.alertPending = true;
        entry.alertEventId ||= randomUUID();
        decision.alert = true;
        decision.alertEventId = entry.alertEventId;
      }
      if (entry.consecutiveFailures >= degradeAt && lifecycleState === 'connected') {
        decision.degrade = true;
        entry.degradeAlertPending = true;
        entry.degradeAlertEventId ||= randomUUID();
      }
      if (entry.degradeAlertPending) {
        decision.degradeAlert = true;
        decision.degradeAlertEventId = entry.degradeAlertEventId;
      }
    }
    state[normalized] = entry;
    return { value: state, result: decision };
  });
}

/** 分派成功后确认告警；失败保留同一事件 ID，下一轮可幂等重试。 */
export function acknowledgeMonitoringAlert({ code, alertEventId, at = now() } = {}) {
  const normalized = String(code || '').toUpperCase();
  return mutateState(NAMESPACE, semanticTenantStateKey(CYCLE_KEY), {}, (state) => {
    const entry = state[normalized];
    if (!entry?.alertPending || entry.alertEventId !== alertEventId) return { commit: false, result: false };
    entry.alertPending = false;
    entry.alerted = true;
    entry.lastAlertAt = at;
    entry.lastAlertType = 'probe_failed';
    return { value: state, result: true };
  });
}

export function acknowledgeMonitoringDegradeAlert({ code, alertEventId } = {}) {
  const normalized = String(code || '').toUpperCase();
  return mutateState(NAMESPACE, semanticTenantStateKey(CYCLE_KEY), {}, (state) => {
    const entry = state[normalized];
    if (!entry?.degradeAlertPending || entry.degradeAlertEventId !== alertEventId) return { commit: false, result: false };
    entry.degradeAlertPending = false;
    return { value: state, result: true };
  });
}

/** 监控总览：同步挂载集合后返回挂载系统、周期状态、事件日志与告警配置。 */
export async function getSystemMonitoringOverview() {
  syncSystemMonitoring();
  const mounted = readMounted();
  const cycleState = readCycleState();
  const connections = getTenantSystemConnections();
  const byCode = new Map(connections.map((conn) => [conn.code, conn]));
  const probes = getSystemProbeResults().probes;
  const systems = Object.values(mounted).map((entry) => {
    const conn = byCode.get(entry.code);
    const cycle = cycleState[entry.code] || null;
    const probe = probes[entry.code] || null;
    return {
      code: entry.code,
      name: conn?.name || entry.name,
      domain: conn?.domain || null,
      origin: conn?.origin || null,
      lifecycleState: conn?.lifecycleState || entry.lifecycleState,
      paused: Boolean(entry.paused),
      mountedAt: entry.mountedAt,
      mountedBy: entry.source,
      heartbeatConfigured: Boolean(conn?.custom?.heartbeat?.endpoint || conn?.heartbeat?.endpoint),
      monitoring: {
        consecutiveFailures: cycle?.consecutiveFailures || 0,
        alerted: Boolean(cycle?.alerted),
        alertPending: Boolean(cycle?.alertPending),
        degradeAlertPending: Boolean(cycle?.degradeAlertPending),
        lastAlertAt: cycle?.lastAlertAt || null,
        lastAlertType: cycle?.lastAlertType || null,
        lastVerifiedAt: cycle?.lastVerifiedAt || null,
        lastProbeAt: cycle?.lastProbeAt || null
      },
      lastProbe: probe ? { status: probe.status, checkedAt: probe.checkedAt, probeKind: probe.probeKind || null, issue: probe.issue || null } : null
    };
  }).sort((a, b) => a.code.localeCompare(b.code));

  return {
    boundary: SYSTEM_MONITORING_BOUNDARY,
    tenantId: currentSemanticTenant(),
    config: {
      alertThreshold: DEFAULT_ALERT_THRESHOLD,
      degradeThreshold: DEFAULT_DEGRADE_THRESHOLD,
      alertRecipientRole: 'executive（系统管理员，IAM 在役 executive 角色）',
      alertChannels: '邮件（告警域升级策略 risk_owner 渠道含 email）+ 元域智语站内通知'
    },
    summary: {
      monitored: systems.length,
      alerting: systems.filter((item) => item.monitoring.alerted).length,
      paused: systems.filter((item) => item.paused).length,
      degraded: systems.filter((item) => item.lifecycleState === 'degraded').length
    },
    systems,
    events: readEvents().slice(0, 50)
  };
}

/** 告警分派默认实现：告警域 dispatchAlert（P1 升级策略含邮件渠道）+ 元域智语站内通知。 */
async function defaultDispatch({ kind, code, name, issue, consecutiveFailures, tenantId, alertEventId }) {
  const [{ dispatchAlert }, { createSemanticOperationsNotification }] = await Promise.all([
    import('../domains/alerting/alerting-service.js'),
    import('./semantic-operations-notification-service.js')
  ]);
  const admin = await resolveAdminIdentity();
  if (!admin.subjectId) throw new Error('SYSTEM_MONITOR_ALERT_ADMIN_NOT_CONFIGURED');
  const eventType = kind === 'degraded' ? 'SystemConnectionDegraded' : 'SystemConnectionProbeFailed';
  const title = kind === 'degraded'
    ? `系统接入已自动降级：${name || code}`
    : `系统接入异常告警：${name || code}`;
  const message = kind === 'degraded'
    ? `系统 ${code} 探测连续 ${consecutiveFailures} 次失败，已自动降级为 degraded；需人工裁定是否断开。${issue ? `最近失败原因：${issue}` : ''}`
    : `系统 ${code} 探测连续 ${consecutiveFailures} 次失败。${issue ? `最近失败原因：${issue}` : ''}`;
  const riskId = `SYSMON-${code}-${alertEventId || randomUUID()}`;
  const dispatched = await dispatchAlert({
    riskId,
    title,
    sourceSystem: code,
    eventType,
    ownerUserId: admin.subjectId,
    affectedOrders: 0,
    tenantId
  });
  if (dispatched?.error) throw new Error(dispatched.code || 'SYSTEM_MONITOR_ALERT_DISPATCH_FAILED');
  if (!dispatched?.reused && !dispatched?.deliveries?.length) throw new Error('SYSTEM_MONITOR_ALERT_NO_DELIVERY');
  await createSemanticOperationsNotification({
    identityScope: { tenantId, subjectId: admin.subjectId },
    severity: 'error',
    title,
    message,
    sourceType: 'system-monitoring',
    sourceId: code,
    action: { type: 'open_system_monitoring', code }
  });
  return { riskId, alertSeverity: dispatched?.classification?.severity || null, deliveryCount: dispatched?.deliveries?.length || 0, notifiedAdmin: admin.subjectId };
}

/** 恢复提示（站内通知，不发邮件）：探测恢复，等待人工裁定接通。 */
async function defaultRecoveryNotify({ code, name, tenantId }) {
  const { createSemanticOperationsNotification } = await import('./semantic-operations-notification-service.js');
  const admin = await resolveAdminIdentity();
  if (!admin.subjectId) throw new Error('SYSTEM_MONITOR_ALERT_ADMIN_NOT_CONFIGURED');
  await createSemanticOperationsNotification({
    identityScope: { tenantId, subjectId: admin.subjectId },
    severity: 'info',
    title: `系统接入探测已恢复：${name || code}`,
    message: `系统 ${code} 的探测已恢复 verified。当前状态为 degraded，如需恢复接通请人工裁定（接通仍需填写理由签字）。`,
    sourceType: 'system-monitoring',
    sourceId: code,
    action: { type: 'open_system_monitoring', code }
  });
  return { notifiedAdmin: admin.subjectId };
}

/**
 * 轮询周期（监控机制的轮询逻辑）：同步挂载集合 → 逐挂载系统探测 → 按探测结果更新
 * 连续失败计数 → 按阈值告警/降级/恢复提示。
 *
 * 可注入：fetcher / credentialResolver（测试不发真实网络请求）、dispatch / notify
 * （测试注入 mock，不写告警域）。生产默认走动态 import 的真实实现。
 */
export async function runSystemMonitoringCycle({
  alertThreshold = DEFAULT_ALERT_THRESHOLD,
  degradeThreshold = DEFAULT_DEGRADE_THRESHOLD,
  now: nowFn = now,
  fetcher,
  credentialResolver,
  dispatch = defaultDispatch,
  notify = defaultRecoveryNotify
} = {}) {
  const tenantId = currentSemanticTenant();
  const sync = syncSystemMonitoring({ now: nowFn });
  const mounted = readMounted();
  const connections = getTenantSystemConnections();
  const byCode = new Map(connections.map((conn) => [conn.code, conn]));
  let checked = 0;
  let verified = 0;
  let failed = 0;
  let alerts = 0;
  let degradations = 0;
  let recoveries = 0;
  let deliveryFailures = 0;
  const deliveryFailureCodes = [];

  for (const entry of Object.values(mounted)) {
    if (entry.paused) continue;
    const conn = byCode.get(entry.code);
    if (!conn) continue;
    checked += 1;
    const outcome = await probeSystemConnection({
      code: entry.code,
      faultMode: 'none',
      roleId: 'executive',
      identityScope: { tenantId, subjectId: 'system-monitoring-worker' },
      fetcher,
      credentialResolver
    });
    // 探测结果三态：verified / failed / skipped（无可读数据集等「不可探测」，不参与失败计数）。
    const probeOutcome = outcome.error ? 'failed'
      : outcome.status === 'verified' ? 'verified'
        : outcome.supported === false ? 'skipped'
          : 'failed';
    const issue = outcome.error
      ? outcome.error
      : (outcome.status === 'verified' ? null : (outcome.issue?.message || outcome.message || `探测结果 ${outcome.status}`));
    const decision = recordMonitoringProbeOutcome({
      code: entry.code,
      probeOutcome,
      lifecycleState: conn.lifecycleState,
      alertThreshold,
      degradeThreshold,
      now: nowFn
    });
    if (probeOutcome === 'verified') {
      verified += 1;
    } else if (probeOutcome === 'failed') {
      failed += 1;
    }
    if (decision.alert) {
      if (dispatch) {
        try {
          await dispatch({ kind: 'probe_failed', code: entry.code, name: conn.name, issue, consecutiveFailures: decision.consecutiveFailures, tenantId, alertEventId: decision.alertEventId });
          acknowledgeMonitoringAlert({ code: entry.code, alertEventId: decision.alertEventId, at: nowFn() });
          alerts += 1;
        } catch (error) {
          deliveryFailures += 1;
          deliveryFailureCodes.push(boundedDeliveryFailureCode(error));
        }
      }
    }
    let degradedThisCycle = false;
    if (decision.degrade) {
      const degraded = transitionTenantSystemConnection({
        code: entry.code,
        to: 'degraded',
        reason: `监控探测连续 ${decision.consecutiveFailures} 次失败，自动降级为 degraded；需人工裁定是否断开。`,
        identityScope: { tenantId, subjectId: 'system-monitoring-worker' }
      });
      if (!degraded.error) {
        degradations += 1;
        degradedThisCycle = true;
      }
    }
    if (decision.degradeAlert && (conn.lifecycleState === 'degraded' || degradedThisCycle) && dispatch) {
      try {
        await dispatch({ kind: 'degraded', code: entry.code, name: conn.name, issue, consecutiveFailures: decision.consecutiveFailures, tenantId, alertEventId: decision.degradeAlertEventId });
        acknowledgeMonitoringDegradeAlert({ code: entry.code, alertEventId: decision.degradeAlertEventId });
      } catch (error) {
        deliveryFailures += 1;
        deliveryFailureCodes.push(boundedDeliveryFailureCode(error));
      }
    }
    if (decision.recover) {
      recoveries += 1;
      if (notify) {
        try {
          await notify({ code: entry.code, name: conn.name, tenantId });
        } catch (error) {
          deliveryFailures += 1;
          deliveryFailureCodes.push(boundedDeliveryFailureCode(error));
        }
      }
    }
  }

  return { checked, verified, failed, alerts, degradations, recoveries, deliveryFailures, deliveryFailureCodes: [...new Set(deliveryFailureCodes)], syncEvents: sync.events.length };
}
