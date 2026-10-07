// 心跳定时探测 worker（ADR-028 阶段 8-6）：定期巡检已接通系统的心跳接口。
//
// 职责：
//   * 遍历当前租户所有已接通（connected）或降级（degraded）的自定义系统
//   * 对有 heartbeat.endpoint 的系统调用 executeHeartbeatProbe
//   * 连续 N 次失败（可配置，默认 3）→ 自动降级为 degraded（不自动断开，需人工裁定）
//   * 探测结果写现有 PROBES_KEY 历史
//
// 用法：node --import ./backend/src/infrastructure/app-bootstrap.js backend/src/workers/heartbeat-probe-worker.js
// 环境变量：HEARTBEAT_PROBE_INTERVAL_MS（默认 300000=5min）、HEARTBEAT_PROBE_FAILURE_THRESHOLD（默认 3）

import { readState, mutateState } from '../repositories/runtime-state-repository.js';
import { currentSemanticTenant } from '../services/semantic-tenant-context.js';
import { executeHeartbeatProbe, transitionTenantSystemConnection } from '../services/system-access-service.js';
import { getTenantSystemConnections, getTenantSystemDefinitions } from '../services/system-registry-service.js';

const ACCESS_NAMESPACE = 'system_access_runtime';
const PROBES_KEY = 'probes';
const MAX_PROBE_HISTORY = 24;

const INTERVAL_MS = Number(process.env.HEARTBEAT_PROBE_INTERVAL_MS) || 300_000;
const FAILURE_THRESHOLD = Number(process.env.HEARTBEAT_PROBE_FAILURE_THRESHOLD) || 3;

/**
 * 单次巡检：遍历所有已接通系统，对有心跳的调探测。
 * @param {object} [options]
 * @param {number} [options.failureThreshold] - 连续失败N次降级为degraded
 * @param {function} [options.now] - 可注入的时钟
 * @param {function} [options.fetcher] - 可注入的 HTTP fetcher（测试用）
 * @param {function} [options.credentialResolver] - 可注入的凭据解析器（测试用）
 * @returns {Promise<{checked: number, verified: number, failed: number, degraded: number}>}
 */
export async function runHeartbeatProbeCycle({ failureThreshold = FAILURE_THRESHOLD, now = () => new Date().toISOString(), fetcher, credentialResolver } = {}) {
  const tenantId = currentSemanticTenant();
  const definitions = getTenantSystemDefinitions();
  const connections = getTenantSystemConnections();
  let checked = 0;
  let verified = 0;
  let failed = 0;
  let degraded = 0;

  for (const definition of definitions) {
    if (definition.origin !== 'tenant_custom') continue;
    if (!definition.heartbeat?.endpoint) continue;
    const connection = connections.find((conn) => conn.code === definition.code);
    if (!connection || (connection.lifecycleState !== 'connected' && connection.lifecycleState !== 'degraded')) continue;

    checked++;
    const checkedAt = now();
    const result = await executeHeartbeatProbe(definition, { identityScope: { tenantId, subjectId: 'heartbeat-worker' }, fetcher, credentialResolver });

    const outcome = {
      code: definition.code,
      status: result.status,
      supported: true,
      faultMode: 'none',
      checkedAt,
      probeKind: 'heartbeat_scheduled',
      issue: result.issue
    };
    mutateState(ACCESS_NAMESPACE, `${tenantId}:${PROBES_KEY}`, {}, (probes) => {
      const history = (probes[definition.code]?.history || []).slice(0, MAX_PROBE_HISTORY - 1);
      probes[definition.code] = { ...outcome, tenantId, history: [outcome, ...history] };
      return { value: probes, result: { code: definition.code } };
    });

    if (result.status === 'verified') {
      verified++;
    } else {
      failed++;
      const recentHistory = (readState(ACCESS_NAMESPACE, `${tenantId}:${PROBES_KEY}`, {})[definition.code]?.history || []);
      const recentFailures = recentHistory.slice(0, failureThreshold).filter((h) => h.status !== 'verified').length;
      if (recentFailures >= failureThreshold && connection.lifecycleState === 'connected') {
        const degradedResult = transitionTenantSystemConnection({
          code: definition.code,
          to: 'degraded',
          reason: `心跳连续 ${recentFailures} 次失败，自动降级为 degraded；需人工裁定是否断开。`,
          identityScope: { tenantId, subjectId: 'heartbeat-worker' }
        });
        if (!degradedResult.error) degraded++;
      }
    }
  }

  return { checked, verified, failed, degraded };
}

// ---- 常驻 worker 模式 ----
if (process.env.WORKER_MODE === 'daemon') {
  console.log(`[heartbeat-probe-worker] 启动：间隔 ${INTERVAL_MS}ms，降级阈值 ${FAILURE_THRESHOLD} 次`);

  async function tick() {
    try {
      const result = await runHeartbeatProbeCycle();
      console.log(`[heartbeat-probe-worker] 巡检完成：checked=${result.checked} verified=${result.verified} failed=${result.failed} degraded=${result.degraded}`);
    } catch (error) {
      console.error(`[heartbeat-probe-worker] 巡检异常：${error.message}`);
    }
  }

  tick();
  setInterval(tick, INTERVAL_MS);
}
