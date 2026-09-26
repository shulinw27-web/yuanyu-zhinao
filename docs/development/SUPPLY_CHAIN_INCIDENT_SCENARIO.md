# 全链路质量事件：双 Agent 复杂世界模型验证场景

日期：2026-09-10。全部公司、人物、编号、金额和业务事件为合成测试，不涉及真实事故或客户数据。

## 验证什么

从原料到货批次 RAW-N1 的筛查阳性出发，模拟元域智语 Agent 建模、人工建模校对、案例回放和 Semantica 发布，再由智脑追溯采购、生产、仓库、在途、门店、销售、退货、财务和人员职责。验证依据是实际调用和独立计算，不以“生成了模型”或 HTTP 200 作为业务完成。

输入来源分为 7 系统、24 对象、27 字段级外键、77 条唯一记录和 1 条重复银行到账投递。OMS 同时模拟门店与订单；OA 同时模拟人员与责任指派，并未声称额外接入 POS/HR 实体系统。

| 系统 | 模拟对象 | 关键分叉 |
| --- | --- | --- |
| ERP | Supplier、PurchaseOrder、RawLot、Invoice、BankReceipt、Allocation | 供应商重号；订单/发票粒度；重复到账；已核销与待核销 |
| LIMS | Inspection | 筛查阳性待复检 / 其他原料最终合格 |
| MES | MaterialIssue、ProductionBatch、BatchOutput、LotGenealogy | 实发 / 计划领料；同批产出拆分；合批后继续拆分 |
| WMS | FinishedLot、StockPosition、Warehouse、TransferLine | 两仓；净库存与已发出在途；已收与未收 |
| OMS | Store、StoreReceipt、SalesOrder、SalesLine、ReturnLine | 三店；一个订单多行；取消行；已售后待检退货 |
| QMS | QualityEvent | 调查中，原因未确定 |
| OA | Approval、Person、Responsibility | 审批通过但无执行回执；现任和过期指派；在职与离职 |

## 核心流向

```text
SUP-N1 → PO-N1 → RAW-N1（筛查阳性，待复检）
                  ├─ 实发50kg → PB-N1 → LOT-N1（400件）→ 两店收货/在途/销售/退货
                  │                    └→ LOT-N2（100件）─┐
                  ├─ 实发30kg → PB-N2 → LOT-N3（300件）  │
                  └─ 计划20kg → PB-N3（不当作实际消耗）  │
                                                       ↓
SUP-N2 → PO-N2 → RAW-N2 → PB-N9 → LOT-N9（200件）→ 合批 LOT-N4（300件）
                                              ├─ 仓内80件、三店收货160件
                                              └─ 再拆 LOT-N5（60件）：仓内40、在途20
```

RAW-N1 与 RAW-N2 的供应商批号同为 VENDOR-778，但供应商和内部批次不同。应向后纳入 LOT-N4/N5，不应反向把 LOT-N9 合批之前的全部业务也认定为 RAW-N1 的影响。

仓库、门店数量是净快照。已售包含后来退回待检的 10 件；退货不能再次加到累计销量中，也不能视为可售。源数据件数是 piece，领料是 kg，金额是 CNY；没有提供转换依据时不能把原料重量直接换算成成品件数。

## 独立人工答案

下表是测试基线，不上传给任一 Agent。

| 项目 | 完整影响范围 | 仅直接产物对照 |
| --- | ---: | ---: |
| 仓内 | 460 件 | 340 件 |
| 在途 | 60 件 | 40 件 |
| 门店现存 | 190 件 | 130 件 |
| 累计实售 | 290 件 | 190 件 |
| 待检退货（实售子集） | 10 件 | 10 件 |
| 涉及订单金额（非赔付额） | 6,000 CNY | 4,000 CNY |
| 确认到账 | 5,000 CNY | 3,000 CNY |
| 已核销 | 2,500 CNY | 2,500 CNY |
| 确认但未核销 | 2,500 CNY | 500 CNY |

影响生产批次 PB-N1/N2，直接产物 LOT-N1/N2/N3，含合拆批后代后为 LOT-N1/N2/N3/N4/N5。涉及 SHOP-N1/N2/N3 和 SO-N1/N2/N3。PB-N3 是计划，不应称为实际受影响产物；SO-N4 已取消。

协作人员：PER-N1 测试人员林甲（质量调查），PER-N2 测试人员周乙（库存核查），PER-N3 测试人员陈丙（财务核对）。PER-N0 旧主管指派过期且不在职。联系人不是过错责任人。AP-N1 approved 但执行回执为空，不能宣称召回已执行。

## 如何模拟人工建模

自动建模分支与人工分支分开记录。人工依据原始字典定义对象、外键、单位、可空字段、访问策略与明确的业务边界，通过真实草稿 API 保存，并完成校验、回放、模拟与发布。没有直接改数据库，也未点击实际 UI，所以只称“人工建模流程 API 模拟”。

当前读计划最多 24 数据集，人工直接范围对照已使用 24 个。它能取到 LOT-N2→LOT-N4 的谱系边，却不能在该计划继续取 LOT-N4/N5 的实例和下游事实。先用完整预期回放，必须失败且阻止发布；随后单独按已标注的“直接范围”验证并发布，用于暴露业务消费缺口。不能把后者说成全场景验收成功。

要求智脑回答四组问题：全范围排查、溯源与缺失证据、合批遗漏、有效联系人。再对比两个重号原料，并注入连接器覆盖缺失、库存冲突版本、跨租户返回三类故障。最后直接上传完整合成记录作为材料推理对照，以及补传人员材料的对照，区分数据链路问题、附件上下文问题和推理问题。

## 文件与复现

- `examples/semantic-schemas/supply-chain-incident/scenario.mjs`：生成 API、字典、记录和需求，均不含预期答案。
- `expected.mjs`：独立验收基线，禁止作为模型输入。
- `read-plan.mjs`：保留原直接范围 `readPlan`，新增人工审阅的闭包 `fullReadPlan`；不是产品代码内置场景算法。
- `backend/test/supply-chain-incident-fixture.test.js`：独立外键、单位、传播方向、金额与重复记录核对。
- `scripts/evaluate-supply-chain-incident.mjs`：实际双 Agent HTTP、方舟和隔离 Semantica 联测。

```powershell
npm run test:supply-chain-fixture
npm run evaluate:supply-chain
npm run evaluate:supply-chain -- --repair
```

脚本输出到 `output/supply-chain-incident/<批次>/`，包含可供导入的 JSON 输入、人工模型、回放样本及逐次原始答复。只启停脚本自己的 API、Semantica 和回环连接器，不操作用户当前模型。默认保留修复前直接范围对照；`--repair` 使用完整闭包计划，六组验收有一组失败即退出非零。业务结论以 `assessment.json.checks`、`acceptancePassed` 及逐项答案评审为准，不能只看 HTTP 状态。

见 [联调结果与问题清单](SUPPLY_CHAIN_INCIDENT_EVALUATION.md)。
