import { randomUUID } from 'node:crypto';

const ARTIFACT_DESTINATIONS = Object.freeze(['desktop', 'documents', 'downloads']);
const artifactDestinationSchema = Object.freeze({ type: 'string', enum: ARTIFACT_DESTINATIONS });
const artifactDestinationLabels = Object.freeze({
  desktop: '桌面“元域智脑工作区”',
  documents: '文档“元域智脑工作区”',
  downloads: '下载“元域智脑工作区”'
});

const textArtifactSchema = Object.freeze({
  type: 'object',
  properties: Object.freeze({
    fileName: Object.freeze({ type: 'string', minLength: 1, maxLength: 120, pattern: '^[^\\\\/:*?"<>|]+\\.(?:md|txt|csv)$' }),
    content: Object.freeze({ type: 'string', minLength: 1, maxLength: 524_288 }),
    conflictPolicy: Object.freeze({ type: 'string', enum: Object.freeze(['create_unique']) }),
    destination: artifactDestinationSchema
  }),
  required: Object.freeze(['fileName', 'content', 'conflictPolicy']),
  additionalProperties: false
});

const officeArtifactSchema = (extension) => Object.freeze({
  type: 'object',
  properties: Object.freeze({
    fileName: Object.freeze({ type: 'string', minLength: 1, maxLength: 120, pattern: `^[^\\\\/:*?"<>|]+\\.${extension}$` }),
    content: Object.freeze({ type: 'string', minLength: 1, maxLength: 524_288 }),
    conflictPolicy: Object.freeze({ type: 'string', enum: Object.freeze(['create_unique']) }),
    destination: artifactDestinationSchema
  }),
  required: Object.freeze(['fileName', 'content', 'conflictPolicy']),
  additionalProperties: false
});

const workspaceFileSchema = Object.freeze({
  type: 'object',
  properties: Object.freeze({
    fileName: Object.freeze({ type: 'string', minLength: 1, maxLength: 120, pattern: '^[^\\\\/:*?"<>|]+\\.(?:md|txt|csv)$' })
  }),
  required: Object.freeze(['fileName']),
  additionalProperties: false
});

const desktopTools = Object.freeze([
  Object.freeze({
    id: 'desktop.artifact.create_text',
    name: '在智脑工作区创建文本产物',
    capability: 'desktop.artifact.create',
    riskLevel: 'L1',
    sideEffect: 'reversible_local_write',
    executionTarget: 'electron_endpoint',
    requiresConfirmation: true,
    enabled: true,
    description: '只在智脑专属工作区新建 Markdown、文本或 CSV 文件；不允许覆盖现有文件。',
    inputSchema: textArtifactSchema
  }),
  Object.freeze({
    id: 'desktop.artifact.create_docx',
    name: '在智脑工作区创建 Word 草稿',
    capability: 'desktop.artifact.create',
    riskLevel: 'L1',
    sideEffect: 'reversible_local_write',
    executionTarget: 'electron_endpoint',
    requiresConfirmation: true,
    enabled: true,
    description: '只在智脑专属工作区新建格式化 DOCX 草稿；不允许覆盖现有文件。',
    inputSchema: officeArtifactSchema('docx')
  }),
  Object.freeze({
    id: 'desktop.artifact.create_xlsx',
    name: '在智脑工作区创建 Excel 工作簿',
    capability: 'desktop.artifact.create',
    riskLevel: 'L1',
    sideEffect: 'reversible_local_write',
    executionTarget: 'electron_endpoint',
    requiresConfirmation: true,
    enabled: true,
    description: '只在智脑专属工作区新建结构化 XLSX 工作簿；不允许覆盖现有文件。',
    inputSchema: officeArtifactSchema('xlsx')
  }),
  Object.freeze({
    id: 'desktop.browser.open_https',
    name: '在系统浏览器打开 HTTPS 页面',
    capability: 'desktop.browser.navigate',
    riskLevel: 'L1',
    sideEffect: 'external_navigation',
    executionTarget: 'electron_endpoint',
    requiresConfirmation: true,
    enabled: true,
    description: '只允许本人确认后使用系统浏览器打开 HTTPS 地址；禁止凭据、file、data、javascript 和本机协议。',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({ url: Object.freeze({ type: 'string', minLength: 9, maxLength: 2_048, pattern: '^https://[^\\s]+$' }) }),
      required: Object.freeze(['url']),
      additionalProperties: false
    })
  }),
  Object.freeze({
    id: 'desktop.workspace.read_text',
    name: '读取智脑工作区文本产物',
    capability: 'desktop.workspace.read',
    riskLevel: 'L1',
    sideEffect: 'local_read',
    executionTarget: 'electron_endpoint',
    requiresConfirmation: true,
    enabled: true,
    description: '仅在本人确认后读取智脑专属工作区内的 Markdown、文本或 CSV 文件；禁止路径穿越、链接文件和其他目录。',
    inputSchema: workspaceFileSchema
  }),
  Object.freeze({
    id: 'desktop.clipboard.write_text',
    name: '复制文本到系统剪贴板',
    capability: 'desktop.clipboard.write',
    riskLevel: 'L1',
    sideEffect: 'reversible_local_write',
    executionTarget: 'electron_endpoint',
    requiresConfirmation: true,
    enabled: true,
    description: '仅在本人确认后把智脑生成的纯文本写入系统剪贴板，不读取剪贴板原内容。',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({ text: Object.freeze({ type: 'string', minLength: 1, maxLength: 65_536 }) }),
      required: Object.freeze(['text']),
      additionalProperties: false
    })
  }),
  Object.freeze({
    id: 'desktop.mail.send',
    name: '发送邮件',
    capability: 'desktop.mail.send',
    riskLevel: 'L2',
    sideEffect: 'external_write',
    executionTarget: 'electron_endpoint',
    requiresConfirmation: true,
    enabled: false,
    blockedReason: '当前阶段只支持邮件草稿规划，尚未开放外部发送。',
    inputSchema: Object.freeze({ type: 'object', properties: Object.freeze({}), required: Object.freeze([]), additionalProperties: false })
  }),
  Object.freeze({
    id: 'desktop.file.delete',
    name: '删除本地文件',
    capability: 'desktop.file.delete',
    riskLevel: 'L3',
    sideEffect: 'destructive_local_write',
    executionTarget: 'electron_endpoint',
    requiresConfirmation: true,
    enabled: false,
    blockedReason: '当前策略禁止 Agent 删除本地文件。',
    inputSchema: Object.freeze({ type: 'object', properties: Object.freeze({}), required: Object.freeze([]), additionalProperties: false })
  })
]);

const toolById = new Map(desktopTools.map((tool) => [tool.id, tool]));

const validatePrimitive = (definition, value, key) => {
  if (definition.type === 'string' && typeof value !== 'string') return `${key} 必须是字符串。`;
  if (definition.type === 'string' && value.length < (definition.minLength || 0)) return `${key} 长度不足。`;
  if (definition.type === 'string' && definition.maxLength && value.length > definition.maxLength) return `${key} 超出最大长度。`;
  if (definition.enum && !definition.enum.includes(value)) return `${key} 不在允许值范围内。`;
  if (definition.pattern && !new RegExp(definition.pattern, 'u').test(value)) return `${key} 格式不符合端侧工具约束。`;
  return null;
};

export function getDesktopToolCatalog() {
  return desktopTools.map((tool) => structuredClone(tool));
}

export function validateDesktopToolInvocation(toolId, input = {}) {
  const tool = toolById.get(String(toolId || ''));
  if (!tool) return { valid: false, code: 'DESKTOP_TOOL_NOT_REGISTERED', error: '端侧工具未在服务端允许列表中注册。' };
  if (!tool.enabled) return { valid: false, code: 'DESKTOP_TOOL_DISABLED', error: tool.blockedReason || '端侧工具当前未开放。', tool };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { valid: false, code: 'DESKTOP_TOOL_INPUT_INVALID', error: '端侧工具参数必须是对象。', tool };
  const schema = tool.inputSchema;
  const unexpected = Object.keys(input).filter((key) => !Object.hasOwn(schema.properties, key));
  if (unexpected.length) return { valid: false, code: 'DESKTOP_TOOL_INPUT_ADDITIONAL_PROPERTY', error: `端侧工具参数包含未授权字段：${unexpected.join('、')}`, tool };
  const missing = schema.required.filter((key) => !Object.hasOwn(input, key));
  if (missing.length) return { valid: false, code: 'DESKTOP_TOOL_INPUT_REQUIRED', error: `端侧工具缺少必填字段：${missing.join('、')}`, tool };
  for (const [key, value] of Object.entries(input)) {
    const error = validatePrimitive(schema.properties[key], value, key);
    if (error) return { valid: false, code: 'DESKTOP_TOOL_INPUT_SCHEMA', error, tool };
  }
  if (tool.id === 'desktop.browser.open_https') {
    try {
      const target = new URL(input.url);
      if (target.protocol !== 'https:' || target.username || target.password) throw new Error('denied');
    } catch {
      return { valid: false, code: 'DESKTOP_TOOL_INPUT_SCHEMA', error: 'url 必须是无内嵌凭据的 HTTPS 地址。', tool };
    }
  }
  return { valid: true, tool };
}

const normalizeTitle = (input) => {
  const quoted = String(input || '').match(/[《“"]([^》”"]{2,40})[》”"]/u)?.[1];
  const base = quoted || String(input || '')
    .replace(/(?:保存|导出|写入|放|生成|创建)?(?:到|至|在|于)?(?:我的)?(?:桌面(?:上)?|文档(?:目录|文件夹)?|下载(?:目录|文件夹))(?:里|下|中)?/gu, ' ')
    .replace(/(?:请|麻烦|帮我|给我|把|将|生成|创建|保存|写入|导出|一份|一个|文档|文件|报告|工作区|里面|中)/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 32) || '智脑工作成果';
  return base.replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '-').replace(/[. ]+$/u, '').slice(0, 48) || '智脑工作成果';
};

export const resolveArtifactDestination = (input) => {
  const text = String(input || '');
  if (/(?:我的文档|文档目录|文档文件夹)(?:里|下|中)?|(?:保存|导出|写入|放)?(?:到|至|在|于)(?:我的)?文档(?:里|下|中)?/u.test(text)) return 'documents';
  if (/(?:下载目录|下载文件夹)(?:里|下|中)?|(?:保存|导出|写入|放)?(?:到|至|在|于)(?:我的)?下载(?:里|下|中)?/u.test(text)) return 'downloads';
  if (/桌面(?:上|里|下|中)?/u.test(text)) return 'desktop';
  return 'desktop';
};

const affirmativeDesktopInput = (input) => String(input || '').split(/[，,。；;！!？?\n]|(?:但是|但|不过)/u)
  .filter(clause => !/(?:不要|不用|不必|无需|禁止|暂不|不能|不可|(?<!识|辨|区|级)别|不(?:再|会|能)?(?:保存|发布|生成|创建|读取|查看|复制|打开|写入|导出))|\b(?:don't|do not|never)\b/iu.test(clause)).join('，');

export const isDesktopArtifactIntent = (input) => (
  /(?:生成|创建|整理|保存|写入|导出).{0,24}(?:文档|文件|报告|笔记|纪要|Word|DOCX|Excel|XLSX|表格|清单|台账)|(?:保存|写入|导出).{0,18}(?:工作区|本地)/iu.test(affirmativeDesktopInput(input))
);

export const isDesktopBrowserIntent = (input) => (
  /(?:用|在|通过)?(?:浏览器|网页).{0,12}(?:打开|访问|搜索|查询)|(?:打开|访问).{0,12}https:\/\//iu.test(affirmativeDesktopInput(input))
);

export const isDesktopClipboardIntent = (input) => /(?:复制|拷贝).{0,12}(?:剪贴板|粘贴板)|(?:剪贴板|粘贴板).{0,12}(?:写入|保存|复制)/u.test(affirmativeDesktopInput(input));

export const isDesktopWorkspaceReadIntent = (input) => /(?:读取|查看|总结|分析).{0,18}(?:工作区|本地).{0,12}(?:md|txt|csv|文件|文档)|(?:读取|查看|总结|分析).{0,12}[^\\/:*?"<>|\s]+\.(?:md|txt|csv)/iu.test(affirmativeDesktopInput(input));

const csvCell = (value) => `"${String(value || '').replace(/"/gu, '""').replace(/[\r\n]+/gu, ' ')}"`;

export function buildDesktopArtifactCommand({ input, content }) {
  const title = normalizeTitle(input);
  const destination = resolveArtifactDestination(input);
  const destinationLabel = artifactDestinationLabels[destination];
  const body = String(content || '').trim();
  const isExplicitCsv = /CSV/iu.test(String(input || ''));
  const isXlsx = !isExplicitCsv && /(?:Excel|XLSX|电子表格|表格|清单|台账)/iu.test(String(input || ''));
  const isDocx = !isXlsx && /(?:Word|DOCX|办公文档)/iu.test(String(input || ''));
  const extension = isExplicitCsv ? 'csv' : isXlsx ? 'xlsx' : isDocx ? 'docx' : 'md';
  const toolId = isXlsx ? 'desktop.artifact.create_xlsx' : isDocx ? 'desktop.artifact.create_docx' : 'desktop.artifact.create_text';
  const actionInput = {
    fileName: `${title}.${extension}`,
    content: isExplicitCsv
      ? `字段,内容\r\n${csvCell('用户目标')},${csvCell(String(input || '').trim())}\r\n${csvCell('智脑输出')},${csvCell(body || '当前没有可写入的有效内容。')}\r\n`
      : `# ${title}\n\n## 用户目标\n\n${String(input || '').trim()}\n\n## 智脑输出\n\n${body || '当前没有可写入的有效内容。'}\n`,
    conflictPolicy: 'create_unique',
    destination
  };
  const validation = validateDesktopToolInvocation(toolId, actionInput);
  if (!validation.valid) return null;
  return {
    id: isXlsx ? 'desktop_create_xlsx_artifact' : isDocx ? 'desktop_create_docx_artifact' : 'desktop_create_text_artifact',
    target: 'desktop',
    label: `确认在${destinationLabel}创建“${actionInput.fileName}”`,
    confirmLabel: `确认创建${isXlsx ? ' Excel 工作簿' : isDocx ? ' Word 草稿' : '本地文档'}`,
    requiresConfirmation: true,
    impact: `仅在${destinationLabel}新建文件，不覆盖现有文件，不访问其他目录。`,
    control: {
      allowed: true,
      action: validation.tool.id,
      riskLevel: validation.tool.riskLevel,
      requiredCapability: validation.tool.capability,
      reason: validation.tool.description
    },
    endpointAction: {
      dispatchId: `desktop-dispatch-${randomUUID()}`,
      toolId: validation.tool.id,
      input: actionInput
    }
  };
}

export function buildDesktopBrowserCommand({ input }) {
  const text = String(input || '').trim();
  const explicit = text.match(/https:\/\/[^\s，。；、]+/iu)?.[0];
  let url;
  try {
    if (explicit) {
      const parsed = new URL(explicit);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
      url = parsed.toString();
    } else if (/(?:浏览器|网页).{0,12}(?:搜索|查询)/iu.test(text)) {
      const query = text
        .replace(/(?:请|帮我|使用|用|在|通过|浏览器|网页|搜索|查询|打开)/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, 200);
      if (!query) return null;
      url = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
    } else return null;
  } catch {
    return null;
  }
  const validation = validateDesktopToolInvocation('desktop.browser.open_https', { url });
  if (!validation.valid) return null;
  const target = new URL(url);
  return {
    id: 'desktop_open_https_url',
    target: 'desktop',
    label: `确认使用系统浏览器打开 ${target.hostname}`,
    confirmLabel: '确认打开浏览器',
    requiresConfirmation: true,
    impact: '将把该 HTTPS 地址交给系统默认浏览器；搜索词或网址会发送给目标网站。',
    control: {
      allowed: true,
      action: validation.tool.id,
      riskLevel: validation.tool.riskLevel,
      requiredCapability: validation.tool.capability,
      reason: validation.tool.description
    },
    endpointAction: {
      dispatchId: `desktop-dispatch-${randomUUID()}`,
      toolId: validation.tool.id,
      input: { url }
    }
  };
}

export function buildDesktopClipboardCommand({ input, content }) {
  const text = String(content || input || '').trim().slice(0, 65_536);
  const validation = validateDesktopToolInvocation('desktop.clipboard.write_text', { text });
  if (!validation.valid) return null;
  return {
    id: 'desktop_write_clipboard_text', target: 'desktop', label: '确认把智脑输出复制到系统剪贴板', confirmLabel: '确认复制', requiresConfirmation: true,
    impact: '将替换系统剪贴板中的文本内容；智脑不会读取原剪贴板。',
    control: { allowed: true, action: validation.tool.id, riskLevel: validation.tool.riskLevel, requiredCapability: validation.tool.capability, reason: validation.tool.description },
    endpointAction: { dispatchId: `desktop-dispatch-${randomUUID()}`, toolId: validation.tool.id, input: { text } }
  };
}

export function buildDesktopWorkspaceReadCommand({ input }) {
  const fileName = String(input || '').match(/([^\\/:*?"<>|\s，。；、]{1,110}\.(?:md|txt|csv))/iu)?.[1];
  if (!fileName) return null;
  const validation = validateDesktopToolInvocation('desktop.workspace.read_text', { fileName });
  if (!validation.valid) return null;
  return {
    id: 'desktop_read_workspace_text', target: 'desktop', label: `确认读取智脑工作区文件“${fileName}”`, confirmLabel: '确认读取', requiresConfirmation: true,
    impact: '只读取智脑专属工作区内指定的文本文件，最多返回 512 KiB，不访问其他目录。',
    control: { allowed: true, action: validation.tool.id, riskLevel: validation.tool.riskLevel, requiredCapability: validation.tool.capability, reason: validation.tool.description },
    endpointAction: { dispatchId: `desktop-dispatch-${randomUUID()}`, toolId: validation.tool.id, input: { fileName } }
  };
}

export function buildDesktopCommandForInput({ input, content }) {
  input = affirmativeDesktopInput(input);
  if (isDesktopWorkspaceReadIntent(input)) return buildDesktopWorkspaceReadCommand({ input });
  if (isDesktopClipboardIntent(input)) return buildDesktopClipboardCommand({ input, content });
  if (isDesktopBrowserIntent(input)) return buildDesktopBrowserCommand({ input });
  if (isDesktopArtifactIntent(input)) return buildDesktopArtifactCommand({ input, content });
  return null;
}

export function createDesktopExecutionDispatch(endpointAction, { runId, expiresAt }) {
  const validation = validateDesktopToolInvocation(endpointAction?.toolId, endpointAction?.input);
  if (!validation.valid) return { error: validation.error, code: validation.code };
  if (!endpointAction?.dispatchId || !String(endpointAction.dispatchId).startsWith('desktop-dispatch-')) {
    return { error: '端侧执行派发标识无效。', code: 'DESKTOP_DISPATCH_INVALID' };
  }
  return {
    protocolVersion: 'desktop-execution.v1',
    dispatchId: endpointAction.dispatchId,
    runId,
    toolId: validation.tool.id,
    input: structuredClone(endpointAction.input),
    riskLevel: validation.tool.riskLevel,
    workspaceScope: 'zhinao_artifacts_only',
    expiresAt
  };
}

export function validateDesktopExecutionReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return { valid: false, error: '端侧执行回执必须是对象。', code: 'DESKTOP_RECEIPT_INVALID' };
  const allowed = new Set(['status', 'dispatchId', 'toolId', 'artifact', 'result', 'error', 'completedAt']);
  const unexpected = Object.keys(receipt).filter((key) => !allowed.has(key));
  if (unexpected.length) return { valid: false, error: `端侧回执包含未授权字段：${unexpected.join('、')}`, code: 'DESKTOP_RECEIPT_ADDITIONAL_PROPERTY' };
  if (!['succeeded', 'failed'].includes(receipt.status)) return { valid: false, error: '端侧回执状态无效。', code: 'DESKTOP_RECEIPT_STATUS_INVALID' };
  if (!String(receipt.dispatchId || '').startsWith('desktop-dispatch-')) return { valid: false, error: '端侧回执派发标识无效。', code: 'DESKTOP_RECEIPT_DISPATCH_INVALID' };
  if (receipt.status === 'succeeded' && ['desktop.artifact.create_text', 'desktop.artifact.create_docx', 'desktop.artifact.create_xlsx'].includes(receipt.toolId)) {
    const artifact = receipt.artifact;
    if (!artifact || typeof artifact !== 'object' || !artifact.relativePath || !artifact.sha256 || !Number.isInteger(artifact.bytes)) {
      return { valid: false, error: '端侧产物回执缺少路径、大小或哈希。', code: 'DESKTOP_RECEIPT_ARTIFACT_INVALID' };
    }
    if (String(artifact.relativePath).includes('..') || /^[A-Za-z]:|^[\\/]/u.test(String(artifact.relativePath))) {
      return { valid: false, error: '端侧产物回执路径必须是工作区相对路径。', code: 'DESKTOP_RECEIPT_PATH_INVALID' };
    }
    const artifactKeys = new Set(['relativePath', 'bytes', 'sha256', 'workspace']);
    if (Object.keys(artifact).some((key) => !artifactKeys.has(key))) return { valid: false, error: '端侧产物回执包含未授权字段。', code: 'DESKTOP_RECEIPT_ARTIFACT_ADDITIONAL_PROPERTY' };
    if (!/^[a-f0-9]{64}$/u.test(String(artifact.sha256)) || artifact.bytes < 1 || artifact.bytes > 1_048_576) {
      return { valid: false, error: '端侧产物大小或 SHA-256 无效。', code: 'DESKTOP_RECEIPT_ARTIFACT_INTEGRITY_INVALID' };
    }
  }
  if (receipt.status === 'succeeded' && receipt.toolId === 'desktop.browser.open_https') {
    const result = receipt.result;
    if (!result || result.kind !== 'browser_navigation' || typeof result.origin !== 'string') return { valid: false, error: '浏览器导航回执无效。', code: 'DESKTOP_RECEIPT_BROWSER_RESULT_INVALID' };
    if (Object.keys(result).some((key) => !['kind', 'origin'].includes(key))) return { valid: false, error: '浏览器导航回执包含未授权字段。', code: 'DESKTOP_RECEIPT_BROWSER_RESULT_ADDITIONAL_PROPERTY' };
    try {
      if (new URL(result.origin).protocol !== 'https:') throw new Error('invalid protocol');
    } catch {
      return { valid: false, error: '浏览器导航回执来源不是 HTTPS。', code: 'DESKTOP_RECEIPT_BROWSER_ORIGIN_INVALID' };
    }
  }
  if (receipt.status === 'succeeded' && receipt.toolId === 'desktop.workspace.read_text') {
    const result = receipt.result;
    if (!result || result.kind !== 'workspace_text' || typeof result.fileName !== 'string' || typeof result.content !== 'string' || !Number.isInteger(result.bytes) || !/^[a-f0-9]{64}$/u.test(String(result.sha256 || ''))) {
      return { valid: false, error: '工作区文本读取回执无效。', code: 'DESKTOP_RECEIPT_WORKSPACE_TEXT_INVALID' };
    }
    if (Object.keys(result).some((key) => !['kind', 'fileName', 'content', 'bytes', 'sha256', 'truncated'].includes(key)) || result.bytes < 0 || result.bytes > 524_288 || result.content.length > 524_288) {
      return { valid: false, error: '工作区文本读取回执超出允许范围。', code: 'DESKTOP_RECEIPT_WORKSPACE_TEXT_INVALID' };
    }
  }
  if (receipt.status === 'succeeded' && receipt.toolId === 'desktop.clipboard.write_text') {
    const result = receipt.result;
    if (!result || result.kind !== 'clipboard_write' || !Number.isInteger(result.characters) || result.characters < 1 || result.characters > 65_536 || Object.keys(result).some((key) => !['kind', 'characters'].includes(key))) {
      return { valid: false, error: '剪贴板写入回执无效。', code: 'DESKTOP_RECEIPT_CLIPBOARD_INVALID' };
    }
  }
  return { valid: true };
}
