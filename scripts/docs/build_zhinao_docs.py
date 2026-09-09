from pathlib import Path
import re
from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_CELL_VERTICAL_ALIGNMENT
from docx.shared import Inches, Pt, RGBColor
from docx.oxml import OxmlElement
from docx.oxml.ns import qn

ROOT = Path(__file__).resolve().parents[2]
DOCS = ROOT / "docs"

INK = "10212E"
NAVY = "112B3A"
TEAL = "00A7B5"
CYAN = "39C7D5"
MUTED = "617482"
LIGHT = "EEF4F6"
PALE = "E3F4F5"
WHITE = "FFFFFF"
RED = "A43843"
GOLD = "9B6A14"


def set_cell_shading(cell, fill):
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = tc_pr.find(qn("w:shd"))
    if shd is None:
        shd = OxmlElement("w:shd")
        tc_pr.append(shd)
    shd.set(qn("w:fill"), fill)


def set_cell_margins(cell, top=80, start=120, bottom=80, end=120):
    tc = cell._tc
    tc_pr = tc.get_or_add_tcPr()
    tc_mar = tc_pr.first_child_found_in("w:tcMar")
    if tc_mar is None:
        tc_mar = OxmlElement("w:tcMar")
        tc_pr.append(tc_mar)
    for side, value in (("top", top), ("start", start), ("bottom", bottom), ("end", end)):
        node = tc_mar.find(qn(f"w:{side}"))
        if node is None:
            node = OxmlElement(f"w:{side}")
            tc_mar.append(node)
        node.set(qn("w:w"), str(value))
        node.set(qn("w:type"), "dxa")


def set_repeat_table_header(row):
    tr_pr = row._tr.get_or_add_trPr()
    repeat = OxmlElement("w:tblHeader")
    repeat.set(qn("w:val"), "true")
    tr_pr.append(repeat)


def prevent_row_split(row):
    tr_pr = row._tr.get_or_add_trPr()
    if tr_pr.find(qn("w:cantSplit")) is None:
        tr_pr.append(OxmlElement("w:cantSplit"))


def set_fixed_table_geometry(table, widths):
    total = sum(widths)
    table.autofit = False
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    tbl_pr = table._tbl.tblPr
    layout = tbl_pr.find(qn("w:tblLayout"))
    if layout is None:
        layout = OxmlElement("w:tblLayout")
        tbl_pr.append(layout)
    layout.set(qn("w:type"), "fixed")
    tbl_w = tbl_pr.find(qn("w:tblW"))
    tbl_w.set(qn("w:w"), str(total))
    tbl_w.set(qn("w:type"), "dxa")
    tbl_ind = tbl_pr.find(qn("w:tblInd"))
    if tbl_ind is None:
        tbl_ind = OxmlElement("w:tblInd")
        tbl_pr.append(tbl_ind)
    tbl_ind.set(qn("w:w"), "120")
    tbl_ind.set(qn("w:type"), "dxa")
    grid = table._tbl.tblGrid
    for child in list(grid):
        grid.remove(child)
    for width in widths:
        col = OxmlElement("w:gridCol")
        col.set(qn("w:w"), str(width))
        grid.append(col)
    for row in table.rows:
        for index, cell in enumerate(row.cells):
            width = widths[min(index, len(widths) - 1)]
            tc_pr = cell._tc.get_or_add_tcPr()
            tc_w = tc_pr.find(qn("w:tcW"))
            tc_w.set(qn("w:w"), str(width))
            tc_w.set(qn("w:type"), "dxa")
            cell.width = Inches(width / 1440)
            set_cell_margins(cell)


def set_font(run, name="Microsoft YaHei", size=10.5, color=INK, bold=False, italic=False):
    run.font.name = name
    run.font.size = Pt(size)
    run.font.color.rgb = RGBColor.from_string(color)
    run.bold = bold
    run.italic = italic
    run._element.rPr.rFonts.set(qn("w:eastAsia"), name)


def configure_styles(doc):
    styles = doc.styles
    normal = styles["Normal"]
    normal.font.name = "Microsoft YaHei"
    normal.font.size = Pt(10.5)
    normal.font.color.rgb = RGBColor.from_string(INK)
    normal._element.rPr.rFonts.set(qn("w:eastAsia"), "Microsoft YaHei")
    normal.paragraph_format.space_before = Pt(0)
    normal.paragraph_format.space_after = Pt(6)
    normal.paragraph_format.line_spacing = 1.1
    for name, size, before, after, color in (
        ("Heading 1", 16, 16, 8, NAVY),
        ("Heading 2", 13, 12, 6, TEAL),
        ("Heading 3", 11.5, 8, 4, NAVY),
    ):
        style = styles[name]
        style.font.name = "Microsoft YaHei"
        style.font.size = Pt(size)
        style.font.bold = True
        style.font.color.rgb = RGBColor.from_string(color)
        style._element.rPr.rFonts.set(qn("w:eastAsia"), "Microsoft YaHei")
        style.paragraph_format.space_before = Pt(before)
        style.paragraph_format.space_after = Pt(after)
        style.paragraph_format.keep_with_next = True
    for name in ("List Bullet", "List Number"):
        style = styles[name]
        style.font.name = "Microsoft YaHei"
        style.font.size = Pt(10.5)
        style._element.rPr.rFonts.set(qn("w:eastAsia"), "Microsoft YaHei")
        style.paragraph_format.left_indent = Inches(.5)
        style.paragraph_format.first_line_indent = Inches(-.25)
        style.paragraph_format.space_after = Pt(8)
        style.paragraph_format.line_spacing = 1.167


def setup_page(doc, running_label):
    section = doc.sections[0]
    section.page_width = Inches(8.5)
    section.page_height = Inches(11)
    section.top_margin = Inches(1)
    section.right_margin = Inches(1)
    section.bottom_margin = Inches(1)
    section.left_margin = Inches(1)
    section.header_distance = Inches(.492)
    section.footer_distance = Inches(.492)
    header = section.header
    p = header.paragraphs[0]
    p.alignment = WD_ALIGN_PARAGRAPH.LEFT
    p.paragraph_format.space_after = Pt(0)
    r = p.add_run(running_label.upper())
    set_font(r, size=8, color=MUTED, bold=True)
    p_pr = p._p.get_or_add_pPr()
    borders = OxmlElement("w:pBdr")
    bottom = OxmlElement("w:bottom")
    bottom.set(qn("w:val"), "single")
    bottom.set(qn("w:sz"), "8")
    bottom.set(qn("w:space"), "5")
    bottom.set(qn("w:color"), TEAL)
    borders.append(bottom)
    p_pr.append(borders)
    footer = section.footer
    fp = footer.paragraphs[0]
    fp.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    rr = fp.add_run("元域智脑  ·  ")
    set_font(rr, size=8, color=MUTED)
    fld = OxmlElement("w:fldSimple")
    fld.set(qn("w:instr"), "PAGE")
    fp._p.append(fld)


def add_cover(doc, title, subtitle, version, manual=False):
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(62 if manual else 26)
    p.paragraph_format.space_after = Pt(14)
    r = p.add_run("YUANYUAN HEALTH  /  PRIVATE AGENT")
    set_font(r, size=9, color=TEAL, bold=True)
    title_p = doc.add_paragraph()
    title_p.paragraph_format.space_after = Pt(14)
    title_p.paragraph_format.keep_with_next = True
    r = title_p.add_run(title)
    set_font(r, size=28, color=NAVY, bold=True)
    sub = doc.add_paragraph()
    sub.paragraph_format.space_after = Pt(28)
    r = sub.add_run(subtitle)
    set_font(r, size=12, color=MUTED)
    line = doc.add_table(rows=1, cols=3)
    line.style = "Table Grid"
    set_fixed_table_geometry(line, [2100, 3900, 3360])
    values = [("VERSION", version), ("BASELINE", "Demo 可运行基线"), ("DATE", "2026-08-21")]
    for idx, (label, value) in enumerate(values):
        cell = line.cell(0, idx)
        set_cell_shading(cell, PALE if idx == 0 else LIGHT)
        cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
        p = cell.paragraphs[0]
        p.paragraph_format.space_after = Pt(0)
        a = p.add_run(f"{label}\n")
        set_font(a, size=7, color=TEAL, bold=True)
        b = p.add_run(value)
        set_font(b, size=9, color=NAVY, bold=True)
    doc.add_paragraph()
    callout = doc.add_table(rows=1, cols=1)
    callout.style = "Table Grid"
    set_fixed_table_geometry(callout, [9360])
    cell = callout.cell(0, 0)
    set_cell_shading(cell, NAVY)
    p = cell.paragraphs[0]
    p.paragraph_format.space_after = Pt(0)
    statement = "把企业上下文、权限、证据和执行收敛到同一条可控链路。" if not manual else "跨端一致操作；每个结论有来源，每个动作有边界。"
    r = p.add_run(statement)
    set_font(r, size=13, color=WHITE, bold=True)
    doc.add_page_break()


def add_toc(doc):
    p = doc.add_paragraph(style="Heading 1")
    p.add_run("目录")
    field = doc.add_paragraph()
    fld = OxmlElement("w:fldSimple")
    fld.set(qn("w:instr"), 'TOC \\o "1-3" \\h \\z \\u')
    field._p.append(fld)
    note = doc.add_paragraph()
    r = note.add_run("提示：在 Word 中右键目录并选择“更新域”即可刷新页码。")
    set_font(r, size=8, color=MUTED, italic=True)
    doc.add_page_break()


def parse_inline(paragraph, text):
    parts = re.split(r"(`[^`]+`|\*\*[^*]+\*\*|<https?://[^>]+>)", text)
    for part in parts:
        if not part:
            continue
        if part.startswith("`") and part.endswith("`"):
            run = paragraph.add_run(part[1:-1])
            set_font(run, name="Consolas", size=9, color=TEAL)
        elif part.startswith("**") and part.endswith("**"):
            run = paragraph.add_run(part[2:-2])
            set_font(run, bold=True)
        elif part.startswith("<http") and part.endswith(">"):
            run = paragraph.add_run(part[1:-1])
            set_font(run, size=8.5, color=TEAL)
        else:
            run = paragraph.add_run(part.replace("  ", " "))
            set_font(run)


def add_markdown_table(doc, rows):
    if len(rows) < 2:
        return
    header = [cell.strip() for cell in rows[0].strip().strip("|").split("|")]
    data = [[cell.strip() for cell in row.strip().strip("|").split("|")] for row in rows[2:]]
    cols = len(header)
    table = doc.add_table(rows=1, cols=cols)
    table.style = "Table Grid"
    widths = [9360 // cols] * cols
    widths[-1] += 9360 - sum(widths)
    for index, value in enumerate(header):
        cell = table.rows[0].cells[index]
        set_cell_shading(cell, NAVY)
        p = cell.paragraphs[0]
        p.paragraph_format.space_after = Pt(0)
        r = p.add_run(value)
        set_font(r, size=8.5, color=WHITE, bold=True)
    set_repeat_table_header(table.rows[0])
    prevent_row_split(table.rows[0])
    for row_index, row in enumerate(data):
        table_row = table.add_row()
        prevent_row_split(table_row)
        cells = table_row.cells
        for index in range(cols):
            cell = cells[index]
            if row_index % 2:
                set_cell_shading(cell, "F8FAFB")
            p = cell.paragraphs[0]
            p.paragraph_format.space_after = Pt(0)
            parse_inline(p, row[index] if index < len(row) else "")
            for run in p.runs:
                run.font.size = Pt(8.3)
    set_fixed_table_geometry(table, widths)
    doc.add_paragraph().paragraph_format.space_after = Pt(0)


def add_code_block(doc, lines):
    if lines and lines[0].strip().startswith("flowchart"):
        add_architecture_visual(doc)
        return
    table = doc.add_table(rows=1, cols=1)
    table.style = "Table Grid"
    set_fixed_table_geometry(table, [9360])
    cell = table.cell(0, 0)
    set_cell_shading(cell, "14232D")
    p = cell.paragraphs[0]
    p.paragraph_format.space_after = Pt(0)
    r = p.add_run("\n".join(lines))
    set_font(r, name="Consolas", size=8, color="D7E8EA")
    doc.add_paragraph().paragraph_format.space_after = Pt(0)


def add_architecture_visual(doc):
    layers = [
        ("体验层", ["移动端", "桌面 Web", "Electron", "管理 Web"], PALE),
        ("共享交互", ["Agent Workbench", "Agent SDK", "任务上下文", "路径引导"], LIGHT),
        ("控制面", ["IAM / 数据域", "Agent 编排", "安全网关", "证据链"], "DCEEF0"),
        ("执行与数据", ["模型网关", "Key Center", "MCP 连接器", "OA / ERP / MES / QMS / OMS"], NAVY),
    ]
    table = doc.add_table(rows=0, cols=4)
    table.style = "Table Grid"
    for layer, items, fill in layers:
        label_row = table.add_row()
        merged = label_row.cells[0].merge(label_row.cells[-1])
        set_cell_shading(merged, TEAL if fill != NAVY else NAVY)
        p = merged.paragraphs[0]
        p.paragraph_format.space_after = Pt(0)
        r = p.add_run(layer)
        set_font(r, size=8, color=WHITE, bold=True)
        row = table.add_row()
        for idx, item in enumerate(items):
            cell = row.cells[idx]
            set_cell_shading(cell, fill)
            p = cell.paragraphs[0]
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            p.paragraph_format.space_after = Pt(0)
            r = p.add_run(item)
            set_font(r, size=8.3, color=WHITE if fill == NAVY else NAVY, bold=True)
    set_fixed_table_geometry(table, [2340, 2340, 2340, 2340])
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_after = Pt(6)
    r = p.add_run("当前输入路由 → 联合授权 → 受控检索 → 模型建议 → 确认 → 工具执行 → 审计回执")
    set_font(r, size=8.5, color=TEAL, bold=True)


def create_numbering_id(doc):
    numbering = doc.part.numbering_part.element
    abstract_ids = [int(node.get(qn("w:abstractNumId"))) for node in numbering.findall(qn("w:abstractNum"))]
    num_ids = [int(node.get(qn("w:numId"))) for node in numbering.findall(qn("w:num"))]
    abstract_id = max(abstract_ids or [0]) + 1
    num_id = max(num_ids or [0]) + 1
    abstract = OxmlElement("w:abstractNum")
    abstract.set(qn("w:abstractNumId"), str(abstract_id))
    multi = OxmlElement("w:multiLevelType")
    multi.set(qn("w:val"), "singleLevel")
    abstract.append(multi)
    lvl = OxmlElement("w:lvl")
    lvl.set(qn("w:ilvl"), "0")
    start = OxmlElement("w:start")
    start.set(qn("w:val"), "1")
    fmt = OxmlElement("w:numFmt")
    fmt.set(qn("w:val"), "decimal")
    text = OxmlElement("w:lvlText")
    text.set(qn("w:val"), "%1.")
    suffix = OxmlElement("w:suff")
    suffix.set(qn("w:val"), "tab")
    p_pr = OxmlElement("w:pPr")
    ind = OxmlElement("w:ind")
    ind.set(qn("w:left"), "720")
    ind.set(qn("w:hanging"), "360")
    p_pr.append(ind)
    lvl.extend([start, fmt, text, suffix, p_pr])
    abstract.append(lvl)
    numbering.append(abstract)
    num = OxmlElement("w:num")
    num.set(qn("w:numId"), str(num_id))
    ref = OxmlElement("w:abstractNumId")
    ref.set(qn("w:val"), str(abstract_id))
    num.append(ref)
    numbering.append(num)
    return num_id


def apply_numbering(paragraph, num_id):
    p_pr = paragraph._p.get_or_add_pPr()
    num_pr = OxmlElement("w:numPr")
    ilvl = OxmlElement("w:ilvl")
    ilvl.set(qn("w:val"), "0")
    num = OxmlElement("w:numId")
    num.set(qn("w:val"), str(num_id))
    num_pr.extend([ilvl, num])
    p_pr.append(num_pr)
    paragraph.paragraph_format.left_indent = Inches(.5)
    paragraph.paragraph_format.first_line_indent = Inches(-.25)
    paragraph.paragraph_format.space_after = Pt(8)
    paragraph.paragraph_format.line_spacing = 1.167


def markdown_to_doc(doc, source_path):
    lines = source_path.read_text(encoding="utf-8").splitlines()
    index = 1
    in_code = False
    code_lines = []
    number_group_id = None
    while index < len(lines):
        raw = lines[index]
        stripped = raw.strip()
        if stripped.startswith("```"):
            number_group_id = None
            if in_code:
                add_code_block(doc, code_lines)
                code_lines = []
                in_code = False
            else:
                in_code = True
            index += 1
            continue
        if in_code:
            code_lines.append(raw)
            index += 1
            continue
        if stripped.startswith("|") and index + 1 < len(lines) and re.match(r"^\s*\|?\s*:?-+", lines[index + 1]):
            table_lines = [raw, lines[index + 1]]
            index += 2
            while index < len(lines) and lines[index].strip().startswith("|"):
                table_lines.append(lines[index])
                index += 1
            add_markdown_table(doc, table_lines)
            continue
        if not stripped or stripped == "---":
            number_group_id = None
            index += 1
            continue
        if stripped.startswith(">"):
            number_group_id = None
            p = doc.add_paragraph()
            p.paragraph_format.left_indent = Inches(.2)
            p.paragraph_format.space_after = Pt(4)
            r = p.add_run(stripped.lstrip("> "))
            set_font(r, size=8.5, color=MUTED, italic=True)
        elif stripped.startswith("### "):
            number_group_id = None
            p = doc.add_paragraph(style="Heading 3")
            parse_inline(p, stripped[4:])
        elif stripped.startswith("## "):
            number_group_id = None
            p = doc.add_paragraph(style="Heading 2")
            parse_inline(p, stripped[3:])
        elif stripped.startswith("# "):
            number_group_id = None
            p = doc.add_paragraph(style="Heading 1")
            parse_inline(p, stripped[2:])
        elif re.match(r"^\d+\.\s+", stripped):
            if number_group_id is None:
                number_group_id = create_numbering_id(doc)
            p = doc.add_paragraph()
            apply_numbering(p, number_group_id)
            parse_inline(p, re.sub(r"^\d+\.\s+", "", stripped))
        elif stripped.startswith("- "):
            number_group_id = None
            p = doc.add_paragraph(style="List Bullet")
            parse_inline(p, stripped[2:])
        else:
            number_group_id = None
            p = doc.add_paragraph()
            parse_inline(p, stripped)
        index += 1


def audit_document(doc):
    section = doc.sections[0]
    assert round(section.page_width.inches, 2) == 8.5
    assert round(section.page_height.inches, 2) == 11.0
    assert all(round(value.inches, 2) == 1.0 for value in (section.top_margin, section.right_margin, section.bottom_margin, section.left_margin))
    for table in doc.tables:
        assert table._tbl.tblPr.find(qn("w:tblLayout")).get(qn("w:type")) == "fixed"


def build(source_name, output_name, title, subtitle, manual=False, version="2.0"):
    doc = Document()
    configure_styles(doc)
    setup_page(doc, title)
    add_cover(doc, title, subtitle, version, manual=manual)
    add_toc(doc)
    markdown_to_doc(doc, DOCS / source_name)
    audit_document(doc)
    output = DOCS / "reference" / "exports" / output_name
    doc.save(output)
    return output


if __name__ == "__main__":
    outputs = [
        build("architecture/ZHINAO_AGENT_ARCHITECTURE_V2.md", "元域智脑-Agent架构技术说明书-v2.1.docx", "元域智脑 Agent 架构技术说明书", "多端任务空间 · 受控上下文 · 证据驱动执行 · 安全与数据权限", manual=False, version="2.1"),
        build("guides/ZHINAO_USER_GUIDE_V2.md", "元域智脑-多端使用说明书-v2.0.docx", "元域智脑多端使用说明书", "桌面 Web · Electron · 移动端", manual=True),
    ]
    for output in outputs:
        print(output)
