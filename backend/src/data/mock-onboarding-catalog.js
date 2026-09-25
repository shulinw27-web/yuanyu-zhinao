import { systemDefinitions } from './system-catalog.js';

// 场景所引用的系统码必须存在于系统注册表。此前这里是两处硬编码的系统三元组，
// 系统改名或删除后不会报错，只会静默产出错误的来源标注——现在改为加载期快速失败。
const registeredCodes = new Set(systemDefinitions.map((item) => item.code));
const registeredSystems = (scenarioId, codes) => codes.map((code) => {
  if (!registeredCodes.has(code)) throw new Error(`模拟接入场景 ${scenarioId} 引用了未登记的系统码：${code}`);
  return code;
});

export const mockOnboardingScenarios = [
  { id: 'fulfillment', label: '订单履约', description: '梳理订单、库存和发运材料，确认跨系统履约问题所需的证据。', systems: registeredSystems('fulfillment', ['OMS', 'ERP', 'WMS']), questions: ['哪些订单存在缺货或延迟风险？', '订单与库存、发运记录通过哪些字段关联？'] },
  { id: 'quality_incident', label: '批次异常', description: '梳理质量事件、批次和库存材料，确认异常追溯所需的证据。', systems: registeredSystems('quality_incident', ['QMS', 'MES', 'WMS']), questions: ['异常涉及哪些批次与库存？', '质量事件与批次通过哪些字段关联？'] }
];

export const mockOnboardingMaterialKinds = [
  { kind: 'requirements', label: '业务需求', description: '至少 24 个非空白字符，说明业务目标、范围与验收问题。', format: 'text' },
  { kind: 'api', label: '接口说明', description: '至少 24 个非空白字符，说明接口路径、请求方式、字段与只读范围；当前只登记说明。', format: 'text' },
  { kind: 'dictionary', label: '数据字典', description: '限定 JSON：{tables:[{name,system,primaryKey,fields:[{name,type,required?,reference?,referenceField?}]}]}。type 支持 string/number/integer/boolean；reference 填目标表名。每表必须显式声明主键。', format: 'json' },
  { kind: 'samples', label: '合成样本', description: '限定 JSON：{records:[{objectType,payload}]}。objectType 与字典表名一致，payload 为字段值对象；只提交合成数据，主键需非空字符串或有限数字，必填、类型和外键需匹配字典。', format: 'json' },
  { kind: 'rules', label: '业务规则', description: '至少 24 个非空白字符，说明判断条件、阈值及异常处理要求。', format: 'text' }
];

export const mockOnboardingLimits = Object.freeze({ projectsPerPrincipalRole: 20, materialsPerProject: 5, materialBytes: 65536, projectBytes: 262144, principalRoleBytes: 1048576, tables: 40, fieldsPerTable: 80, sampleRecords: 500, previewRows: 10, sourceBytes: 1048576 });
export const mockOnboardingBoundary = 'Synthetic 模拟接入：校验合成材料与本地 Mock 只读数据；显式交接后可生成待审阅候选结构。不调用大模型、不连接真实系统、不自动采纳或发布模型、不提供业务问答。仅验证 mock-onboarding-query.v1，不代表真实连接器验收；业务语义仍需人工审阅。';
