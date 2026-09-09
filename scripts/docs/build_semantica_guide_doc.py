from pathlib import Path
from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.style import WD_STYLE_TYPE
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_CELL_VERTICAL_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor

OUT = Path(__file__).resolve().parents[2] / 'docs' / 'reference' / 'exports' / '元域智脑-Semantica语义层构建指南-v1.0.docx'

NAVY = '0B2545'
BLUE = '2E74B5'
DARK_BLUE = '1F4D78'
MUTED = '5B6573'
PALE_BLUE = 'E8EEF5'
PALE_GRAY = 'F2F4F7'
PALE_GOLD = 'FFF8E8'
WHITE = 'FFFFFF'
CONTENT_WIDTH = 9360


def set_font(run, name='Calibri', size=11, color=None, bold=None, italic=None):
    run.font.name = name
    run._element.rPr.rFonts.set(qn('w:ascii'), name)
    run._element.rPr.rFonts.set(qn('w:hAnsi'), name)
    run._element.rPr.rFonts.set(qn('w:eastAsia'), 'Microsoft YaHei')
    run.font.size = Pt(size)
    if color:
        run.font.color.rgb = RGBColor.from_string(color)
    if bold is not None:
        run.bold = bold
    if italic is not None:
        run.italic = italic


def shade(cell, fill):
    tc_pr = cell._tc.get_or_add_tcPr()
    item = tc_pr.find(qn('w:shd'))
    if item is None:
        item = OxmlElement('w:shd')
        tc_pr.append(item)
    item.set(qn('w:fill'), fill)


def set_cell_margins(cell, top=80, start=120, bottom=80, end=120):
    tc_pr = cell._tc.get_or_add_tcPr()
    margins = tc_pr.first_child_found_in('w:tcMar')
    if margins is None:
        margins = OxmlElement('w:tcMar')
        tc_pr.append(margins)
    for edge, value in [('top', top), ('start', start), ('bottom', bottom), ('end', end)]:
        tag = qn(f'w:{edge}')
        node = margins.find(tag)
        if node is None:
            node = OxmlElement(f'w:{edge}')
            margins.append(node)
        node.set(qn('w:w'), str(value))
        node.set(qn('w:type'), 'dxa')


def fixed_table(table, widths, header_fill=PALE_BLUE):
    table.autofit = False
    table.alignment = WD_TABLE_ALIGNMENT.LEFT
    table_pr = table._tbl.tblPr
    width = table_pr.first_child_found_in('w:tblW')
    width.set(qn('w:w'), str(sum(widths)))
    width.set(qn('w:type'), 'dxa')
    indent = OxmlElement('w:tblInd')
    indent.set(qn('w:w'), '120')
    indent.set(qn('w:type'), 'dxa')
    table_pr.append(indent)
    grid = table._tbl.tblGrid
    for col, dx in zip(grid.gridCol_lst, widths):
        col.set(qn('w:w'), str(dx))
    for row_index, row in enumerate(table.rows):
        if row_index == 0:
            row_pr = row._tr.get_or_add_trPr()
            header = OxmlElement('w:tblHeader')
            header.set(qn('w:val'), 'true')
            row_pr.append(header)
        for cell, dx in zip(row.cells, widths):
            cell.width = Inches(dx / 1440)
            set_cell_margins(cell)
            cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
            if row_index == 0:
                shade(cell, header_fill)
            for paragraph in cell.paragraphs:
                paragraph.paragraph_format.space_before = Pt(0)
                paragraph.paragraph_format.space_after = Pt(0)
                paragraph.paragraph_format.line_spacing = 1.1
                for run in paragraph.runs:
                    set_font(run, size=9.5, color=NAVY if row_index == 0 else None, bold=True if row_index == 0 else None)


def add_table(doc, headers, rows, widths):
    table = doc.add_table(rows=1, cols=len(headers))
    table.style = 'Table Grid'
    for cell, text in zip(table.rows[0].cells, headers):
        cell.text = text
    for data in rows:
        cells = table.add_row().cells
        for cell, text in zip(cells, data):
            cell.text = str(text)
    fixed_table(table, widths)
    for r_index, row in enumerate(table.rows):
        if r_index and r_index % 2 == 0:
            for cell in row.cells:
                shade(cell, 'FAFBFC')
    doc.add_paragraph().paragraph_format.space_after = Pt(2)
    return table


def add_heading(doc, text, level=1):
    p = doc.add_paragraph(style=f'Heading {level}')
    p.add_run(text)
    return p


def add_body(doc, text, bold_lead=None):
    p = doc.add_paragraph(style='Normal')
    if bold_lead and text.startswith(bold_lead):
        r = p.add_run(bold_lead)
        set_font(r, size=11, bold=True, color=NAVY)
        r = p.add_run(text[len(bold_lead):])
        set_font(r, size=11)
    else:
        r = p.add_run(text)
        set_font(r, size=11)
    return p


def add_bullets(doc, items):
    for item in items:
        p = doc.add_paragraph(style='List Bullet')
        p.paragraph_format.space_after = Pt(4)
        p.paragraph_format.line_spacing = 1.25
        set_font(p.add_run(item), size=10.5)


def add_steps(doc, items):
    for item in items:
        p = doc.add_paragraph(style='List Number')
        p.paragraph_format.space_after = Pt(4)
        p.paragraph_format.line_spacing = 1.25
        set_font(p.add_run(item), size=10.5)


def callout(doc, title, text, fill=PALE_GOLD):
    table = doc.add_table(rows=1, cols=1)
    table.style = 'Table Grid'
    fixed_table(table, [CONTENT_WIDTH], header_fill=fill)
    cell = table.cell(0, 0)
    shade(cell, fill)
    p = cell.paragraphs[0]
    p.paragraph_format.space_after = Pt(3)
    set_font(p.add_run(title), size=10.5, color=DARK_BLUE, bold=True)
    p = cell.add_paragraph()
    p.paragraph_format.space_after = Pt(0)
    set_font(p.add_run(text), size=10)
    doc.add_paragraph().paragraph_format.space_after = Pt(2)


def page_number(paragraph):
    run = paragraph.add_run('第 ')
    set_font(run, size=8.5, color=MUTED)
    field = OxmlElement('w:fldSimple')
    field.set(qn('w:instr'), 'PAGE')
    paragraph._p.append(field)
    run = paragraph.add_run(' 页')
    set_font(run, size=8.5, color=MUTED)


def build():
    doc = Document()
    section = doc.sections[0]
    section.top_margin = Inches(0.85)
    section.bottom_margin = Inches(0.8)
    section.left_margin = Inches(0.85)
    section.right_margin = Inches(0.85)
    section.header_distance = Inches(0.35)
    section.footer_distance = Inches(0.35)

    normal = doc.styles['Normal']
    normal.font.name = 'Calibri'
    normal._element.rPr.rFonts.set(qn('w:eastAsia'), 'Microsoft YaHei')
    normal.font.size = Pt(11)
    normal.paragraph_format.space_after = Pt(6)
    normal.paragraph_format.line_spacing = 1.25

    for name, size, color, before, after in [('Heading 1', 16, BLUE, 18, 10), ('Heading 2', 13, BLUE, 14, 7), ('Heading 3', 12, DARK_BLUE, 10, 5)]:
        style = doc.styles[name]
        style.font.name = 'Calibri'
        style._element.rPr.rFonts.set(qn('w:eastAsia'), 'Microsoft YaHei')
        style.font.size = Pt(size)
        style.font.color.rgb = RGBColor.from_string(color)
        style.font.bold = True
        style.paragraph_format.space_before = Pt(before)
        style.paragraph_format.space_after = Pt(after)
        style.paragraph_format.keep_with_next = True

    header = section.header.paragraphs[0]
    header.alignment = WD_ALIGN_PARAGRAPH.LEFT
    set_font(header.add_run('元域智脑｜Semantica 语义层构建指南'), size=8.5, color=MUTED)
    footer = section.footer.paragraphs[0]
    footer.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    page_number(footer)

    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(18)
    p.paragraph_format.space_after = Pt(4)
    set_font(p.add_run('技术实施指南'), size=10, color=BLUE, bold=True)
    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(6)
    set_font(p.add_run('元域智脑 Semantica 语义层构建指南'), size=26, color=NAVY, bold=True)
    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(14)
    set_font(p.add_run('从受控业务事实、跨系统关系到可追溯 Agent 决策的实施路径'), size=13, color=MUTED)
    meta = doc.add_table(rows=3, cols=2)
    meta.style = 'Table Grid'
    for row, pair in zip(meta.rows, [('版本', 'v1.0'), ('日期', '2026-08-25'), ('适用范围', 'OA/BPM、ERP、MES、LIMS、QMS、OMS，以及后续 WMS、SRM、PLM')]):
        row.cells[0].text, row.cells[1].text = pair
    fixed_table(meta, [1800, 7560], header_fill=PALE_GRAY)
    for row in meta.rows:
        shade(row.cells[0], PALE_GRAY)
        for run in row.cells[0].paragraphs[0].runs:
            set_font(run, size=10, color=NAVY, bold=True)
    doc.add_paragraph()
    callout(doc, '本指南的核心原则', '语义层组织的是“已经授权且可追溯的业务事实”，不是把所有系统数据复制进知识库。模型只能使用经权限裁剪的事实生成分析；任何写入仍由工作流、本人确认和 OA 审批控制。', PALE_BLUE)

    add_heading(doc, '1. 语义层的职责和边界')
    add_body(doc, '语义层用于把分散在 OA、ERP、MES、LIMS、QMS、OMS 等系统中的业务事实，组织成对象、关系、时间和来源都清晰的上下文。它服务于影响分析、证据检索和决策溯源，不替代 IAM、Key Center 或业务工作流。')
    add_table(doc, ['能力', '由谁负责', '禁止事项'], [
        ('身份、组织、角色、行列范围', 'IAM / Node API', '不得由 Semantica 或模型自行放宽'),
        ('Connector 短时凭据', 'Key Center', '不得写入图谱、前端或 Prompt'),
        ('事实、关系、影响路径、来源', 'Semantica', '不得把模型推测升级为事实'),
        ('草稿、确认、审批、正式写入', '工作流 / OA / 业务系统', '模型无直接写权限'),
    ], [2300, 2500, 4560])

    add_heading(doc, '2. 现有项目可直接复用的基础')
    add_bullets(doc, [
        '状态化 Mock Connector：OA、ERP、MES、LIMS、QMS、OMS，包含基础事件和可注入运行场景。',
        '统一事件结构：系统、对象类型、事件类型、状态、数据分级、发生时间、业务载荷。',
        'Node 侧语义投影、Agent 证据链、角色和组织范围裁剪。',
        '独立 Python Semantica 服务；本地已用 semantica==0.6.5 的 ContextGraph 进行实际验证。',
        'Mock 验收基线：12 条跨系统事实、33 个节点、71 条关系；质量链和订单链均已通过追踪。',
    ])

    add_heading(doc, '3. 推荐架构和数据流')
    callout(doc, '受控数据流', 'OA / ERP / MES / LIMS / QMS / OMS / WMS → 受控 Connector → 数据分级、脱敏、行列裁剪 → Canonical Fact → Semantica 图谱 → 智脑检索与证据 → 方案/草稿 → 本人确认 → OA 审批/回执。', PALE_BLUE)
    add_body(doc, 'Semantica 应部署在内网服务边界。浏览器不直连图谱；Node API 只向语义服务发送已经验证身份、裁剪范围和通过内容安全检查的事实。图中不保存 Token、密码、原始附件、原始 Prompt 或未经脱敏的敏感字段。')

    add_heading(doc, '4. 统一事实标准：Canonical Fact')
    add_body(doc, '不要把各系统原表直接入图。先将每条来源记录转换为稳定、可审计的 Canonical Fact，再由语义入图 Worker 处理。')
    add_table(doc, ['字段', '要求', '示例'], [
        ('factId', '跨系统唯一', 'erp:SIM-ERP-0010'),
        ('sourceSystem / sourceRecordId', '必须可回链', 'ERP / SIM-ERP-0010'),
        ('objectType / eventType / status', '业务语义稳定', 'Inventory / InventoryAllocated / review_required'),
        ('occurredAt / recordedAt', '分别记录业务与平台时间', 'ISO 8601'),
        ('classification', '数据分级必填', '供应链受限'),
        ('tenantId / organizationId', '强制隔离边界', 'demo-enterprise / org-procurement-dept'),
        ('entities', '经主数据校验的业务标识', 'RMB-CA-20260802、SUP-002'),
        ('payloadVersion / contentHash', '用于映射、版本与幂等', 'erp.inventory.v1 / SHA-256'),
    ], [2100, 3880, 3380])
    callout(doc, '入图门槛', '缺少来源系统、来源记录 ID、时间、数据分级或实体绑定的记录，不进入生产图谱；应进入隔离队列等待字段补齐或映射修复。')

    add_heading(doc, '5. 对象模型和关系模型')
    add_table(doc, ['类别', '首批对象', '关键示例'], [
        ('供应与物料', 'RawMaterial、MaterialLot、Supplier、Inventory、PurchaseOrder', 'RMB-VC-20260801、SUP-002'),
        ('生产与设备', 'ProductionBatch、FinishedGoodsBatch、SKU、Equipment', 'PB-202608-01-A、EQ-004'),
        ('质量', 'Sample、TestResult、QualityEvent、CAPA、ReleaseDecision', 'QE-SIM-9001'),
        ('履约与渠道', 'Order、Fulfillment、Store、CustomerComplaint', 'ORD-202608-00001'),
        ('过程与审计', 'Scenario、Approval、DecisionRecord、EvidenceTrace', 'OA-APP-0006'),
    ], [1900, 4900, 2560])
    add_table(doc, ['关系', '方向', '用途'], [
        ('referenced_by', '实体 → 来源事实', '按业务标识汇集相关证据'),
        ('affects_entity', '来源事实 → 实体', '沿影响方向继续追踪'),
        ('produced_fact', '场景/流程 → 来源事实', '汇集同一流程证据'),
        ('uses_material / produces_product', '批次 ↔ 物料/成品', '构建批次可追溯链'),
        ('blocks_release / requires_approval', '质量或风险 → 成品、订单、OA', '表达约束与人机边界'),
        ('resolved_by', '事件 → CAPA/处置任务', '形成闭环'),
    ], [2300, 2850, 4210])
    callout(doc, '关键经验', 'ContextGraph 的影响遍历有方向。首轮验证中，仅建立“实体 → 事实”会使订单无法继续追到成品批次及 ERP/QMS 约束；补全“事实 → 受影响实体”后，订单履约链才完整。', PALE_GOLD)

    add_heading(doc, '6. Semantica 入图实现模式')
    add_steps(doc, [
        'Connector 以当前身份和数据域读取来源记录，不转发用户原始自然语言。',
        '接入层进行字段映射、类型验证、数据分级、脱敏、注入检测和 Canonical Fact 组装。',
        'Outbox 或消息队列发布事实变更，语义入图 Worker 按 sourceSystem + sourceRecordId + payloadVersion 幂等消费。',
        'Worker 创建/更新事实节点，按 entities 创建或复用实体节点，并维护 referenced_by 与 affects_entity 等关系。',
        'Agent 在每次任务中以当前权限重新检索图谱和 Connector 证据；语义结果不构成写入授权。',
    ])
    add_body(doc, '事实不能被直接覆盖。源系统修订、撤销或删除时，应增加新版本、有效期和失效原因，保留历史路径；冲突事实应标记为待复核，而不是由模型选择一方。')

    add_heading(doc, '7. 分阶段实施路线')
    add_table(doc, ['阶段', '交付重点', '放行条件'], [
        ('第一阶段：Mock 基线', '事实 Schema、实体映射、关系清单、跨系统测试夹具', '业务标识可回链，越权事实不入图'),
        ('第二阶段：只读接入', 'ERP 库存、MES 批次、QMS 事件、OA 审批的实时事实', '去重、版本、断连降级、撤权均通过'),
        ('第三阶段：影响与决策', '路径模板、DecisionRecord、证据引用、人工复核', '关键结论可显示来源、路径、时效和不确定性'),
    ], [1850, 4100, 3410])

    add_heading(doc, '8. 安全、权限和治理要求')
    add_bullets(doc, [
        '权限在入图前和查询前执行；Semantica 只接收已经授权的事实，不把 role 参数当作授权凭据。',
        '按租户和组织隔离图数据；生产环境采用物理隔离或等效的强制过滤与跨租户拒绝测试。',
        '凭据只由 Key Center 签发短时不透明租约；不得进入图谱、日志、模型上下文或客户端。',
        '审计使用只追加存储；每个事实、关系和 DecisionRecord 保存来源、版本、时间、分级和关联 run/trace。',
        '模型生成的建议、摘要和推断始终是决策候选，不能回写为事实节点。',
    ])

    add_heading(doc, '9. 首批验收用例')
    add_table(doc, ['用例', '输入', '应验证的结果'], [
        ('原料质量异常', 'RMB-VC-20260801', 'LIMS、QMS、MES、OA 完整关联；来源和时间可见'),
        ('供应与库存风险', 'RMB-CA-20260802', 'ERP、MES、QMS、OA 完整关联；无自动采购写入'),
        ('订单履约风险', 'ORD-202608-00001', 'OMS、ERP、QMS、OA 完整关联；替代批次约束可见'),
        ('权限隔离', '市场角色查询供应/质量对象', '上游不把 ERP/QMS 受限事实输入图谱'),
        ('冲突处理', '同一实体出现不一致状态', '标记待复核，不自行判定或触发写入'),
    ], [1900, 2450, 5010])

    add_heading(doc, '10. 可立即执行的工作清单')
    add_bullets(doc, [
        '建立 OA、ERP、MES、LIMS、QMS、OMS 的字段字典与 Canonical Fact 映射表。',
        '冻结首批对象、关系、枚举和版本治理规则，并由业务与数据团队评审。',
        '使用现有 Mock 夹具固化 20 至 30 条跨系统回归样本。',
        '先接入 ERP、MES、QMS、OA 的只读测试环境，再接 WMS、SRM、PLM。',
        '建设 Connector → Outbox → Semantica Worker 链路及延迟、死信、冲突、命中率监控。',
        '以角色、组织和字段三级权限完成 UAT；高风险动作仅允许创建草稿并进入 OA 审批。',
    ])
    callout(doc, '结论', '最快的做法不是先堆数据或采购图数据库，而是用项目现有 Mock 先跑通事实标准、实体映射、双向关系、来源链和权限边界。首批真实接入应选择 ERP、MES、QMS、OA 的只读事实，待模型与验收标准稳定后再扩展 WMS、SRM、PLM。', PALE_BLUE)

    doc.core_properties.title = '元域智脑 Semantica 语义层构建指南'
    doc.core_properties.subject = '语义层实施方案与验收指南'
    doc.core_properties.author = '元域智脑项目组'
    doc.save(OUT)
    print(OUT)


if __name__ == '__main__':
    build()
