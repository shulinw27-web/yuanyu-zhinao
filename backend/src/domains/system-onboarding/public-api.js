// 系统接入领域的公共入口。
//
// 为什么独立成域，而不是并入 governance：
//   * 治理域 public-api 的导出已达冻结上限（92），且棘轮只降不升。把系统接入塞进去
//     会迫使抬高基线，等于削弱约束；而架构基线本身给出的合法路径就是「拆分领域」。
//   * 系统接入在本次重构中已成为独立关注点：它有独立的事实源（data/system-catalog.js）、
//     独立的状态机（接入生命周期）与独立的多租户资产（租户级接入实例与探测结果），
//     与「元模型 / 世界模型」的治理关注点并不重合。
//   * 对外只暴露 4 项契约：边界声明、总览、详情、探测。元模型连接模板与映射草稿
//     仍由 governance 域提供，由路由层组合——本域不做「重导出管道」。
export {
  SYSTEM_ACCESS_BOUNDARY,
  getSystemAccessOverview,
  getSystemAccessDetail,
  probeSystemConnection
} from '../../services/system-access-service.js';
