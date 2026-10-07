# ADR-029: 文档形态字典进 mock 强校验链（推翻 5a 决策点 3）

- 状态：Accepted
- 日期：2026-10-07
- 关联：[ADR-027](ADR-027-document-material-registration.md)（5a 决策点 3 被本 ADR 推翻）、[ADR-024](ADR-024-custom-system-registration.md)（登记物料通道）、ADR-028（系统登记文档物料）

## 背景

ADR-027（阶段 5a）决策点 3 明确写了「dictionary / samples 保持 JSON 契约：文档形态字典只走 5a-2 候选路径，不直接进 mock 通道强校验链（连接 / 样本 / 对齐仍以 JSON 字典为准）」。当时的理由是控制 5a 的增量边界——文档形态字典在 5a-2 只进了 schema 发现候选（`xlsx_dictionary` / `docx_dictionary`）。

留下的后果：登记通道的 dictionary 类别只接受 JSON 文本；用户上传 XLSX/DOCX 行式字典只能进候选，**无法驱动 mock 强校验链**（连接 / 样本 / 对齐 / 预览都以 JSON 字典为唯一事实源）——同一份字典内容要以两种形态登记两次（文档进候选、JSON 进强校验链），运营负担与形态漂移风险并存。

用户 2026-10-07 确认「文档字典进 mock 强校验链」，推翻 5a 决策点 3（dictionary 一侧；samples 仍保持 JSON 契约）。

## 决策

### 1. 登记通道：dictionary 接受文档形态（仅 XLSX/DOCX）

`saveMockOnboardingMaterial` 的文档附件通道加入 `dictionary` 类别；**mime 收窄到 XLSX / DOCX**（表格结构可确定性还原）——PDF 提取文本无行列结构（5a-2 边界：PDF 只走自然语言上下文），文档形态字典给专用错误码 `MOCK_ONBOARDING_MATERIAL_FORM_UNSUPPORTED` 整份拒绝；samples / requirements 双形态边界不变（samples 仍仅 JSON）。

### 2. 强校验链：文档字典与 JSON 字典同一条校验链

`validateDictionary` 新增文档形态分支——material 带 `source.mimeType`（office）时：

1. `parseOfficeTableRows(text)` 把序列化行文本**确定性还原**为行列矩阵（单元格坐标对齐，5a-2 既有能力）；
2. `matrixToRecords`（由 schema 发现服务导出共享，与 CSV 同语义：首行表头 + 数据行按位对齐）还原为记录；
3. 按**行式别名**映射到 `{tables:[...]}` JSON 契约——表名（表名/table/entity/object）、字段（字段/field/column）、类型（类型/type/datatype）、必填（必填/required）、主键（主键/primarykey/pk，按行 truthy 标记）、外键（外键/reference，`目标表.目标字段` 点号拆分）、来源系统（来源系统/system）；
4. **类型映射是严格别名**（string/varchar/text/字符串→string、number/decimal/数字→number、integer/int/整型→integer、boolean/布尔/是否→boolean）——不在映射内的类型**整份拒绝并点名**（如「VARCHAR(64) 不在 mock 契约」），**不静默默认**：mock 强校验链的类型契约不放宽；
5. 映射产物落入既有 JSON 字典的同一套严格校验（表名 identifier、system validLabel、主键显式且存在于 fields、外键目标存在且类型一致、discovery 走 office mime 产出同构候选）。

### 3. 前端：kind 级 mime 收窄

`SemanticOnboardingWorkspace.vue`：dictionary 类别开放文档上传（`document: true` + `documentMimes: ['docx', 'xlsx']`）；文件选择 accept 与客户端校验按 kind 级 mime 收窄——**PDF 扩展名直接映射 mime 会绕过收窄**，故校验改查收窄后清单，PDF 字典在客户端先拦下（专用提示），不发起请求。

## 实测口径（2026-10-07）

- `backend/test/mock-onboarding-document.test.js` 6 → **9**：新增 3 项——XLSX 行式字典登记 + readiness 零 issue（与 JSON 字典同链）、不可映射类型（VARCHAR(64)）整份拒绝并点名、PDF 字典专用拒绝消息；既有「document form is rejected for json kinds」用例更新（dictionary 转接受、samples 仍拒绝，5→4 处 FORM_UNSUPPORTED）。
- console 组件 **63/63**（字典 + PDF 客户端拦截断言更新为 /XLSX \/ DOCX/）。
- 实现期修正两处别名缺口（与发现服务对齐）：类型列补裸「类型」表头、truthy 标记补「主键 / pk」。

## 边界（不得在界面或文档中弱化）

1. **samples 仍仅 JSON 契约**——样本是具体记录，文档形态样本记录的反序列化属独立增量；本 ADR 只覆盖 dictionary 一侧。
2. **类型映射不放宽**——文档字典的类型列必须可映射到 mock 契约四类型；映射是确定性别名（如 varchar→string），**不是**宽松推断；不可映射整份拒绝。
3. **PDF 仍不进文档字典**——提取文本无行列结构（5a-2 边界），PDF 字典材料一律专用错误码整份拒绝。
4. **证据等级不变**——文档字典驱动强校验链 ≠ 结构被验证为真；连接 / 样本 / 对齐 / Critic / 人工复核全链照常。
5. **原文件仍不落地**——登记的只有提取文本 + 解析取证（5a-1 契约不变）。

## 触发式复审

- 若文档形态样本（samples）需进强校验链，样本记录的反序列化与主键/外键语义需独立设计；本阶段不做。
- 若文档字典需要表达 JSON 契约之外的能力（如复合主键、枚举、单位），映射契约需扩展；本阶段只映射既有契约字段。
