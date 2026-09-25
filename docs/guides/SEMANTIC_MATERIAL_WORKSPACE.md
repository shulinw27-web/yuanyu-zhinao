# 用业务材料快速建立语义候选模型

更新：2026-09-10。适用于独立元域智营 Agent，不是业务智脑。用 [制造案例材料](../../examples/semantic-schemas/manufacturing-case/) 可以复现；详细结果见 [修复报告](../development/SEMANTIC_MANUFACTURING_REPAIR.md)。

## 准备什么

准备业务目标/判断规则、各系统 API 或数据字典，以及经过许可的脱敏样本。字典应逐对象写明来源、主键、粒度和字段；不要求为了识别系统而把所有内容拆成不同文件。

```json
{
  "tables": [{
    "name": "ReceiptLine",
    "system": "WMS",
    "granularity": "transaction",
    "primaryKey": "receipt_line_id",
    "fields": [
      {"name": "receipt_line_id", "type": "string", "primaryKey": true},
      {"name": "lot_id", "type": "string", "reference": "MaterialLot", "referenceField": "lot_id"},
      {"name": "received_qty", "type": "number", "unit": "kg"}
    ]
  }]
}
```

上例不是完整模型，还需提供被引用的 MaterialLot。OpenAPI 对应使用 Schema 级 `x-source-system`、`x-primary-key`、`x-granularity`，标量外键用字段级 `x-foreign-key: {"schema":"MaterialLot","field":"lot_id"}`。这些 `x-` 字段是本项目支持的扩展，不是所有 OpenAPI 生成器都会自动提供。只在描述里写“外键”会进入待补充状态，不凭字段名猜关系。

## 操作顺序

1. 新建语义任务，上传需求和字典，输入：“先解释业务对象、粒度和判断规则，不建模、不发布。”先核对业务含义。
2. 在同一任务补材料，例如先 ERP/WMS，再 LIMS/QMS/MES/OA。输入：“合并前后材料生成候选，不删除旧对象，不发布。”缺少引用对象时继续补充该对象定义。
3. 查看候选来源、主键、粒度及关系；查看“业务规则与状态依据”，确认需求没有遗漏、对象关联是否准确。
4. 检查三个不同结论：结构是否一致、样本是否通过、需求是否评审。绿色结构检查不等于已经能回答所有业务问题。
5. 若要做样本映射，上传 JSON 的 `records` 数组。每条记录须有 objectType、system、id、version、tenantId、organizationId、classification、occurredAt、payload。身份/组织以服务端为准；不能通过改附件里的 tenant 或 role 获取权限。完全相同的 system/id/version 投递去重；同版本不同内容阻断。
6. 样本和结构检查通过后，仍需人工确认采纳草稿；接着在治理页配置指标、状态转换及已注册判断/动作，完成校验、模拟和当前版本案例回放。发布单独确认。

内置 Mock 的字段与所上传企业字典不一致时，显示映射失败是预期保护，不应删除必填字段来凑通过；应提供对应的、获准访问的样本。没有样本时不声称已验证映射。

## 冲突与材料记忆

同一任务不会把新版同名对象静默覆盖旧版：主键、来源、类型、单位等不一致时列出冲突。当前解决方式是先核对权威版本，再以更正后的完整材料新建明确版本任务；没有自动判断“最后上传的一定正确”，也未提供自动删除旧来源的聊天指令。

持久材料引用保留扫描、脱敏后的文本和用户诉求，由当前配置的语义治理存储承载。默认内存测试不跨进程；文件/PostgreSQL 存储可持久化。同一主体的同一原始角色才能复用，跨账号、跨租户或降权不复用旧材料。原始二进制附件和派生材料工作区不是同一种生命周期；生产环境必须评审派生文本保留、备份、删除和密钥策略，不能把“原附件临时保留”误认为“所有派生内容自动清除”。

单任务最多 64 份材料/诉求版本、2 MiB 已扫描文本；模型/草稿最多 40 对象、每对象 80 字段，关系保持当前 40 条上限。超限明确拒绝，不裁掉对象凑数。聊天和模型输入仍有摘要预算，结构化解析不受该摘要预算限制；非结构化抽取超过 20,000 字符时仍需拆分或提供字典，不保证任意长 PDF 一次成功。

`worldModel` 保存的是有证据的候选约束，全部 `executable=false`。它不是自动生成的新权限、脚本或可执行状态机；真实系统接入及发布验收另见 [生产清单](../operations/PRODUCTION_TODO_CHECKLIST.md)。
