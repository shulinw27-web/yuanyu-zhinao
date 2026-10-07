// 系统接入监控定时轮询 worker（2026-10-07）：定时执行监控巡检周期。
//
// 职责：
//   * 按 SYSTEM_MONITOR_INTERVAL_MS（默认 300000=5min）执行 runSystemMonitoringCycle
//   * 周期内：同步挂载集合（接入成功自动挂载、停用/删除自动解除）→ 逐挂载系统探测
//     → 连续失败按阈值告警（邮件给系统管理员 + 站内通知）→ 按阈值自动降级 degraded
//   * 手动触发走 POST /api/semantic-operations/system-monitoring/run（同一执行体）
//
// 用法：node --import ./backend/src/infrastructure/app-bootstrap.js backend/src/workers/system-monitoring-worker.js
// 环境变量：SYSTEM_MONITOR_INTERVAL_MS（默认 300000）、SYSTEM_MONITOR_LEASE_MS（默认周期的 2 倍）、
//           SYSTEM_MONITOR_WORKER_ID（默认进程级 UUID）、SYSTEM_MONITOR_ALERT_THRESHOLD（默认 2）、
//           SYSTEM_MONITOR_DEGRADE_THRESHOLD（默认 3）
//
// 说明：本 worker 是轮询查询系统接入状态的**主机制**；既有 heartbeat-probe-worker
// 仅针对心跳的单系统巡检保留可用（其周期函数仍有专项测试），生产常驻轮询跑本 worker
// 即可覆盖心跳与模拟数据源两类探测，避免两 worker 同时运行造成重复探测。
import { randomUUID } from 'node:crypto';
import { acquireSystemMonitoringWorkerLease, runSystemMonitoringCycle } from '../services/system-monitoring-service.js';
import { runWithSemanticTenant } from '../services/semantic-tenant-context.js';
import { runWithIAMStoreContext } from '../services/iam-store.js';

const INTERVAL_MS = Number(process.env.SYSTEM_MONITOR_INTERVAL_MS) || 300_000;
const LEASE_MS = Math.min(Math.max(Number(process.env.SYSTEM_MONITOR_LEASE_MS) || INTERVAL_MS * 2, 30_000), 30 * 60_000);
const WORKER_ID = String(process.env.SYSTEM_MONITOR_WORKER_ID || `system-monitor-${process.pid}-${randomUUID()}`);

/** 不从请求体或共享状态猜租户；生产必须由部署配置显式指定巡检租户。 */
export function resolveMonitoringTenantIds(configured = process.env.SYSTEM_MONITOR_TENANT_IDS, production = process.env.NODE_ENV === 'production') {
  if (!configured?.trim()) {
    if (production) throw new Error('SYSTEM_MONITOR_TENANT_IDS_REQUIRED');
    return ['demo-enterprise'];
  }
  const ids = configured.split(',').map(value => value.trim());
  if (ids.some(id => !id || id.length > 120 || /[\u0000-\u001f]/u.test(id)) || new Set(ids).size !== ids.length) {
    throw new Error('SYSTEM_MONITOR_TENANT_IDS_INVALID');
  }
  return ids;
}

export async function runConfiguredMonitoringCycles({
  tenantIds = resolveMonitoringTenantIds(),
  runCycle = runSystemMonitoringCycle,
  acquireLease = acquireSystemMonitoringWorkerLease,
  workerId = WORKER_ID,
  leaseMs = LEASE_MS,
  nowAt = Date.now()
} = {}) {
  const results = [];
  for (const tenantId of tenantIds) {
    try {
      const outcome = await runWithIAMStoreContext(() => runWithSemanticTenant({ tenantId }, async () => {
        const lease = acquireLease({ workerId, leaseMs, nowAt });
        if (!lease.acquired) return { skipped: true, reason: 'lease_held', lease };
        return { skipped: false, lease, result: await runCycle() };
      }), tenantId);
      results.push({ tenantId, ...outcome });
    } catch (error) {
      results.push({ tenantId, error: error.code || error.message });
    }
  }
  return results;
}

// ---- 常驻 worker 模式 ----
if (process.env.WORKER_MODE === 'daemon') {
  const tenantIds = resolveMonitoringTenantIds();
  console.log(`[system-monitoring-worker] 启动：间隔 ${INTERVAL_MS}ms，租户数 ${tenantIds.length}`);

  let running = false;
  async function tick() {
    if (running) return;
    running = true;
    try {
      const results = await runConfiguredMonitoringCycles({ tenantIds });
      for (const { tenantId, result, error, skipped, lease } of results) {
        if (error) console.error(`[system-monitoring-worker] tenant=${tenantId} 巡检异常：${error}`);
        else if (skipped) console.log(`[system-monitoring-worker] tenant=${tenantId} 由 ${lease.leaderWorkerId} 持有租约，本轮跳过`);
        else console.log(`[system-monitoring-worker] tenant=${tenantId} checked=${result.checked} verified=${result.verified} failed=${result.failed} alerts=${result.alerts} deliveryFailures=${result.deliveryFailures} degradations=${result.degradations}`);
      }
    } catch (error) {
      console.error(`[system-monitoring-worker] 巡检异常：${error.message}`);
    } finally {
      running = false;
    }
  }

  tick();
  setInterval(tick, INTERVAL_MS);
}
