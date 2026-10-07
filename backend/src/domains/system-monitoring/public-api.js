// 系统接入监控领域的公共入口（2026-10-07）。
//
// 为什么独立成域：监控是系统接入的新关注点——挂载集合、轮询周期、告警分派有独立的
// 事实源（system_monitoring_runtime 按租户隔离的挂载注册表），与接入视图/探测
// （system-onboarding 域）和风险告警（alerting 域）都不重合。
// 对外暴露 4 项契约：边界声明、监控总览（读取即同步挂载集合）、单系统监控控制、
// 手动触发一轮轮询巡检。挂载/解除由 syncSystemMonitoring 按生命周期自动完成
// （接入成功自动挂载、停用/退回/删除自动解除），不作为独立 HTTP 契约暴露。
import { runWithSemanticTenant } from '../../services/semantic-tenant-context.js';

// 路由层只能依赖领域公共入口。监控数据本身是租户资产，因此把受信身份绑定作为
// 此领域的一项边界契约，而不是让 HTTP 路由穿透 services/。
export function runWithSystemMonitoringTenant(identity, work) {
  return runWithSemanticTenant(identity, work);
}

export {
  SYSTEM_MONITORING_BOUNDARY,
  getSystemMonitoringOverview,
  controlSystemMonitoring,
  runSystemMonitoringCycle
} from '../../services/system-monitoring-service.js';
