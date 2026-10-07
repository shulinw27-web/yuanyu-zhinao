export const initialSeverityLevels = [
  {
    id: 'P0', name: '紧急事件', description: '可能导致生产中断、质量放行、合规事故或重大订单影响，必须立即处理。',
    color: '#ff647c', priority: 0, enabled: true, acknowledgementMinutes: 5, resolutionMinutes: 60,
    channels: ['in_app', 'push', 'sms', 'voice', 'email', 'webhook'], voiceMode: 'immediate', repeatMinutes: 5, maxVoiceAttempts: 3
  },
  {
    id: 'P1', name: '中等级别告警', description: '已经产生业务影响但尚未达到紧急事故标准，需要在限定时间内确认。',
    color: '#f2bd55', priority: 1, enabled: true, acknowledgementMinutes: 30, resolutionMinutes: 240,
    channels: ['in_app', 'push', 'email', 'sms'], voiceMode: 'on_timeout', repeatMinutes: 30, maxVoiceAttempts: 2
  },
  {
    id: 'P2', name: '低风险告警', description: '趋势提醒、轻微异常或建议关注事项，默认进入站内信和定时摘要。',
    color: '#57c9e8', priority: 2, enabled: true, acknowledgementMinutes: 480, resolutionMinutes: 1440,
    channels: ['in_app', 'email'], voiceMode: 'disabled', repeatMinutes: 480, maxVoiceAttempts: 0
  }
];

export const initialClassificationRules = [
  {
    id: 'quality-release-blocked', name: '质量放行或关键检验失败', priority: 100, enabled: true, version: 1,
    match: { sourceSystems: ['LIMS', 'QMS'], eventTypes: ['TestResultFailed', 'QualityReleaseBlocked', 'CriticalQualityEvent'] },
    resultSeverity: 'P0'
  },
  {
    id: 'production-interruption', name: '生产中断或关键设备停机', priority: 90, enabled: true, version: 1,
    match: { sourceSystems: ['MES'], eventTypes: ['ProductionStopped', 'CriticalDeviation'] },
    resultSeverity: 'P0'
  },
  {
    // 系统接入监控告警（2026-10-07）：接入监控轮询探测连续失败 / 自动降级时，
    // 监控服务以这两个事件类型分派告警。P1 升级链第 1 步 risk_owner 渠道含 email，
    // 收件人按事件的 ownerUserId（系统管理员）解析——邮件送达既有联系点邮箱。
    id: 'system-connection-monitoring', name: '系统接入连接异常', priority: 95, enabled: true, version: 1,
    match: { eventTypes: ['SystemConnectionProbeFailed', 'SystemConnectionDegraded'] },
    resultSeverity: 'P1'
  },
  {
    id: 'business-impact-warning', name: '已产生中等业务影响', priority: 50, enabled: true, version: 1,
    match: { minimumAffectedOrders: 1, eventTypes: ['InventoryExpiring', 'ProcessDeviation', 'OrderDelay', 'QualityTrend'] },
    resultSeverity: 'P1'
  },
  {
    id: 'default-low-risk', name: '默认低风险规则', priority: 0, enabled: true, version: 1,
    match: {}, resultSeverity: 'P2'
  }
];

export const initialEscalationPolicies = [
  {
    id: 'p0-default', name: 'P0 立即外呼升级链', severity: 'P0', enabled: true,
    steps: [
      { order: 1, delayMinutes: 0, receiverType: 'risk_owner', channels: ['voice', 'sms', 'push', 'in_app'] },
      { order: 2, delayMinutes: 5, receiverType: 'on_call', channels: ['voice', 'sms'] },
      { order: 3, delayMinutes: 10, receiverType: 'organization_manager', channels: ['voice', 'sms', 'email'] },
      { order: 4, delayMinutes: 15, receiverType: 'executive', channels: ['voice', 'sms', 'email'] }
    ]
  },
  {
    id: 'p1-default', name: 'P1 超时升级链', severity: 'P1', enabled: true,
    steps: [
      { order: 1, delayMinutes: 0, receiverType: 'risk_owner', channels: ['in_app', 'push', 'email'] },
      { order: 2, delayMinutes: 30, receiverType: 'on_call', channels: ['voice', 'sms'] },
      { order: 3, delayMinutes: 60, receiverType: 'organization_manager', channels: ['email', 'sms'] }
    ]
  },
  {
    id: 'p2-default', name: 'P2 摘要策略', severity: 'P2', enabled: true,
    steps: [{ order: 1, delayMinutes: 0, receiverType: 'risk_owner', channels: ['in_app', 'email'], digest: true }]
  }
];

export const initialOnCallSchedules = [
  { id: 'oncall-quality', name: '质量与合规 7×24 值班', organizationId: 'org-quality-dept', timezone: 'Asia/Shanghai', enabled: true, primaryUserId: 'usr-003', backupUserIds: ['usr-001'] },
  { id: 'oncall-production', name: '生产运营 7×24 值班', organizationId: 'org-production-factory-sh', timezone: 'Asia/Shanghai', enabled: true, primaryUserId: 'usr-002', backupUserIds: ['usr-001'] },
  { id: 'oncall-supply', name: '采购与供应链值班', organizationId: 'org-procurement-dept', timezone: 'Asia/Shanghai', enabled: true, primaryUserId: 'usr-004', backupUserIds: ['usr-001'] },
  { id: 'oncall-market', name: '市场运营值班', organizationId: 'org-market-dept', timezone: 'Asia/Shanghai', enabled: true, primaryUserId: 'usr-005', backupUserIds: ['usr-001'] }
];

export const initialContactPoints = [
  { userId: 'usr-001', maskedPhone: '139****0001', phoneRef: 'pii://demo/users/usr-001/mobile', email: 'admin@demo.local', enabledChannels: ['voice', 'sms', 'email', 'push', 'in_app'] },
  { userId: 'usr-002', maskedPhone: '139****0002', phoneRef: 'pii://demo/users/usr-002/mobile', email: 'production@demo.local', enabledChannels: ['voice', 'sms', 'email', 'push', 'in_app'] },
  { userId: 'usr-003', maskedPhone: '139****0003', phoneRef: 'pii://demo/users/usr-003/mobile', email: 'quality@demo.local', enabledChannels: ['voice', 'sms', 'email', 'push', 'in_app'] },
  { userId: 'usr-004', maskedPhone: '139****0004', phoneRef: 'pii://demo/users/usr-004/mobile', email: 'procurement@demo.local', enabledChannels: ['voice', 'sms', 'email', 'push', 'in_app'] },
  { userId: 'usr-005', maskedPhone: '139****0005', phoneRef: 'pii://demo/users/usr-005/mobile', email: 'market@demo.local', enabledChannels: ['voice', 'sms', 'email', 'push', 'in_app'] }
];

export const initialVoiceProviders = [
  { id: 'mock', name: 'Mock 虚拟电话', type: 'mock', enabled: true, status: 'healthy', credentialRef: null, callerId: '元域智脑', language: 'zh-CN', voice: 'standard-female', supportsDtmf: true },
  { id: 'cloud-voice', name: '云电话供应商适配器', type: 'cloud', enabled: false, status: 'not_configured', credentialRef: 'kms://health-prod/notification/cloud-voice', callerId: null, language: 'zh-CN', voice: 'standard-female', supportsDtmf: true },
  { id: 'asterisk', name: '企业 Asterisk / SIP', type: 'asterisk', enabled: false, status: 'not_configured', credentialRef: 'kms://health-prod/notification/asterisk', callerId: null, language: 'zh-CN', voice: 'standard-female', supportsDtmf: true }
];

export const initialVoiceTemplates = [
  { id: 'voice-p0-v1', severity: 'P0', version: 1, status: 'published', content: '元域智脑紧急告警。{organizationName}存在一条 P0 风险，事件编号 {riskId}。请立即登录智脑查看。按 1 确认收到，按 2 重新播放，按 3 请求升级。' },
  { id: 'voice-p1-v1', severity: 'P1', version: 1, status: 'published', content: '元域智脑告警提醒。{organizationName}存在一条超时未确认的 P1 风险，事件编号 {riskId}。请登录智脑处理。按 1 确认收到，按 2 重新播放。' }
];

export const initialAlertingDeliveries = [
  {
    id: 'NT-VOICE-9005', riskId: 'RC-2026-0042', organizationId: 'org-quality-dept', severity: 'P0', channel: 'voice',
    receiverUserId: 'usr-003', target: '139****0003', policyId: 'p0-default', escalationStep: 1,
    status: 'answered', attempt: 1, createdAt: '2026-07-30T01:43:12.000Z', updatedAt: '2026-07-30T01:43:28.000Z'
  }
];

export const initialVoiceCalls = [
  {
    id: 'CALL-2026-0001', notificationId: 'NT-VOICE-9005', riskId: 'RC-2026-0042', organizationId: 'org-quality-dept', severity: 'P0',
    receiverUserId: 'usr-003', maskedNumber: '139****0003', phoneRef: 'pii://demo/users/usr-003/mobile', providerId: 'mock',
    providerCallId: 'mock-call-seed-0001', status: 'answered', receiptStatus: 'played', attempt: 1,
    templateId: 'voice-p0-v1', policyVersion: 1, idempotencyKey: 'RC-2026-0042:p0-default:1:usr-003:voice',
    startedAt: '2026-07-30T01:43:12.000Z', answeredAt: '2026-07-30T01:43:18.000Z', completedAt: '2026-07-30T01:43:28.000Z', acknowledgedAt: null
  }
];
