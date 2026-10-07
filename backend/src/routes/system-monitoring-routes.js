// 系统接入监控路由（2026-10-07）：监控总览、单系统控制、手动触发一轮巡检。
//
// 权限分界（与系统接入同一把闸门体系）：
//   * 读取（监控总览）走 page.semantic-operations.view —— 由 route-security 的
//     requiredReadPagePermissions 对 /api/semantic-operations/ 前缀统一强制，本文件不重复。
//   * 写入（暂停/恢复监控、手动触发巡检）走 meta_model.draft.save —— 与接入侧写入
//     （探测/生命周期）同一把闸门。
//
// 路由只做权限与转发；探测/告警/降级逻辑都在服务层与 worker。
import {
  getSystemMonitoringOverview,
  controlSystemMonitoring,
  runSystemMonitoringCycle,
  runWithSystemMonitoringTenant
} from '../domains/system-monitoring/public-api.js';

export function handleSystemMonitoringRoutes(context) {
  if (!/^\/api\/semantic-operations\/system-monitoring/u.test(context.url.pathname)) return false;
  // 与 systems/* 接入路由相同：监控挂载、周期状态和事件日志都是租户资产。
  // 不可依赖 currentSemanticTenant 在 Demo 中的默认回落，否则请求虽经身份认证，
  // 仍会从非 demo 租户误读 demo-enterprise 的监控视图。
  return runWithSystemMonitoringTenant(context.agentIdentity, () => handleTenantSystemMonitoringRoutes(context));
}

async function handleTenantSystemMonitoringRoutes({ req, res, url, readBody, send, selectActionRole, denyButton }) {
  if (req.method === 'GET' && url.pathname === '/api/semantic-operations/system-monitoring') {
    send(res, 200, await getSystemMonitoringOverview());
    return true;
  }
  const controlMatch = url.pathname.match(/^\/api\/semantic-operations\/system-monitoring\/([^/]+)\/(pause|resume)$/u);
  if (req.method === 'POST' && controlMatch) {
    const actionRole = selectActionRole('meta_model.draft.save');
    if (!actionRole) { denyButton('meta_model.draft.save'); return true; }
    const result = controlSystemMonitoring({ code: decodeURIComponent(controlMatch[1]), action: controlMatch[2] });
    const status = !result.error ? 200 : result.error.code === 'SYSTEM_MONITORING_NOT_MOUNTED' ? 404 : 409;
    send(res, status, result.error ? { message: result.error, code: result.code } : result);
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/semantic-operations/system-monitoring/run') {
    // 手动触发一轮巡检：与定时 worker 同一执行体（alertThreshold/degradeThreshold 可传）。
    const actionRole = selectActionRole('meta_model.draft.save');
    if (!actionRole) { denyButton('meta_model.draft.save'); return true; }
    const body = await readBody(req);
    const result = await runSystemMonitoringCycle({
      alertThreshold: body?.alertThreshold,
      degradeThreshold: body?.degradeThreshold
    });
    send(res, 200, { boundary: '手动触发的一轮监控巡检：与定时轮询同一执行体；告警与降级逻辑一致。', ...result });
    return true;
  }
  send(res, 405, { message: '不支持的系统接入监控操作。', code: 'SYSTEM_MONITORING_METHOD_NOT_ALLOWED' });
  return true;
}
