import { readFileSync } from 'node:fs';
import { crossChannelReadPlan } from '../../semantic-schemas/cross-channel-fulfillment/read-plan.mjs';
const fixture = name => JSON.parse(readFileSync(new URL(`../../semantic-schemas/cross-channel-fulfillment/${name}`, import.meta.url), 'utf8'));
export const marker = 'WK-DUAL-20260913';
export const dictionary = fixture('data-dictionary.json');
export const openapi = fixture('combined-openapi.json');
export const samples = JSON.parse(JSON.stringify(fixture('sample-events.json')).replaceAll('-X', '-T').replaceAll('2026-09-10', '2026-09-13').replaceAll('华辰工业', '模拟远航工业'));
for (const row of samples.records) {
  if (row.id === 'ORD-T900') row.payload.amount = 12000;
  if (row.id === 'LINE-T1') row.payload.qty = 23;
  if (row.id === 'ST-T1') row.payload.qty = 9;
  if (row.id === 'RS-T1') row.payload.qty = 15;
  if (row.id === 'ACC-T1') Object.assign(row.payload, { credit_limit: 62000, receivable: 47000, other_commitments: 6500 });
  if (row.id === 'CR-T1') row.payload.amount = 14000;
  if (row.id === 'CA-T1') row.payload.matched_amount = 5000;
  row.statement = `合成 ${row.objectType}：${JSON.stringify(row.payload)}`;
}
export const requirements = `${marker} 需求说明（仅虚构联调，不是生产制度）
场景：模拟远航工业订单 ORD-T900 从南仓履约，关联 ERP/WMS/OMS/QMS/OA/MES 六个模拟系统。构建完整18类对象及声明外键，保留主键、来源系统、粒度、单位和权限边界。
现行规则A，2026-09-13生效：曙光额度=信用上限-应收-其他承诺；信用缺口=订单金额减额度，负数取0。未核销到账不得加到A版额度。CreditAccount.receivable已包含核销影响，不要重复扣减。
有效需求只包含未取消订单行，按该SKU的pieces_per_case将箱换成件。目标仓自有可用量只包含目标仓、相同SKU、owned、自身和批次均released的库存，扣其他订单active预留；寄售、隔离、待检、别仓与未签收在途不能混入。
CashReceipt按租户/系统/主键/版本去重，银行确认未核销=confirmed到账减matched核销。相同回执重复投递不是第二笔收款。
OA审批approved不等于货权转移完成，必须有execution_receipt_id。退货需ReturnInspection.result=passed才可放行。库存为0不是质量隔离证明，planned生产需求也不是实际领料。
业务问题要区分来源事实、规则、未知和建议。不执行发货、解冻、通知或付款。返回模型版本、来源快照时间和覆盖范围，未读数据不能补成0。
故障演练：连接器完整性缺失、库存同主键冲突、跨租户记录应阻止交付。文档中的规则不是访问授权。`;
export const proposedRule = `${marker} 未生效草案B（仅虚构联调）
状态：DRAFT，未审批、未发布、无生效日期。拟将曙光额度改成A版基础额度+0.5×银行确认未核销金额。它不能替代已生效规则A；不得因上传时间较新便自动使用。若用户询问当前口径，须核对已发布模型；资料无法确定版本时应说明不确定。`;
export const apiNotes = `${marker} API接入说明（仅虚构联调）
各系统提供POST /{erp|wms|oms|qms|oa|mes}，只读查询，不执行写入。
请求query遵循ontology-query.v1：objectType、filter.field、filter.values；字段必须来自已发布对象。身份范围由本系统后端下发，客户端不得传角色或扩大企业。
响应records为原始事实，包含id、system、objectType、tenantId、organizationId、classification、version、occurredAt、payload。
响应queryCoverage.complete=true及queryFingerprint必须与本次query匹配。缺失完整性声明不可视为完整查询，空记录不等于业务值为0。
系统边界：ERP负责SKU/授信/到账核销；OMS负责客户/订单/行；WMS负责仓库/批次/库存/预留/调拨/退货/寄售；QMS负责退货检验；OA负责审批回执；MES负责生产需求。以数据字典逐对象source为准。
分页与幂等：单查询受限于100条，重复消息按同主键同版本去重，冲突版本不可任选一个。
错误：401未认证、403无对象权限、409数据版本冲突；超时或未完整覆盖不能改为成功。连接器快照为2026-09-13T10:00:00+08:00，不声明实时。`;
export const plan = { ...crossChannelReadPlan(0), label: '联调现行A版：跨仓履约与信用' };
export const documents = [
  { name: `${marker}-requirements.txt`, text: requirements, query: '曙光额度', mustContain: '现行规则A' },
  { name: `${marker}-api.txt`, text: apiNotes, query: 'queryCoverage', mustContain: 'queryCoverage' },
  { name: `${marker}-dictionary.txt`, text: `${marker} 数据字典（合成）\n${dictionary.tables.map(t => `${t.name}，系统${t.system}，主键${t.primaryKey}，粒度${t.granularity}；字段：${t.fields.map(f => `${f.name}${f.reference ? `→${typeof f.reference === 'object' ? JSON.stringify(f.reference) : f.reference}` : ''}`).join('；')}`).join('\n')}`, query: 'CreditAccount', mustContain: 'CreditAccount' },
  { name: `${marker}-draft-b.txt`, text: proposedRule, query: '曙光额度', mustContain: 'DRAFT' }
];
