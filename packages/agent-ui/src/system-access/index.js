// 系统接入共享资产出口。
//
// 元模型连接模板（字段 → 元模型对象映射）在阶段 2 从管理 Web config 页迁到元域智语端的
// 系统接入视图。它仍然是既有的受治理世界模型机制（阶段 6 等价合并后权限挂 meta_model.*），只是入口换了端，
// 因此组件提升为共享包资产，两端都可用声明式依赖引用，不再需要跨包穿透。
export { default as WorldModelTemplateConfig } from './WorldModelTemplateConfig.vue';
