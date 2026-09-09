from pathlib import Path

from docx import Document
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor

OUT = Path(__file__).resolve().parents[2] / 'docs' / 'reference' / 'exports' / '元域智营AI基座-部署说明.docx'
BLUE, DARK, INK, MUTED = '2E74B5', '1F4D78', '0B2545', '5B6773'
LIGHT_BLUE, LIGHT_GRAY, CALLOUT = 'E8EEF5', 'F2F4F7', 'F4F6F9'


def set_font(run, size=11, color='263746', bold=False):
    run.font.name = 'Calibri'
    run._element.rPr.rFonts.set(qn('w:ascii'), 'Calibri')
    run._element.rPr.rFonts.set(qn('w:hAnsi'), 'Calibri')
    run._element.rPr.rFonts.set(qn('w:eastAsia'), 'Microsoft YaHei')
    run.font.size = Pt(size)
    run.font.color.rgb = RGBColor.from_string(color)
    run.bold = bold


def configure_style(style, size, color, before, after, bold=False, line=1.25):
    style.font.name = 'Calibri'
    style._element.rPr.rFonts.set(qn('w:ascii'), 'Calibri')
    style._element.rPr.rFonts.set(qn('w:hAnsi'), 'Calibri')
    style._element.rPr.rFonts.set(qn('w:eastAsia'), 'Microsoft YaHei')
    style.font.size = Pt(size)
    style.font.color.rgb = RGBColor.from_string(color)
    style.font.bold = bold
    style.paragraph_format.space_before = Pt(before)
    style.paragraph_format.space_after = Pt(after)
    style.paragraph_format.line_spacing = line
    style.paragraph_format.keep_with_next = style.name != 'Normal'


def set_cell_margins(cell):
    tc_pr = cell._tc.get_or_add_tcPr()
    tc_mar = tc_pr.first_child_found_in('w:tcMar')
    if tc_mar is None:
        tc_mar = OxmlElement('w:tcMar')
        tc_pr.append(tc_mar)
    for side, value in [('top', 80), ('start', 120), ('bottom', 80), ('end', 120)]:
        node = tc_mar.find(qn(f'w:{side}'))
        if node is None:
            node = OxmlElement(f'w:{side}')
            tc_mar.append(node)
        node.set(qn('w:w'), str(value))
        node.set(qn('w:type'), 'dxa')


def set_shading(cell, color):
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = tc_pr.find(qn('w:shd'))
    if shd is None:
        shd = OxmlElement('w:shd')
        tc_pr.append(shd)
    shd.set(qn('w:fill'), color)


def set_geometry(table, widths):
    table.autofit = False
    tbl_pr = table._tbl.tblPr
    tbl_w = tbl_pr.first_child_found_in('w:tblW')
    if tbl_w is None:
        tbl_w = OxmlElement('w:tblW')
        tbl_pr.append(tbl_w)
    tbl_w.set(qn('w:w'), str(sum(widths)))
    tbl_w.set(qn('w:type'), 'dxa')
    tbl_ind = tbl_pr.first_child_found_in('w:tblInd')
    if tbl_ind is None:
        tbl_ind = OxmlElement('w:tblInd')
        tbl_pr.append(tbl_ind)
    tbl_ind.set(qn('w:w'), '120')
    tbl_ind.set(qn('w:type'), 'dxa')
    for grid_col, width in zip(table._tbl.tblGrid.gridCol_lst, widths):
        grid_col.set(qn('w:w'), str(width))
    for row in table.rows:
        for cell, width in zip(row.cells, widths):
            tc_pr = cell._tc.get_or_add_tcPr()
            tc_w = tc_pr.find(qn('w:tcW'))
            if tc_w is None:
                tc_w = OxmlElement('w:tcW')
                tc_pr.append(tc_w)
            tc_w.set(qn('w:w'), str(width))
            tc_w.set(qn('w:type'), 'dxa')
            set_cell_margins(cell)
            cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER


def mark_header(row):
    props = row._tr.get_or_add_trPr()
    marker = OxmlElement('w:tblHeader')
    marker.set(qn('w:val'), 'true')
    props.append(marker)


def add_body(doc, text, label=None):
    p = doc.add_paragraph(style='Normal')
    if label:
        set_font(p.add_run(label), color=INK, bold=True)
        set_font(p.add_run(text))
    else:
        set_font(p.add_run(text))
    return p


def add_matrix(doc, headers, rows, widths, fill=LIGHT_BLUE):
    table = doc.add_table(rows=1, cols=len(headers), style='Table Grid')
    set_geometry(table, widths)
    mark_header(table.rows[0])
    for cell, text in zip(table.rows[0].cells, headers):
        set_shading(cell, fill)
        p = cell.paragraphs[0]
        p.paragraph_format.space_after = Pt(0)
        set_font(p.add_run(text), size=9.3, color=INK, bold=True)
    for values in rows:
        cells = table.add_row().cells
        for cell, text in zip(cells, values):
            p = cell.paragraphs[0]
            p.paragraph_format.space_after = Pt(0)
            set_font(p.add_run(text), size=9.2)
    doc.add_paragraph().paragraph_format.space_after = Pt(1)


def add_callout(doc, title, text):
    table = doc.add_table(rows=1, cols=1, style='Table Grid')
    set_geometry(table, [9360])
    mark_header(table.rows[0])
    cell = table.cell(0, 0)
    set_shading(cell, CALLOUT)
    p = cell.paragraphs[0]
    p.paragraph_format.space_after = Pt(2)
    set_font(p.add_run(title), size=10.5, color=DARK, bold=True)
    p = cell.add_paragraph()
    p.paragraph_format.space_after = Pt(0)
    set_font(p.add_run(text), size=10)
    doc.add_paragraph().paragraph_format.space_after = Pt(1)


def page_number(p):
    set_font(p.add_run('第 '), size=8.5, color=MUTED)
    field = OxmlElement('w:fldSimple')
    field.set(qn('w:instr'), 'PAGE')
    p._p.append(field)
    set_font(p.add_run(' 页'), size=8.5, color=MUTED)


doc = Document()
section = doc.sections[0]
for attr in ['top_margin', 'bottom_margin', 'left_margin', 'right_margin']:
    setattr(section, attr, Inches(1))
section.header_distance = Inches(0.492)
section.footer_distance = Inches(0.492)
configure_style(doc.styles['Normal'], 11, '263746', 0, 6)
configure_style(doc.styles['Heading 1'], 16, BLUE, 18, 10, True, 1.0)
configure_style(doc.styles['Heading 2'], 13, BLUE, 14, 7, True, 1.0)
configure_style(doc.styles['Heading 3'], 12, DARK, 10, 5, True, 1.0)

header = section.header.paragraphs[0]
header.alignment = WD_ALIGN_PARAGRAPH.RIGHT
set_font(header.add_run('元域智营 AI 基座 | 部署说明'), size=8.5, color=MUTED)
footer = section.footer.paragraphs[0]
footer.alignment = WD_ALIGN_PARAGRAPH.RIGHT
set_font(footer.add_run('内部技术文档  |  '), size=8.5, color=MUTED)
page_number(footer)

# memo_masthead opening
p = doc.add_paragraph()
p.paragraph_format.space_before = Pt(18)
p.paragraph_format.space_after = Pt(2)
set_font(p.add_run('技术部署与运行手册'), size=10.5, color=DARK, bold=True)
p = doc.add_paragraph()
p.paragraph_format.space_after = Pt(5)
set_font(p.add_run('元域智营 AI 基座\n部署说明'), size=25, color=INK, bold=True)
p = doc.add_paragraph()
p.paragraph_format.space_after = Pt(14)
set_font(p.add_run('适用于本地开发、测试/预生产及生产环境'), size=13, color=DARK)
add_matrix(doc, ['文档项', '说明'], [
    ['当前仓库基线', 'Node.js 原生 HTTP API、Vue/Vite Web 管理端、Vue/Vite 移动端、桌面端与 Python 语义上下文服务'],
    ['默认开发端口', 'API 3001；语义服务 3011；Web 5173；移动端 5175；桌面端 5184'],
    ['生产部署建议', '容器平台 + 内部负载均衡/API 网关 + 托管数据库/队列/对象存储 + Vault/KMS + 企业身份源'],
    ['安全定位', '生产必须关闭 Demo 角色 Header 与模拟登录；前端、日志和配置文件不得保存业务或模型密钥'],
], [2200, 7160], fill=LIGHT_GRAY)
add_callout(doc, '使用前提', '当前仓库未提供 Dockerfile、Helm Chart、Docker Compose 或生产级 IaC。本文给出基于现有代码的部署流程和生产化改造清单；在完成这些改造前，不应将当前 Demo 直接暴露到生产网络。')

doc.add_heading('一、服务清单与依赖关系', level=1)
add_body(doc, '平台由浏览器/移动客户端、业务 API、语义上下文服务以及企业外部控制面组成。PC Web、移动端和桌面端是独立构建产物；业务 API 是当前统一的服务端入口；语义服务是受控上下文的独立边界。')
add_matrix(doc, ['服务/组件', '当前技术与端口', '运行职责', '生产部署位置'], [
    ['Web 管理端', 'Vue 3 + Vite；开发 5173', '运营、配置、治理控制台', 'CDN/静态站点或 Nginx；仅 HTTPS'],
    ['移动智脑端', 'Vue 3 + Vite；开发 5175', '用户指令、告警、任务与审批入口', '静态站点或 Tauri 打包；调用统一 API 域名'],
    ['桌面控制台', 'Vue 3 + Vite；开发 5184', '独立运营控制台', '静态站点或桌面发行包；调用统一 API 域名'],
    ['业务 API', 'Node.js ESM 原生 HTTP；默认 3001', '身份、授权、Agent、连接器、审计与业务 API', '私有子网容器服务；经 API 网关暴露'],
    ['语义上下文服务', 'Python HTTP；默认 3011', '图谱上下文、来源、有效时间和决策证据边界', '私有子网容器服务；仅 API/服务网格访问'],
    ['密钥与身份控制面', '企业 Vault/KMS、IdP/OIDC、OA', '密钥、短期凭据、统一身份、审批', '企业受控服务；不部署在客户端'],
], [1600, 2450, 2950, 2360])
add_callout(doc, '推荐访问路径', '浏览器、移动端和桌面端只访问统一 HTTPS 域名；API 网关将 /api 转发给 Node API。Node API 通过私有网络调用语义服务、企业 OA/MES 等 Connector、KMS/Vault 和模型网关。语义服务不应被互联网或终端直接访问。')

doc.add_heading('二、部署前必须完成的生产化改造', level=1)
add_body(doc, '以下事项来自当前代码结构和 Demo 配置，是生产部署的阻断项。它们应进入开发 Backlog，并在预生产环境验证后才申请生产开通。')
add_matrix(doc, ['阻断项', '当前状态', '部署前要求'], [
    ['前端 API 地址', 'Web 客户端当前直接请求 http://localhost:3001/api', '改为构建时环境变量或同源 /api 相对路径；生产不得依赖用户设备的 localhost'],
    ['身份与授权', '支持 Demo 角色 Header 与模拟 OA/本地账号', '接入 OIDC/OAuth 2.1 或企业 IdP；NODE_ENV=production 且 DEMO_ALLOW_ROLE_HEADER=false'],
    ['持久化', '业务演示数据与部分运行状态在内存中', '替换为受治理的 PostgreSQL、事件总线、对象存储和审计仓；定义备份与恢复'],
    ['密钥配置', '管理端可进行内存运行时配置，Demo Key Center 可用', '改为 Vault/KMS/HSM 引用、短期租约和自动轮换；禁止密钥回显与日志'],
    ['接口连接器', '模拟 LIMS/MES/ERP/QMS/OMS 数据', '部署各系统 Connector，完成网络、服务账号、重试、幂等、死信和对账'],
    ['语义服务', 'Python ThreadingHTTPServer 绑定 127.0.0.1', '容器化，配置私有监听/服务发现、mTLS、健康探针和受控持久化'],
], [1600, 3150, 4610])

doc.add_heading('三、环境分层与网络规划', level=1)
add_body(doc, '至少建立开发、测试/集成、预生产、生产四个环境。环境之间不得共享数据库、密钥、服务账号、消息主题或对象存储桶。预生产应尽可能与生产同构，至少覆盖认证、网关、日志、Connector 和发布流程。')
add_matrix(doc, ['环境', '用途', '数据要求', '发布控制'], [
    ['开发 DEV', '日常开发与单元测试', '模拟或完全脱敏数据', '开发分支；不允许生产凭据'],
    ['测试/集成 SIT', '接口联调、对账、自动化回归', '系统测试账号与脱敏快照', '合并请求流水线自动部署'],
    ['预生产 UAT', '业务验收、性能、安全、回滚演练', '生产等价配置；脱敏或批准的回放数据', '受版本冻结与变更单管理'],
    ['生产 PROD', '受控业务运行', '真实数据，严格最小权限', '双人审批、灰度、监控与回滚预案'],
], [1500, 3100, 2600, 2160])
add_matrix(doc, ['网络区', '放置组件', '允许通信'], [
    ['DMZ/入口区', 'WAF、CDN、API 网关、负载均衡', '互联网仅 HTTPS 443；转发至应用区'],
    ['应用区', 'Node API、Agent、Connector、语义服务', '仅接收网关与受控服务间流量'],
    ['数据区', 'PostgreSQL、Redis、消息队列、对象存储端点', '仅应用区按端口和身份访问'],
    ['管理与安全区', 'CI/CD Runner、镜像仓库、Vault/KMS、监控、堡垒机', '仅运维和受控工作负载访问'],
], [1650, 3950, 3760])

doc.add_heading('四、本地开发部署', level=1)
add_body(doc, '本地部署用于开发和界面联调，不等同于生产部署。建议使用项目根目录的 .env 文件保存非敏感开发配置；不要把真实企业账号、模型密钥或生产地址写入仓库。')
add_matrix(doc, ['步骤', 'PowerShell 命令/动作', '验证'], [
    ['1. 安装依赖', 'npm.cmd install；Python 安装 services/semantic-context/requirements.txt', 'Node 与 Python 依赖安装完成'],
    ['2. 配置开发环境', '复制 .env.example 为 .env，保持 AGENT_RUNTIME_MODE=mock', '不包含任何真实密钥'],
    ['3. 启动 API', 'npm.cmd run dev:api', 'http://localhost:3001/api/health 返回 ok'],
    ['4. 启动语义服务', 'npm.cmd run dev:semantic', 'http://localhost:3011/health 返回 healthy'],
    ['5. 启动 Web 管理端', 'npm.cmd run dev:web', 'http://localhost:5173 可打开'],
    ['6. 启动可选客户端', 'npm.cmd run dev -w @healthcare-ai/mobile-app；桌面端同理', '移动端 5175、桌面端 5184 可访问'],
], [1500, 5200, 2660])
add_body(doc, '构建命令：Web 使用 npm.cmd run build；移动端使用 npm.cmd run build:mobile；桌面端使用 npm.cmd run build:desktop；业务 API 使用 npm.cmd run start（生产运行时不得使用 node --watch）。', '构建：')

doc.add_heading('五、容器与生产构建规范', level=1)
add_body(doc, '建议将每个可独立扩缩容的服务构建为独立镜像：business-api、semantic-context、web-static、connector-*。前端仅生成静态文件，由 Nginx 或企业静态托管服务发布；Node API 和 Python 服务通过容器平台运行。')
add_matrix(doc, ['镜像', '构建输入', '运行要求'], [
    ['business-api', '根目录 package-lock 与 backend/src', '非 root 用户；只读根文件系统；PORT、CORS、身份、KMS、模型和连接器配置通过外部注入'],
    ['semantic-context', 'services/semantic-context 与 requirements.txt', '非 root 用户；私有网络；SEMANTIC_CONTEXT_PORT；mTLS/服务网格或内网网关'],
    ['web-static', 'frontend 构建输出 dist', 'Nginx/静态托管；缓存带版本哈希；把 /api 反向代理到统一网关'],
    ['mobile/desktop', 'apps/* 构建输出', '发布前将 API 基础地址指向统一 HTTPS 域名；签名与版本管理'],
], [1650, 3400, 4310])
add_callout(doc, '镜像基线', '在 CI 中固定 Node/Python 基础镜像版本，执行依赖锁定、SAST、依赖与镜像漏洞扫描、许可证检查和镜像签名。生产仅允许部署通过扫描与签名验证的制品。')

doc.add_heading('六、配置与密钥注入', level=1)
add_body(doc, '配置要区分普通参数、环境差异参数和机密。普通参数可使用 ConfigMap/配置中心；机密仅通过 Vault/KMS、Secret Manager 或工作负载身份动态获取。客户端不得获得任何业务系统、模型、通知通道或 KMS 密钥。')
add_matrix(doc, ['配置项', '示例/用途', '生产要求'], [
    ['NODE_ENV', 'production', '必须为 production'],
    ['PORT', '业务 API 监听端口，默认 3001', '由容器平台服务发现；不对公网直出'],
    ['CORS_ALLOWED_ORIGINS', '管理端与移动端正式 HTTPS 域名', '只列出受控域名；禁止通配符'],
    ['DEMO_ALLOW_ROLE_HEADER', 'false', '生产必须关闭；请求必须具有企业身份会话'],
    ['OA_AUTH_MODE / ACCOUNT_AUTH_MODE', '企业 OIDC/OA 实际模式', '禁止 mock；令牌校验、刷新与设备策略可审计'],
    ['AGENT_RUNTIME_MODE', 'local、openai、deepseek 或 compatible', '按安全批准的模型路由；启用限额、审计和降级'],
    ['AGENT_EXTERNAL_DATA_MODE', 'redacted 或经审批的 full', '默认 redacted；完整上下文需数据 Owner 和安全批准'],
    ['SEMANTIC_CONTEXT_PORT', '3011', '仅私有服务端口；不要向互联网开放'],
    ['KEY_CENTER_*', 'Vault/KMS、mTLS、租约策略', '使用工作负载身份；禁止 .env 明文密钥'],
], [2100, 3550, 3710])
add_body(doc, '生产环境中的 API Key 配置页面只能作为受审计的“密钥引用/连接配置”入口，不能成为浏览器保存或长期持有密钥的渠道。密钥材料应由服务端通过 Vault/KMS 读取，并仅向调用者签发短期不透明租约。', '密钥原则：')

doc.add_heading('七、网关、反向代理与 TLS', level=1)
add_body(doc, '推荐由企业 API 网关或 Ingress 承担 TLS 终止、WAF、限流、JWT/OIDC 令牌校验（如架构允许）、请求 ID、访问日志与路由。业务 API 仅接受来自网关或服务网格的受控流量。')
add_matrix(doc, ['外部路径', '目标服务', '规则'], [
    ['https://platform.example.com/', 'Web 静态资源', 'TLS、CSP、安全响应头、静态资源缓存'],
    ['https://platform.example.com/api/*', 'business-api Service', '鉴权、限流、请求大小限制、超时、审计 ID'],
    ['https://platform.example.com/mobile/*', '移动端静态资源或下载页', 'TLS、版本标识、最小缓存策略'],
    ['内部 /semantic/*', 'semantic-context Service', '仅服务网格/API 允许；mTLS；不可公开'],
], [2550, 3000, 3810])
add_body(doc, '当前 Web API 客户端使用 localhost 地址，因此生产前必须改为由 Vite 注入的 VITE_API_BASE_URL 或使用相对 /api 路径。改造后，应以 API 网关域名作为唯一公开 API 基址，避免跨域和用户设备 localhost 问题。', '前端关键改造：')

doc.add_heading('八、发布、健康检查与回滚', level=1)
add_matrix(doc, ['阶段', '执行动作', '放行条件'], [
    ['构建', '安装锁定依赖、执行 Web/移动/桌面构建、静态检查和单元测试', '构建可复现、无阻断级漏洞'],
    ['集成部署', '部署到 SIT，运行接口契约、权限、Connector Mock 与回归测试', '接口对账和关键用例通过'],
    ['预生产', '发布不可变镜像，执行性能、安全、备份恢复和回滚演练', '业务、安全、运维联合签字'],
    ['灰度生产', '按用户组或单工厂发布；先只读；观察 API、队列、数据延迟和模型指标', 'SLO 稳定，未发生高风险权限/数据事件'],
    ['全量与稳定期', '扩大覆盖，保留上一个稳定版本与回滚窗口', '稳定期结束，Runbook 与运维交接完成'],
], [1450, 5200, 2710])
add_matrix(doc, ['检查项', '端点/指标', '建议阈值'], [
    ['API 存活', 'GET /api/health', '连续失败 3 次触发告警；容器自动重启'],
    ['语义服务存活', 'GET /health（内部）', '失败时 Agent 降级并告警；不得绕过授权'],
    ['系统接入', 'Connector 成功率、事件延迟、死信队列积压', '按系统设定 SLO；积压/失败超阈值告警'],
    ['数据质量', '对账差异、缺失率、主键冲突', '不合格数据不得作为确定性 Agent 结论'],
    ['模型运行', 'P95 时延、错误率、Token/成本、降级次数', '超过预算或错误率阈值时自动限流/降级'],
], [1700, 4650, 3010])
add_callout(doc, '回滚原则', '前端静态资源、API 镜像、Connector 配置和数据库变更必须可独立回滚。数据库结构变更采用向后兼容的 Expand/Contract 方式；涉及跨系统写入时，必须同时具备业务补偿、审计记录和人工处置流程。')

doc.add_heading('九、上线验收与运维交接清单', level=1)
add_matrix(doc, ['领域', '上线前验收项', '责任方'], [
    ['安全', '真实身份认证、权限矩阵、密钥引用、审计、漏洞修复、外部模型出网策略', '安全/IAM/业务 Owner'],
    ['集成', '网络、服务账号、接口契约、幂等、重试、死信、对账、变更联系人', '集成团队/系统 Owner'],
    ['数据', '主数据映射、质量阈值、脱敏、保留、归档与恢复', '数据 Owner'],
    ['运行', '仪表盘、告警、Runbook、备份、回滚、值班与故障分级', 'SRE/运维'],
    ['业务', '端到端场景、审批责任、异常人工处理、培训与签字', '业务产品负责人'],
], [1600, 5350, 2410])
add_body(doc, '运维交接应至少包含：架构图与资产清单、域名和证书责任、环境/配置清单、服务依赖、监控看板、告警规则、故障 Runbook、备份恢复步骤、发布回滚步骤、系统联系人、变更窗口和应急通讯录。', '交接包：')

doc.add_heading('附录：生产部署顺序', level=1)
add_matrix(doc, ['顺序', '部署对象', '完成条件'], [
    ['1', '网络、域名、证书、WAF、API 网关、镜像仓库与监控基础设施', '私有网络与统一 HTTPS 入口可用'],
    ['2', 'Vault/KMS、企业身份源、服务账号、数据库、队列、对象存储', '最小权限、备份与连接验证通过'],
    ['3', '业务 API、语义服务、Connector 框架与内部服务发现', '健康检查、mTLS、日志和审计可用'],
    ['4', 'OA/MES/QMS/LIMS/ERP/OMS Connector 与数据对账作业', '测试环境端到端只读数据验证通过'],
    ['5', 'Web 管理端、移动端、桌面端及正式 API 基址配置', '身份登录、角色和跨端访问验证通过'],
    ['6', '预生产验收、灰度生产、监控观察和运维交接', '上线审批与稳定期目标达成'],
], [700, 5100, 3560], fill=LIGHT_GRAY)
add_callout(doc, '最终提醒', '本部署说明描述的是从当前 Demo 走向生产的目标流程，不代表现有仓库已具备生产部署条件。应先完成“生产化改造”一节的阻断项，再依照本说明进行环境部署和上线验收。')

doc.add_heading('附录：当前状态化 Mock 演练部署', level=1)
add_body(doc, '在 OA、MES、QMS、LIMS、ERP、OMS 尚未完成真实接入前，当前推荐部署目标是“状态化流程模拟环境”。它使用与未来 Connector 一致的查询、事件、审批和受控写回边界，但只读取基础种子数据并在 API 进程内生成运行时事件，不访问任何企业生产系统。')
add_matrix(doc, ['能力', '当前 Mock 部署行为', '生产替换方式'], [
    ['基础数据', '每个业务系统约 100 条确定性种子记录', '替换为真实 Connector 增量同步和受治理数据仓'],
    ['流程场景', '质量、设备、库存、订单四类场景可由管理端启动', '保留为 SIT/UAT 回归与故障注入能力'],
    ['审批与写回', '生成模拟 OA 待办；批准后写入 QMS 模拟 CAPA 事件', '替换为 OA/BPM 审批回调和经授权的业务 Action'],
    ['状态保存', '仅当前 API 进程内存，可一键重置，重启即清空', '替换为 PostgreSQL、消息队列、Outbox 与审计仓'],
    ['网络与密钥', '不调用真实企业系统，也不需要真实系统凭据', '通过 Vault/KMS、mTLS 和私有 Connector 接入'],
], [1700, 4550, 3110], fill=LIGHT_GRAY)
add_body(doc, '部署模拟环境时，管理端、移动端与 Agent 均应通过业务 API 读取模拟 Connector 输出，禁止页面直接读取种子文件。运行“原料质量异常”场景后，可用批次号 RMB-VC-20260801 查询 LIMS OOS、QMS 偏差、MES 冻结和 CAPA 草稿的完整证据链。', '演练验证：')

doc.core_properties.title = '元域智营 AI 基座 - 部署说明'
doc.core_properties.subject = '本地、测试、预生产与生产部署手册'
doc.core_properties.author = '项目团队'
doc.save(OUT)
print(OUT)
