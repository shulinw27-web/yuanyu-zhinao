from __future__ import annotations

import re
from pathlib import Path

from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT, WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK, WD_LINE_SPACING
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "docs" / "overview" / "元域智脑-整体平台介绍说明-v1.0.md"
OUTPUT = ROOT / "docs" / "reference" / "exports" / "元域智脑-整体平台介绍说明-v1.0.docx"

# standard_business_brief preset + named Chinese-font and brand-color overrides
PAGE_WIDTH_DXA = 12240
PAGE_HEIGHT_DXA = 15840
CONTENT_WIDTH_DXA = 9360
TABLE_INDENT_DXA = 120
CELL_MARGINS_DXA = {"top": 80, "bottom": 80, "start": 120, "end": 120}
ASCII_FONT = "Calibri"
EAST_ASIA_FONT = "Microsoft YaHei"
NAVY = "0B2545"
BLUE = "2E74B5"
DARK_BLUE = "1F4D78"
CYAN = "0EA5C6"
MUTED = "667085"
LIGHT = "F2F4F7"
PALE_BLUE = "E8EEF5"
PALE_CYAN = "EAF8FC"
WHITE = "FFFFFF"
BORDER = "CBD5E1"
RISK = "9B1C1C"
GOLD = "7A5A00"
GREEN = "166534"


def set_font(run, *, size=None, color=None, bold=None, italic=None, east_asia=EAST_ASIA_FONT):
    run.font.name = ASCII_FONT
    run._element.get_or_add_rPr().rFonts.set(qn("w:ascii"), ASCII_FONT)
    run._element.get_or_add_rPr().rFonts.set(qn("w:hAnsi"), ASCII_FONT)
    run._element.get_or_add_rPr().rFonts.set(qn("w:eastAsia"), east_asia)
    if size is not None:
        run.font.size = Pt(size)
    if color is not None:
        run.font.color.rgb = RGBColor.from_string(color)
    if bold is not None:
        run.bold = bold
    if italic is not None:
        run.italic = italic


def set_cell_shading(cell, fill):
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = tc_pr.find(qn("w:shd"))
    if shd is None:
        shd = OxmlElement("w:shd")
        tc_pr.append(shd)
    shd.set(qn("w:fill"), fill)


def set_cell_margins(cell, margins=CELL_MARGINS_DXA):
    tc = cell._tc
    tc_pr = tc.get_or_add_tcPr()
    tc_mar = tc_pr.first_child_found_in("w:tcMar")
    if tc_mar is None:
        tc_mar = OxmlElement("w:tcMar")
        tc_pr.append(tc_mar)
    for key in ("top", "start", "bottom", "end"):
        node = tc_mar.find(qn(f"w:{key}"))
        if node is None:
            node = OxmlElement(f"w:{key}")
            tc_mar.append(node)
        node.set(qn("w:w"), str(margins[key]))
        node.set(qn("w:type"), "dxa")


def set_cell_width(cell, width_dxa):
    tc_pr = cell._tc.get_or_add_tcPr()
    tc_w = tc_pr.find(qn("w:tcW"))
    if tc_w is None:
        tc_w = OxmlElement("w:tcW")
        tc_pr.append(tc_w)
    tc_w.set(qn("w:w"), str(width_dxa))
    tc_w.set(qn("w:type"), "dxa")


def set_repeat_table_header(row):
    tr_pr = row._tr.get_or_add_trPr()
    tbl_header = OxmlElement("w:tblHeader")
    tbl_header.set(qn("w:val"), "true")
    tr_pr.append(tbl_header)


def prevent_row_split(row):
    tr_pr = row._tr.get_or_add_trPr()
    cant_split = OxmlElement("w:cantSplit")
    tr_pr.append(cant_split)


def set_table_borders(table, color=BORDER, size="5"):
    tbl_pr = table._tbl.tblPr
    borders = tbl_pr.find(qn("w:tblBorders"))
    if borders is None:
        borders = OxmlElement("w:tblBorders")
        tbl_pr.append(borders)
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        tag = borders.find(qn(f"w:{edge}"))
        if tag is None:
            tag = OxmlElement(f"w:{edge}")
            borders.append(tag)
        tag.set(qn("w:val"), "single")
        tag.set(qn("w:sz"), size)
        tag.set(qn("w:space"), "0")
        tag.set(qn("w:color"), color)


def set_table_geometry(table, widths_dxa, indent_dxa=TABLE_INDENT_DXA):
    table.autofit = False
    table.alignment = WD_TABLE_ALIGNMENT.LEFT
    tbl_pr = table._tbl.tblPr
    tbl_w = tbl_pr.find(qn("w:tblW"))
    if tbl_w is None:
        tbl_w = OxmlElement("w:tblW")
        tbl_pr.append(tbl_w)
    tbl_w.set(qn("w:w"), str(sum(widths_dxa)))
    tbl_w.set(qn("w:type"), "dxa")
    tbl_ind = tbl_pr.find(qn("w:tblInd"))
    if tbl_ind is None:
        tbl_ind = OxmlElement("w:tblInd")
        tbl_pr.append(tbl_ind)
    tbl_ind.set(qn("w:w"), str(indent_dxa))
    tbl_ind.set(qn("w:type"), "dxa")
    grid = table._tbl.tblGrid
    for child in list(grid):
        grid.remove(child)
    for width in widths_dxa:
        col = OxmlElement("w:gridCol")
        col.set(qn("w:w"), str(width))
        grid.append(col)
    for row in table.rows:
        for idx, cell in enumerate(row.cells):
            set_cell_width(cell, widths_dxa[idx])
            set_cell_margins(cell)
            cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER


def paragraph_bottom_border(paragraph, color=CYAN, size="18", space="8"):
    p_pr = paragraph._p.get_or_add_pPr()
    p_bdr = p_pr.find(qn("w:pBdr"))
    if p_bdr is None:
        p_bdr = OxmlElement("w:pBdr")
        p_pr.append(p_bdr)
    bottom = OxmlElement("w:bottom")
    bottom.set(qn("w:val"), "single")
    bottom.set(qn("w:sz"), size)
    bottom.set(qn("w:space"), space)
    bottom.set(qn("w:color"), color)
    p_bdr.append(bottom)


def add_field(paragraph, instruction):
    run = paragraph.add_run()
    begin = OxmlElement("w:fldChar")
    begin.set(qn("w:fldCharType"), "begin")
    instr = OxmlElement("w:instrText")
    instr.set(qn("xml:space"), "preserve")
    instr.text = instruction
    separate = OxmlElement("w:fldChar")
    separate.set(qn("w:fldCharType"), "separate")
    text = OxmlElement("w:t")
    text.text = "1"
    end = OxmlElement("w:fldChar")
    end.set(qn("w:fldCharType"), "end")
    run._r.extend([begin, instr, separate, text, end])
    set_font(run, size=8.5, color=MUTED)


def create_numbering_sequence(doc):
    """Create a real single-level Word numbering definition that restarts at 1."""
    root = doc.part.numbering_part.element
    abstract_ids = [
        int(node.get(qn("w:abstractNumId")))
        for node in root.findall(qn("w:abstractNum"))
    ]
    num_ids = [int(node.get(qn("w:numId"))) for node in root.findall(qn("w:num"))]
    abstract_id = max(abstract_ids, default=0) + 1
    num_id = max(num_ids, default=0) + 1

    abstract = OxmlElement("w:abstractNum")
    abstract.set(qn("w:abstractNumId"), str(abstract_id))
    multi = OxmlElement("w:multiLevelType")
    multi.set(qn("w:val"), "singleLevel")
    abstract.append(multi)
    lvl = OxmlElement("w:lvl")
    lvl.set(qn("w:ilvl"), "0")
    start = OxmlElement("w:start")
    start.set(qn("w:val"), "1")
    num_fmt = OxmlElement("w:numFmt")
    num_fmt.set(qn("w:val"), "decimal")
    lvl_text = OxmlElement("w:lvlText")
    lvl_text.set(qn("w:val"), "%1.")
    lvl_jc = OxmlElement("w:lvlJc")
    lvl_jc.set(qn("w:val"), "left")
    p_pr = OxmlElement("w:pPr")
    tabs = OxmlElement("w:tabs")
    tab = OxmlElement("w:tab")
    tab.set(qn("w:val"), "num")
    tab.set(qn("w:pos"), "720")
    tabs.append(tab)
    ind = OxmlElement("w:ind")
    ind.set(qn("w:left"), "720")
    ind.set(qn("w:hanging"), "360")
    p_pr.extend([tabs, ind])
    lvl.extend([start, num_fmt, lvl_text, lvl_jc, p_pr])
    abstract.append(lvl)
    root.append(abstract)

    num = OxmlElement("w:num")
    num.set(qn("w:numId"), str(num_id))
    abstract_ref = OxmlElement("w:abstractNumId")
    abstract_ref.set(qn("w:val"), str(abstract_id))
    num.append(abstract_ref)
    root.append(num)
    return num_id


def apply_numbering(paragraph, num_id):
    p_pr = paragraph._p.get_or_add_pPr()
    num_pr = p_pr.find(qn("w:numPr"))
    if num_pr is None:
        num_pr = OxmlElement("w:numPr")
        p_pr.append(num_pr)
    ilvl = OxmlElement("w:ilvl")
    ilvl.set(qn("w:val"), "0")
    num = OxmlElement("w:numId")
    num.set(qn("w:val"), str(num_id))
    num_pr.extend([ilvl, num])


def configure_styles(doc):
    normal = doc.styles["Normal"]
    normal.font.name = ASCII_FONT
    normal._element.rPr.rFonts.set(qn("w:ascii"), ASCII_FONT)
    normal._element.rPr.rFonts.set(qn("w:hAnsi"), ASCII_FONT)
    normal._element.rPr.rFonts.set(qn("w:eastAsia"), EAST_ASIA_FONT)
    normal.font.size = Pt(11)
    normal.paragraph_format.space_before = Pt(0)
    normal.paragraph_format.space_after = Pt(6)
    normal.paragraph_format.line_spacing = 1.10

    settings = {
        "Heading 1": (16, BLUE, 16, 8),
        "Heading 2": (13, BLUE, 12, 6),
        "Heading 3": (12, DARK_BLUE, 8, 4),
    }
    for name, (size, color, before, after) in settings.items():
        style = doc.styles[name]
        style.font.name = ASCII_FONT
        style._element.rPr.rFonts.set(qn("w:ascii"), ASCII_FONT)
        style._element.rPr.rFonts.set(qn("w:hAnsi"), ASCII_FONT)
        style._element.rPr.rFonts.set(qn("w:eastAsia"), EAST_ASIA_FONT)
        style.font.size = Pt(size)
        style.font.color.rgb = RGBColor.from_string(color)
        style.font.bold = True
        style.paragraph_format.space_before = Pt(before)
        style.paragraph_format.space_after = Pt(after)
        style.paragraph_format.keep_with_next = True
        style.paragraph_format.widow_control = True

    for name in ("List Bullet", "List Number"):
        style = doc.styles[name]
        style.font.name = ASCII_FONT
        style._element.rPr.rFonts.set(qn("w:eastAsia"), EAST_ASIA_FONT)
        style.font.size = Pt(11)
        style.paragraph_format.left_indent = Inches(0.5)
        style.paragraph_format.first_line_indent = Inches(-0.25)
        style.paragraph_format.tab_stops.add_tab_stop(Inches(0.5))
        style.paragraph_format.space_after = Pt(8)
        style.paragraph_format.line_spacing = 1.167


def configure_section(section):
    section.page_width = Inches(8.5)
    section.page_height = Inches(11)
    section.top_margin = Inches(1.0)
    section.right_margin = Inches(1.0)
    section.bottom_margin = Inches(1.0)
    section.left_margin = Inches(1.0)
    section.header_distance = Inches(0.492)
    section.footer_distance = Inches(0.492)
    section.different_first_page_header_footer = False


def set_running_furniture(section):
    def apply_header(header):
        p = header.paragraphs[0]
        p.alignment = WD_ALIGN_PARAGRAPH.LEFT
        p.paragraph_format.space_after = Pt(2)
        left = p.add_run("元域智脑 | 整体平台介绍说明")
        set_font(left, size=8.5, color=MUTED, bold=True)
        paragraph_bottom_border(p, color=BORDER, size="5", space="3")

    def apply_footer(footer):
        p = footer.paragraphs[0]
        p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
        p.paragraph_format.space_before = Pt(2)
        label = p.add_run("内部参考  ·  v1.0  ·  ")
        set_font(label, size=8.5, color=MUTED)
        add_field(p, "PAGE")

    apply_header(section.header)
    apply_header(section.even_page_header)
    apply_footer(section.footer)
    apply_footer(section.even_page_footer)


def add_cover(doc):
    for _ in range(5):
        p = doc.add_paragraph()
        p.paragraph_format.space_after = Pt(12)

    kicker = doc.add_paragraph()
    kicker.alignment = WD_ALIGN_PARAGRAPH.CENTER
    kicker.paragraph_format.space_after = Pt(18)
    r = kicker.add_run("PLATFORM OVERVIEW  ·  智能运营与受控 AGENT")
    set_font(r, size=10, color=CYAN, bold=True)

    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_after = Pt(10)
    r = p.add_run("元域智脑")
    set_font(r, size=31, color=NAVY, bold=True)

    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_after = Pt(8)
    r = p.add_run("整体平台介绍说明")
    set_font(r, size=21, color=DARK_BLUE, bold=True)

    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_after = Pt(28)
    r = p.add_run("企业 Agent 工作台与独立元域智语平台")
    set_font(r, size=13.5, color=MUTED)
    paragraph_bottom_border(p, color=CYAN, size="14", space="12")

    meta = doc.add_table(rows=3, cols=2)
    meta_data = [
        ("文档版本", "v1.0"),
        ("更新日期", "2026-09-03 修订"),
        ("建设状态", "Demo 可运行基线 / 生产化准备阶段"),
    ]
    for row, (label, value) in zip(meta.rows, meta_data):
        set_cell_shading(row.cells[0], PALE_BLUE)
        set_cell_shading(row.cells[1], WHITE)
        p1 = row.cells[0].paragraphs[0]
        p1.paragraph_format.space_after = Pt(0)
        r1 = p1.add_run(label)
        set_font(r1, size=9.5, color=DARK_BLUE, bold=True)
        p2 = row.cells[1].paragraphs[0]
        p2.paragraph_format.space_after = Pt(0)
        r2 = p2.add_run(value)
        set_font(r2, size=9.5, color=NAVY)
    set_table_geometry(meta, [2200, 7160])
    set_table_borders(meta, color=BORDER)

    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(38)
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = p.add_run("适用于管理层、业务、产品、研发、测试、实施、运维与安全团队")
    set_font(r, size=9.5, color=MUTED, italic=True)

    doc.add_page_break()


def add_toc(doc, headings):
    title = doc.add_paragraph(style="Heading 1")
    title.add_run("阅读导航")
    intro = doc.add_paragraph("本文档按“平台定位—总体架构—产品能力—业务闭环—安全治理—生产路径”的顺序展开。")
    intro.paragraph_format.space_after = Pt(12)

    for text in headings:
        p = doc.add_paragraph(style="List Number")
        p.paragraph_format.space_after = Pt(4)
        r = p.add_run(re.sub(r"^\d+\.\s*", "", text))
        set_font(r, size=10.5, color=NAVY)

    callout = doc.add_table(rows=1, cols=1)
    cell = callout.cell(0, 0)
    set_cell_shading(cell, PALE_CYAN)
    p = cell.paragraphs[0]
    p.paragraph_format.space_after = Pt(0)
    r = p.add_run("阅读提示：当前版本明确区分“已实现的 Demo 能力”和“生产环境必须补齐的能力”。自动化测试通过不等同于企业生产验收。")
    set_font(r, size=10, color=DARK_BLUE, bold=True)
    set_table_geometry(callout, [CONTENT_WIDTH_DXA])
    set_table_borders(callout, color=CYAN, size="8")
    doc.add_page_break()


def add_inline_runs(paragraph, text, default_size=11, default_color=NAVY):
    parts = re.split(r"(\*\*.*?\*\*|`.*?`)", text)
    for part in parts:
        if not part:
            continue
        if part.startswith("**") and part.endswith("**"):
            r = paragraph.add_run(part[2:-2])
            set_font(r, size=default_size, color=default_color, bold=True)
        elif part.startswith("`") and part.endswith("`"):
            r = paragraph.add_run(part[1:-1])
            set_font(r, size=max(9, default_size - 0.5), color=DARK_BLUE, east_asia="Consolas")
            r.font.name = "Consolas"
            r._element.get_or_add_rPr().rFonts.set(qn("w:ascii"), "Consolas")
            r._element.get_or_add_rPr().rFonts.set(qn("w:hAnsi"), "Consolas")
        else:
            r = paragraph.add_run(part)
            set_font(r, size=default_size, color=default_color)


def add_architecture_visual(doc):
    rows = [
        ("业务与交互", "企业用户 / 管理者", "管理 Web  ·  智脑 Web  ·  移动端  ·  Electron", PALE_CYAN),
        ("元域智语", "独立运营 Agent", "Web / Electron  ·  候选建模  ·  人工校对  ·  发布与巡检", PALE_BLUE),
        ("身份与策略", "账号中心 / IAM", "身份会话  ·  角色  ·  页面/按钮权限  ·  组织数据范围", PALE_BLUE),
        ("Agent 控制", "Agent Runtime", "任务与上下文  ·  技能与工具  ·  工作流  ·  确认执行", "DCEAF7"),
        ("语义与信任", "语义 / 证据 / Key", "核心对象与知识  ·  Evidence Trace  ·  Key Center", "E8EEF5"),
        ("集成与运行", "Connector / Event", "OA · MES · LIMS · QMS · ERP · OMS  |  Outbox / Worker", LIGHT),
        ("数据环境", "Mock → Production", "状态化 Mock + SQLite  →  企业系统 + PostgreSQL/Redis/Broker", "F8FAFC"),
    ]
    table = doc.add_table(rows=len(rows), cols=3)
    for idx, (layer, component, desc, fill) in enumerate(rows):
        for cell in table.rows[idx].cells:
            set_cell_shading(cell, fill)
        values = [layer, component, desc]
        for cidx, value in enumerate(values):
            p = table.rows[idx].cells[cidx].paragraphs[0]
            p.paragraph_format.space_after = Pt(0)
            r = p.add_run(value)
            set_font(r, size=9.5 if cidx != 2 else 9, color=NAVY, bold=cidx < 2)
    set_table_geometry(table, [1450, 2200, 5710])
    set_table_borders(table, color=BORDER)
    cap = doc.add_paragraph("图 1  元域智脑分层逻辑架构（当前 Mock 基线与生产替换路径）")
    cap.alignment = WD_ALIGN_PARAGRAPH.CENTER
    cap.paragraph_format.space_before = Pt(4)
    cap.paragraph_format.space_after = Pt(8)
    for r in cap.runs:
        set_font(r, size=8.5, color=MUTED, italic=True)


def add_markdown_table(doc, lines):
    rows = []
    for line in lines:
        parts = [x.strip() for x in line.strip().strip("|").split("|")]
        rows.append(parts)
    if len(rows) >= 2 and all(re.fullmatch(r":?-{3,}:?", cell) for cell in rows[1]):
        rows.pop(1)
    cols = max(len(row) for row in rows)
    if cols == 2:
        widths = [2500, 6860]
    elif cols == 3:
        widths = [1800, 3100, 4460]
    elif cols == 4:
        widths = [1500, 2260, 2800, 2800]
    else:
        widths = [CONTENT_WIDTH_DXA // cols] * cols
        widths[-1] += CONTENT_WIDTH_DXA - sum(widths)

    table = doc.add_table(rows=len(rows), cols=cols)
    for ridx, values in enumerate(rows):
        prevent_row_split(table.rows[ridx])
        for cidx in range(cols):
            value = values[cidx] if cidx < len(values) else ""
            cell = table.rows[ridx].cells[cidx]
            if ridx == 0:
                set_cell_shading(cell, PALE_BLUE)
            elif ridx % 2 == 0:
                set_cell_shading(cell, "FAFBFC")
            p = cell.paragraphs[0]
            p.paragraph_format.space_after = Pt(0)
            add_inline_runs(p, value, default_size=8.8 if cols >= 4 else 9.2, default_color=NAVY)
            if ridx == 0:
                for run in p.runs:
                    run.bold = True
                    run.font.color.rgb = RGBColor.from_string(DARK_BLUE)
        if ridx == 0:
            set_repeat_table_header(table.rows[ridx])
    set_table_geometry(table, widths)
    set_table_borders(table, color=BORDER)
    doc.add_paragraph().paragraph_format.space_after = Pt(2)


def parse_document(doc, source_text):
    lines = source_text.splitlines()
    in_code = False
    code_lines = []
    table_lines = []
    skip_frontmatter = True
    architecture_visual_added = False
    active_numbering_id = None

    def flush_table():
        nonlocal table_lines
        if table_lines:
            add_markdown_table(doc, table_lines)
            table_lines = []

    def flush_code():
        nonlocal code_lines, architecture_visual_added
        if not code_lines:
            return
        if code_lines[0].strip().startswith("flowchart"):
            if not architecture_visual_added:
                add_architecture_visual(doc)
                architecture_visual_added = True
        else:
            table = doc.add_table(rows=1, cols=1)
            cell = table.cell(0, 0)
            set_cell_shading(cell, "F8FAFC")
            p = cell.paragraphs[0]
            p.paragraph_format.space_after = Pt(0)
            r = p.add_run("\n".join(code_lines))
            set_font(r, size=8.3, color=DARK_BLUE, east_asia="Microsoft YaHei")
            r.font.name = "Consolas"
            r._element.get_or_add_rPr().rFonts.set(qn("w:ascii"), "Consolas")
            r._element.get_or_add_rPr().rFonts.set(qn("w:hAnsi"), "Consolas")
            set_table_geometry(table, [CONTENT_WIDTH_DXA])
            set_table_borders(table, color=BORDER)
        code_lines = []

    for raw in lines:
        line = raw.rstrip()
        if line.startswith("# "):
            continue
        if skip_frontmatter:
            if line.startswith(">") or not line.strip():
                continue
            skip_frontmatter = False
        if line.startswith("```"):
            active_numbering_id = None
            flush_table()
            if in_code:
                flush_code()
                in_code = False
            else:
                in_code = True
            continue
        if in_code:
            code_lines.append(line)
            continue
        if line.startswith("|"):
            active_numbering_id = None
            table_lines.append(line)
            continue
        flush_table()
        if not line.strip() or line.strip() == "---":
            continue

        heading = re.match(r"^(#{2,4})\s+(.+)$", line)
        if heading:
            active_numbering_id = None
            level = min(len(heading.group(1)) - 1, 3)
            text = heading.group(2)
            if level == 1 and text.startswith("4."):
                doc.add_page_break()
            p = doc.add_paragraph(style=f"Heading {level}")
            add_inline_runs(p, text, default_size={1: 16, 2: 13, 3: 12}[level], default_color=BLUE if level < 3 else DARK_BLUE)
            continue

        bullet = re.match(r"^-\s+(.+)$", line)
        if bullet:
            active_numbering_id = None
            p = doc.add_paragraph(style="List Bullet")
            add_inline_runs(p, bullet.group(1))
            continue

        number = re.match(r"^\d+\.\s+(.+)$", line)
        if number:
            if active_numbering_id is None:
                active_numbering_id = create_numbering_sequence(doc)
            p = doc.add_paragraph(style="List Number")
            apply_numbering(p, active_numbering_id)
            add_inline_runs(p, number.group(1))
            continue

        if line.startswith(">"):
            active_numbering_id = None
            table = doc.add_table(rows=1, cols=1)
            cell = table.cell(0, 0)
            set_cell_shading(cell, PALE_CYAN)
            p = cell.paragraphs[0]
            p.paragraph_format.space_after = Pt(0)
            add_inline_runs(p, line.lstrip("> "), default_size=10, default_color=DARK_BLUE)
            set_table_geometry(table, [CONTENT_WIDTH_DXA])
            set_table_borders(table, color=CYAN)
            continue

        active_numbering_id = None
        p = doc.add_paragraph()
        p.paragraph_format.widow_control = True
        add_inline_runs(p, line)

    flush_table()
    if in_code:
        flush_code()


def audit(doc):
    section = doc.sections[0]
    assert section.page_width.twips == PAGE_WIDTH_DXA
    assert section.page_height.twips == PAGE_HEIGHT_DXA
    assert section.left_margin.twips == 1440
    assert section.right_margin.twips == 1440
    assert section.top_margin.twips == 1440
    assert section.bottom_margin.twips == 1440
    assert section.header_distance.twips == 708
    assert section.footer_distance.twips == 708
    assert doc.styles["Normal"].font.size.pt == 11
    assert doc.styles["Heading 1"].font.size.pt == 16
    assert doc.styles["Heading 2"].font.size.pt == 13
    assert doc.styles["Heading 3"].font.size.pt == 12
    assert len(doc.tables) >= 10


def main():
    source_text = SOURCE.read_text(encoding="utf-8")
    headings = [
        m.group(1)
        for m in re.finditer(r"^##\s+(.+)$", source_text, flags=re.MULTILINE)
        if not m.group(1).startswith("1. 文档目的")
    ]

    doc = Document()
    doc.settings.odd_and_even_pages_header_footer = True
    configure_styles(doc)
    for section in doc.sections:
        configure_section(section)
        set_running_furniture(section)

    props = doc.core_properties
    props.title = "元域智脑整体平台介绍说明"
    props.subject = "企业 Agent 工作台与独立元域智语平台"
    props.author = "元域智脑项目组"
    props.keywords = "元域智脑, Agent, 平台架构, IAM, Evidence Trace, Mock"
    props.comments = "2026-09-03 项目目录整理及平台现状校准修订"

    add_cover(doc)
    add_toc(doc, headings)
    parse_document(doc, source_text)
    audit(doc)
    doc.save(OUTPUT)
    print(f"created={OUTPUT}")
    print(f"paragraphs={len(doc.paragraphs)} tables={len(doc.tables)}")


if __name__ == "__main__":
    main()
