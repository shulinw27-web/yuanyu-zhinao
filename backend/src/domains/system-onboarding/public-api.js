// 系统接入领域的公共入口。
//
// 为什么独立成域，而不是并入 governance：
//   * 治理域 public-api 的导出已达冻结上限（92），且棘轮只降不升。把系统接入塞进去
//     会迫使抬高基线，等于削弱约束；而架构基线本身给出的合法路径就是「拆分领域」。
//   * 系统接入在本次重构中已成为独立关注点：它有独立的事实源（data/system-catalog.js）、
//     独立的状态机（接入生命周期）与独立的多租户资产（租户级接入实例与探测结果），
//     与「元模型 / 世界模型」的治理关注点并不重合。
//   * 对外暴露 6 项契约：边界声明、总览、详情、登记自定义系统、探测、生命周期操作。
//     元模型连接模板与映射草稿仍由 governance 域提供，由路由层组合——本域不做「重导出管道」。
//   * 2026-09-26：第 5 项（生命周期操作）补齐了 ADR-023 的接入流程缺口；同日第 6 项
//     （登记自定义系统）落实 ADR-024：接入清单不再预设备待接入/未登记系统，
//     「新增接入」变成租户提交接入物料、任意命名的登记动作。见 ADR-024。
//   * 2026-10-07：+2 项（已接入系统补充物料 / 系统理解）——接入成功后租户可继续补充
//     系统物料（8-5 同一受控解析管线），并把登记物料 + 文档提取文本交给大模型生成
//     系统理解（理解结果同时是 agent 引导接入的事实面）。实现移至 system-material-service。
export {
  SYSTEM_ACCESS_BOUNDARY,
  getSystemAccessOverview,
  getSystemAccessDetail,
  registerSystemOnboarding,
  probeSystemConnection,
  transitionTenantSystemConnection
} from '../../services/system-access-service.js';
export {
  SYSTEM_MATERIALS_BOUNDARY,
  supplementSystemMaterials,
  getSystemUnderstanding
} from '../../services/system-material-service.js';
