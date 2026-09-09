import re
from pathlib import Path

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor

from word_helpers import (
    DARK,
    INK,
    MUTED,
    add_bullets,
    add_heading,
    add_page_field,
    add_steps as base_add_steps,
    add_text,
    configure_section,
    configure_styles,
    set_font,
)

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'docs' / 'guides' / '元域智脑-语义运营Agent操作指南-v1.0.md'
OUTPUT = ROOT / 'docs' / 'reference' / 'exports' / '元域智脑-语义运营Agent操作指南-v1.0.docx'


def set_running_furniture(section):
    configure_section(section, first=True)
    header = section.header
    paragraph = header.paragraphs[0]
    paragraph.clear()
    paragraph.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    run = paragraph.add_run('元域智脑 | 语义运营 Agent 操作指南')
    set_font(run, 8.5, MUTED)
    first_header = section.first_page_header
    first_header.paragraphs[0].clear()
    footer = section.footer
    footer_paragraph = footer.paragraphs[0]
    footer_paragraph.clear()
    footer_paragraph.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    add_page_field(footer_paragraph)


def configure_numbering_styles(doc):
    for style_name in ('List Bullet', 'List Number'):
        style = doc.styles[style_name]
        p_pr = style._element.get_or_add_pPr()
        spacing = p_pr.find(qn('w:spacing'))
        if spacing is None:
            from docx.oxml import OxmlElement
            spacing = OxmlElement('w:spacing')
            p_pr.append(spacing)
        spacing.set(qn('w:after'), '80')
        spacing.set(qn('w:line'), '300')
        spacing.set(qn('w:lineRule'), 'auto')


def add_steps(doc, items):
    start = len(doc.paragraphs)
    base_add_steps(doc, items)
    for paragraph in doc.paragraphs[start:]:
        paragraph.paragraph_format.left_indent = Inches(0.375)
        paragraph.paragraph_format.first_line_indent = Inches(-0.188)
        paragraph.paragraph_format.tab_stops.add_tab_stop(Inches(0.375))


def add_callout(doc, label, text, color=DARK):
    paragraph = doc.add_paragraph()
    paragraph.paragraph_format.space_before = Pt(6)
    paragraph.paragraph_format.space_after = Pt(8)
    paragraph.paragraph_format.left_indent = Inches(0.08)
    paragraph.paragraph_format.right_indent = Inches(0.08)
    paragraph.paragraph_format.line_spacing = 1.2
    p_pr = paragraph._p.get_or_add_pPr()
    shading = OxmlElement('w:shd')
    shading.set(qn('w:fill'), 'F4F6F9')
    p_pr.append(shading)
    borders = OxmlElement('w:pBdr')
    bottom = OxmlElement('w:bottom')
    bottom.set(qn('w:val'), 'single')
    bottom.set(qn('w:sz'), '8')
    bottom.set(qn('w:space'), '4')
    bottom.set(qn('w:color'), 'D7E1EA')
    borders.append(bottom)
    p_pr.append(borders)
    set_font(paragraph.add_run(f'{label}  '), 10.5, color, bold=True)
    set_font(paragraph.add_run(text), 10.5, INK)


def add_cover(doc):
    for _ in range(6):
        doc.add_paragraph()
    kicker = doc.add_paragraph()
    kicker.alignment = WD_ALIGN_PARAGRAPH.CENTER
    kicker.paragraph_format.space_after = Pt(16)
    set_font(kicker.add_run('SEMANTIC OPERATIONS'), 12, DARK, bold=True)

    title = doc.add_paragraph()
    title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    title.paragraph_format.space_after = Pt(8)
    set_font(title.add_run('元域智脑'), 30, INK, bold=True)

    subtitle = doc.add_paragraph()
    subtitle.alignment = WD_ALIGN_PARAGRAPH.CENTER
    subtitle.paragraph_format.space_after = Pt(22)
    set_font(subtitle.add_run('语义运营 Agent 操作指南'), 20, DARK, bold=True)

    add_text(doc, '面向语义建模、数据治理与平台运营人员', 12, MUTED,
             align=WD_ALIGN_PARAGRAPH.CENTER, after=48)
    add_text(doc, '版本：V1.0', 10.5, INK, bold=True,
             align=WD_ALIGN_PARAGRAPH.CENTER, after=4)
    add_text(doc, '更新日期：2026 年 8 月 27 日', 10.5, MUTED,
             align=WD_ALIGN_PARAGRAPH.CENTER, after=4)
    add_text(doc, '适用端：Web 端与 Windows 桌面端', 9.5, MUTED, italic=True,
             align=WD_ALIGN_PARAGRAPH.CENTER, after=0)
    doc.add_page_break()


def add_contents(doc):
    add_heading(doc, '目录与使用范围', 1)
    add_text(doc, '本指南覆盖任务创建、多模态材料、模型提案审阅、人工校对、发布、版本回滚、权限边界和常见问题。建议首次使用者按顺序阅读第 1—5 章，熟练使用者可直接查阅任务、发布和故障处理章节。')
    add_steps(doc, [
        '工具定位与使用前准备',
        '界面结构和语义建模任务',
        '人工校对、校验与发布',
        '任务管理、版本和回滚',
        '权限安全、分辨率和故障处理',
    ])
    add_callout(doc, '执行边界', 'Agent 生成建议、计划和草稿，不会把自然语言直接当作业务授权。写入、发布、回滚和主键变更必须通过服务端权限、校验与显式确认。', color=DARK)


def strip_inline_markup(text):
    return text.replace('`', '').strip()


def flush_paragraph(doc, buffer):
    if not buffer:
        return
    text = strip_inline_markup(' '.join(part.strip() for part in buffer))
    if text:
        add_text(doc, text, size=10.5)
    buffer.clear()


def build_body(doc):
    lines = SOURCE.read_text(encoding='utf-8').splitlines()
    paragraph = []
    bullets = []
    numbers = []

    def flush_lists():
        nonlocal bullets, numbers
        if bullets:
            add_bullets(doc, [strip_inline_markup(item) for item in bullets])
            bullets = []
        if numbers:
            add_steps(doc, [strip_inline_markup(item) for item in numbers])
            numbers = []

    for raw in lines:
        line = raw.strip()
        if not line:
            flush_paragraph(doc, paragraph)
            flush_lists()
            continue
        if line.startswith('# '):
            continue
        if line.startswith('版本：') or line.startswith('适用端：') or line.startswith('更新日期：'):
            continue
        if line.startswith('## '):
            flush_paragraph(doc, paragraph)
            flush_lists()
            add_heading(doc, strip_inline_markup(line[3:]), 1)
            continue
        if line.startswith('### '):
            flush_paragraph(doc, paragraph)
            flush_lists()
            add_heading(doc, strip_inline_markup(line[4:]), 2)
            continue
        if line.startswith('> '):
            flush_paragraph(doc, paragraph)
            flush_lists()
            add_callout(doc, '示例', strip_inline_markup(line[2:]), color=DARK)
            continue
        if line.startswith('- '):
            flush_paragraph(doc, paragraph)
            if numbers:
                flush_lists()
            bullets.append(line[2:])
            continue
        number_match = re.match(r'^\d+\.\s+(.*)$', line)
        if number_match:
            flush_paragraph(doc, paragraph)
            if bullets:
                flush_lists()
            numbers.append(number_match.group(1))
            continue
        flush_lists()
        paragraph.append(line)

    flush_paragraph(doc, paragraph)
    flush_lists()


def main():
    doc = Document()
    configure_styles(doc)
    configure_numbering_styles(doc)
    set_running_furniture(doc.sections[0])
    add_cover(doc)
    add_contents(doc)
    build_body(doc)

    doc.core_properties.title = '元域智脑 - 语义运营 Agent 操作指南'
    doc.core_properties.subject = '语义运营、语义建模、Semantica 与版本治理操作说明'
    doc.core_properties.author = '元域智脑平台'
    doc.core_properties.keywords = '语义运营 Agent, Semantica, 语义建模, 操作指南'
    doc.save(OUTPUT)
    print(OUTPUT)


if __name__ == '__main__':
    main()
