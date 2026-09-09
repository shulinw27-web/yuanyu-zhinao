from pathlib import Path

from docx import Document
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor


OUT = Path(__file__).resolve().parents[2] / "docs" / "reference" / "exports" / "元域智脑-项目专业术语解释.docx"

# compact_reference_guide token map
INK = "17324D"
BODY = "263238"
MUTED = "5F6B76"
BLUE = "2E74B5"
DARK_BLUE = "1F4D78"
LIGHT_BLUE = "E8EEF5"
LIGHT_GRAY = "F2F4F7"
CALLOUT = "F4F6F9"
CAUTION = "FFF4D6"
GREEN = "E8F3EC"


def rgb(value):
    return RGBColor.from_string(value)


def set_font(run, size=11, color=BODY, bold=False, italic=False):
    run.font.name = "Calibri"
    run._element.rPr.rFonts.set(qn("w:ascii"), "Calibri")
    run._element.rPr.rFonts.set(qn("w:hAnsi"), "Calibri")
    run._element.rPr.rFonts.set(qn("w:eastAsia"), "Microsoft YaHei")
    run.font.size = Pt(size)
    run.font.color.rgb = rgb(color)
    run.bold = bold
    run.italic = italic
    return run


def shade(cell, fill):
    props = cell._tc.get_or_add_tcPr()
    node = props.find(qn("w:shd"))
    if node is None:
        node = OxmlElement("w:shd")
        props.append(node)
    node.set(qn("w:fill"), fill)


def set_cell_margins(cell, top=80, start=120, bottom=80, end=120):
    props = cell._tc.get_or_add_tcPr()
    margins = props.find(qn("w:tcMar"))
    if margins is None:
        margins = OxmlElement("w:tcMar")
        props.append(margins)
    for side, value in (("top", top), ("start", start), ("bottom", bottom), ("end", end)):
        node = margins.find(qn(f"w:{side}"))
        if node is None:
            node = OxmlElement(f"w:{side}")
            margins.append(node)
        node.set(qn("w:w"), str(value))
        node.set(qn("w:type"), "dxa")


def table_geometry(table, widths):
    table.autofit = False
    props = table._tbl.tblPr
    tbl_w = props.find(qn("w:tblW"))
    if tbl_w is None:
        tbl_w = OxmlElement("w:tblW")
        props.append(tbl_w)
    tbl_w.set(qn("w:w"), str(sum(widths)))
    tbl_w.set(qn("w:type"), "dxa")
    indent = props.find(qn("w:tblInd"))
    if indent is None:
        indent = OxmlElement("w:tblInd")
        props.append(indent)
    indent.set(qn("w:w"), "120")
    indent.set(qn("w:type"), "dxa")
    grid = table._tbl.tblGrid
    while len(grid.gridCol_lst) < len(widths):
        grid.append(OxmlElement("w:gridCol"))
    for col, width in zip(grid.gridCol_lst, widths):
        col.set(qn("w:w"), str(width))
    for row in table.rows:
        for cell, width in zip(row.cells, widths):
            cell_props = cell._tc.get_or_add_tcPr()
            cell_w = cell_props.find(qn("w:tcW"))
            if cell_w is None:
                cell_w = OxmlElement("w:tcW")
                cell_props.append(cell_w)
            cell_w.set(qn("w:w"), str(width))
            cell_w.set(qn("w:type"), "dxa")
            set_cell_margins(cell)
            cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER


def header_row(row):
    props = row._tr.get_or_add_trPr()
    node = OxmlElement("w:tblHeader")
    node.set(qn("w:val"), "true")
    props.append(node)


def keep_row(row):
    props = row._tr.get_or_add_trPr()
    node = OxmlElement("w:cantSplit")
    node.set(qn("w:val"), "true")
    props.append(node)


def cell_text(cell, text, size=9.1, bold=False, color=BODY, align=None):
    p = cell.paragraphs[0]
    p.paragraph_format.space_after = Pt(0)
    p.paragraph_format.line_spacing = 1.14
    if align:
        p.alignment = align
    set_font(p.add_run(str(text)), size=size, color=color, bold=bold)


def add_table(doc, headers, rows, widths=(1700, 4520, 3140), size=9.05):
    t = doc.add_table(rows=1, cols=len(headers), style="Table Grid")
    table_geometry(t, list(widths))
    header_row(t.rows[0])
    keep_row(t.rows[0])
    for c, label in zip(t.rows[0].cells, headers):
        shade(c, LIGHT_BLUE)
        cell_text(c, label, size=9.3, bold=True, color=INK)
    for values in rows:
        row = t.add_row()
        keep_row(row)
        for c, value in zip(row.cells, values):
            cell_text(c, value, size=size)
    spacer = doc.add_paragraph()
    spacer.paragraph_format.space_after = Pt(2)
    return t


def callout(doc, title, text, fill=CALLOUT):
    t = doc.add_table(rows=1, cols=1, style="Table Grid")
    table_geometry(t, [9360])
    header_row(t.rows[0])
    keep_row(t.rows[0])
    c = t.cell(0, 0)
    shade(c, fill)
    p = c.paragraphs[0]
    p.paragraph_format.space_after = Pt(2)
    set_font(p.add_run(title), size=10.4, color=DARK_BLUE, bold=True)
    p2 = c.add_paragraph()
    p2.paragraph_format.space_after = Pt(0)
    p2.paragraph_format.line_spacing = 1.18
    set_font(p2.add_run(text), size=9.7)
    doc.add_paragraph().paragraph_format.space_after = Pt(1)


def body(doc, text, label=None):
    p = doc.add_paragraph(style="Normal")
    if label and text.startswith(label):
        set_font(p.add_run(label), color=INK, bold=True)
        set_font(p.add_run(text[len(label):]))
    else:
        set_font(p.add_run(text))
    return p


def bullets(doc, items):
    for text in items:
        p = doc.add_paragraph(style="List Bullet")
        p.paragraph_format.left_indent = Inches(0.375)
        p.paragraph_format.first_line_indent = Inches(-0.188)
        p.paragraph_format.space_after = Pt(4)
        p.paragraph_format.line_spacing = 1.25
        set_font(p.add_run(text))


def heading(doc, text, level=1):
    p = doc.add_heading(text, level=level)
    p.paragraph_format.keep_with_next = True
    return p


def page_number(paragraph):
    set_font(paragraph.add_run("第 "), size=8.5, color=MUTED)
    field = OxmlElement("w:fldSimple")
    field.set(qn("w:instr"), "PAGE")
    paragraph._p.append(field)
    set_font(paragraph.add_run(" 页"), size=8.5, color=MUTED)


doc = Document()
section = doc.sections[0]
section.top_margin = Inches(1)
section.bottom_margin = Inches(1)
section.left_margin = Inches(1)
section.right_margin = Inches(1)
section.header_distance = Inches(0.492)
section.footer_distance = Inches(0.492)

normal = doc.styles["Normal"]
normal.font.name = "Calibri"
normal._element.rPr.rFonts.set(qn("w:eastAsia"), "Microsoft YaHei")
normal.font.size = Pt(11)
normal.font.color.rgb = rgb(BODY)
normal.paragraph_format.space_after = Pt(6)
normal.paragraph_format.line_spacing = 1.25

for name, size, before, after, color in (
    ("Heading 1", 16, 18, 10, BLUE),
    ("Heading 2", 13, 14, 7, BLUE),
    ("Heading 3", 12, 10, 5, DARK_BLUE),
):
    style = doc.styles[name]
    style.font.name = "Calibri"
    style._element.rPr.rFonts.set(qn("w:eastAsia"), "Microsoft YaHei")
    style.font.size = Pt(size)
    style.font.color.rgb = rgb(color)
    style.font.bold = True
    style.paragraph_format.space_before = Pt(before)
    style.paragraph_format.space_after = Pt(after)

for style_name in ("List Bullet", "List Number"):
    style = doc.styles[style_name]
    style.font.name = "Calibri"
    style._element.rPr.rFonts.set(qn("w:eastAsia"), "Microsoft YaHei")
    style.font.size = Pt(11)

footer = section.footer.paragraphs[0]
footer.alignment = WD_ALIGN_PARAGRAPH.RIGHT
page_number(footer)

# Cover
title = doc.add_paragraph()
title.paragraph_format.space_before = Pt(104)
title.paragraph_format.space_after = Pt(8)
set_font(title.add_run("元域智脑"), size=28, color=INK, bold=True)
subtitle = doc.add_paragraph()
subtitle.paragraph_format.space_after = Pt(18)
set_font(subtitle.add_run("项目专业术语解释"), size=18, color=BLUE, bold=True)
intro = doc.add_paragraph()
intro.paragraph_format.space_after = Pt(14)
set_font(intro.add_run("面向项目成员、业务协作方与外部系统对接方的统一术语表。每个词都按本项目的实现边界解释，而非泛泛的行业定义。"), size=11.5)
meta = doc.add_paragraph()
set_font(meta.add_run("依据：当前代码库与架构、权限、语义、密钥、模拟运行时、接口标准等项目文档  |  2026 年 8 月"), size=9.5, color=MUTED)
doc.add_page_break()

heading(doc, "使用说明")
body(doc, "同一个词在不同公司可能含义不同。本术语表优先采用项目中的实际边界；如果某项能力仍处于 Demo 或目标生产状态，会在“项目中的含义”一栏中说明。")
callout(doc, "先分清三类词", "业务词描述企业对象和流程，例如产品、批次、风险；平台词描述元域智脑的组件和运行方式，例如 Agent Run、语义上下文；工程词描述可靠性和交付机制，例如 Outbox、幂等、OpenAPI。", GREEN)
bullets(doc, [
    "“Demo”表示当前仓库可用于演示或本地验证，不等同于已经具备生产级高可用、安全和合规能力。",
    "“生产目标”表示架构已明确，但仍需在真实环境中接入企业身份、真实连接器、持久化基础设施或安全服务。",
    "术语中的英文缩写首次出现时给出中文含义；附录收录常用缩写速查。",
])

heading(doc, "一、平台与架构")
add_table(doc, ["术语", "解释", "项目中的含义"], [
    ("元域智脑", "项目对受控企业 AI 能力层的产品名称。", "把移动端、桌面工作台、治理 Web、Agent、权限、证据、连接器和审计串成一个可治理的平台。它不是单一聊天机器人。"),
    ("控制面", "定义身份、权限、策略、模型、密钥和工作流规则的管理层。", "账号与权限中心、智脑授权、Key Center 和治理页面均属于控制面。它决定谁可以做什么，而不保存业务事实本身。"),
    ("业务数据面", "承载业务事实、外部系统访问和业务处理的数据与服务层。", "OA、ERP、MES、LIMS、QMS 等源系统及其受控连接器属于这一侧；客户端不能绕过控制面直接访问。"),
    ("Agent 运行时", "接收用户请求，完成授权、证据检索、计划生成、确认与工具编排的服务端逻辑。", "位于 Node API 内。它可以给建议或生成受控计划，但模型输出不能直接变成业务写入。"),
    ("Agent Workbench", "多端共用的智脑交互工作台。", "承载登录、对话、告警、材料上传、确认卡、待办和回执，减少移动端、桌面端之间的功能偏差。"),
    ("Agent SDK", "面向客户端的共享访问封装。", "统一维护身份会话、稳定设备标识和 API 调用上下文；它不是服务端权限判断的替代品。"),
    ("模型网关", "把不同模型提供方接入到同一安全与调用边界的服务。", "可路由 Mock、内网或外部模型，并对输入、输出、超时和降级结果执行统一控制。"),
    ("受控 MCP 连接器", "以策略、凭据和审计约束访问企业系统的连接器。MCP 指 Model Context Protocol。", "连接 OA、ERP、MES、LIMS、QMS 等系统时，通过连接器访问。终端和模型不直接持有外部系统凭据。"),
], size=8.9)

heading(doc, "二、业务语义与数据")
add_table(doc, ["术语", "解释", "项目中的含义"], [
    ("核心元对象", "贯穿多个业务域的统一业务锚点。", "当前定义人员、原材料、产品、设备、门店五类对象。门店使用稳定 store_id 并关联组织与营业状态；业务流程缺少必要对象时只能保存草稿，不能发起执行或写入。"),
    ("元模型", "对业务对象、字段、关系、来源、规则和约束的结构化描述。", "用于让业务对象和规则可配置、可校验、可发布；不是把原始业务数据再复制一份。"),
    ("OA 元模型", "针对组织、人员、岗位、角色、审批流、待办与审计的元模型。", "承担“人员”对象的身份和审批语义，是其他业务流程关联人员、角色和审批的基础。"),
    ("世界模型", "描述对象、关系、来源系统和数据分级的业务知识结构。", "以草稿、校验、发布方式治理；用于明确哪些事实可以关联、如何参与上下文与影响分析。"),
    ("语义上下文", "带对象关系、来源、时间和分类信息的可引用事实集合。", "智脑只能读取已授权、已裁剪的语义上下文，用于解释和计划；它本身不判定用户权限。"),
    ("Semantica", "项目语义上下文微服务的目标适配技术。", "Python 服务优先使用 `semantica.context.ContextGraph`；依赖不可用时可回退为本地投影，回退模式仅用于 Demo。"),
    ("证据", "支撑智脑结论的来源化业务事实，而不是模型的主观推断。", "每条证据应有来源系统、业务记录 ID、版本、采集时间、组织范围、内容摘要和数据分级。"),
    ("数据分级", "按敏感性、使用边界或保护要求给数据加的标签。", "事实进入语义服务前需要完成授权和脱敏；分级信息也应随证据保留，帮助限制后续展示和调用。"),
    ("有效时间 / 记录时间", "有效时间是事实在业务上生效的时间；记录时间是系统记录或入库的时间。", "两类时间同时保存，才能判断“当时是否有效”与“系统何时得知”，避免只按更新时间推断业务状态。"),
], size=8.85)

heading(doc, "三、身份、权限与数据边界")
add_table(doc, ["术语", "解释", "项目中的含义"], [
    ("IAM", "Identity and Access Management，身份与访问管理。", "管理组织、人员、角色、页面权限、按钮权限和组织数据范围。当前 Demo 可运行，生产需替换为企业 IdP 与持久化策略服务。"),
    ("身份会话", "用户认证后由服务端签发的会话凭证与上下文。", "会话包含人员、有效角色、设备绑定和策略版本快照；人员、角色或策略变化后，旧会话在下一次校验时失效。"),
    ("Tenant（租户）", "系统内用于隔离企业或业务空间的边界标识。", "Agent Run、证据追踪、事件等至少按租户隔离，防止跨企业访问。"),
    ("Subject（主体）", "实际发起请求、拥有任务或被授权访问资源的具体身份。", "同一角色不代表同一主体。任务读取按 `tenant + subject` 收敛，不能因为角色相同就查看他人的 Run。"),
    ("RBAC", "Role-Based Access Control，基于角色的访问控制。", "页面、菜单和按钮权限由角色获得，例如是否可以看风险详情、发起审批或管理策略。"),
    ("组织数据范围", "角色在组织层面可读取和操作的数据边界。", "支持 SELF、CURRENT_ORG、ORG_AND_DESCENDANTS、SELECTED_ORGS、ALL；服务端会把请求条件与实际允许组织求交。"),
    ("联合授权", "多个权限条件同时成立才获得有效能力的计算方式。", "有效能力为用户身份权限、智脑服务主体权限、设备会话策略、数据域与工作流策略的交集。"),
    ("最小权限", "只授予完成当前任务所需的最小范围、最短时间能力。", "适用于数据查询、工作流工具、连接器凭据和服务身份；不因“管理员”身份自动放宽所有边界。"),
    ("Fail-closed", "无法确认授权时默认拒绝，而不是放行。", "未知主体、会话失效、角色撤销和权限类 401/403 都会清理不再可信的前端数据，并停止原操作。"),
    ("权限代际", "用于标识当前权限版本的一次读取快照。", "异步请求回来的旧数据如果所属权限代际已过期，前端会丢弃，避免撤权后旧数据重新显示。"),
], size=8.8)

heading(doc, "四、Agent 任务与受控执行")
add_table(doc, ["术语", "解释", "项目中的含义"], [
    ("Agent Run", "一次智脑任务的服务端运行记录。", "记录请求、计划、证据、状态和可能的确认动作；查询以 `tenant + subject` 为边界，不能把它理解为普通聊天消息。"),
    ("技能（Skill）", "Agent 可以按业务意图调用的专业能力单元。", "例如生产、市场、内务相关能力。技能决定如何组织工具和规则，不自动携带企业系统权限。"),
    ("工具（Tool）", "可被 Agent 在服务端调用的具体能力。", "只读工具可检索受控数据；写入工具还需要工作流、业务门禁、核心对象校验和短时凭据租约。"),
    ("计划（Plan）", "根据受控证据和规则形成的建议步骤。", "计划帮助用户理解下一步；它不等同于已执行，也不表示外部系统已被修改。"),
    ("Proposed Command", "服务端为可写候选动作保存的原始命令。", "仅在同一有效角色同时拥有 prompt 与 execute 权限，并通过数据域、工作流和业务校验后才产生。"),
    ("确认卡", "向用户展示待执行动作、范围和确认入口的客户端交互组件。", "用于高风险动作的人机确认。确认卡不能替代服务端校验，提交后仍要验证原命令、角色、会话、设备和有效期。"),
    ("Confirmation Token", "一次性确认凭据。", "默认短时有效，Run 中只保存其哈希；它必须与原 run、命令、会话和设备匹配，消费后不可再次使用。"),
    ("审批工作项", "进入正式业务审批路由的待办或草稿。", "确认通过后先创建受控草稿或工作项；写外部系统前仍需按流程审批，不由模型直接提交。"),
    ("执行回执", "服务端工具链返回的、可证明业务动作结果的结构化记录。", "只有具备执行回执时，界面才可显示“已执行”。模型自行声称完成任务会被安全层替换为确定性结果。"),
    ("确定性降级", "模型或安全条件不满足时，用规则化结果替代不可靠输出。", "例如模型不可用、输出不符合 `agent-summary.v1`、发现风险上下文或权限不足时，系统只给只读建议或拒绝原因。"),
    ("Agent Memory", "跨任务复用的记忆或偏好信息。", "当前默认不自动写入；高风险输入、隔离证据和不安全模型输出不得进入可复用记忆。"),
], size=8.65)

heading(doc, "五、提示词安全、密钥与审计")
add_table(doc, ["术语", "解释", "项目中的含义"], [
    ("提示词注入", "用看似正常的输入诱导模型忽略既定规则、泄露信息或执行未授权动作的攻击。", "项目同时防护用户输入中的直接注入，以及知识库、附件、系统证据中的间接注入。"),
    ("直接注入", "攻击指令直接出现在用户提交的文字或文件名等输入中。", "会经过 Unicode 归一化、零宽字符清理、编码载荷识别与规则检测；高风险输入不会进入检索、模型、工具或记忆。"),
    ("间接注入", "攻击指令藏在外部系统记录、知识、附件或检索结果中。", "每条外部证据会单独扫描；发现风险后移出本次上下文、记录隔离元数据，并取消可写命令生成。"),
    ("多模态材料", "用户上传的图片、PDF 等非纯文本材料。", "当前会检查数量、大小、MIME、魔数、文件名和可打印字节片段；内容扫描状态仍可能是 `unscanned`，不能当作病毒扫描或 OCR 完成。"),
    ("Key Center", "负责连接器与模型凭据策略、租约、轮换、吊销和审计的控制面服务。", "业务、浏览器和模型只拿到受控能力或句柄；生产应通过服务身份与 mTLS 调用独立 Key Center。"),
    ("Lease（租约）", "绑定用途和有效期的短时、不透明凭据授权。", "绑定服务主体、角色、连接器、操作、任务和 TTL。写入类租约只在审批门禁通过后签发。"),
    ("Vault / KMS / HSM", "保存和使用密钥材料的安全基础设施。", "Vault 是密钥管理服务，KMS 是密钥管理系统，HSM 是硬件安全模块。真实密钥应停留在这些边界内。"),
    ("密钥轮换 / 吊销", "更新凭据或提前停止已有凭据授权的操作。", "轮换和吊销均应记录审计事件；它们不是在代码仓库或浏览器中替换明文密码。"),
    ("Evidence Trace", "对一次 Agent 任务的证据、判断、工具和执行过程进行结构化追踪。", "记录谁在何种身份、会话、设备下读取了哪些证据并产生何种结果；不记录模型内部思维链，也会剔除 Token 和密钥。"),
    ("哈希链", "每条审计事件都包含前一条事件哈希的完整性校验结构。", "当前用于检测普通篡改和顺序变化；生产级不可篡改仍需 WORM/Object Lock、KMS/HSM 签名、可信时间戳和归档策略。"),
], size=8.72)

heading(doc, "六、系统集成、模拟运行与可靠性")
add_table(doc, ["术语", "解释", "项目中的含义"], [
    ("状态化 Mock Connector", "使用可变运行时状态模拟外部系统的连接器。", "在未连真实企业系统时演练查询、事件、审批和受控写回；基础种子数据与运行时事件分离，可重置。"),
    ("场景注入", "人为生成特定业务异常或系统故障，以验证流程。", "可注入原料质量、设备异常、库存风险、订单履约风险，以及连接器不可用、数据延迟、主数据冲突等情况。"),
    ("连接器健康状态", "描述外部系统连接器当前是否可安全、及时地提供数据。", "`healthy` 正常；`unavailable` 接口不可用；`delayed` 数据时效存在风险；`degraded` 发生主数据冲突等降级。"),
    ("受控模拟写回", "在模拟运行时对 Mock 数据库执行的业务状态变更。", "只影响本地 Mock SQLite，不调用企业生产系统；用于检验审批、审计和回执链路。"),
    ("领域事件", "业务上已经发生、可被其他模块消费的事实。", "如风险已确认、采购申请已发起、权限策略已发布。事件本身不携带凭据、Prompt、附件或大对象快照。"),
    ("Outbox", "与业务数据在同一事务写入的事件出口表或队列。", "避免“业务写成功但事件没发出”。项目区分跨领域事实事件 Outbox 与通知/电话的送达任务队列。"),
    ("事件信封", "所有领域事件共用的外层元数据结构。", "通常包含 eventId、type、version、tenantId、organizationId、aggregate、时间、关联 ID 和 payload。`type + version` 是稳定契约。"),
    ("Correlation ID / Causation ID", "关联 ID 用于追踪同一业务链路；因果 ID 表示本事件由哪个上游事件触发。", "用于串起请求、审批、工具回执和异步事件，帮助排错，不应被用来扩大权限。"),
    ("幂等", "同一操作被重复提交或重复消费时，结果仍保持一次有效。", "写 API 使用 Idempotency-Key；事件消费者按 eventId 去重。幂等不能替代 Agent 确认凭据的会话和命令绑定。"),
    ("Claim Lease", "Worker 在处理 Outbox 事件前取得的短时处理认领。", "避免多个消费者同时处理同一事件；认领过期后可以重试，但消费者仍要自己保证幂等。"),
    ("Dead Letter", "多次处理失败后暂存的事件。", "达到重试上限的事件进入死信状态，需通过受控管理操作检查和重放，不能悄悄丢弃。"),
], size=8.62)

heading(doc, "七、接口、交付与告警")
add_table(doc, ["术语", "解释", "项目中的含义"], [
    ("API 契约", "调用方与服务端共同遵守的请求、响应、权限、错误码和版本约定。", "项目将 OpenAPI、共享错误码、Schema 和事件定义作为契约单一事实源，避免前后端各自猜字段。"),
    ("OpenAPI", "用于描述 HTTP API 路径、参数、响应和 Schema 的标准。", "`packages/api-contracts` 中维护接口规范；CI 目标是检查接口文档、SDK 和路由实现的一致性。"),
    ("expectedVersion", "客户端提交更新时所声明的对象版本号。", "用于乐观并发控制：若服务端当前版本已变化，返回 `409 VERSION_CONFLICT`，要求先刷新再保存。"),
    ("乐观并发控制", "默认允许并行编辑，提交时再检查版本是否冲突的机制。", "用于人员、角色策略、告警配置等可编辑内容，防止后提交的人无意覆盖先提交的修改。"),
    ("Idempotency-Key", "标识一次写操作的唯一键。", "服务端按租户、主体和操作去重，降低网络重试造成重复业务动作的风险。"),
    ("Request ID", "一次 HTTP 请求的唯一追踪编号。", "在成功或错误响应中返回，便于把客户端问题、服务端日志和异步事件串联起来。"),
    ("限流（Rate Limit）", "限制某类来源在一段时间内可提交的请求数量。", "Node API 会按来源 IP 等规则限制请求。命中时通常返回 429，调用方应退避，不应无限重试。"),
    ("RiskCase", "可被查询、确认、批准或处置的风险业务对象。", "告警领域只负责分级、通知、升级和送达；是否改变风险或业务状态仍由风险与工作流门禁决定。"),
    ("P0 / P1 / P2", "告警严重度分级。", "P0 紧急，默认 5 分钟确认并可立即模拟外呼；P1 中等；P2 低风险。等级由确定性规则和策略决定，不由大模型直接修改。"),
    ("值班与升级", "当告警未确认或未解决时，按预设顺序触达下一接收人的机制。", "当前可演示值班表、备班与升级路由；生产需接入真实企业通讯录、调度和通知供应商。"),
    ("虚拟电话回执", "电话接通或按键确认所产生的送达证明。", "它只表示接收方已收到通知，不能批准采购、放行、冻结或其他业务写操作。"),
], size=8.62)

heading(doc, "附录：常用缩写速查")
add_table(doc, ["缩写", "中文 / 英文全称", "在项目中的常见位置"], [
    ("OA / BPM", "办公自动化 / Business Process Management", "组织、人员、审批流、待办和身份源。"),
    ("ERP", "Enterprise Resource Planning，企业资源计划", "采购、库存、批次、供应链等业务事实来源。"),
    ("MES", "Manufacturing Execution System，制造执行系统", "工单、工序、批次、产量、设备和生产状态。"),
    ("LIMS", "Laboratory Information Management System，实验室信息管理系统", "检验、原料质量、OOS 等实验室质量信息。"),
    ("QMS", "Quality Management System，质量管理系统", "偏差、CAPA、放行、质量调查和处置。"),
    ("OMS / WMS / SRM", "订单管理 / 仓储管理 / 供应商关系管理", "订单履约、库存、供应商与原材料质量相关数据。"),
    ("PLM / EAM / IoT", "产品生命周期 / 企业资产管理 / 物联网", "产品、设备维护校准、设备状态与传感数据。"),
    ("OIDC / OAuth 2.1", "OpenID Connect / 授权框架", "生产身份认证和授权接入的目标方案。"),
    ("mTLS", "Mutual TLS，双向 TLS", "服务到服务调用、Key Center 与语义服务的生产网络认证。"),
    ("DLP", "Data Loss Prevention，数据防泄漏", "附件、敏感数据和外部内容进入模型前的生产安全能力。"),
    ("CI/CD", "持续集成 / 持续交付或部署", "构建、测试、扫描、部署和回滚的自动化交付流水线。"),
    ("WORM", "Write Once Read Many，一次写入、多次读取", "用于生产审计的防篡改保留和长期归档。"),
], size=8.85)
callout(doc, "维护建议", "新增模块、接口、连接器或安全控制时，应同步补充或修订本术语表。对于同名但含义不同的企业系统、角色或审批状态，以项目 API 契约、元模型发布版本和实际系统交接材料为准。", CAUTION)

doc.core_properties.title = "元域智脑项目专业术语解释"
doc.core_properties.subject = "项目架构、业务语义、权限安全、集成与工程术语表"
doc.core_properties.author = ""
doc.save(OUT)
print(OUT)
