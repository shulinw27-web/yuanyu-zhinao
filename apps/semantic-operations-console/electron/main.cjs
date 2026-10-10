const { app, BrowserWindow, ipcMain, session, shell } = require('electron');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { exportSemanticReport, REPORT_ROOT_DIR_NAME } = require('./report-exporter.cjs');

const developmentUrl = process.env.ELECTRON_RENDERER_URL;
const isDevelopment = Boolean(developmentUrl);
const rendererEntry = path.resolve(__dirname, '..', 'dist', 'index.html');
let mainWindow = null;
const smokeMode = process.env.SEMANTIC_OPS_ELECTRON_SMOKE === '1';
if (smokeMode && process.env.YUANYU_ELECTRON_SMOKE_USER_DATA) {
  if (!path.isAbsolute(process.env.YUANYU_ELECTRON_SMOKE_USER_DATA)) throw new Error('SMOKE_USER_DATA_MUST_BE_ABSOLUTE');
  app.setPath('userData', process.env.YUANYU_ELECTRON_SMOKE_USER_DATA);
}

const resolveApiBaseUrl = () => {
  const fallback = 'http://127.0.0.1:3001/api';
  try {
    const url = new URL(process.env.SEMANTIC_OPS_API_BASE_URL || fallback);
    const localHttp = url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
    if (url.protocol !== 'https:' && !localHttp) return fallback;
    return url.toString().replace(/\/$/, '');
  } catch {
    return fallback;
  }
};

const trustedOrigin = (rawUrl) => {
  try {
    const url = new URL(rawUrl);
    if (url.protocol === 'file:') return path.resolve(fileURLToPath(url)) === rendererEntry;
    if (!isDevelopment) return false;
    return url.origin === new URL(developmentUrl).origin;
  } catch {
    return false;
  }
};

const openExternal = async (rawUrl) => {
  try {
    const url = new URL(rawUrl);
    if (url.protocol === 'https:') await shell.openExternal(url.toString());
  } catch {
    // 非法链接直接忽略，禁止交给操作系统处理。
  }
};

function registerIpc() {
  const requireTrustedSender = (event) => {
    const senderUrl = event.senderFrame?.url || event.sender.getURL();
    if (!trustedOrigin(senderUrl)) throw new Error('UNTRUSTED_RENDERER');
  };
  ipcMain.handle('semantic-ops:app-info', (event) => {
    requireTrustedSender(event);
    return { name: app.getName(), version: app.getVersion(), platform: process.platform };
  });
  ipcMain.handle('semantic-ops:export-report', (event, report) => {
    requireTrustedSender(event);
    return exportSemanticReport({ documentsPath: app.getPath('documents'), name: report?.name, format: report?.format, content: report?.content });
  });
  ipcMain.handle('semantic-ops:show-report', (event, targetPath) => {
    requireTrustedSender(event);
    const root = path.resolve(app.getPath('documents'), REPORT_ROOT_DIR_NAME);
    const target = path.resolve(String(targetPath || ''));
    if (path.dirname(target) !== root) throw new Error('REPORT_PATH_INVALID');
    shell.showItemInFolder(target); return true;
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1560,
    height: 960,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#07131f',
    title: '元域智语 Agent',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      navigateOnDragDrop: false,
      webviewTag: false,
      devTools: isDevelopment,
      spellcheck: false,
      additionalArguments: [`--semantic-ops-api-base-url=${resolveApiBaseUrl()}`]
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (trustedOrigin(url)) return;
    event.preventDefault();
    openExternal(url);
  });
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  mainWindow.once('ready-to-show', () => { if (!smokeMode) mainWindow?.show(); });
  mainWindow.on('closed', () => { mainWindow = null; });

  if (isDevelopment) mainWindow.loadURL(developmentUrl);
  else mainWindow.loadFile(rendererEntry);

  if (process.env.SEMANTIC_OPS_ELECTRON_SMOKE === '1') {
    mainWindow.webContents.once('did-finish-load', async () => {
      const result = await mainWindow.webContents.executeJavaScript(
        `(async () => {
          const deadline = Date.now() + 10000;
          while (document.querySelector('.ops-loading') && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          return {
            title: document.title,
            mounted: Boolean(document.querySelector('.semantic-console')),
            runtime: window.semanticOperationsDesktop?.runtime,
            authRequired: Boolean(document.querySelector('.semantic-auth')),
            loading: Boolean(document.querySelector('.ops-loading')),
            error: document.querySelector('.ops-error')?.textContent?.trim() || '',
            objectTypes: Number(document.querySelector('.ops-kpis article b')?.textContent || 0)
          };
        })()`
      );
      process.stdout.write(`SEMANTIC_OPS_ELECTRON_SMOKE_OK ${JSON.stringify(result)}\n`);
      if (process.env.YUANYU_ELECTRON_SMOKE_USER_DATA) require('node:fs').writeFileSync(path.join(app.getPath('userData'), 'smoke-result.json'), JSON.stringify(result));
      if (!result.mounted || result.runtime !== 'electron' || (!result.authRequired && (result.loading || result.error || result.objectTypes < 1))) {
        process.exitCode = 1;
      }
      setTimeout(() => app.quit(), 250);
    });
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    registerIpc();
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.on('will-download', (event) => event.preventDefault());
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
}

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
