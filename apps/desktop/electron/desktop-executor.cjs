const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { buildDocxBuffer, buildXlsxBuffer } = require('./office-artifact-builder.cjs');

const MAX_CONTENT_BYTES = 1024 * 1024;
const FILE_NAME_PATTERN = /^[^\\/:*?"<>|\u0000-\u001f]{1,120}\.(?:md|txt|csv|docx|xlsx)$/u;
const ARTIFACT_TOOL_IDS = new Set(['desktop.artifact.create_text', 'desktop.artifact.create_docx', 'desktop.artifact.create_xlsx']);
const ARTIFACT_DESTINATIONS = new Set(['desktop', 'documents', 'downloads']);
const WORKSPACE_LABELS = Object.freeze({ desktop: '桌面\\元域智脑工作区', documents: '文档\\元域智脑工作区', downloads: '下载\\元域智脑工作区' });
const WORKSPACE_TEXT_PATTERN = /^[^\\/:*?"<>|\u0000-\u001f]{1,120}\.(?:md|txt|csv)$/u;
const ALLOWED_TOOL_IDS = new Set([...ARTIFACT_TOOL_IDS, 'desktop.browser.open_https', 'desktop.workspace.read_text', 'desktop.clipboard.write_text']);

const safeError = (error) => {
  const code = String(error?.code || 'DESKTOP_EXECUTION_FAILED').slice(0, 80);
  const known = {
    EACCES: '智脑工作区没有写入权限。',
    EPERM: '操作系统拒绝写入智脑工作区。',
    ENOSPC: '磁盘空间不足，无法创建本地产物。'
  };
  return { code, message: known[code] || String(error?.safeMessage || '端侧执行失败，未创建本地产物。').slice(0, 300) };
};

const validateDispatch = (dispatch) => {
  if (!dispatch || typeof dispatch !== 'object' || Array.isArray(dispatch)) throw Object.assign(new Error(), { code: 'DESKTOP_DISPATCH_INVALID', safeMessage: '端侧执行请求无效。' });
  if (dispatch.protocolVersion !== 'desktop-execution.v1') throw Object.assign(new Error(), { code: 'DESKTOP_PROTOCOL_UNSUPPORTED', safeMessage: '端侧执行协议版本不受支持。' });
  if (!String(dispatch.dispatchId || '').startsWith('desktop-dispatch-')) throw Object.assign(new Error(), { code: 'DESKTOP_DISPATCH_ID_INVALID', safeMessage: '端侧执行标识无效。' });
  if (!String(dispatch.runId || '').startsWith('run-')) throw Object.assign(new Error(), { code: 'DESKTOP_RUN_ID_INVALID', safeMessage: '端侧任务标识无效。' });
  if (!ALLOWED_TOOL_IDS.has(dispatch.toolId) || dispatch.riskLevel !== 'L1' || dispatch.workspaceScope !== 'zhinao_artifacts_only') {
    throw Object.assign(new Error(), { code: 'DESKTOP_TOOL_NOT_ALLOWED', safeMessage: '当前桌面端未授权执行该工具或风险等级。' });
  }
  const expiresAt = new Date(dispatch.expiresAt || '').getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw Object.assign(new Error(), { code: 'DESKTOP_DISPATCH_EXPIRED', safeMessage: '端侧执行授权已过期，请重新发起任务。' });
  const input = dispatch.input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Object.assign(new Error(), { code: 'DESKTOP_INPUT_INVALID', safeMessage: '端侧工具参数无效。' });
  if (ARTIFACT_TOOL_IDS.has(dispatch.toolId)) {
    const allowedKeys = new Set(['fileName', 'content', 'conflictPolicy', 'destination']);
    if (Object.keys(input).some((key) => !allowedKeys.has(key))) throw Object.assign(new Error(), { code: 'DESKTOP_INPUT_ADDITIONAL_PROPERTY', safeMessage: '端侧工具参数包含未授权字段。' });
    if (!FILE_NAME_PATTERN.test(String(input.fileName || '')) || path.basename(input.fileName) !== input.fileName) {
      throw Object.assign(new Error(), { code: 'DESKTOP_FILE_NAME_INVALID', safeMessage: '文件名或扩展名不符合智脑工作区约束。' });
    }
    if (typeof input.content !== 'string' || !input.content.trim()) throw Object.assign(new Error(), { code: 'DESKTOP_CONTENT_INVALID', safeMessage: '没有可写入的文档内容。' });
    if (Buffer.byteLength(input.content, 'utf8') > MAX_CONTENT_BYTES) throw Object.assign(new Error(), { code: 'DESKTOP_CONTENT_TOO_LARGE', safeMessage: '文档内容超出端侧执行器限制。' });
    if (input.conflictPolicy !== 'create_unique') throw Object.assign(new Error(), { code: 'DESKTOP_CONFLICT_POLICY_INVALID', safeMessage: '端侧执行器不允许覆盖现有文件。' });
    if (input.destination !== undefined && !ARTIFACT_DESTINATIONS.has(input.destination)) throw Object.assign(new Error(), { code: 'DESKTOP_DESTINATION_INVALID', safeMessage: '目标位置不在智脑允许的本地工作区范围内。' });
    const extension = path.extname(input.fileName).toLowerCase();
    const expected = { 'desktop.artifact.create_text': new Set(['.md', '.txt', '.csv']), 'desktop.artifact.create_docx': new Set(['.docx']), 'desktop.artifact.create_xlsx': new Set(['.xlsx']) }[dispatch.toolId];
    if (!expected.has(extension)) throw Object.assign(new Error(), { code: 'DESKTOP_ARTIFACT_FORMAT_MISMATCH', safeMessage: '端侧工具与目标文件格式不匹配。' });
  } else if (dispatch.toolId === 'desktop.browser.open_https') {
    if (Object.keys(input).length !== 1 || typeof input.url !== 'string') throw Object.assign(new Error(), { code: 'DESKTOP_BROWSER_INPUT_INVALID', safeMessage: '浏览器导航参数无效。' });
    let target;
    try { target = new URL(input.url); } catch { throw Object.assign(new Error(), { code: 'DESKTOP_BROWSER_URL_INVALID', safeMessage: '浏览器地址无效。' }); }
    if (target.protocol !== 'https:' || target.username || target.password || input.url.length > 2_048) {
      throw Object.assign(new Error(), { code: 'DESKTOP_BROWSER_URL_DENIED', safeMessage: '只允许无内嵌凭据的 HTTPS 地址。' });
    }
  } else if (dispatch.toolId === 'desktop.workspace.read_text') {
    if (Object.keys(input).length !== 1 || !WORKSPACE_TEXT_PATTERN.test(String(input.fileName || '')) || path.basename(input.fileName) !== input.fileName) {
      throw Object.assign(new Error(), { code: 'DESKTOP_WORKSPACE_READ_INPUT_INVALID', safeMessage: '工作区文本文件名无效。' });
    }
  } else if (dispatch.toolId === 'desktop.clipboard.write_text') {
    if (Object.keys(input).length !== 1 || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 65_536) {
      throw Object.assign(new Error(), { code: 'DESKTOP_CLIPBOARD_INPUT_INVALID', safeMessage: '剪贴板文本无效或超出长度限制。' });
    }
  }
  return input;
};

const chooseUniqueFile = (workspaceRoot, fileName) => {
  const extension = path.extname(fileName);
  const baseName = path.basename(fileName, extension);
  for (let index = 0; index < 1000; index += 1) {
    const candidate = index ? `${baseName} (${index})${extension}` : fileName;
    const target = path.resolve(workspaceRoot, candidate);
    if (path.dirname(target) !== workspaceRoot) throw Object.assign(new Error(), { code: 'DESKTOP_PATH_ESCAPE', safeMessage: '文件目标超出智脑工作区。' });
    if (!fs.existsSync(target)) return { candidate, target };
  }
  throw Object.assign(new Error(), { code: 'DESKTOP_NAME_EXHAUSTED', safeMessage: '同名文件过多，请修改任务标题后重试。' });
};

function createDesktopExecutor({ workspaceRoot = null, workspaceRoots = null, openExternal = null, openPath = null, writeClipboard = null }) {
  const configuredRoots = workspaceRoots || (workspaceRoot ? { desktop: workspaceRoot } : null);
  if (!configuredRoots || typeof configuredRoots !== 'object' || Array.isArray(configuredRoots)) throw new TypeError('workspaceRoot or workspaceRoots is required');
  const requestedRoots = Object.fromEntries(Object.entries(configuredRoots).map(([destination, root]) => {
    if (!ARTIFACT_DESTINATIONS.has(destination) || !path.isAbsolute(root)) throw new TypeError('workspace roots must use allowlisted destinations and absolute paths');
    return [destination, path.resolve(root)];
  }));
  if (!requestedRoots.desktop) throw new TypeError('desktop workspace root is required');

  const ensureWorkspace = (destination = 'desktop') => {
    const requestedRoot = requestedRoots[destination];
    if (!requestedRoot) throw Object.assign(new Error(), { code: 'DESKTOP_DESTINATION_UNAVAILABLE', safeMessage: '当前设备没有配置该目标工作区。' });
    fs.mkdirSync(requestedRoot, { recursive: true });
    const stats = fs.lstatSync(requestedRoot);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw Object.assign(new Error(), { code: 'DESKTOP_WORKSPACE_INVALID', safeMessage: '智脑工作区不是可信的本地目录。' });
    return fs.realpathSync.native(requestedRoot);
  };

  const execute = async (dispatch) => {
    const completedAt = () => new Date().toISOString();
    try {
      const input = validateDispatch(dispatch);
      if (dispatch.toolId === 'desktop.browser.open_https') {
        if (typeof openExternal !== 'function') throw Object.assign(new Error(), { code: 'DESKTOP_BROWSER_ADAPTER_MISSING', safeMessage: '系统浏览器适配器不可用。' });
        await openExternal(input.url);
        return {
          status: 'succeeded',
          dispatchId: dispatch.dispatchId,
          toolId: dispatch.toolId,
          result: { kind: 'browser_navigation', origin: new URL(input.url).origin },
          completedAt: completedAt()
        };
      }
      const destination = ARTIFACT_TOOL_IDS.has(dispatch.toolId) ? (input.destination || 'desktop') : 'desktop';
      const root = ensureWorkspace(destination);
      if (dispatch.toolId === 'desktop.workspace.read_text') {
        const target = path.resolve(root, input.fileName);
        if (path.dirname(target) !== root) throw Object.assign(new Error(), { code: 'DESKTOP_PATH_ESCAPE', safeMessage: '文件目标超出智脑工作区。' });
        const stats = fs.lstatSync(target);
        if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 524_288) throw Object.assign(new Error(), { code: 'DESKTOP_WORKSPACE_FILE_DENIED', safeMessage: '文件不是可信的工作区文本，或大小超出限制。' });
        const buffer = fs.readFileSync(target);
        return { status: 'succeeded', dispatchId: dispatch.dispatchId, toolId: dispatch.toolId, result: { kind: 'workspace_text', fileName: input.fileName, content: buffer.toString('utf8'), bytes: buffer.byteLength, sha256: crypto.createHash('sha256').update(buffer).digest('hex'), truncated: false }, completedAt: completedAt() };
      }
      if (dispatch.toolId === 'desktop.clipboard.write_text') {
        if (typeof writeClipboard !== 'function') throw Object.assign(new Error(), { code: 'DESKTOP_CLIPBOARD_ADAPTER_MISSING', safeMessage: '系统剪贴板适配器不可用。' });
        await writeClipboard(input.text);
        return { status: 'succeeded', dispatchId: dispatch.dispatchId, toolId: dispatch.toolId, result: { kind: 'clipboard_write', characters: input.text.length }, completedAt: completedAt() };
      }
      const { candidate, target } = chooseUniqueFile(root, input.fileName);
      const buffer = dispatch.toolId === 'desktop.artifact.create_docx'
        ? await buildDocxBuffer(input)
        : dispatch.toolId === 'desktop.artifact.create_xlsx'
          ? await buildXlsxBuffer(input)
          : Buffer.from(input.content, 'utf8');
      if (!buffer.length || buffer.byteLength > MAX_CONTENT_BYTES) throw Object.assign(new Error(), { code: 'DESKTOP_ARTIFACT_SIZE_INVALID', safeMessage: '生成的办公产物大小超出端侧执行器限制。' });
      const handle = fs.openSync(target, 'wx', 0o600);
      try {
        fs.writeFileSync(handle, buffer);
        fs.fsyncSync(handle);
      } finally {
        fs.closeSync(handle);
      }
      const writtenStats = fs.lstatSync(target);
      if (!writtenStats.isFile() || writtenStats.isSymbolicLink() || writtenStats.size !== buffer.byteLength) {
        throw Object.assign(new Error(), { code: 'DESKTOP_ARTIFACT_VERIFY_FAILED', safeMessage: '文件写入后完整性校验失败，未返回成功回执。' });
      }
      const writtenBuffer = fs.readFileSync(target);
      const writtenSha256 = crypto.createHash('sha256').update(writtenBuffer).digest('hex');
      const expectedSha256 = crypto.createHash('sha256').update(buffer).digest('hex');
      if (writtenSha256 !== expectedSha256) {
        throw Object.assign(new Error(), { code: 'DESKTOP_ARTIFACT_VERIFY_FAILED', safeMessage: '文件写入后哈希校验失败，未返回成功回执。' });
      }
      return {
        status: 'succeeded',
        dispatchId: dispatch.dispatchId,
        toolId: dispatch.toolId,
        artifact: {
          relativePath: candidate,
          bytes: buffer.byteLength,
          sha256: writtenSha256,
          workspace: WORKSPACE_LABELS[destination]
        },
        completedAt: completedAt()
      };
    } catch (error) {
      const failure = safeError(error);
      return {
        status: 'failed',
        dispatchId: String(dispatch?.dispatchId || '').slice(0, 120),
        toolId: String(dispatch?.toolId || '').slice(0, 120),
        error: `${failure.code}: ${failure.message}`,
        completedAt: completedAt()
      };
    }
  };

  const listArtifacts = () => {
    const artifacts = [];
    for (const [destination, requestedRoot] of Object.entries(requestedRoots)) {
      try {
        if (!fs.existsSync(requestedRoot)) continue;
        const root = ensureWorkspace(destination);
        artifacts.push(...fs.readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isFile() && FILE_NAME_PATTERN.test(entry.name))
        .map((entry) => {
          const target = path.resolve(root, entry.name);
          const stats = fs.lstatSync(target);
          if (stats.isSymbolicLink()) return null;
          return { name: entry.name, bytes: stats.size, modifiedAt: stats.mtime.toISOString(), type: path.extname(entry.name).slice(1).toLowerCase(), destination, workspace: WORKSPACE_LABELS[destination] };
        })
        .filter(Boolean));
      } catch {
        // 某个可选位置不可用时不暴露系统路径，也不影响其他工作区。
      }
    }
    return artifacts.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt)).slice(0, 50);
  };

  const openArtifact = async (fileName, destination = 'desktop') => {
    if (typeof openPath !== 'function') return { opened: false, error: '系统文件打开适配器不可用。' };
    if (!ARTIFACT_DESTINATIONS.has(destination) || !requestedRoots[destination]) return { opened: false, error: '产物目标位置无效。' };
    if (!FILE_NAME_PATTERN.test(String(fileName || '')) || path.basename(fileName) !== fileName) return { opened: false, error: '产物文件名无效。' };
    try {
      const root = ensureWorkspace(destination);
      const target = path.resolve(root, fileName);
      if (path.dirname(target) !== root) return { opened: false, error: '产物路径超出智脑工作区。' };
      const stats = fs.lstatSync(target);
      if (!stats.isFile() || stats.isSymbolicLink()) return { opened: false, error: '产物不是可信的普通文件。' };
      const error = await openPath(target);
      return error ? { opened: false, error: String(error).slice(0, 300) } : { opened: true, name: fileName, destination };
    } catch {
      return { opened: false, error: '未找到可打开的本地产物。' };
    }
  };

  return Object.freeze({
    capabilities: () => ({
      protocolVersion: 'desktop-execution.v1',
      workspaceName: '按用户指定位置（默认桌面）\\元域智脑工作区',
      workspaceDestinations: ['desktop', 'documents', 'downloads'],
      tools: [
        { id: 'desktop.artifact.create_text', riskLevel: 'L1', requiresConfirmation: true, overwrite: false },
        { id: 'desktop.artifact.create_docx', riskLevel: 'L1', requiresConfirmation: true, overwrite: false },
        { id: 'desktop.artifact.create_xlsx', riskLevel: 'L1', requiresConfirmation: true, overwrite: false },
        { id: 'desktop.browser.open_https', riskLevel: 'L1', requiresConfirmation: true, protocols: ['https:'] }
        ,{ id: 'desktop.workspace.read_text', riskLevel: 'L1', requiresConfirmation: true, extensions: ['md', 'txt', 'csv'] }
        ,{ id: 'desktop.clipboard.write_text', riskLevel: 'L1', requiresConfirmation: true, readsClipboard: false }
      ]
    }),
    execute,
    listArtifacts,
    openArtifact
  });
}

module.exports = { createDesktopExecutor };
