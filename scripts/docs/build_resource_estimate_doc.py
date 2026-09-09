from pathlib import Path

from docx import Document
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor

OUT = Path(__file__).resolve().parents[2] / 'docs' / 'reference' / 'exports' / '元域智营AI基座-项目资源与配置估算.docx'
BLUE, DARK, INK, MUTED = '2E74B5', '1F4D78', '0B2545', '5B6773'
LIGHT_BLUE, LIGHT_GRAY, CALLOUT = 'E8EEF5', 'F2F4F7', 'F4F6F9'


def font(run, size=11, color='263746', bold=False):
    run.font.name = 'Calibri'
    run._element.rPr.rFonts.set(qn('w:ascii'), 'Calibri')
    run._element.rPr.rFonts.set(qn('w:hAnsi'), 'Calibri')
    run._element.rPr.rFonts.set(qn('w:eastAsia'), 'Microsoft YaHei')
    run.font.size = Pt(size)
    run.font.color.rgb = RGBColor.from_string(color)
    run.bold = bold


def style(s, size, color, before, after, bold=False, line=1.25):
    s.font.name = 'Calibri'
    s._element.rPr.rFonts.set(qn('w:ascii'), 'Calibri')
    s._element.rPr.rFonts.set(qn('w:hAnsi'), 'Calibri')
    s._element.rPr.rFonts.set(qn('w:eastAsia'), 'Microsoft YaHei')
    s.font.size = Pt(size)
    s.font.color.rgb = RGBColor.from_string(color)
    s.font.bold = bold
    s.paragraph_format.space_before = Pt(before)
    s.paragraph_format.space_after = Pt(after)
    s.paragraph_format.line_spacing = line
    s.paragraph_format.keep_with_next = s.name != 'Normal'


def margins(cell):
    tc_pr = cell._tc.get_or_add_tcPr()
    tc_mar = tc_pr.first_child_found_in('w:tcMar')
    if tc_mar is None:
        tc_mar = OxmlElement('w:tcMar')
        tc_pr.append(tc_mar)
    for side, width in [('top', 80), ('start', 120), ('bottom', 80), ('end', 120)]:
        elem = tc_mar.find(qn(f'w:{side}'))
        if elem is None:
            elem = OxmlElement(f'w:{side}')
            tc_mar.append(elem)
        elem.set(qn('w:w'), str(width))
        elem.set(qn('w:type'), 'dxa')


def shade(cell, color):
    tc_pr = cell._tc.get_or_add_tcPr()
    node = tc_pr.find(qn('w:shd'))
    if node is None:
        node = OxmlElement('w:shd')
        tc_pr.append(node)
    node.set(qn('w:fill'), color)


def geo(table, widths):
    table.autofit = False
    tbl_pr = table._tbl.tblPr
    tbl_w = tbl_pr.first_child_found_in('w:tblW')
    if tbl_w is None:
        tbl_w = OxmlElement('w:tblW')
        tbl_pr.append(tbl_w)
    tbl_w.set(qn('w:w'), str(sum(widths)))
    tbl_w.set(qn('w:type'), 'dxa')
    ind = tbl_pr.first_child_found_in('w:tblInd')
    if ind is None:
        ind = OxmlElement('w:tblInd')
        tbl_pr.append(ind)
    ind.set(qn('w:w'), '120')
    ind.set(qn('w:type'), 'dxa')
    for col, width in zip(table._tbl.tblGrid.gridCol_lst, widths):
        col.set(qn('w:w'), str(width))
    for row in table.rows:
        for cell, width in zip(row.cells, widths):
            tc_pr = cell._tc.get_or_add_tcPr()
            tcw = tc_pr.find(qn('w:tcW'))
            if tcw is None:
                tcw = OxmlElement('w:tcW')
                tc_pr.append(tcw)
            tcw.set(qn('w:w'), str(width))
            tcw.set(qn('w:type'), 'dxa')
            margins(cell)
            cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER


def header_row(row):
    tr_pr = row._tr.get_or_add_trPr()
    marker = OxmlElement('w:tblHeader')
    marker.set(qn('w:val'), 'true')
    tr_pr.append(marker)


def body(doc, text, label=None):
    p = doc.add_paragraph(style='Normal')
    if label:
        font(p.add_run(label), color=INK, bold=True)
        font(p.add_run(text), color='263746')
    else:
        font(p.add_run(text), color='263746')
    return p


def matrix(doc, heads, rows, widths, fill=LIGHT_BLUE):
    table = doc.add_table(rows=1, cols=len(heads), style='Table Grid')
    geo(table, widths)
    header_row(table.rows[0])
    for cell, text in zip(table.rows[0].cells, heads):
        shade(cell, fill)
        p = cell.paragraphs[0]
        p.paragraph_format.space_after = Pt(0)
        font(p.add_run(text), size=9.3, color=INK, bold=True)
    for values in rows:
        cells = table.add_row().cells
        for cell, text in zip(cells, values):
            p = cell.paragraphs[0]
            p.paragraph_format.space_after = Pt(0)
            font(p.add_run(text), size=9.2)
    doc.add_paragraph().paragraph_format.space_after = Pt(1)


def callout(doc, title, text):
    table = doc.add_table(rows=1, cols=1, style='Table Grid')
    geo(table, [9360])
    header_row(table.rows[0])
    cell = table.cell(0, 0)
    shade(cell, CALLOUT)
    p = cell.paragraphs[0]
    p.paragraph_format.space_after = Pt(2)
    font(p.add_run(title), size=10.5, color=DARK, bold=True)
    p = cell.add_paragraph()
    p.paragraph_format.space_after = Pt(0)
    font(p.add_run(text), size=10)
    doc.add_paragraph().paragraph_format.space_after = Pt(1)


def page_field(p):
    font(p.add_run('第 '), size=8.5, color=MUTED)
    fld = OxmlElement('w:fldSimple')
    fld.set(qn('w:instr'), 'PAGE')
    p._p.append(fld)
    font(p.add_run(' 页'), size=8.5, color=MUTED)


doc = Document()
sec = doc.sections[0]
for attr in ['top_margin', 'bottom_margin', 'left_margin', 'right_margin']:
    setattr(sec, attr, Inches(1))
sec.header_distance = Inches(0.492)
sec.footer_distance = Inches(0.492)
style(doc.styles['Normal'], 11, '263746', 0, 6)
style(doc.styles['Heading 1'], 16, BLUE, 18, 10, True, 1.0)
style(doc.styles['Heading 2'], 13, BLUE, 14, 7, True, 1.0)
style(doc.styles['Heading 3'], 12, DARK, 10, 5, True, 1.0)

h = sec.header.paragraphs[0]
h.alignment = WD_ALIGN_PARAGRAPH.RIGHT
font(h.add_run('元域智营 AI 基座 | 资源与配置估算'), size=8.5, color=MUTED)
f = sec.footer.paragraphs[0]
f.alignment = WD_ALIGN_PARAGRAPH.RIGHT
font(f.add_run('内部规划稿  |  '), size=8.5, color=MUTED)
page_field(f)

# memo_masthead opening
p = doc.add_paragraph()
p.paragraph_format.space_before = Pt(18)
p.paragraph_format.space_after = Pt(2)
font(p.add_run('容量规划与投入估算'), size=10.5, color=DARK, bold=True)
p = doc.add_paragraph()
p.paragraph_format.space_after = Pt(5)
font(p.add_run('元域智营 AI 基座\n项目资源与配置估算'), size=25, color=INK, bold=True)
p = doc.add_paragraph()
p.paragraph_format.space_after = Pt(14)
font(p.add_run('面向生产化开发、首批系统接入与试运行的基线规划'), size=13, color=DARK)
matrix(doc, ['项目属性', '规划基线'], [
    ['规划版本', 'V1.0 - 2026 年 8 月'],
    ['适用范围', 'OA、MES、QMS、LIMS、ERP、OMS 与大模型能力接入'],
    ['建议首期规模', '1 至 2 个工厂/业务域，150 名命名用户，50 名峰值并发用户'],
    ['数据规模假设', '约 500 万条业务事件/月，热数据留存 90 天，审计与归档按企业策略执行'],
    ['资源估算性质', '用于立项、预算和采购预沟通；上线前必须以真实压测、数据量和 SLA 复核'],
], [2200, 7160], fill=LIGHT_GRAY)
callout(doc, '关键结论', '建议按“中型企业生产基线”建设：首期 11 至 14 名核心成员，约 4 至 6 个月完成生产化与首批只读闭环；生产环境采用高可用应用、托管数据库、消息队列、集中观测与 Vault/KMS。若使用外部大模型，可暂不采购 GPU；若要求企业内网模型，则需单列 GPU 推理资源。')

doc.add_heading('一、规划前提与容量边界', level=1)
body(doc, '本估算针对当前 Demo 平台推进至企业生产开发的首期。系统以只读聚合、证据检索、风险解释、OA 审批建议为主要能力；跨系统自动写入仅作为后续受控阶段，不纳入首期性能承诺。')
matrix(doc, ['维度', '首期基线', '扩容触发条件'], [
    ['业务覆盖', '1 至 2 个工厂/业务域；6 个主要系统接入', '新增工厂、增加高频设备数据或接入 3 个以上新系统'],
    ['用户与请求', '150 名命名用户；50 名高峰并发；每秒 20 次 API 峰值', '峰值并发超过 80 或峰值 API 超过 40 次/秒'],
    ['事件与同步', '约 500 万条/月；近实时事件延迟目标 5 分钟内', '月事件超过 1,500 万或延迟超过既定 SLO'],
    ['可用性', '业务工作时间高可用；关键查询可降级为只读缓存', '需要 7x24、跨地域或 RTO/RPO 提升'],
    ['AI 调用', '以摘要、问答和受控检索为主；模型调用需限额和降级', '并发推理、长上下文、图片理解或本地模型需求明显增长'],
], [1750, 4800, 2810])
body(doc, '若实际 MES 需要秒级设备时序数据，或需接入大量历史批记录，建议将高频时序、离线分析和业务查询拆分为独立数据管道与存储；不要直接将设备原始流量写入业务 API。', '重要边界：')

doc.add_heading('二、项目团队与人力投入', level=1)
body(doc, '首期建议采用“核心全职团队 + 系统 Owner 兼职投入”的组织方式。人力按人月估算，集成与数据工作在前两个月投入较高，测试、安全和运维在联调与上线前达到峰值。')
matrix(doc, ['角色', '建议人数', '投入周期', '主要职责'], [
    ['项目经理/交付经理', '1', '4 至 6 个月全程', '计划、依赖、风险、跨部门决策与验收协调'],
    ['业务产品负责人', '1 至 2', '4 至 6 个月', '场景、流程、用户验收、指标和优先级'],
    ['解决方案/企业架构师', '1', '前 3 个月重点，后续 0.5', '总体架构、非功能需求、技术决策'],
    ['后端与集成工程师', '2 至 3', '4 至 6 个月', 'API、Connector、OA/MES 等接口、消息和审计'],
    ['前端/移动端工程师', '1 至 2', '4 至 5 个月', '管理端、智脑移动端、权限与体验'],
    ['数据工程/语义建模', '1 至 2', '前 4 个月重点', '数据管道、主数据、映射、对账、语义层'],
    ['AI/平台工程师', '1', '3 至 5 个月', '模型路由、评测、提示词、Guardrail、成本与降级'],
    ['测试工程师', '1 至 2', '第 2 月起，联调期重点', '自动化、性能、集成、回归与验收支持'],
    ['DevOps/SRE', '1', '前 2 月重点，后续 0.5', '环境、CI/CD、监控、发布、容灾'],
    ['安全与合规', '0.5 至 1', '关键评审节点', '身份、密钥、数据分级、渗透和合规放行'],
], [1750, 1100, 2050, 4460])
matrix(doc, ['阶段', '持续时间', '平均核心投入', '主要里程碑'], [
    ['启动与方案', '2 至 4 周', '7 至 9 FTE', '范围、接口台账、架构与安全方案确认'],
    ['生产化开发', '6 至 8 周', '10 至 12 FTE', '环境、认证、Connector、数据/语义和首批体验完成'],
    ['联调与预生产', '4 至 6 周', '12 至 14 FTE', '跨系统对账、性能、安全和业务验收'],
    ['灰度与稳定期', '2 至 4 周', '6 至 8 FTE', '受控上线、监控优化、运维交接'],
], [1800, 1800, 2200, 3560])
callout(doc, '外部系统配合资源', '除项目团队外，OA、MES、QMS、LIMS、ERP、OMS 每个系统应至少指定 1 名业务 Owner、1 名技术接口人和 1 名测试联系人。首批联调阶段，每个系统通常需投入每周 0.5 至 1 人天用于账号、数据、异常定位和验收。')

doc.add_heading('三、生产环境基础设施配置', level=1)
body(doc, '推荐采用托管 Kubernetes 或等价容器平台，以减少集群控制面维护。以下为生产基础配置，不含开发和测试环境；如果企业已有平台，应优先复用其网络、日志、IAM、镜像仓库和备份能力。')
matrix(doc, ['组件', '推荐生产配置', '高可用/配置要点'], [
    ['容器运行平台', '6 个工作节点，每节点 8 vCPU / 32 GB RAM；系统盘 100 GB SSD', '跨 3 个可用区或故障域；应用水平扩容；预留约 30% 容量'],
    ['API 与 Agent 服务', '初始 3 副本，每副本 2 vCPU / 4 GB RAM；自动扩容上限 10 副本', '健康检查、限流、熔断、无状态部署、最小 2 副本'],
    ['Connector 服务', '每类关键系统 2 副本，每副本 1 至 2 vCPU / 2 至 4 GB RAM', '与源系统隔离；支持重试、死信与节流；按系统独立凭据'],
    ['语义/检索服务', '2 副本，每副本 4 vCPU / 8 GB RAM', '独立队列和缓存；检索失败可降级为基础查询'],
    ['PostgreSQL', '托管高可用实例：4 至 8 vCPU / 32 GB RAM / 500 GB SSD 起步', '主备、自动备份、PITR、连接池、读写告警'],
    ['Redis', '主从或托管高可用：2 至 4 vCPU / 8 至 16 GB RAM', '会话、限流、缓存独立命名空间；不作为唯一事实存储'],
    ['消息队列', '3 节点集群或托管等价服务；每节点 4 vCPU / 16 GB RAM / 200 GB SSD', '持久化、死信队列、消费积压和重试监控'],
    ['对象存储', '1 TB 起步，按 90 天热数据和归档策略扩容', '附件、导出、审计证据；生命周期与加密策略'],
], [1650, 4450, 3260])
body(doc, '开发、测试/集成和预生产环境可按生产 30% 至 50% 的计算资源配置，但必须使用独立账号、网络分段、数据库、密钥和消息主题。预生产应尽可能与生产同构，用于发布、回滚和容量验证。', '非生产环境：')

doc.add_heading('四、网络、存储、备份与容灾', level=1)
matrix(doc, ['能力', '建议配置', '验证方式'], [
    ['网络分区', '接入区、应用区、数据区、运维区分段；Connector 靠近内网业务系统部署', '白名单、流量路径和越权访问测试'],
    ['入口安全', 'WAF/API 网关、TLS 1.2+、速率限制、请求 ID、DDoS 基础防护', '安全扫描、压力和异常流量演练'],
    ['数据库备份', '每日全量 + 连续日志/PITR；至少保留 30 天', '季度恢复演练；记录恢复耗时和数据点'],
    ['对象存储备份', '跨存储域复制或企业备份；生命周期归档', '随机抽样恢复与权限校验'],
    ['容灾目标', '首期建议 RPO 不超过 15 分钟，RTO 不超过 4 小时', '灾难场景演练与业务签字'],
], [1650, 5050, 2660])
callout(doc, '部署模式建议', '若 MES、QMS 或 LIMS 位于工厂内网，建议在工厂侧部署轻量 Connector/边缘网关，通过企业批准的 VPN、专线或 API 网关连接中心平台。不要直接暴露工厂系统数据库或管理接口。')

doc.add_heading('五、数据平台、接口与存储容量', level=1)
body(doc, '数据容量应按“事件流、业务快照、检索索引、附件、审计”分别计算。最常见的低估项是审计日志、失败重试记录、文件附件和模型调用追踪。')
matrix(doc, ['数据域', '首期建议容量', '保留与扩容建议'], [
    ['业务事件与状态快照', '500 GB 高性能数据库/湖仓起步', '保留近 90 天热数据；月增量超过 150 GB 时评估分区和归档'],
    ['检索/向量索引', '100 至 200 GB 起步', '按知识库、批记录和文档增长；索引需可重建'],
    ['审计、日志与链路', '500 GB 起步，在线保留 30 至 90 天', '按安全策略归档；错误与审计日志不可与业务日志混存'],
    ['附件与证据材料', '1 TB 对象存储起步', '分级、加密、病毒扫描、保留和删除策略先行'],
    ['消息积压缓冲', '200 GB SSD 起步', '按 72 小时高峰积压规划；超过阈值自动告警'],
], [1700, 4100, 3560])
body(doc, '建议将接口接入按优先级分为：事件订阅优先、增量 API 其次、受控数据库视图再次、文件交换最后。所有方式均要包含幂等键、重试、延迟监控、失败队列和对账。', '接入策略：')

doc.add_heading('六、大模型资源与模型服务配置', level=1)
body(doc, '模型方案分为外部 API、企业内网推理和混合路由三种。首期若以证据检索、摘要和问答为主，建议先采用经安全评估的外部 API 或企业已有模型网关，并保持 Mock/规则化降级能力；只有存在严格不出网、持续高并发或大规模文档推理时，再自建 GPU 推理。')
matrix(doc, ['方案', '资源估算', '适用条件', '关键控制'], [
    ['外部模型 API', '无需自购 GPU；准备 API 网关、预算限额和备用模型路由', '数据可按策略脱敏/外发，调用量尚未达到自建成本阈值', 'KMS 管理密钥、默认脱敏、调用审计、速率/预算限制'],
    ['企业内网模型', '2 台 GPU 推理节点起步；每台建议 2 张 48 GB 级 GPU、32 vCPU、128 GB RAM、2 TB NVMe', '严格不出网、较长上下文或稳定高调用量', '模型版本、容量压测、隔离、补丁、内容和工具权限控制'],
    ['混合路由', '外部 API + 内网推理池；按任务分流', '不同数据级别、成本与时延目标并存', '分类路由、禁止数据类别、统一审计与降级'],
], [1600, 3600, 2250, 1910])
body(doc, '模型预算不能只按 Token 计费评估。还应纳入嵌入/重排、附件处理、日志审计、评测、失败重试和峰值并发。生产发布前，应针对典型业务问题建立离线评测集并定义：答案依据完整率、事实错误率、越权工具调用率、P95 时延和单任务成本。', '容量与成本控制：')

doc.add_heading('七、安全、观测与运维资源', level=1)
matrix(doc, ['能力', '推荐配置', '资源/责任'], [
    ['身份与权限', '对接 OA/IdP，SSO、MFA、RBAC/ABAC、服务账号最小权限', 'IAM 团队 + 安全负责人'],
    ['密钥管理', 'Vault/KMS、按系统隔离、租约、轮换、禁止明文配置与日志', '安全团队 + 平台工程师'],
    ['安全检测', 'SAST、依赖/镜像扫描、WAF、审计检索、年度渗透测试', '应用安全 + 外部测评（如需）'],
    ['可观测性', '指标、日志、链路、业务对账、模型调用、告警与看板', 'SRE + 各服务 Owner'],
    ['运行支持', '工作时间值班起步；P1/P2 事件流程、Runbook、工单与复盘', '运维负责人 + 项目团队'],
], [1700, 5000, 2660])
callout(doc, '生产必须替换的 Demo 能力', 'Demo 角色 Header 必须替换为企业认证与真实授权；模拟数据必须替换为受治理的数据访问层；模型密钥的内存配置必须替换为 Vault/KMS 引用；接口调用必须有审计、限流、熔断和运行监控。')

doc.add_heading('八、软件、平台与许可证清单', level=1)
matrix(doc, ['类别', '需要确认的采购/复用项', '备注'], [
    ['云/数据中心基础设施', '计算、存储、网络、托管 K8s、数据库、消息队列、对象存储', '优先复用企业标准平台与账号体系'],
    ['集成与 API 管理', 'API 网关、iPaaS/ESB、消息平台、VPN/专线、工厂边缘网关', '由既有集成架构决定是否新增采购'],
    ['安全与运维', 'KMS/Vault、WAF、SIEM、日志平台、监控/APM、备份', '需要确认日志量、保留期和审计要求'],
    ['AI 服务', '外部模型 API 合同/额度，或 GPU、推理平台与模型支持服务', '应单列模型调用预算与供应商风险评估'],
    ['研发效率', '代码托管、CI/CD、制品库、测试管理、缺陷与需求管理', '通常可复用企业 DevSecOps 工具链'],
], [1900, 5300, 2160])

doc.add_heading('九、预算估算框架与待确认项', level=1)
body(doc, '由于云厂商、地域、已有企业平台、模型供应商、数据量和可用性要求尚未确定，本文件不提供不可靠的金额总数。立项预算可按以下四类汇总，并在方案评审后由采购/云平台团队报价。')
matrix(doc, ['预算包', '主要构成', '影响最大的变量'], [
    ['一次性实施投入', '项目团队人力、架构与安全评审、接口开发、测试、上线与培训', '系统接口成熟度、数据质量、写入范围、定制程度'],
    ['年度基础设施', '计算、数据库、队列、存储、网络、备份、日志与监控', '高可用架构、数据增长、日志留存、地域'],
    ['年度 AI 服务', '模型 API/推理 GPU、嵌入、评测、模型网关与支持服务', '调用量、上下文长度、是否自建 GPU、图片/附件处理'],
    ['年度运行与改进', 'SRE、安全复测、许可证、系统接口维护、需求迭代', 'SLA、接入系统数量、业务扩张和监管要求'],
], [1800, 4950, 2610])
body(doc, '报价前需补齐的关键参数包括：各系统每日/每月数据量与峰值；用户数和并发；附件规模；目标 RPO/RTO；是否 7x24；内网模型或外部模型偏好；已有云平台与许可证；工厂数量和网络条件；以及系统接口是否由厂商另行收费。', '必须补齐的参数：')

doc.add_heading('十、推荐决策与下一步', level=1)
matrix(doc, ['时间', '建议动作', '应产出'], [
    ['第 1 周', '确认首期场景、规模假设、SLA、模型策略与企业既有平台', '容量假设确认单、差距清单'],
    ['第 2 周', '由云平台、网络、安全、OA/MES 等 Owner 核对配置与接口条件', '目标架构、网络开通与账号计划'],
    ['第 3 至 4 周', '建立测试环境，跑通单条只读链路并采集真实性能指标', '压测基线、对账报告、容量修订版'],
    ['联调前', '根据真实数据、并发、日志和模型调用量锁定生产规格与预算', '生产 BOM、采购/资源申请、上线验收表'],
], [1750, 5000, 2610])
callout(doc, '推荐起步配置', '在企业已有云原生与安全平台的前提下，先按 6 节点容器集群、4 至 8 vCPU/32 GB 高可用 PostgreSQL、3 节点消息服务、1 TB 对象存储、集中观测，以及 11 至 14 FTE 的首期团队推进。外部模型 API 先行并保留内网模型接口；GPU 采购应以真实调用与数据合规评估后再决定。')

doc.core_properties.title = '元域智营 AI 基座 - 项目资源与配置估算'
doc.core_properties.subject = '生产化开发资源、容量与配置规划'
doc.core_properties.author = '项目团队'
doc.save(OUT)
print(OUT)
