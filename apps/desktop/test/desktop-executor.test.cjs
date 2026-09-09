const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const JSZip = require('jszip');
const { createDesktopExecutor } = require('../electron/desktop-executor.cjs');

const dispatch = (overrides = {}) => ({
  protocolVersion: 'desktop-execution.v1',
  dispatchId: `desktop-dispatch-${Date.now()}-${Math.random()}`,
  runId: `run-${Date.now()}`,
  toolId: 'desktop.artifact.create_text',
  input: { fileName: '测试产物.md', content: '# 测试\n', conflictPolicy: 'create_unique' },
  riskLevel: 'L1',
  workspaceScope: 'zhinao_artifacts_only',
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  ...overrides
});

test('desktop executor only creates unique files inside its dedicated workspace', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zhinao-desktop-executor-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const workspaceRoot = path.join(tempRoot, 'workspace');
  const executor = createDesktopExecutor({ workspaceRoot });

  const first = await executor.execute(dispatch());
  assert.equal(first.status, 'succeeded');
  assert.equal(first.artifact.relativePath, '测试产物.md');
  assert.equal(first.artifact.workspace, '桌面\\元域智脑工作区');
  assert.equal(fs.readFileSync(path.join(workspaceRoot, first.artifact.relativePath), 'utf8'), '# 测试\n');

  const second = await executor.execute(dispatch());
  assert.equal(second.status, 'succeeded');
  assert.equal(second.artifact.relativePath, '测试产物 (1).md');
  assert.equal(first.artifact.sha256, second.artifact.sha256);
});

test('electron host binds the protected workspace to the Windows desktop folder', () => {
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8');
  assert.match(mainSource, /app\.getPath\('desktop'\)/u);
  assert.match(mainSource, /app\.getPath\('documents'\)/u);
  assert.match(mainSource, /app\.getPath\('downloads'\)/u);
});

test('desktop executor writes to the requested allowlisted workspace and defaults to desktop', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zhinao-desktop-destinations-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const workspaceRoots = {
    desktop: path.join(tempRoot, 'desktop'),
    documents: path.join(tempRoot, 'documents'),
    downloads: path.join(tempRoot, 'downloads')
  };
  const openedPaths = [];
  const executor = createDesktopExecutor({ workspaceRoots, openPath: async (target) => { openedPaths.push(target); return ''; } });
  const defaultReceipt = await executor.execute(dispatch({ input: { fileName: '默认.md', content: 'desktop', conflictPolicy: 'create_unique' } }));
  const documentsReceipt = await executor.execute(dispatch({ input: { fileName: '文档.md', content: 'documents', conflictPolicy: 'create_unique', destination: 'documents' } }));
  const downloadsReceipt = await executor.execute(dispatch({ input: { fileName: '下载.md', content: 'downloads', conflictPolicy: 'create_unique', destination: 'downloads' } }));
  assert.equal(defaultReceipt.artifact.workspace, '桌面\\元域智脑工作区');
  assert.equal(documentsReceipt.artifact.workspace, '文档\\元域智脑工作区');
  assert.equal(downloadsReceipt.artifact.workspace, '下载\\元域智脑工作区');
  assert.equal(fs.readFileSync(path.join(workspaceRoots.desktop, '默认.md'), 'utf8'), 'desktop');
  assert.equal(fs.readFileSync(path.join(workspaceRoots.documents, '文档.md'), 'utf8'), 'documents');
  assert.equal(fs.readFileSync(path.join(workspaceRoots.downloads, '下载.md'), 'utf8'), 'downloads');
  assert.equal((await executor.openArtifact('文档.md', 'documents')).opened, true);
  assert.equal(openedPaths[0], path.join(fs.realpathSync.native(workspaceRoots.documents), '文档.md'));
  assert.deepEqual(new Set(executor.listArtifacts().map((item) => item.destination)), new Set(['desktop', 'documents', 'downloads']));
  assert.equal((await executor.execute(dispatch({ input: { fileName: '非法.md', content: 'x', conflictPolicy: 'create_unique', destination: 'system' } }))).status, 'failed');
});

test('desktop executor rejects path escapes, expired grants, overwrites, and disabled tools', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zhinao-desktop-guards-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const executor = createDesktopExecutor({ workspaceRoot: path.join(tempRoot, 'workspace') });

  assert.equal((await executor.execute(dispatch({ input: { fileName: '../escape.md', content: 'x', conflictPolicy: 'create_unique' } }))).status, 'failed');
  assert.equal((await executor.execute(dispatch({ expiresAt: new Date(Date.now() - 1_000).toISOString() }))).status, 'failed');
  assert.equal((await executor.execute(dispatch({ input: { fileName: 'safe.md', content: 'x', conflictPolicy: 'overwrite' } }))).status, 'failed');
  assert.equal((await executor.execute(dispatch({ toolId: 'desktop.file.delete', riskLevel: 'L3' }))).status, 'failed');
  assert.equal(fs.existsSync(path.join(tempRoot, 'escape.md')), false);
});

test('desktop executor lists trusted artifacts and opens only allowlisted HTTPS navigation', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zhinao-desktop-browser-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const openedUrls = [];
  const openedPaths = [];
  const workspaceRoot = path.join(tempRoot, 'workspace');
  const executor = createDesktopExecutor({
    workspaceRoot,
    openExternal: async (url) => { openedUrls.push(url); },
    openPath: async (target) => { openedPaths.push(target); return ''; }
  });
  await executor.execute(dispatch({ input: { fileName: '数据.csv', content: 'a,b\r\n1,2\r\n', conflictPolicy: 'create_unique' } }));
  const artifacts = executor.listArtifacts();
  assert.equal(artifacts[0].name, '数据.csv');
  assert.equal((await executor.openArtifact('数据.csv')).opened, true);
  assert.equal(openedPaths.length, 1);
  assert.equal((await executor.openArtifact('../escape.csv')).opened, false);

  const browserDispatch = dispatch({ toolId: 'desktop.browser.open_https', input: { url: 'https://example.com/path?q=test' } });
  const browserReceipt = await executor.execute(browserDispatch);
  assert.equal(browserReceipt.status, 'succeeded');
  assert.deepEqual(browserReceipt.result, { kind: 'browser_navigation', origin: 'https://example.com' });
  assert.deepEqual(openedUrls, ['https://example.com/path?q=test']);
  assert.equal((await executor.execute(dispatch({ toolId: 'desktop.browser.open_https', input: { url: 'file:///etc/passwd' } }))).status, 'failed');
  assert.equal((await executor.execute(dispatch({ toolId: 'desktop.browser.open_https', input: { url: 'https://user:secret@example.com/' } }))).status, 'failed');
});

test('desktop executor creates parseable DOCX and XLSX office drafts without overwriting', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zhinao-desktop-office-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const workspaceRoot = path.join(tempRoot, 'workspace');
  const executor = createDesktopExecutor({ workspaceRoot });
  const content = '# 周报\n\n## 本周完成\n\n- 完成智脑办公产物闭环\n\n## 下周计划\n\n1. 验证用户体验';

  const docx = await executor.execute(dispatch({
    toolId: 'desktop.artifact.create_docx',
    input: { fileName: '项目周报.docx', content, conflictPolicy: 'create_unique' }
  }));
  assert.equal(docx.status, 'succeeded');
  const docxBuffer = fs.readFileSync(path.join(workspaceRoot, docx.artifact.relativePath));
  const docxZip = await JSZip.loadAsync(docxBuffer);
  assert.ok(docxZip.file('word/document.xml'));
  const documentXml = await docxZip.file('word/document.xml').async('string');
  assert.match(documentXml, /完成智脑办公产物闭环/);
  assert.equal((documentXml.match(/项目周报/gu) || []).length, 1);

  const xlsx = await executor.execute(dispatch({
    toolId: 'desktop.artifact.create_xlsx',
    input: { fileName: '项目清单.xlsx', content, conflictPolicy: 'create_unique' }
  }));
  assert.equal(xlsx.status, 'succeeded');
  const xlsxBuffer = fs.readFileSync(path.join(workspaceRoot, xlsx.artifact.relativePath));
  const xlsxZip = await JSZip.loadAsync(xlsxBuffer);
  assert.ok(xlsxZip.file('xl/worksheets/sheet1.xml'));
  const sheetXml = await xlsxZip.file('xl/worksheets/sheet1.xml').async('string');
  assert.match(sheetXml, /完成智脑办公产物闭环/);
  assert.match(sheetXml, /state="frozen"/);
  assert.deepEqual(executor.listArtifacts().map((item) => item.type).sort(), ['docx', 'xlsx']);
});

test('desktop executor reads only allowlisted workspace text and writes but never reads clipboard', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zhinao-desktop-read-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const clipboardWrites = [];
  const workspaceRoot = path.join(tempRoot, 'workspace');
  const executor = createDesktopExecutor({ workspaceRoot, writeClipboard: async (text) => clipboardWrites.push(text) });
  await executor.execute(dispatch({ input: { fileName: '上下文.md', content: '只允许读取这个工作区文件', conflictPolicy: 'create_unique' } }));

  const read = await executor.execute(dispatch({ toolId: 'desktop.workspace.read_text', input: { fileName: '上下文.md' } }));
  assert.equal(read.status, 'succeeded');
  assert.equal(read.result.kind, 'workspace_text');
  assert.equal(read.result.content, '只允许读取这个工作区文件');
  assert.match(read.result.sha256, /^[a-f0-9]{64}$/u);
  assert.equal((await executor.execute(dispatch({ toolId: 'desktop.workspace.read_text', input: { fileName: '../上下文.md' } }))).status, 'failed');

  const copied = await executor.execute(dispatch({ toolId: 'desktop.clipboard.write_text', input: { text: '受控复制内容' } }));
  assert.equal(copied.status, 'succeeded');
  assert.deepEqual(copied.result, { kind: 'clipboard_write', characters: 6 });
  assert.deepEqual(clipboardWrites, ['受控复制内容']);
});
