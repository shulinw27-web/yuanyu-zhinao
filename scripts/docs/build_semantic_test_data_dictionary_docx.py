from pathlib import Path
from docx import Document
from docx.enum.section import WD_SECTION_START
from docx.enum.table import WD_ALIGN_VERTICAL
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor


OUTPUT = Path(__file__).resolve().parents[2] / "docs" / "reference" / "exports" / "元域智营-测试数据字典-v1.0.docx"

NAVY = "17324D"
BLUE = "2E74B5"
DARK_BLUE = "1F4D78"
MUTED = "667085"
LIGHT_BLUE = "E8EEF5"
LIGHT_GRAY = "F2F4F7"
PALE_GOLD = "FFF7E1"
GOLD = "7A5A00"
RED = "9B1C1C"
WHITE = "FFFFFF"
BORDER = "CBD5E1"
INK = "172B4D"


def set_font(run, name="Microsoft YaHei", size=10.5, bold=False, color=INK, italic=False):
    run.font.name = name
    run._element.get_or_add_rPr().rFonts.set(qn("w:ascii"), name)
    run._element.get_or_add_rPr().rFonts.set(qn("w:hAnsi"), name)
    run._element.get_or_add_rPr().rFonts.set(qn("w:eastAsia"), "Microsoft YaHei")
    run.font.size = Pt(size)
    run.bold = bold
    run.italic = italic
    run.font.color.rgb = RGBColor.from_string(color)


def set_cell_shading(cell, fill):
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = tc_pr.find(qn("w:shd"))
    if shd is None:
        shd = OxmlElement("w:shd")
        tc_pr.append(shd)
    shd.set(qn("w:fill"), fill)


def set_cell_margins(cell, top=80, start=120, bottom=80, end=120):
    tc_pr = cell._tc.get_or_add_tcPr()
    tc_mar = tc_pr.first_child_found_in("w:tcMar")
    if tc_mar is None:
        tc_mar = OxmlElement("w:tcMar")
        tc_pr.append(tc_mar)
    for margin, value in (("top", top), ("start", start), ("bottom", bottom), ("end", end)):
        node = tc_mar.find(qn(f"w:{margin}"))
        if node is None:
            node = OxmlElement(f"w:{margin}")
            tc_mar.append(node)
        node.set(qn("w:w"), str(value))
        node.set(qn("w:type"), "dxa")


def set_table_borders(table, color=BORDER, size="4"):
    tbl_pr = table._tbl.tblPr
    borders = tbl_pr.first_child_found_in("w:tblBorders")
    if borders is None:
        borders = OxmlElement("w:tblBorders")
        tbl_pr.append(borders)
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        el = borders.find(qn(f"w:{edge}"))
        if el is None:
            el = OxmlElement(f"w:{edge}")
            borders.append(el)
        el.set(qn("w:val"), "single")
        el.set(qn("w:sz"), size)
        el.set(qn("w:color"), color)


def set_repeat_table_header(row):
    tr_pr = row._tr.get_or_add_trPr()
    header = OxmlElement("w:tblHeader")
    header.set(qn("w:val"), "true")
    tr_pr.append(header)


def prevent_row_split(row):
    tr_pr = row._tr.get_or_add_trPr()
    cant_split = OxmlElement("w:cantSplit")
    cant_split.set(qn("w:val"), "true")
    tr_pr.append(cant_split)


def set_table_geometry(table, widths_dxa):
    total = sum(widths_dxa)
    table.autofit = False
    tbl_pr = table._tbl.tblPr
    tbl_w = tbl_pr.first_child_found_in("w:tblW")
    if tbl_w is None:
        tbl_w = OxmlElement("w:tblW")
        tbl_pr.append(tbl_w)
    tbl_w.set(qn("w:w"), str(total))
    tbl_w.set(qn("w:type"), "dxa")
    tbl_ind = tbl_pr.first_child_found_in("w:tblInd")
    if tbl_ind is None:
        tbl_ind = OxmlElement("w:tblInd")
        tbl_pr.append(tbl_ind)
    tbl_ind.set(qn("w:w"), "120")
    tbl_ind.set(qn("w:type"), "dxa")
    grid = table._tbl.tblGrid
    for child in list(grid):
        grid.remove(child)
    for width in widths_dxa:
        col = OxmlElement("w:gridCol")
        col.set(qn("w:w"), str(width))
        grid.append(col)
    for row in table.rows:
        prevent_row_split(row)
        for idx, cell in enumerate(row.cells):
            tc_pr = cell._tc.get_or_add_tcPr()
            tc_w = tc_pr.first_child_found_in("w:tcW")
            if tc_w is None:
                tc_w = OxmlElement("w:tcW")
                tc_pr.append(tc_w)
            tc_w.set(qn("w:w"), str(widths_dxa[idx]))
            tc_w.set(qn("w:type"), "dxa")
            cell.width = Inches(widths_dxa[idx] / 1440)
            cell.vertical_alignment = WD_ALIGN_VERTICAL.CENTER
            set_cell_margins(cell)


def style_table_text(table, header=True, font_size=8.4):
    for r_idx, row in enumerate(table.rows):
        if r_idx == 0 and header:
            set_repeat_table_header(row)
        for c_idx, cell in enumerate(row.cells):
            if r_idx == 0 and header:
                set_cell_shading(cell, LIGHT_BLUE)
            elif r_idx % 2 == 0:
                set_cell_shading(cell, "F8FAFC")
            for paragraph in cell.paragraphs:
                paragraph.paragraph_format.space_before = Pt(0)
                paragraph.paragraph_format.space_after = Pt(0)
                paragraph.paragraph_format.line_spacing = 1.05
                paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER if c_idx in (2, 3) else WD_ALIGN_PARAGRAPH.LEFT
                for run in paragraph.runs:
                    set_font(run, size=font_size, bold=(r_idx == 0), color=NAVY if r_idx == 0 else INK)
    set_table_borders(table)


def add_heading(doc, text, level=1):
    p = doc.add_paragraph(text, style=f"Heading {level}")
    p.paragraph_format.keep_with_next = True
    return p


def add_body(doc, text, bold_prefix=None):
    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(6)
    p.paragraph_format.line_spacing = 1.25
    if bold_prefix and text.startswith(bold_prefix):
        first = p.add_run(bold_prefix)
        set_font(first, bold=True)
        rest = p.add_run(text[len(bold_prefix):])
        set_font(rest)
    else:
        set_font(p.add_run(text))
    return p


def add_callout(doc, label, text, fill=PALE_GOLD, color=GOLD):
    # Use a shaded paragraph instead of a one-cell layout table so assistive
    # technology does not announce the callout as tabular data.
    p = doc.add_paragraph()
    p_pr = p._p.get_or_add_pPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:fill"), fill)
    p_pr.append(shd)
    p_bdr = OxmlElement("w:pBdr")
    for edge in ("top", "left", "bottom", "right"):
        border = OxmlElement(f"w:{edge}")
        border.set(qn("w:val"), "single")
        border.set(qn("w:sz"), "8")
        border.set(qn("w:color"), fill)
        p_bdr.append(border)
    p_pr.append(p_bdr)
    p.paragraph_format.left_indent = Pt(7)
    p.paragraph_format.right_indent = Pt(7)
    p.paragraph_format.space_before = Pt(5)
    p.paragraph_format.space_after = Pt(5)
    p.paragraph_format.space_after = Pt(0)
    p.paragraph_format.line_spacing = 1.15
    set_font(p.add_run(f"{label}  "), size=9.5, bold=True, color=color)
    set_font(p.add_run(text), size=9.5, color=INK)
    doc.add_paragraph().paragraph_format.space_after = Pt(2)


def add_metadata_rows(doc, rows, keep_with_next=False):
    for label, value in rows:
        p = doc.add_paragraph()
        p.paragraph_format.space_after = Pt(2)
        p.paragraph_format.line_spacing = 1.05
        p.paragraph_format.keep_with_next = keep_with_next
        set_font(p.add_run(f"{label}："), size=9.5, bold=True, color=NAVY)
        set_font(p.add_run(value), size=9.5, color=INK)


def add_small_table(doc, headers, rows, widths, font_size=8.6):
    table = doc.add_table(rows=1, cols=len(headers))
    for idx, header in enumerate(headers):
        table.rows[0].cells[idx].text = header
    for row in rows:
        cells = table.add_row().cells
        for idx, value in enumerate(row):
            cells[idx].text = str(value)
    set_table_geometry(table, widths)
    style_table_text(table, font_size=font_size)
    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(4)
    return table


SYSTEMS = [
    ("ERP", "企业资源计划", "采购、供应商、产品主数据", "10.20.10.15", "Asia/Shanghai", "每日全量 + 5 分钟增量"),
    ("WMS", "仓储管理", "仓库、库存批次、库位", "10.20.20.21", "UTC", "事件推送 + 每小时对账"),
    ("QMS", "质量管理", "检验、不合格、处置", "10.20.30.18", "Asia/Shanghai", "10 分钟增量"),
    ("OA", "协同办公", "人员、组织、审批实例", "10.20.40.12", "Asia/Shanghai", "Webhook + 每日校验"),
]


ENTITIES = [
    {
        "system": "ERP", "table": "md_product", "name": "产品主数据", "grain": "每个产品编码一条记录",
        "classification": "内部", "retention": "主数据长期保留", "sensitive": "无个人信息",
        "fields": [
            ("product_code", "产品编码", "varchar(32)", "PK, NOT NULL", "ERP 产品唯一标识；与 WMS.sku_code 语义等价但编码规则不同", "PRD-VC-1000"),
            ("product_name", "产品名称", "varchar(128)", "NOT NULL", "产品对外名称；允许多语言别名", "维生素C原料"),
            ("product_category", "产品分类", "varchar(32)", "NOT NULL", "RAW=原料，SEMI=半成品，FIN=成品", "RAW"),
            ("base_uom", "基础计量单位", "varchar(12)", "NOT NULL", "数量归一化单位；KG、G、EA", "KG"),
            ("specification", "规格", "varchar(128)", "NULL", "包装或技术规格的显示文本，不作为换算依据", "25kg/袋"),
            ("quality_status", "质量状态", "varchar(16)", "NOT NULL", "QUALIFIED、REJECTED、PENDING；与 QMS 检验结果需映射", "PENDING"),
            ("active_flag", "是否启用", "boolean", "NOT NULL", "停用产品不得用于新采购单", "true"),
            ("updated_at", "更新时间", "timestamp", "NOT NULL", "ERP 本地时间，无时区后缀", "2026-08-30 09:15:20"),
        ],
    },
    {
        "system": "ERP", "table": "md_supplier", "name": "供应商主数据", "grain": "每个供应商编码一条记录",
        "classification": "内部敏感", "retention": "合作终止后保留 7 年", "sensitive": "联系人姓名、电话需脱敏",
        "fields": [
            ("supplier_id", "供应商编码", "varchar(24)", "PK, NOT NULL", "ERP 权威供应商标识；WMS 使用 vendor_code", "SUP-000187"),
            ("supplier_name", "供应商名称", "varchar(160)", "NOT NULL", "工商登记名称", "华东新材料有限公司"),
            ("credit_level", "信用等级", "char(1)", "NOT NULL", "A、B、C、D；D 级禁止新建采购", "A"),
            ("qualification_expiry", "资质到期日", "date", "NULL", "为空表示尚未完成资质录入，不代表长期有效", "2027-06-30"),
            ("contact_name", "联系人", "varchar(64)", "NULL, PII", "仅采购角色可见；语义层默认隐藏", "张某"),
            ("contact_phone", "联系电话", "varchar(32)", "NULL, PII", "输出时保留前三后四", "138****5721"),
            ("status", "合作状态", "varchar(16)", "NOT NULL", "ACTIVE、SUSPENDED、CLOSED", "ACTIVE"),
        ],
    },
    {
        "system": "ERP", "table": "po_order", "name": "采购订单", "grain": "每张采购订单一条记录",
        "classification": "商业敏感", "retention": "订单关闭后保留 10 年", "sensitive": "金额与供应商范围受角色控制",
        "fields": [
            ("po_no", "采购订单号", "varchar(30)", "PK, NOT NULL", "采购订单业务主键", "PO-202608-00421"),
            ("supplier_id", "供应商编码", "varchar(24)", "FK, NOT NULL", "关联 md_supplier.supplier_id", "SUP-000187"),
            ("order_date", "下单日期", "date", "NOT NULL", "采购订单创建日期", "2026-08-25"),
            ("currency", "币种", "char(3)", "NOT NULL", "ISO 4217 代码", "CNY"),
            ("total_amount", "含税总额", "decimal(18,2)", "NOT NULL", "订单币种金额，不可跨币种直接汇总", "33000.00"),
            ("status", "订单状态", "varchar(20)", "NOT NULL", "DRAFT、APPROVING、APPROVED、PART_RECEIVED、CLOSED、CANCELLED", "APPROVED"),
            ("oa_approval_id", "OA审批实例", "varchar(40)", "NULL", "关联 OA.oa_approval_instance.instance_id", "APR-202608-9812"),
            ("expected_date", "预计到货日", "date", "NULL", "订单级期望日期；行项目日期优先", "2026-09-05"),
        ],
    },
    {
        "system": "ERP", "table": "po_order_line", "name": "采购订单行", "grain": "每张订单每个行号一条记录",
        "classification": "商业敏感", "retention": "随采购订单", "sensitive": "单价与数量受采购数据域控制",
        "fields": [
            ("po_no", "采购订单号", "varchar(30)", "PK/FK, NOT NULL", "关联 po_order.po_no", "PO-202608-00421"),
            ("line_no", "行号", "integer", "PK, NOT NULL", "订单内从 1 递增", "1"),
            ("product_code", "产品编码", "varchar(32)", "FK, NOT NULL", "关联 md_product.product_code", "PRD-VC-1000"),
            ("order_qty", "订购数量", "decimal(18,3)", "NOT NULL", "必须与 order_uom 组合解释", "400.000"),
            ("order_uom", "订购单位", "varchar(12)", "NOT NULL", "可能与产品基础单位不同", "KG"),
            ("unit_price", "含税单价", "decimal(18,4)", "NOT NULL", "订单币种/订购单位", "82.5000"),
            ("expected_date", "行预计到货日", "date", "NULL", "为空时继承订单级 expected_date", "2026-09-05"),
        ],
    },
    {
        "system": "WMS", "table": "wh_warehouse", "name": "仓库主数据", "grain": "每个仓库编码一条记录",
        "classification": "内部", "retention": "主数据长期保留", "sensitive": "地址仅内部可见",
        "fields": [
            ("warehouse_code", "仓库编码", "varchar(20)", "PK, NOT NULL", "WMS 仓库唯一标识", "WH-SH-01"),
            ("warehouse_name", "仓库名称", "varchar(100)", "NOT NULL", "仓库显示名称", "上海原料一库"),
            ("org_code", "所属组织", "varchar(20)", "NOT NULL", "需映射 OA.organization_code", "ORG-PROD-SH"),
            ("warehouse_type", "仓库类型", "varchar(16)", "NOT NULL", "RAW、FINISHED、QUARANTINE", "RAW"),
            ("timezone", "时区", "varchar(40)", "NOT NULL", "IANA 时区；库存事件时间按此解释", "UTC"),
            ("active_flag", "是否启用", "boolean", "NOT NULL", "停用后只允许历史查询", "true"),
        ],
    },
    {
        "system": "WMS", "table": "inv_lot", "name": "库存批次", "grain": "每个仓库、SKU、批次一条当前库存快照",
        "classification": "内部敏感", "retention": "快照 2 年，变更事件 7 年", "sensitive": "库存数量按组织权限裁剪",
        "fields": [
            ("lot_id", "库存批次ID", "uuid", "PK, NOT NULL", "WMS 技术主键，不作为业务展示编号", "3f6c0c10-..."),
            ("warehouse_code", "仓库编码", "varchar(20)", "FK, NOT NULL", "关联 wh_warehouse.warehouse_code", "WH-SH-01"),
            ("sku_code", "SKU编码", "varchar(40)", "NOT NULL", "对应 ERP.product_code；需通过主数据映射表转换", "SKU-VC-025"),
            ("batch_no", "业务批号", "varchar(40)", "NOT NULL", "供应/生产批次号；跨系统追溯键", "RM-20260718"),
            ("stock_qty", "现存数量", "decimal(18,3)", "NOT NULL", "必须与 stock_uom 组合解释", "1860.000"),
            ("stock_uom", "库存单位", "varchar(12)", "NOT NULL", "BAG、KG、EA；与 ERP 基础单位可能不同", "BAG"),
            ("quality_hold", "质量冻结", "boolean", "NOT NULL", "true 时库存不可分配", "true"),
            ("expiry_date", "有效期至", "date", "NULL", "为空表示未维护，不代表无有效期", "2028-07-17"),
            ("last_event_time", "最后事件时间", "timestamp", "NOT NULL", "无时区后缀，按仓库 timezone 解释", "2026-08-30 01:22:09"),
        ],
    },
    {
        "system": "QMS", "table": "qc_inspection", "name": "质量检验单", "grain": "每个检验单号一条记录",
        "classification": "质量敏感", "retention": "检验完成后保留 10 年", "sensitive": "检验人按审计权限查看",
        "fields": [
            ("inspection_no", "检验单号", "varchar(32)", "PK, NOT NULL", "质量检验业务主键", "QC-202608-0042"),
            ("batch_no", "批号", "varchar(40)", "NOT NULL", "关联 WMS.inv_lot.batch_no；非数据库外键", "RM-20260718"),
            ("product_ref", "物料引用", "varchar(40)", "NOT NULL", "可能存 ERP product_code 或 WMS sku_code，来源不一致", "SKU-VC-025"),
            ("inspection_type", "检验类型", "varchar(20)", "NOT NULL", "INCOMING、PROCESS、FINAL、RETEST", "INCOMING"),
            ("result", "检验结果", "varchar(16)", "NOT NULL", "PASS、FAIL、HOLD；与 ERP quality_status 枚举不一致", "HOLD"),
            ("sample_qty", "抽样数量", "decimal(12,3)", "NOT NULL", "抽样数量，不等于受影响库存数量", "5.000"),
            ("sample_uom", "抽样单位", "varchar(12)", "NOT NULL", "抽样计量单位", "KG"),
            ("inspector_user_id", "检验人", "varchar(32)", "FK, NOT NULL", "关联 OA.oa_user.user_id", "U-QA-0017"),
            ("completed_at", "完成时间", "datetimeoffset", "NULL", "ISO 8601，带时区", "2026-08-29T16:20:00+08:00"),
            ("version_no", "记录版本", "integer", "NOT NULL", "乐观锁版本；更正检验结果时递增", "3"),
        ],
    },
    {
        "system": "QMS", "table": "qc_nonconformance", "name": "不合格事件", "grain": "每个不合格事件编号一条记录",
        "classification": "质量敏感", "retention": "关闭后保留 10 年", "sensitive": "原因和责任部门按质量域控制",
        "fields": [
            ("nc_no", "不合格编号", "varchar(32)", "PK, NOT NULL", "不合格事件业务主键", "NC-202608-0118"),
            ("inspection_no", "检验单号", "varchar(32)", "FK, NOT NULL", "关联 qc_inspection.inspection_no", "QC-202608-0042"),
            ("severity", "严重度", "varchar(12)", "NOT NULL", "MINOR、MAJOR、CRITICAL", "MAJOR"),
            ("reason_code", "原因编码", "varchar(32)", "NULL", "空值表示原因调查中", "PKG-DAMAGE"),
            ("affected_qty", "影响数量", "decimal(18,3)", "NOT NULL", "与 affected_uom 组合解释", "50.000"),
            ("affected_uom", "影响单位", "varchar(12)", "NOT NULL", "需转换为产品基础单位才能汇总", "KG"),
            ("disposition", "处置决定", "varchar(20)", "NULL", "RETURN、REWORK、SCRAP、USE_AS_IS；空值表示待评审", "RETURN"),
            ("status", "事件状态", "varchar(16)", "NOT NULL", "OPEN、INVESTIGATING、DISPOSED、CLOSED", "INVESTIGATING"),
        ],
    },
    {
        "system": "OA", "table": "oa_user", "name": "人员账号", "grain": "每个企业人员账号一条记录",
        "classification": "个人信息", "retention": "离职后 2 年转匿名映射", "sensitive": "姓名、邮箱、组织为 PII/组织信息",
        "fields": [
            ("user_id", "人员账号ID", "varchar(32)", "PK, NOT NULL", "OA 权威人员标识，不复用", "U-QA-0017"),
            ("employee_no", "工号", "varchar(24)", "UNIQUE, NOT NULL", "显示用工号；历史上存在补零差异", "QA0017"),
            ("display_name", "姓名", "varchar(80)", "NOT NULL, PII", "前端显示；普通日志不得记录", "李某"),
            ("email", "企业邮箱", "varchar(120)", "NULL, PII", "可变属性，不作为跨系统永久主键", "li***@example.test"),
            ("organization_code", "组织编码", "varchar(24)", "NOT NULL", "组织树节点；WMS 使用 org_code", "ORG-QA-SH"),
            ("employment_status", "任职状态", "varchar(16)", "NOT NULL", "ACTIVE、LEAVE、TERMINATED", "ACTIVE"),
            ("updated_at", "更新时间", "datetimeoffset", "NOT NULL", "带时区的权威变更时间", "2026-08-30T08:30:00+08:00"),
        ],
    },
    {
        "system": "OA", "table": "oa_approval_instance", "name": "审批实例", "grain": "每个审批实例一条记录",
        "classification": "内部敏感", "retention": "流程结束后保留 10 年", "sensitive": "审批意见默认不进入模型上下文",
        "fields": [
            ("instance_id", "审批实例ID", "varchar(40)", "PK, NOT NULL", "OA 流程实例业务主键", "APR-202608-9812"),
            ("business_type", "业务类型", "varchar(32)", "NOT NULL", "PURCHASE_ORDER、SUPPLIER、QUALITY_DISPOSITION", "PURCHASE_ORDER"),
            ("business_key", "业务单据号", "varchar(48)", "NOT NULL", "对应源系统业务主键，不保证数据库外键", "PO-202608-00421"),
            ("applicant_user_id", "申请人", "varchar(32)", "FK, NOT NULL", "关联 oa_user.user_id", "U-PROC-0008"),
            ("status", "审批状态", "varchar(20)", "NOT NULL", "DRAFT、RUNNING、APPROVED、REJECTED、CANCELLED", "APPROVED"),
            ("current_node", "当前节点", "varchar(80)", "NULL", "结束流程为空；不可据此推断审批人", ""),
            ("started_at", "发起时间", "datetimeoffset", "NULL", "DRAFT 状态可能为空", "2026-08-25T10:10:00+08:00"),
            ("completed_at", "结束时间", "datetimeoffset", "NULL", "仅终态有值", "2026-08-25T15:42:00+08:00"),
            ("version_no", "流程版本", "integer", "NOT NULL", "状态更新时递增，供幂等同步", "6"),
        ],
    },
]


RELATIONSHIPS = [
    ("ERP.md_supplier", "1:N", "ERP.po_order", "supplier_id", "供应商拥有采购订单", "强关系/同库外键"),
    ("ERP.po_order", "1:N", "ERP.po_order_line", "po_no", "采购订单包含订单行", "强关系/复合主键"),
    ("ERP.md_product", "1:N", "ERP.po_order_line", "product_code", "产品被采购订单行引用", "强关系/同库外键"),
    ("ERP.md_product", "1:N", "WMS.inv_lot", "product_code ↔ sku_code", "产品对应库存批次", "需主数据映射"),
    ("WMS.inv_lot", "1:N", "QMS.qc_inspection", "batch_no", "库存批次产生质量检验", "跨系统业务键"),
    ("QMS.qc_inspection", "1:N", "QMS.qc_nonconformance", "inspection_no", "检验产生不合格事件", "强关系/同库外键"),
    ("OA.oa_user", "1:N", "QMS.qc_inspection", "user_id ↔ inspector_user_id", "人员执行质量检验", "跨系统人员标识"),
    ("OA.oa_approval_instance", "0..1:1", "ERP.po_order", "instance_id ↔ oa_approval_id", "审批实例授权采购订单", "跨系统显式引用"),
]


ENUMS = [
    ("产品质量状态", "ERP.quality_status", "QUALIFIED / REJECTED / PENDING", "QMS.result", "PASS / FAIL / HOLD", "PASS→QUALIFIED；FAIL→REJECTED；HOLD→PENDING"),
    ("审批状态", "ERP.po_order.status", "DRAFT / APPROVING / APPROVED / ...", "OA.status", "DRAFT / RUNNING / APPROVED / ...", "APPROVING→RUNNING；其余需按终态规则映射"),
    ("组织编码", "WMS.org_code", "ORG-PROD-SH", "OA.organization_code", "ORG-QA-SH", "同一编码体系，需校验组织树存在"),
    ("产品编码", "ERP.product_code", "PRD-VC-1000", "WMS.sku_code", "SKU-VC-025", "通过 product_sku_mapping 映射，不可字符串猜测"),
    ("供应商编码", "ERP.supplier_id", "SUP-000187", "WMS.vendor_code", "V000187", "通过 supplier_vendor_mapping 映射"),
    ("重量单位", "ERP.base_uom", "KG / G", "WMS.stock_uom", "KG / BAG", "BAG 必须结合包装换算率，禁止固定按 25kg"),
]


CONFLICTS = [
    ("C-01", "产品标识同义", "ERP.product_code 与 WMS.sku_code 指向同一产品，但编码完全不同。", "建立 Product 元对象与受版本控制的映射关系；禁止按名称自动合并。", "高"),
    ("C-02", "质量枚举冲突", "ERP.quality_status 和 QMS.result 枚举不同，HOLD 不等于 FAIL。", "定义统一 QualityDisposition 枚举并保留原始值。", "高"),
    ("C-03", "时间语义冲突", "ERP 无时区时间按 Asia/Shanghai；WMS 库存事件按仓库 timezone，本例为 UTC。", "所有事件转为 UTC，同时保留 source_timezone 与原始文本。", "高"),
    ("C-04", "计量单位不可直接汇总", "WMS BAG 与 ERP KG 存在包装换算依赖，规格文本不能充当换算率。", "建立 UomConversion 元对象，按产品和生效日期管理。", "高"),
    ("C-05", "空值含义不一致", "资质到期日、有效期、完成时间为空均有不同业务含义。", "字段级定义 missing_reason，不把 NULL 统一解释为“不适用”。", "中"),
    ("C-06", "物料引用来源不稳定", "QMS.product_ref 可能保存 ERP 产品编码或 WMS SKU。", "新增 reference_system 字段；存量数据进入待复核队列。", "高"),
]


def configure_document(doc):
    section = doc.sections[0]
    section.page_width = Inches(8.5)
    section.page_height = Inches(11)
    section.top_margin = Inches(0.78)
    section.bottom_margin = Inches(0.72)
    section.left_margin = Inches(1.0)
    section.right_margin = Inches(1.0)
    section.header_distance = Inches(0.35)
    section.footer_distance = Inches(0.35)

    styles = doc.styles
    normal = styles["Normal"]
    normal.font.name = "Microsoft YaHei"
    normal._element.rPr.rFonts.set(qn("w:eastAsia"), "Microsoft YaHei")
    normal.font.size = Pt(10.5)
    normal.font.color.rgb = RGBColor.from_string(INK)
    normal.paragraph_format.space_after = Pt(6)
    normal.paragraph_format.line_spacing = 1.25
    for name, size, color, before, after in (
        ("Heading 1", 16, BLUE, 18, 10),
        ("Heading 2", 13, BLUE, 14, 7),
        ("Heading 3", 11.5, DARK_BLUE, 10, 5),
    ):
        style = styles[name]
        style.font.name = "Microsoft YaHei"
        style._element.rPr.rFonts.set(qn("w:eastAsia"), "Microsoft YaHei")
        style.font.size = Pt(size)
        style.font.bold = True
        style.font.color.rgb = RGBColor.from_string(color)
        style.paragraph_format.space_before = Pt(before)
        style.paragraph_format.space_after = Pt(after)
        style.paragraph_format.keep_with_next = True

    header = section.header
    hp = header.paragraphs[0]
    hp.alignment = WD_ALIGN_PARAGRAPH.LEFT
    hp.paragraph_format.space_after = Pt(0)
    set_font(hp.add_run("元域智脑  |  元域智营测试资料"), size=8.5, bold=True, color=MUTED)

    footer = section.footer
    fp = footer.paragraphs[0]
    fp.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    set_font(fp.add_run("模拟数据 · 仅用于测试  |  第 "), size=8, color=MUTED)
    fld = OxmlElement("w:fldSimple")
    fld.set(qn("w:instr"), "PAGE")
    fp._p.append(fld)
    set_font(fp.add_run(" 页"), size=8, color=MUTED)


def build_document():
    doc = Document()
    configure_document(doc)
    doc.core_properties.title = "元域智脑元域智营测试数据字典"
    doc.core_properties.subject = "ERP、WMS、QMS、OA 跨系统语义建模模拟输入"
    doc.core_properties.author = "元域智脑测试数据生成器"
    doc.core_properties.keywords = "数据字典,语义层,元对象,元模型,模拟数据"

    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(22)
    p.paragraph_format.space_after = Pt(3)
    set_font(p.add_run("TECHNICAL DATA DICTIONARY"), size=9, bold=True, color=BLUE)
    title = doc.add_paragraph()
    title.paragraph_format.space_after = Pt(6)
    set_font(title.add_run("元域智营测试数据字典"), size=25, bold=True, color=NAVY)
    subtitle = doc.add_paragraph()
    subtitle.paragraph_format.space_after = Pt(18)
    set_font(subtitle.add_run("ERP · WMS · QMS · OA 跨系统模拟数据"), size=13, color=DARK_BLUE)

    add_metadata_rows(doc, [
        ("文档编号", "SEM-TEST-DD-001"),
        ("版本", "v1.0"),
        ("数据性质", "完全虚构的合成数据，不对应任何真实企业或个人"),
        ("测试目标", "验证元对象抽取、字段归类、主外键识别、跨系统关系发现、枚举映射和冲突校正"),
        ("建议输入", "将本 DOCX 作为数据字典上传至元域智营 Agent，要求先生成草稿，不直接发布"),
    ])
    add_callout(doc, "测试提醒", "本文故意保留 6 类建模歧义。合格的元域智营 Agent 应把它们标记为待确认，而不是自行猜测并直接发布。")

    add_heading(doc, "1. 文档说明", 1)
    add_body(doc, "本数据字典模拟一家通用制造企业的 ERP、WMS、QMS 和 OA 数据资产。字段、地址、人员、金额与业务编号均为测试数据，用于验证语义建模流程，不得作为生产事实。")
    add_body(doc, "建模口径：优先识别稳定业务对象，再识别对象属性、状态、事件和关系；技术主键与业务标识应分开；跨系统同义字段必须经过映射或人工确认。")

    add_heading(doc, "2. 数据源目录", 1)
    add_small_table(doc,
        ["系统", "系统名称", "权威范围", "模拟地址", "时间语义", "同步方式"],
        SYSTEMS,
        [700, 1150, 1850, 1200, 1500, 2960],
        font_size=8.2,
    )

    add_heading(doc, "3. 实体总览", 1)
    overview = [(e["system"], e["table"], e["name"], e["grain"], e["classification"], len(e["fields"])) for e in ENTITIES]
    add_small_table(doc,
        ["系统", "物理表", "业务对象", "数据粒度", "分级", "字段数"],
        overview,
        [800, 2050, 1300, 2500, 1500, 1210],
        font_size=8.3,
    )

    add_heading(doc, "4. 字段级数据字典", 1)
    add_body(doc, "以下表格是元域智营 Agent 的主要解析输入。主键、外键、空值和枚举仅代表源系统现状；统一语义模型应保留来源和版本，不覆盖源字段。")
    current_system = None
    for entity in ENTITIES:
        if entity["system"] != current_system:
            current_system = entity["system"]
            add_heading(doc, f"4.{['ERP','WMS','QMS','OA'].index(current_system)+1} {current_system} 数据对象", 2)
        entity_heading = add_heading(doc, f"{entity['name']}（{entity['table']}）", 3)
        if entity["table"] == "qc_nonconformance":
            # Paragraph-level page breaks preserve the document header and
            # top margin more reliably than an inline page-break run.
            entity_heading.paragraph_format.page_break_before = True
        add_metadata_rows(doc, [
            ("数据粒度", entity["grain"]),
            ("数据分级", entity["classification"]),
            ("保留策略", entity["retention"]),
            ("敏感边界", entity["sensitive"]),
        ], keep_with_next=True)
        add_small_table(doc,
            ["字段代码", "中文名称", "类型/长度", "约束", "业务语义与规则", "模拟值"],
            entity["fields"],
            [1300, 1100, 1100, 1000, 3100, 1760],
            font_size=7.8,
        )

    add_heading(doc, "5. 跨系统关系", 1)
    add_small_table(doc,
        ["起点对象", "基数", "终点对象", "关联字段", "业务关系", "可信度/处理"],
        RELATIONSHIPS,
        [1450, 700, 1450, 1750, 2300, 1710],
        font_size=8.0,
    )

    add_heading(doc, "6. 枚举与编码映射", 1)
    add_small_table(doc,
        ["统一概念", "来源A", "值域A", "来源B", "值域B", "建议映射"],
        ENUMS,
        [1050, 1450, 1700, 1450, 1700, 2010],
        font_size=7.8,
    )

    add_heading(doc, "7. 待人工确认的建模冲突", 1)
    add_callout(doc, "验收重点", "元域智营 Agent 应先输出模型 Diff 与冲突清单。下列问题在人工确认前不得进入已发布语义版本。", fill="FDECEC", color=RED)
    add_small_table(doc,
        ["编号", "冲突类型", "现状", "建议治理", "风险"],
        CONFLICTS,
        [700, 1300, 3000, 3410, 950],
        font_size=8.0,
    )

    section_8_heading = add_heading(doc, "8. 预期抽取的元对象与关系", 1)
    section_8_heading.paragraph_format.page_break_before = True
    expected_objects = [
        ("Product", "产品", "ERP.md_product", "product_code", "核心主数据"),
        ("Supplier", "供应商", "ERP.md_supplier", "supplier_id", "核心主数据"),
        ("PurchaseOrder", "采购订单", "ERP.po_order", "po_no", "业务单据"),
        ("PurchaseOrderLine", "采购订单行", "ERP.po_order_line", "po_no + line_no", "业务明细"),
        ("Warehouse", "仓库", "WMS.wh_warehouse", "warehouse_code", "组织资产"),
        ("InventoryLot", "库存批次", "WMS.inv_lot", "lot_id / batch_no", "事实快照"),
        ("QualityInspection", "质量检验", "QMS.qc_inspection", "inspection_no", "业务事件"),
        ("Nonconformance", "不合格事件", "QMS.qc_nonconformance", "nc_no", "风险事件"),
        ("Person", "人员", "OA.oa_user", "user_id", "身份主数据"),
        ("ApprovalInstance", "审批实例", "OA.oa_approval_instance", "instance_id", "流程实例"),
    ]
    add_small_table(doc,
        ["元对象代码", "业务名称", "主要来源", "业务标识", "对象类别"],
        expected_objects,
        [1700, 1300, 2500, 2200, 1660],
        font_size=8.2,
    )
    add_body(doc, "建议关系包括：Supplier supplies PurchaseOrder；PurchaseOrder contains PurchaseOrderLine；Product referencedBy PurchaseOrderLine；Product stockedAs InventoryLot；InventoryLot inspectedBy QualityInspection；QualityInspection produces Nonconformance；Person performs QualityInspection；ApprovalInstance authorizes PurchaseOrder。")

    add_heading(doc, "9. 可复制的结构化片段", 1)
    add_body(doc, "该片段用于检查 Agent 能否同时理解自然语言表格和结构化声明；其内容仍需经过 Schema Critic 与人工 Diff。")
    code = """semantic_model_draft:
  objects:
    - code: Product
      source: ERP.md_product
      business_key: product_code
    - code: InventoryLot
      source: WMS.inv_lot
      business_key: lot_id
  relationships:
    - from: Product
      predicate: stocked_as
      to: InventoryLot
      mapping_required: true
      join: ERP.product_code <-> WMS.sku_code
  unresolved:
    - id: C-04
      issue: BAG 到 KG 的换算率依赖产品与生效日期
      publication_gate: human_confirmation"""
    p = doc.add_paragraph()
    p.paragraph_format.left_indent = Inches(0.2)
    p.paragraph_format.right_indent = Inches(0.2)
    p.paragraph_format.space_after = Pt(10)
    set_font(p.add_run(code), name="Consolas", size=8.5, color=NAVY)

    add_heading(doc, "10. 元域智营测试问题", 1)
    questions = [
        ("T-01", "从文档中提取所有候选元对象、业务标识、来源系统和数据分级。", "应得到 10 个核心候选对象。"),
        ("T-02", "识别产品、库存批次、质量检验之间的关系，并说明跨系统关联依据。", "不得按名称猜测产品映射。"),
        ("T-03", "列出所有枚举冲突和建议的统一枚举，但不要直接发布。", "应识别质量与审批状态差异。"),
        ("T-04", "找出所有时间字段，统一说明其时区解释和标准化方案。", "应区分 ERP 本地时间、WMS 仓库时区和 datetimeoffset。"),
        ("T-05", "判断库存 1,860 BAG 能否直接换算为 KG。", "正确答案是不能，需产品级换算率。"),
        ("T-06", "生成当前模型与建议模型的 Diff，并把高风险冲突放入人工确认队列。", "不得自动接受 C-01 至 C-06。"),
        ("T-07", "检查哪些字段属于个人信息或商业敏感信息，并提出默认可见性。", "联系人、人员、金额和库存需权限裁剪。"),
        ("T-08", "为 PurchaseOrder 建立从申请人、审批实例到供应商和订单行的可追溯路径。", "关系必须保留来源、版本和业务键。"),
    ]
    add_small_table(doc, ["用例", "对 Agent 的自然语言指令", "验收要点"], questions, [900, 5500, 2960], font_size=8.4)

    add_heading(doc, "11. 验收判断", 1)
    criteria = [
        "能从 DOCX 表格中完整抽取对象、字段、类型、约束和示例值；",
        "能区分技术主键、业务标识、外键和跨系统业务关联；",
        "能把同义、冲突、缺失和不确定项显示为可编辑草稿；",
        "能生成元模型 Diff，不在未确认时发布或覆盖既有版本；",
        "能保留来源系统、字段路径、采集时间、数据分级和映射依据；",
        "不会把模拟金额、联系人、库存或检验结果当成真实企业事实。",
    ]
    for item in criteria:
        p = doc.add_paragraph(style="List Bullet")
        p.paragraph_format.space_after = Pt(4)
        p.paragraph_format.line_spacing = 1.2
        set_font(p.add_run(item), size=10)
    add_callout(doc, "结束条件", "测试通过后只保存语义草稿和 Diff；除非用户另行确认，不执行发布、回滚或连接真实系统。", fill=LIGHT_BLUE, color=DARK_BLUE)

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    doc.save(OUTPUT)
    print(OUTPUT)


if __name__ == "__main__":
    build_document()
