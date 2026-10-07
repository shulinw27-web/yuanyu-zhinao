# ADR-027：文档类材料登记的存储语义与结构化候选路径

- 状态：Accepted（2026-10-05）
- 关联：阶段 5a（文档类材料接入）；[ADR-017](ADR-017-model-extraction-attribution.md)（材料证据分级）；[ADR-025](ADR-025-object-mention-linking.md)（受控对象链接——其「逐字校验」语义在提取文本上继续成立）；系统接入重构方案 4.4 修正 3

## 背景（Context）

阶段 5 原始范围把 PDF / Word / 图片 / 音频四类材料一揽子绑定验收，其中图片与扫描页依赖视觉模型通道，导致整个阶段被判硬前置卡死。2026-10-05 用户决策重新划界：**暂不增加视觉能力，多模态现阶段体现为文档类能力**——建模时阅读用户提供的接口说明 / 数据字典文档。文档那一半（PDF 文本页 / Word / Excel）走确定性解析、产物是文本，现有文本模型通道即可支撑，拆为 5a 可即刻排期；图片 / 扫描页 / 音频仍属 5b。

划界时代码取证确认的两处真实断点：

1. **登记通道只收纯文本**：`saveMockOnboardingMaterial` 仅接受 `{kind, name, text}`，文档形态材料无法进入接入项目。
2. **schema 发现只认 JSON / YAML / CSV**：`semantic-schema-discovery-service.js` 按 `structuredMimeTypes` 过滤——XLSX / DOCX 字典的提取文本进不了对象 / 字段候选（5a-0 探针实测：同一字典内容 CSV 产出 2 个 schema、XLSX 产出 0）。

另有一处实现级缺陷：`discoverSchemasFromAttachments` 的 `lowerKeys` 把非 ASCII 表头（如「字段名」「主键」）清洗成空串，行式别名判据对中文表头从不生效——别名列表里早已写好的中文别名属于「实现与断言同错」。

## 决策（Decision）

1. **存储语义：提取文本 + 解析取证，原文件不持久化。** 登记通道接受 `{kind, name, expectedRevision, attachment: {mimeType, dataUrl}}`，文档经与对话面同一套安全闸门（`inspectMultimodalInput` + `extractMultimodalEvidence`：签名 / 嵌入文本检查、内容级扫描、DLP、提示注入隔离）后，入库的只有：
   - 提取文本（落 `materials[kind].text`，`digest` 与之绑定）；
   - 解析取证 `source`（形态、mimeType、页数 / 总页数、内容扫描状态、脱敏信号、原文件字节数）。
2. **限制口径分两侧**：原文件按附件侧（4MB、PDF≤20 页）；提取文本按材料侧 `materialBytes` 64KB。**超限整份拒绝、不做静默截断**——为区分解析器级截断与模型上下文预算截断，多模态报告新增 `parserTruncated` 字段（后者只影响展示与模型上下文，不影响登记完整性判据）。
3. **类别边界**：`requirements / api / rules` 三类接受文档形态；`dictionary / samples` 保持 JSON 契约（文档形态字典走对话面候选路径）；图片 / 音频 / 视频一律整份拒绝（专用错误码 `MOCK_ONBOARDING_MATERIAL_FORM_UNSUPPORTED`，指向 5b）。**2026-10-07 更新**：dictionary 一侧已被 [ADR-029](ADR-029-document-dictionary-strong-chain.md) 推翻——XLSX/DOCX 行式字典进 mock 强校验链（与 JSON 字典同一条严格校验、类型严格别名不放宽、PDF 仍不进文档字典）；samples 仍保持 JSON 契约。
4. **结构化候选路径共享**：XLSX / DOCX 字典与 CSV 走同一条确定性候选路径——`office-material-parser` 新增 `parseOfficeTableRows` 把序列化行文本确定性还原为行列矩阵（单元格坐标对齐、稀疏列不移位），发现服务按表头行 + 别名列构造候选；证据等级与 CSV 同级，仍需 Critic 与人工校对。PDF 提取文本不进结构化候选，必须点名披露「仅进入自然语言上下文」。
5. **中文表头别名修复**：`lowerKeys` 保留汉字（`[^a-z0-9\p{Script=Han}]`），使既有中文别名判据真正生效。

## 后果（Consequences）

- 登记的项目材料从「五类纯文本」扩为「三类可为文档形态」，`publicProject` 披露 `source` 取证；handoff 把 `source.mimeType` 透传给 workspace documents，使交接后的 schema 发现能按文档 mime 消费候选路径。
- **不变式**：`mockOnboardingBasis` 以 digest 锚定材料版本，文档形态登记同样使 `connection / alignment / handoff` 全部失效重验；ADR-017 的证据分级与 ADR-025 的逐字校验在提取文本上语义不变。
- **已修复的连带缺陷**：多模态报告的 `truncated` 语义此前把「解析器截断」与「上下文预算截断」混为一谈，现以 `parserTruncated` 区分——对既有消费方纯新增字段。
- 5b（图片 / 扫描页 / 音频）待视觉 / 语音通道可用后单独排期；本 ADR 不改变其整份拒绝语义。

## 验收（2026-10-05 本机实测）

- 新增 `backend/test/mock-onboarding-document.test.js` 6/6（正例 DOCX / XLSX / PDF 登记、取证披露、原文件不入库；反例：字典 / 样本文档形态、图片 / 音频、双通道输入、扫描 PDF、隐藏注入、超 64KiB、超 2000 行）。
- 新增 `backend/test/semantic-schema-discovery-document.test.js` 7/7（XLSX / DOCX 字典候选与 CSV 同构、登记文本交接路径、PDF 披露、无表头披露、稀疏列对齐、隔离材料不进候选）。
- 回归：`npm run quality` 端到端 **EXIT=0**（lint + typecheck + test:all 全量，1m36s）；专项 `test:mock-onboarding` 75/75、`test:semantic` 105/105、`test:mention` 7/7、`test:attribution` 12/12、multimodal 19/19、console 组件 63/63、console 构建通过；`docs:check` 189 份 Markdown / 1241 个本地链接。
- 架构棘轮：新增跨域边 `mock-onboarding-service.js -> multimodal-input-service.js` 已登记入 `architecture-baseline.js`（与 `semantic-operations-task/agent-service`、`knowledge-material-review` 消费同一闸门的三条既有边同性质——共享闸门而非复制闸门，非新领域耦合）。

## References

- 代码：`backend/src/services/mock-onboarding-service.js`（登记通道）、`backend/src/services/multimodal-input-service.js`（`parserTruncated` / office 结构化候选标记）、`backend/src/services/office-material-parser.js`（`parseOfficeTableRows`）、`backend/src/services/semantic-schema-discovery-service.js`（office mime 候选路径、中文表头修复、PDF 披露）、`backend/src/data/mock-onboarding-catalog.js`（`mockOnboardingDocumentMimeTypes` / `documentBoundary`）、`apps/semantic-operations-console/src/components/SemanticOnboardingWorkspace.vue`（文档上传与披露）
- 测试：见「验收」小节
