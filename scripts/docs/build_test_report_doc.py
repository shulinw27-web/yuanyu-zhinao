from __future__ import annotations

import re
from pathlib import Path

from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.table import WD_ALIGN_VERTICAL, WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "docs" / "development" / "TEST_REPORT_2026-09-05.md"
OUTPUT = ROOT / "docs" / "reference" / "exports" / "元域智脑-整体测试报告-2026-09-05.docx"

INK = "172B3A"
BLUE = "235E7A"
TEAL = "168C8C"
MUTED = "5F6F78"
LIGHT = "EEF4F5"
PALE = "F6F8F9"
LINE = "C9D6DB"
GREEN = "167A5A"
AMBER = "9A6700"
RED = "A13B36"
WHITE = "FFFFFF"
CONTENT_DXA = 9360
TABLE_INDENT_DXA = 120


def set_cell_shading(cell, fill: str) -> None:
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = tc_pr.find(qn("w:shd"))
    if shd is None:
        shd = OxmlElement("w:shd")
        tc_pr.append(shd)
    shd.set(qn("w:fill"), fill)


def set_cell_margins(cell, top=100, start=120, bottom=100, end=120) -> None:
    tc = cell._tc
    tc_pr = tc.get_or_add_tcPr()
    tc_mar = tc_pr.first_child_found_in("w:tcMar")
    if tc_mar is None:
        tc_mar = OxmlElement("w:tcMar")
        tc_pr.append(tc_mar)
    for edge, value in (("top", top), ("start", start), ("bottom", bottom), ("end", end)):
        node = tc_mar.find(qn(f"w:{edge}"))
        if node is None:
            node = OxmlElement(f"w:{edge}")
            tc_mar.append(node)
        node.set(qn("w:w"), str(value))
        node.set(qn("w:type"), "dxa")


def set_repeat_table_header(row) -> None:
    tr_pr = row._tr.get_or_add_trPr()
    header = OxmlElement("w:tblHeader")
    header.set(qn("w:val"), "true")
    tr_pr.append(header)


def prevent_row_split(row) -> None:
    tr_pr = row._tr.get_or_add_trPr()
    if tr_pr.find(qn("w:cantSplit")) is None:
        tr_pr.append(OxmlElement("w:cantSplit"))


def set_table_geometry(table, widths: list[int]) -> None:
    table.autofit = False
    table.alignment = WD_TABLE_ALIGNMENT.LEFT
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
    tbl_ind.set(qn("w:w"), str(TABLE_INDENT_DXA))
    tbl_ind.set(qn("w:type"), "dxa")
    grid = table._tbl.tblGrid
    for child in list(grid):
        grid.remove(child)
    for width in widths:
        col = OxmlElement("w:gridCol")
        col.set(qn("w:w"), str(width))
        grid.append(col)
    for row in table.rows:
        for idx, cell in enumerate(row.cells):
            tc_pr = cell._tc.get_or_add_tcPr()
            tc_w = tc_pr.find(qn("w:tcW"))
            if tc_w is None:
                tc_w = OxmlElement("w:tcW")
                tc_pr.append(tc_w)
            tc_w.set(qn("w:w"), str(widths[idx]))
            tc_w.set(qn("w:type"), "dxa")
            set_cell_margins(cell)


def set_paragraph_bottom_border(paragraph, color=TEAL, size=12) -> None:
    p_pr = paragraph._p.get_or_add_pPr()
    p_bdr = p_pr.find(qn("w:pBdr"))
    if p_bdr is None:
        p_bdr = OxmlElement("w:pBdr")
        p_pr.append(p_bdr)
    bottom = OxmlElement("w:bottom")
    bottom.set(qn("w:val"), "single")
    bottom.set(qn("w:sz"), str(size))
    bottom.set(qn("w:space"), "6")
    bottom.set(qn("w:color"), color)
    p_bdr.append(bottom)


def add_page_field(paragraph) -> None:
    run = paragraph.add_run()
    begin = OxmlElement("w:fldChar")
    begin.set(qn("w:fldCharType"), "begin")
    instr = OxmlElement("w:instrText")
    instr.set(qn("xml:space"), "preserve")
    instr.text = " PAGE "
    separate = OxmlElement("w:fldChar")
    separate.set(qn("w:fldCharType"), "separate")
    text = OxmlElement("w:t")
    text.text = "1"
    end = OxmlElement("w:fldChar")
    end.set(qn("w:fldCharType"), "end")
    run._r.extend([begin, instr, separate, text, end])


def set_run_font(run, size=None, color=None, bold=None, italic=None, mono=False) -> None:
    ascii_font = "Consolas" if mono else "Calibri"
    east_font = "Microsoft YaHei"
    run.font.name = ascii_font
    r_fonts = run._element.get_or_add_rPr().get_or_add_rFonts()
    r_fonts.set(qn("w:ascii"), ascii_font)
    r_fonts.set(qn("w:hAnsi"), ascii_font)
    r_fonts.set(qn("w:eastAsia"), east_font)
    if size is not None:
        run.font.size = Pt(size)
    if color:
        run.font.color.rgb = RGBColor.from_string(color)
    if bold is not None:
        run.bold = bold
    if italic is not None:
        run.italic = italic


def configure_styles(doc: Document) -> None:
    normal = doc.styles["Normal"]
    normal.font.name = "Calibri"
    normal.font.size = Pt(10.5)
    normal._element.rPr.rFonts.set(qn("w:ascii"), "Calibri")
    normal._element.rPr.rFonts.set(qn("w:hAnsi"), "Calibri")
    normal._element.rPr.rFonts.set(qn("w:eastAsia"), "Microsoft YaHei")
    normal.paragraph_format.space_before = Pt(0)
    normal.paragraph_format.space_after = Pt(6)
    normal.paragraph_format.line_spacing = 1.1

    levels = {
        "Title": (25, INK, 0, 5),
        "Subtitle": (12, MUTED, 0, 12),
        "Heading 1": (16, BLUE, 16, 8),
        "Heading 2": (13, BLUE, 12, 6),
        "Heading 3": (11.5, INK, 8, 4),
    }
    for name, (size, color, before, after) in levels.items():
        style = doc.styles[name]
        style.font.name = "Calibri"
        style.font.size = Pt(size)
        style.font.color.rgb = RGBColor.from_string(color)
        style.font.bold = name != "Subtitle"
        style._element.rPr.rFonts.set(qn("w:ascii"), "Calibri")
        style._element.rPr.rFonts.set(qn("w:hAnsi"), "Calibri")
        style._element.rPr.rFonts.set(qn("w:eastAsia"), "Microsoft YaHei")
        style.paragraph_format.space_before = Pt(before)
        style.paragraph_format.space_after = Pt(after)
        style.paragraph_format.keep_with_next = True


def create_numbering(doc: Document, bullet: bool) -> int:
    numbering = doc.part.numbering_part.element
    abstract_ids = [int(x.get(qn("w:abstractNumId"))) for x in numbering.findall(qn("w:abstractNum"))]
    num_ids = [int(x.get(qn("w:numId"))) for x in numbering.findall(qn("w:num"))]
    abstract_id = max(abstract_ids, default=0) + 1
    num_id = max(num_ids, default=0) + 1
    abstract = OxmlElement("w:abstractNum")
    abstract.set(qn("w:abstractNumId"), str(abstract_id))
    multi = OxmlElement("w:multiLevelType")
    multi.set(qn("w:val"), "singleLevel")
    abstract.append(multi)
    level = OxmlElement("w:lvl")
    level.set(qn("w:ilvl"), "0")
    start = OxmlElement("w:start")
    start.set(qn("w:val"), "1")
    num_fmt = OxmlElement("w:numFmt")
    num_fmt.set(qn("w:val"), "bullet" if bullet else "decimal")
    lvl_text = OxmlElement("w:lvlText")
    lvl_text.set(qn("w:val"), "•" if bullet else "%1.")
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
    spacing = OxmlElement("w:spacing")
    spacing.set(qn("w:after"), "160")
    spacing.set(qn("w:line"), "280")
    spacing.set(qn("w:lineRule"), "auto")
    p_pr.extend([tabs, ind, spacing])
    level.extend([start, num_fmt, lvl_text, lvl_jc, p_pr])
    abstract.append(level)
    numbering.append(abstract)
    num = OxmlElement("w:num")
    num.set(qn("w:numId"), str(num_id))
    ref = OxmlElement("w:abstractNumId")
    ref.set(qn("w:val"), str(abstract_id))
    num.append(ref)
    numbering.append(num)
    return num_id


def add_numbered_paragraph(doc: Document, text: str, num_id: int) -> None:
    p = doc.add_paragraph()
    p_pr = p._p.get_or_add_pPr()
    num_pr = OxmlElement("w:numPr")
    ilvl = OxmlElement("w:ilvl")
    ilvl.set(qn("w:val"), "0")
    num_id_node = OxmlElement("w:numId")
    num_id_node.set(qn("w:val"), str(num_id))
    num_pr.extend([ilvl, num_id_node])
    p_pr.append(num_pr)
    add_inline_runs(p, text)


def add_inline_runs(paragraph, text: str) -> None:
    pattern = re.compile(r"(\*\*.+?\*\*|`.+?`)")
    cursor = 0
    for match in pattern.finditer(text):
        if match.start() > cursor:
            set_run_font(paragraph.add_run(text[cursor:match.start()]), size=10.5, color=INK)
        token = match.group(0)
        if token.startswith("**"):
            set_run_font(paragraph.add_run(token[2:-2]), size=10.5, color=INK, bold=True)
        else:
            set_run_font(paragraph.add_run(token[1:-1]), size=9, color=BLUE, mono=True)
        cursor = match.end()
    if cursor < len(text):
        set_run_font(paragraph.add_run(text[cursor:]), size=10.5, color=INK)


def parse_table(lines: list[str]) -> list[list[str]]:
    return [[cell.strip() for cell in line.strip().strip("|").split("|")] for line in lines]


def table_widths(headers: list[str]) -> list[int]:
    count = len(headers)
    if count == 2:
        return [1800, 7560]
    if count == 3:
        return [1800, 6260, 1300]
    if count == 4:
        if headers[0] == "编号":
            return [720, 2250, 900, 5490]
        return [1500, 3750, 1500, 2610]
    if count == 5:
        return [650, 1800, 800, 780, 5330]
    base = CONTENT_DXA // count
    widths = [base] * count
    widths[-1] += CONTENT_DXA - sum(widths)
    return widths


def add_table(doc: Document, rows: list[list[str]]) -> None:
    headers = rows[0]
    data = rows[2:]
    table = doc.add_table(rows=1, cols=len(headers))
    table.style = "Table Grid"
    set_table_geometry(table, table_widths(headers))
    set_repeat_table_header(table.rows[0])
    for idx, value in enumerate(headers):
        cell = table.rows[0].cells[idx]
        set_cell_shading(cell, BLUE)
        cell.vertical_alignment = WD_ALIGN_VERTICAL.CENTER
        p = cell.paragraphs[0]
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p.paragraph_format.space_after = Pt(0)
        set_run_font(p.add_run(value.replace("**", "")), size=9, color=WHITE, bold=True)
    prevent_row_split(table.rows[0])
    for row_index, row_values in enumerate(data):
        cells = table.add_row().cells
        for col_index, value in enumerate(row_values):
            cell = cells[col_index]
            cell.vertical_alignment = WD_ALIGN_VERTICAL.CENTER
            if row_index % 2:
                set_cell_shading(cell, PALE)
            p = cell.paragraphs[0]
            p.paragraph_format.space_after = Pt(0)
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER if col_index in {0, 2, 3} else WD_ALIGN_PARAGRAPH.LEFT
            clean = value.replace("**", "").replace("`", "")
            color = GREEN if clean == "通过" or "全部通过" in clean else (AMBER if "风险" in clean else INK)
            set_run_font(p.add_run(clean), size=8.5, color=color, bold=("合计" in clean or clean == "通过"))
        prevent_row_split(table.rows[-1])
    spacer = doc.add_paragraph()
    spacer.paragraph_format.space_after = Pt(3)


def add_callout(doc: Document, title: str, text: str, color=TEAL) -> None:
    p = doc.add_paragraph()
    p.paragraph_format.left_indent = Inches(0.15)
    p.paragraph_format.right_indent = Inches(0.15)
    p.paragraph_format.space_before = Pt(4)
    p.paragraph_format.space_after = Pt(10)
    p.paragraph_format.line_spacing = 1.15
    p_pr = p._p.get_or_add_pPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:fill"), LIGHT)
    p_pr.append(shd)
    borders = OxmlElement("w:pBdr")
    left = OxmlElement("w:left")
    left.set(qn("w:val"), "single")
    left.set(qn("w:sz"), "18")
    left.set(qn("w:space"), "8")
    left.set(qn("w:color"), color)
    borders.append(left)
    p_pr.append(borders)
    set_run_font(p.add_run(title + "  "), size=10.5, color=color, bold=True)
    set_run_font(p.add_run(text), size=10.5, color=INK)


def add_masthead(doc: Document) -> None:
    kicker = doc.add_paragraph()
    kicker.paragraph_format.space_before = Pt(24)
    kicker.paragraph_format.space_after = Pt(7)
    set_run_font(kicker.add_run("SYSTEM TEST REPORT  /  2026-09-05"), size=9, color=TEAL, bold=True)
    title = doc.add_paragraph(style="Title")
    title.add_run("元域智脑整体测试报告")
    subtitle = doc.add_paragraph(style="Subtitle")
    subtitle.add_run("业务端、语义运营端、后端服务、移动端及公共包")
    metadata = [
        ("测试日期", "2026-09-05（UTC+8）"),
        ("测试环境", "Windows 10 / Node.js v24.14.1 / npm 9.8.1"),
        ("测试类型", "静态门禁、功能回归、构建、安全、负载与语义验证"),
        ("总体判断", "开发回归通过；生产发布暂缓"),
    ]
    for label, value in metadata:
        p = doc.add_paragraph()
        p.paragraph_format.space_after = Pt(2)
        set_run_font(p.add_run(f"{label}："), size=10, color=MUTED, bold=True)
        set_run_font(p.add_run(value), size=10, color=INK)
    rule = doc.add_paragraph()
    rule.paragraph_format.space_after = Pt(12)
    set_paragraph_bottom_border(rule)
    add_callout(
        doc,
        "结论",
        "237 项自动化测试全部通过，四端构建成功；可继续开发和内部演示。真实企业集成、长稳压测、真实模型与桌面人工闭环尚未验收，不建议直接生产发布。",
    )


def configure_page(doc: Document) -> None:
    section = doc.sections[0]
    section.page_width = Inches(8.5)
    section.page_height = Inches(11)
    section.top_margin = Inches(1)
    section.bottom_margin = Inches(1)
    section.left_margin = Inches(1)
    section.right_margin = Inches(1)
    section.header_distance = Inches(0.492)
    section.footer_distance = Inches(0.492)
    header = section.header
    hp = header.paragraphs[0]
    hp.alignment = WD_ALIGN_PARAGRAPH.LEFT
    hp.paragraph_format.space_after = Pt(0)
    set_run_font(hp.add_run("元域智脑  |  整体测试报告"), size=8.5, color=MUTED, bold=True)
    set_paragraph_bottom_border(hp, color=LINE, size=4)
    footer = section.footer
    fp = footer.paragraphs[0]
    fp.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    set_run_font(fp.add_run("内部测试记录  ·  "), size=8, color=MUTED)
    add_page_field(fp)


def build() -> None:
    source_lines = SOURCE.read_text(encoding="utf-8").splitlines()
    doc = Document()
    configure_page(doc)
    configure_styles(doc)
    bullet_num = create_numbering(doc, bullet=True)
    decimal_num = create_numbering(doc, bullet=False)
    add_masthead(doc)

    i = 0
    while i < len(source_lines):
        line = source_lines[i].rstrip()
        if not line or line == "---":
            i += 1
            continue
        if line.startswith("# ") or line.startswith("> "):
            i += 1
            continue
        if line.startswith("## "):
            heading_text = line[3:].strip()
            heading = doc.add_paragraph(heading_text, style="Heading 1")
            if heading_text.startswith("9. 发布判断"):
                heading.paragraph_format.page_break_before = True
            i += 1
            continue
        if line.startswith("### "):
            doc.add_paragraph(line[4:].strip(), style="Heading 2")
            i += 1
            continue
        if line.startswith("|"  ):
            table_lines = []
            while i < len(source_lines) and source_lines[i].lstrip().startswith("|"):
                table_lines.append(source_lines[i].rstrip())
                i += 1
            add_table(doc, parse_table(table_lines))
            continue
        if line.startswith("```"):
            code_lines = []
            i += 1
            while i < len(source_lines) and not source_lines[i].startswith("```"):
                code_lines.append(source_lines[i])
                i += 1
            i += 1
            p = doc.add_paragraph()
            p.paragraph_format.left_indent = Inches(0.2)
            p.paragraph_format.right_indent = Inches(0.2)
            p.paragraph_format.space_before = Pt(3)
            p.paragraph_format.space_after = Pt(8)
            p_pr = p._p.get_or_add_pPr()
            shd = OxmlElement("w:shd")
            shd.set(qn("w:fill"), PALE)
            p_pr.append(shd)
            for idx, code_line in enumerate(code_lines):
                run = p.add_run(code_line + ("\n" if idx < len(code_lines) - 1 else ""))
                set_run_font(run, size=8.5, color=INK, mono=True)
            continue
        if line.startswith("- "):
            add_numbered_paragraph(doc, line[2:].strip(), bullet_num)
            i += 1
            continue
        if re.match(r"^\d+\.\s", line):
            add_numbered_paragraph(doc, re.sub(r"^\d+\.\s+", "", line), decimal_num)
            i += 1
            continue
        p = doc.add_paragraph()
        add_inline_runs(p, line)
        i += 1

    for paragraph in doc.paragraphs:
        paragraph.paragraph_format.widow_control = True
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    doc.core_properties.title = "元域智脑整体测试报告"
    doc.core_properties.subject = "2026-09-05 整体测试与发布判断"
    doc.core_properties.author = "元域智脑项目组"
    doc.core_properties.keywords = "测试报告, 元域智脑, Semantica, Agent"
    doc.save(OUTPUT)
    print(OUTPUT)


if __name__ == "__main__":
    build()
