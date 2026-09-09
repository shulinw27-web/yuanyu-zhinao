const { app, BrowserWindow, clipboard, ipcMain, safeStorage, session, shell } = require('electron');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { createDesktopExecutor } = require('./desktop-executor.cjs');
const { createEndpointRuntime } = require('./endpoint-runtime.cjs');

const developmentUrl = process.env.ELECTRON_RENDERER_URL;
const isDevelopment = Boolean(developmentUrl);
const rendererEntry = path.resolve(__dirname, '..', 'dist', 'index.html');
let mainWindow = null;
let desktopExecutor = null;
let endpointRuntime = null;

const resolveApiBaseUrl = () => {
  const fallback = 'http://127.0.0.1:3001/api';
  try {
    const url = new URL(process.env.ZHINAO_API_BASE_URL || fallback);
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
    // 非法链接直接忽略，禁止交给系统处理。
  }
};

function registerIpc() {
  const requireTrustedSender = (event) => {
    const senderUrl = event.senderFrame?.url || event.sender.getURL();
    if (!trustedOrigin(senderUrl)) throw new Error('UNTRUSTED_RENDERER');
  };
  ipcMain.handle('app:info', (event) => {
    requireTrustedSender(event);
    return ({
    name: app.getName(),
    version: app.getVersion(),
    platform: process.platform
    });
  });
  ipcMain.handle('desktop:capabilities', (event) => {
    requireTrustedSender(event);
    return desktopExecutor.capabilities();
  });
  ipcMain.handle('desktop:endpoint-status', (event) => {
    requireTrustedSender(event);
    return endpointRuntime.status();
  });
  ipcMain.handle('desktop:execute', (event, dispatch) => {
    requireTrustedSender(event);
    return desktopExecutor.execute(dispatch);
  });
  ipcMain.handle('desktop:list-artifacts', (event) => {
    requireTrustedSender(event);
    return desktopExecutor.listArtifacts();
  });
  ipcMain.handle('desktop:open-artifact', (event, fileName, destination) => {
    requireTrustedSender(event);
    return desktopExecutor.openArtifact(fileName, destination);
  });
  ipcMain.handle('window:minimize', (event) => {
    requireTrustedSender(event);
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  ipcMain.handle('window:toggle-maximize', (event) => {
    requireTrustedSender(event);
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return false;
    if (window.isMaximized()) window.unmaximize(); else window.maximize();
    return window.isMaximized();
  });
  ipcMain.handle('window:close', (event) => {
    requireTrustedSender(event);
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1040,
    minHeight: 700,
    show: false,
    frame: false,
    backgroundColor: '#0b0b0b',
    title: '元域智脑 · 企业私有 Agent',
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
      additionalArguments: [`--zhinao-api-base-url=${resolveApiBaseUrl()}`]
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
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  if (isDevelopment) {
    mainWindow.loadURL(developmentUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  if (process.env.ZHINAO_ELECTRON_SMOKE === '1') {
    mainWindow.webContents.once('did-finish-load', async () => {
      const result = await mainWindow.webContents.executeJavaScript('({ title: document.title, mounted: Boolean(document.querySelector(".agent-workbench")) })');
      process.stdout.write(`ELECTRON_SMOKE_OK ${JSON.stringify(result)}\n`);
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
    desktopExecutor = createDesktopExecutor({
      workspaceRoots: {
        desktop: path.join(app.getPath('desktop'), '元域智脑工作区'),
        documents: path.join(app.getPath('documents'), '元域智脑工作区'),
        downloads: path.join(app.getPath('downloads'), '元域智脑工作区')
      },
      openExternal: (url) => shell.openExternal(url),
      openPath: (target) => shell.openPath(target),
      writeClipboard: (text) => clipboard.writeText(text)
    });
    const linuxStorageBackend = process.platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function'
      ? safeStorage.getSelectedStorageBackend()
      : null;
    const secureStorageAvailable = safeStorage.isEncryptionAvailable() && linuxStorageBackend !== 'basic_text';
    const secretProtector = secureStorageAvailable
      ? Object.freeze({
          kind: 'os_user_bound',
          protect: (value) => safeStorage.encryptString(value).toString('base64'),
          unprotect: (value) => safeStorage.decryptString(Buffer.from(value, 'base64'))
        })
      : null;
    endpointRuntime = createEndpointRuntime({ userDataRoot: app.getPath('userData'), appVersion: app.getVersion(), packaged: app.isPackaged, platform: process.platform, capabilities: desktopExecutor.capabilities(), secretProtector });
    registerIpc();
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
      const sameApp = trustedOrigin(details.requestingUrl || webContents.getURL());
      const audioOnly = permission === 'media' && (details.mediaTypes || []).every((type) => type === 'audio');
      callback(Boolean(sameApp && audioOnly));
    });
    session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
      return permission === 'media' && trustedOrigin(requestingOrigin || webContents.getURL());
    });
    session.defaultSession.on('will-download', (event) => event.preventDefault());
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
}

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
