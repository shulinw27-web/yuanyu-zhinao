from pathlib import Path

from docx import Document
from docx.enum.style import WD_STYLE_TYPE
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor


OUT = Path(__file__).resolve().parents[2] / "docs" / "reference" / "exports" / "元域智脑AI基座-生产开发准备指南-v1.3.docx"

# compact_reference_guide tokens
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


def color(hex_value):
    return RGBColor.from_string(hex_value)


def font(run, size=11, color_value=BODY, bold=False, italic=False):
    run.font.name = "Calibri"
    run._element.rPr.rFonts.set(qn("w:ascii"), "Calibri")
    run._element.rPr.rFonts.set(qn("w:hAnsi"), "Calibri")
    run._element.rPr.rFonts.set(qn("w:eastAsia"), "Microsoft YaHei")
    run.font.size = Pt(size)
    run.font.color.rgb = color(color_value)
    run.bold = bold
    run.italic = italic
    return run


def shade(cell, fill):
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = tc_pr.find(qn("w:shd"))
    if shd is None:
        shd = OxmlElement("w:shd")
        tc_pr.append(shd)
    shd.set(qn("w:fill"), fill)


def set_cell_margins(cell, top=80, start=120, bottom=80, end=120):
    tc_pr = cell._tc.get_or_add_tcPr()
    margins = tc_pr.find(qn("w:tcMar"))
    if margins is None:
        margins = OxmlElement("w:tcMar")
        tc_pr.append(margins)
    for side, value in (("top", top), ("start", start), ("bottom", bottom), ("end", end)):
        node = margins.find(qn(f"w:{side}"))
        if node is None:
            node = OxmlElement(f"w:{side}")
            margins.append(node)
        node.set(qn("w:w"), str(value))
        node.set(qn("w:type"), "dxa")


def set_table_geometry(table, widths):
    table.autofit = False
    tbl_pr = table._tbl.tblPr
    tbl_w = tbl_pr.find(qn("w:tblW"))
    if tbl_w is None:
        tbl_w = OxmlElement("w:tblW")
        tbl_pr.append(tbl_w)
    tbl_w.set(qn("w:w"), str(sum(widths)))
    tbl_w.set(qn("w:type"), "dxa")
    tbl_ind = tbl_pr.find(qn("w:tblInd"))
    if tbl_ind is None:
        tbl_ind = OxmlElement("w:tblInd")
        tbl_pr.append(tbl_ind)
    tbl_ind.set(qn("w:w"), "120")
    tbl_ind.set(qn("w:type"), "dxa")
    grid = table._tbl.tblGrid
    while len(grid.gridCol_lst) < len(widths):
        grid.append(OxmlElement("w:gridCol"))
    for grid_col, width in zip(grid.gridCol_lst, widths):
        grid_col.set(qn("w:w"), str(width))
    for row in table.rows:
        for cell, width in zip(row.cells, widths):
            tc_pr = cell._tc.get_or_add_tcPr()
            tc_w = tc_pr.find(qn("w:tcW"))
            if tc_w is None:
                tc_w = OxmlElement("w:tcW")
                tc_pr.append(tc_w)
            tc_w.set(qn("w:w"), str(width))
            tc_w.set(qn("w:type"), "dxa")
            set_cell_margins(cell)
            cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER


def header_row(row):
    tr_pr = row._tr.get_or_add_trPr()
    node = OxmlElement("w:tblHeader")
    node.set(qn("w:val"), "true")
    tr_pr.append(node)


def no_split(row):
    tr_pr = row._tr.get_or_add_trPr()
    node = OxmlElement("w:cantSplit")
    node.set(qn("w:val"), "true")
    tr_pr.append(node)


def cell_text(cell, text, size=9.5, bold=False, color_value=BODY, align=None):
    p = cell.paragraphs[0]
    p.paragraph_format.space_after = Pt(0)
    p.paragraph_format.line_spacing = 1.15
    if align is not None:
        p.alignment = align
    font(p.add_run(str(text)), size=size, color_value=color_value, bold=bold)


def table(doc, headers, rows, widths, size=9.4):
    t = doc.add_table(rows=1, cols=len(headers), style="Table Grid")
    set_table_geometry(t, widths)
    header_row(t.rows[0])
    no_split(t.rows[0])
    for c, value in zip(t.rows[0].cells, headers):
        shade(c, LIGHT_BLUE)
        cell_text(c, value, size=9.4, bold=True, color_value=INK)
    for values in rows:
        row = t.add_row()
        no_split(row)
        for c, value in zip(row.cells, values):
            cell_text(c, value, size=size)
    spacer = doc.add_paragraph()
    spacer.paragraph_format.space_after = Pt(2)
    return t


def callout(doc, title, text, fill=CALLOUT):
    t = doc.add_table(rows=1, cols=1, style="Table Grid")
    set_table_geometry(t, [9360])
    header_row(t.rows[0])
    no_split(t.rows[0])
    c = t.cell(0, 0)
    shade(c, fill)
    p = c.paragraphs[0]
    p.paragraph_format.space_after = Pt(2)
    font(p.add_run(title), size=10.6, color_value=DARK_BLUE, bold=True)
    p2 = c.add_paragraph()
    p2.paragraph_format.space_after = Pt(0)
    p2.paragraph_format.line_spacing = 1.18
    font(p2.add_run(text), size=9.8)
    doc.add_paragraph().paragraph_format.space_after = Pt(1)


def body(doc, text, bold_label=None):
    p = doc.add_paragraph(style="Normal")
    if bold_label and text.startswith(bold_label):
        font(p.add_run(bold_label), bold=True, color_value=INK)
        font(p.add_run(text[len(bold_label):]))
    else:
        font(p.add_run(text))
    return p


def bullets(doc, items):
    for item in items:
        p = doc.add_paragraph(style="List Bullet")
        p.paragraph_format.left_indent = Inches(0.375)
        p.paragraph_format.first_line_indent = Inches(-0.188)
        p.paragraph_format.space_after = Pt(4)
        p.paragraph_format.line_spacing = 1.25
        font(p.add_run(item))


def steps(doc, items):
    for item in items:
        p = doc.add_paragraph(style="List Number")
        p.paragraph_format.left_indent = Inches(0.375)
        p.paragraph_format.first_line_indent = Inches(-0.188)
        p.paragraph_format.space_after = Pt(4)
        p.paragraph_format.line_spacing = 1.25
        font(p.add_run(item))


def heading(doc, text, level=1):
    p = doc.add_heading(text, level=level)
    p.paragraph_format.keep_with_next = True
    return p


def page_number(paragraph):
    font(paragraph.add_run("第 "), size=8.5, color_value=MUTED)
    field = OxmlElement("w:fldSimple")
    field.set(qn("w:instr"), "PAGE")
    paragraph._p.append(field)
    font(paragraph.add_run(" 页"), size=8.5, color_value=MUTED)


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
normal.font.color.rgb = color(BODY)
normal.paragraph_format.space_after = Pt(6)
normal.paragraph_format.line_spacing = 1.25

for name, size, before, after, shade_color in (
    ("Heading 1", 16, 18, 10, BLUE),
    ("Heading 2", 13, 14, 7, BLUE),
    ("Heading 3", 12, 10, 5, DARK_BLUE),
):
    style = doc.styles[name]
    style.font.name = "Calibri"
    style._element.rPr.rFonts.set(qn("w:eastAsia"), "Microsoft YaHei")
    style.font.size = Pt(size)
    style.font.color.rgb = color(shade_color)
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
title.alignment = WD_ALIGN_PARAGRAPH.LEFT
font(title.add_run("元域智脑"), size=28, color_value=INK, bold=True)
subtitle = doc.add_paragraph()
subtitle.paragraph_format.space_after = Pt(18)
font(subtitle.add_run("生产开发开工准备清单"), size=18, color_value=BLUE, bold=True)
intro = doc.add_paragraph()
intro.paragraph_format.space_after = Pt(14)
font(intro.add_run("这份文档不分配人、不排汇报动作，只回答一件事：真实开发要开始前，项目组手里必须具备什么。"), size=11.5, color_value=BODY)
meta = doc.add_paragraph()
font(meta.add_run("适用范围：数据通道、连接层、外部系统联调与生产发布前的基础准备  |  更新：2026 年 8 月"), size=9.5, color_value=MUTED)
doc.add_page_break()

heading(doc, "先说结论：开工前卡住的通常不是代码")
body(doc, "真正拖慢项目的，往往是接口地址拿到了，但字段含义没人说得清；测试账号开了，但网络没放行；样本数据有了，却无法判断结果对不对。下面的内容按实际开工顺序整理，拿齐后再写连接器，返工会少很多。")
callout(doc, "本项目当前的起点", "仓库已经具备 Vue 3 / Vite 前端、Node.js 服务、Tauri 桌面端和 Python 语义服务等基础代码。生产所需的环境、统一身份、部署流水线、监控、数据库与消息能力仍需要单独准备和落地。", GREEN)
heading(doc, "开工前至少要具备的四件事", 2)
table(doc, ["准备项", "拿到什么才算够用"], [
    ("对接边界", "确认首批接入的系统、读哪些数据、更新频率、是否只读，以及哪些数据不能进入平台。"),
    ("可调用的接口", "有稳定的地址、认证方式、可用账号、网络路径和真实或脱敏的返回样本。"),
    ("可验证的数据", "每个关键字段知道来源、含义、枚举值和正确结果的判断方式。"),
    ("可协作的工作区", "代码、接口文档、需求、问题记录和环境配置有固定位置，成员能看到同一份最新内容。"),
], [2150, 7210], size=10)

heading(doc, "一、外部系统对接：先把“交接包”拿全")
body(doc, "每接一个系统，都建议让对方提供一份完整交接包。不要只收一份 API 文档；真正联调时，接口说明、样例、网络策略和数据口径缺一项都会卡住。")
heading(doc, "1. 一套系统对接包应该包含什么", 2)
table(doc, ["类别", "需要的材料", "为什么需要"], [
    ("业务范围", "要取的业务对象、使用场景、数据更新时间、历史范围、是否允许回写。", "防止接入后发现取错表、取错时间口径或越权使用。"),
    ("接口说明", "接口地址、请求方式、参数、分页、限流、异常码、版本策略、鉴权方式。", "连接层需要据此实现稳定的调用和重试。"),
    ("字段与码表", "字段名、中文含义、类型、单位、必填、枚举码、主键、关联关系和脱敏规则。", "这是后续映射、检索和对账的依据。"),
    ("真实样本", "成功、空数据、异常、分页、权限不足等完整请求与返回样例。", "文档常常不完整，样本才能暴露真实差异。"),
    ("账号与网络", "测试账号、生产申请路径、IP 白名单、VPN / 专线、证书、代理限制。", "接口能不能通，最终取决于这部分。"),
    ("联调规则", "可联调时间、变更通知方式、问题反馈渠道、数据校验人和验收口径。", "避免接口一变、字段一改，项目组最后才知道。"),
], [1450, 4720, 3190], size=9.1)

heading(doc, "2. 建议的资料目录", 2)
body(doc, "把每个系统的材料放在同一套目录里，后面新增系统时不需要重新发明管理方式。目录可以直接建在项目知识库或受控文件库中：")
bullets(doc, [
    "01-业务范围与数据清单：首批要用的数据对象、数据时效和不可使用的数据。",
    "02-接口与认证：接口文档、调用示例、授权说明、证书和环境地址。",
    "03-数据字典：字段、码表、单位、主键、关联关系、数据质量说明。",
    "04-联调样本：正常、边界、失败、分页和大数据量样例。",
    "05-变更记录：接口版本、字段调整、停机窗口和已知问题。",
])
callout(doc, "一个很实用的原则", "接口文档和样例返回不一致时，以可复现的样例为准，同时把差异写进变更记录。不要在代码里偷偷兼容，过两周没人会记得当初为什么这样处理。", CAUTION)

heading(doc, "3. OA、MES / WME、QMS / QME 的重点", 2)
table(doc, ["系统", "首批优先确认的内容"], [
    ("OA", "组织、人员、部门、角色、流程单据和附件是否需要接入；组织调整后如何同步；离职和权限变更多久生效。"),
    ("MES / WME", "工厂、产线、工单、批次、设备、工序、产量、报工和状态的唯一标识；生产数据是准实时、按班次还是日结。"),
    ("QMS / QME", "检验批、指标、判定、异常、处置、报告及其与工单 / 批次的关联；质量数据的修订、撤销和最终版本规则。"),
], [1750, 7610], size=9.5)
body(doc, "如果 WME、QME 是现网系统名称或内部简称，接口文档里应写清系统全称、版本和边界，避免后续把同名或相似模块当成同一个系统。")

heading(doc, "二、连接层真正需要准备的东西")
body(doc, "连接层的职责是把外部系统变成稳定、可追溯、可治理的数据来源。前端、Agent 和语义服务不应直接连 OA、MES 或 QMS；所有访问都经过连接层和统一的权限、日志、限流控制。")
table(doc, ["能力", "开工前需要确认或建好"], [
    ("调用适配", "每个系统的认证方式、超时、重试、限流、断路和分页处理规则。"),
    ("数据映射", "源字段到统一业务对象的映射表；单位、时区、枚举码和空值的处理规则。"),
    ("同步方式", "首批全量怎么导入，后续是轮询、事件订阅还是文件交换；失败如何补偿。"),
    ("可追溯", "每条同步数据能查到来源系统、来源主键、拉取时间、版本和处理结果。"),
    ("安全控制", "凭证不写入代码；接口访问、敏感字段读取和失败日志均可审计。"),
], [1750, 7610], size=9.5)
callout(doc, "建议先做小闭环", "先选一个业务对象，例如“工单”或“检验批”，完成拉取、映射、存储、查询、对账和异常补数。这个闭环跑稳后，再复制到其他对象和其他系统。", GREEN)

heading(doc, "三、本地开发环境：每位开发人员都要能独立跑起来")
body(doc, "项目当前是多技术栈组合。本地环境不要靠口口相传，应该有一份可重复执行的安装说明和一条能验证环境的命令。版本号暂未在仓库中锁定，启动开发前应补齐版本文件和安装说明。")
table(doc, ["工具或运行时", "用途", "开工前的检查"], [
    ("Git", "代码获取、分支和合并。", "能访问代码仓库；已配置 SSH 或令牌；提交签名规则已明确。"),
    ("Node.js + npm", "Vue / Vite 前端及 Node.js 服务。", "使用项目指定版本；执行 npm ci 后可完成 desktop、mobile 与 service 的构建。"),
    ("Python", "语义服务及相关脚本。", "按 requirements 安装后能启动语义服务，并通过基础健康检查。"),
    ("Rust + Tauri", "桌面端调试和打包。", "Rust stable 与平台构建工具可用；能跑通本地桌面端调试。"),
    ("IDE", "日常开发和调试。", "建议统一 VS Code 配置、格式化器、Lint、调试任务和推荐插件。"),
    ("API / 数据库工具", "调接口、看日志、查数据。", "至少准备一种 API 客户端和一种数据库客户端；连接信息不写在共享文件里。"),
    ("容器工具", "本地依赖与集成环境。", "若采用容器化，Docker Desktop / Podman 与项目镜像仓库访问均已验证。"),
], [1750, 3250, 4360], size=8.9)
heading(doc, "推荐先跑的验证动作", 2)
steps(doc, [
    "拉取代码并执行 npm ci；确认依赖安装没有通过本机缓存“蒙混过关”。",
    "分别执行前端和服务端的构建命令；把常见报错和处理方式写进 README。",
    "启动 Python 语义服务，确认依赖、端口和健康检查正常。",
    "启动 Tauri 桌面端，确认开发机具备原生构建条件。",
    "使用测试账号调用一条经过连接层的外部系统接口，确认网络、认证和日志链路完整。",
])

heading(doc, "四、团队协作工具：东西要放在固定位置")
body(doc, "协作工具不用追求多，关键是每类信息有唯一入口。代码改动、接口变更和数据口径不能散在聊天记录里。")
table(doc, ["工作内容", "建议准备的工具与使用方式"], [
    ("代码与制品", "GitHub / GitLab 等代码仓库；依赖镜像、构建产物和容器镜像使用受控制品库。"),
    ("需求与问题", "Jira、禅道、GitHub Issues 等任选其一；需求、缺陷、接口问题都用编号记录，不在聊天里“口头关闭”。"),
    ("接口协作", "Apifox、Postman 或 OpenAPI 文档库；请求样例、环境变量和 Mock 数据有统一版本。"),
    ("知识库", "Confluence、Notion、SharePoint 或企业文档库；对接材料、数据字典、会议结论和变更记录集中保存。"),
    ("沟通与告警", "Teams、Slack、企业微信或钉钉；建立项目群、接口联调群和生产告警群，群公告写明入口链接。"),
    ("架构与流程图", "Figma、Draw.io 或 Mermaid；架构图、字段映射和流程图跟随版本更新。"),
], [1750, 7610], size=9.2)
callout(doc, "最少要建好的四个空间", "代码仓库、接口资料库、需求 / 缺陷看板、环境与发布记录。只要这四处保持一致，项目大部分协作摩擦都会明显下降。")

heading(doc, "五、环境、账号和网络：让“能调通”变成常态")
body(doc, "本地跑通之后，真正的联调还依赖环境和权限。环境至少区分开发、集成测试、用户验收和生产；配置与数据范围不应混用。")
table(doc, ["准备项", "要具备的内容"], [
    ("环境划分", "DEV、SIT、UAT、PRE（如需要）和 PROD 的地址、用途、数据范围、变更窗口。"),
    ("账号权限", "开发、联调、只读查询、发布和运维账号分开；生产账号通过正式流程申请和回收。"),
    ("网络路径", "DNS、域名、IP 白名单、VPN / 专线、代理、端口和证书链均有记录并已验证。"),
    ("密钥与证书", "API Key、OAuth Client、数据库密码、证书统一存放在密钥管理工具；代码库只保留变量名。"),
    ("公共依赖", "数据库、对象存储、消息队列、缓存、日志和监控的选型、地址、备份与容量边界。"),
    ("发布能力", "从构建、扫描、部署到回滚的最小流水线；当前仓库尚未提供 CI/CD、容器编排或基础设施代码，需要补齐。"),
], [1750, 7610], size=9.2)

heading(doc, "六、测试数据与验收：没有标准样本，联调没有终点")
body(doc, "接口返回 200 不代表数据正确。每个首批对象都要准备能证明“对”和“错”的样本，尤其是跨系统关联的数据。")
table(doc, ["样本类型", "至少包含什么"], [
    ("正常样本", "字段完整、关系正确的一组工单 / 批次 / 检验等数据，能作为演示和回归基线。"),
    ("边界样本", "空值、零值、长文本、跨日、跨组织、多条关联、重复记录和历史修订。"),
    ("异常样本", "无权限、接口超时、码表缺失、重复回传、顺序错乱和部分失败。"),
    ("对账样本", "抽取数量、关键字段和关联关系的比对结果；明确允许差异以及处理方式。"),
], [1750, 7610], size=9.5)
body(doc, "样本可以脱敏，但不能只给空壳。至少要保留字段结构、主外键关系、状态流转和典型异常，否则连接层和映射逻辑无法验证。")

heading(doc, "七、可以正式开工的最低状态")
body(doc, "以下内容齐备时，可以开始首个连接器和数据闭环的真实开发；未齐的部分可以继续并行准备，但不要把它们留成“后面再说”的口头事项。")
table(doc, ["检查项", "完成的标志"], [
    ("□ 首批范围", "明确首批系统和首批数据对象，写清只读 / 回写边界。"),
    ("□ 系统交接包", "接口、字段、样本、账号、网络和变更方式已收到并存档。"),
    ("□ 本地环境", "新同事按 README 能独立安装依赖、启动主要服务并完成一次构建。"),
    ("□ 联调环境", "测试网络、账号、证书和访问路径已实际调通，不只停留在申请单状态。"),
    ("□ 数据口径", "首个对象的字段映射和码表规则已评审；有可对账的标准样本。"),
    ("□ 协作空间", "代码、接口、需求、问题和环境记录有唯一入口，成员都能访问。"),
    ("□ 发布底座", "至少有构建产物、配置注入、日志查看和回滚的最小路径。"),
], [2200, 7160], size=9.5)
callout(doc, "开工后的第一件事", "不要同时接三四个系统。用一个系统、一个对象、一个查询场景先跑通数据通道，沿途把接口差异、映射规则和部署方式沉淀下来。后面的系统接入会快很多。", GREEN)

heading(doc, "附录 A：建议的数据通道架构")
body(doc, "下面的图反映的是准备和建设的顺序。第一阶段的重点是外部系统到连接层的数据通道；智能问答、桌面端和移动端只消费经过治理的数据和服务。")
arch = doc.add_table(rows=1, cols=4, style="Table Grid")
set_table_geometry(arch, [2100, 2500, 2500, 2260])
header_row(arch.rows[0])
for cell, value in zip(arch.rows[0].cells, ["外部业务系统", "连接与安全层", "数据与服务层", "应用层"]):
    shade(cell, LIGHT_BLUE)
    cell_text(cell, value, size=10, bold=True, color_value=INK, align=WD_ALIGN_PARAGRAPH.CENTER)
rows = [
    ("OA\nMES / WME\nQMS / QME", "连接器\n认证与限流\n字段映射\n同步与补数", "统一业务对象\n数据存储\n检索与审计\nAPI / 事件", "Web / 桌面 / 移动\nAgent\n语义服务"),
    ("提供接口、样本、码表与网络", "首批开发重点", "先形成可查询、可对账的数据", "不直接访问外部系统"),
]
for values in rows:
    row = arch.add_row()
    no_split(row)
    for cell, value in zip(row.cells, values):
        cell_text(cell, value, size=9.5, align=WD_ALIGN_PARAGRAPH.CENTER)
doc.add_paragraph().paragraph_format.space_after = Pt(2)
body(doc, "数据流向：外部系统 → 连接层 → 数据与服务层 → 应用层。权限、日志、审计和失败处理贯穿整个链路。")

heading(doc, "附录 B：给外部系统的资料索取模板")
body(doc, "可直接复制以下内容发给 OA、MES / WME、QMS / QME 等系统团队：")
callout(doc, "资料索取说明", "我们正在建设元域智脑的首批数据通道。请提供：1）计划接入的数据对象与业务说明；2）接口文档和认证方式；3）字段字典、码表、主键及关联关系；4）成功、空数据、异常和分页样例；5）测试环境地址、账号申请方式、IP / 网络 / 证书要求；6）接口变更与联调问题的沟通入口。若涉及敏感数据，请同时说明脱敏和使用边界。")

doc.core_properties.title = "元域智脑生产开发开工准备清单"
doc.core_properties.subject = "外部系统对接、开发工具、协作工具与开工条件"
doc.core_properties.author = ""
doc.save(OUT)
print(OUT)
