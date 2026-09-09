const guidance = ({ type, severity = 'warning', title, problem, why, suggestions = [], example = null }) => ({
  type,
  severity,
  title,
  problem,
  why,
  suggestions,
  example
});

export const guidanceForMissingIntent = () => guidance({
  type: 'invalid_path',
  title: '缺少可执行的业务目标',
  problem: '当前输入无法确定要处理的业务对象、范围或结果。',
  why: '在目标不明确时读取企业数据，可能扩大数据访问范围并产生错误结论。',
  suggestions: ['补充业务领域', '提供批次号、订单号或物料', '说明时间范围和期望结果'],
  example: '请检查 8 月 20 日 PB-20260820-A 批次的质量风险，并列出需要我确认的事项。'
});

export const guidanceForUnsafePrompt = () => guidance({
  type: 'policy_violation',
  severity: 'blocked',
  title: '请求包含违规或高风险操作路径',
  problem: '请求试图覆盖安全规则、绕过权限/审批，或访问不应暴露的内部信息。',
  why: '智脑不能通过自然语言改变服务端权限、审批规则或安全边界。',
  suggestions: ['改为描述合法业务目标', '申请对应角色或数据域授权', '先请求只读分析与影响评估'],
  example: '请在我当前权限范围内评估该操作的影响，并告诉我需要由谁审批。'
});

export const guidanceForAuthorizationDenied = (deniedDomains = []) => guidance({
  type: 'permission_boundary',
  severity: 'blocked',
  title: '当前路径超出身份或数据权限',
  problem: deniedDomains.length ? `当前身份无权访问：${deniedDomains.join('、')}。` : '当前身份未获得该业务领域或动作权限。',
  why: '模型只负责理解和规划，数据读取与业务执行始终由服务端权限中心判定。',
  suggestions: ['让管理员配置对应数据域与按钮权限', '改为查询本人或本组织可见数据', '请有权角色发起并完成审批'],
  example: '请仅基于我有权访问的组织数据给出只读风险摘要。'
});

export const guidanceForCommandDowngrade = () => guidance({
  type: 'controlled_downgrade',
  title: '写入路径不合理，已降级为只读建议',
  problem: '当前有效角色不能同时发起智脑任务并确认该业务动作。',
  why: '把生成建议与执行授权分离，可防止角色拼接、越权确认和提示词诱导执行。',
  suggestions: ['由具备完整权限的角色重新发起', '提交权限申请或走人工审批', '继续使用当前只读分析结果准备材料'],
  example: '请输出只读处置方案和所需审批人，不要创建业务草稿。'
});

export const guidanceForAttachmentRejected = (reason) => guidance({
  type: 'invalid_attachment',
  severity: 'blocked',
  title: '材料不符合安全接入要求',
  problem: String(reason || '附件格式、大小或内容未通过校验。'),
  why: '未经扫描的材料不能进入模型上下文或业务工具链。',
  suggestions: ['使用 JPEG、PNG、WEBP 或 PDF', '确保单个文件不超过 4MB', '移除密钥、令牌和不可信指令后重试'],
  example: '先上传已脱敏且完成安全扫描的业务材料。'
});
