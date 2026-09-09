const { contextBridge, ipcRenderer } = require('electron');

const apiArgument = process.argv.find((value) => value.startsWith('--semantic-ops-api-base-url='));
const apiBaseUrl = apiArgument
  ? apiArgument.slice('--semantic-ops-api-base-url='.length)
  : 'http://127.0.0.1:3001/api';

contextBridge.exposeInMainWorld('__ZHINAO_RUNTIME_CONFIG__', Object.freeze({ apiBaseUrl }));
contextBridge.exposeInMainWorld('semanticOperationsDesktop', Object.freeze({
  runtime: 'electron',
  apiBaseUrl,
  getAppInfo: () => ipcRenderer.invoke('semantic-ops:app-info')
  ,exportReport: (report) => ipcRenderer.invoke('semantic-ops:export-report', report)
  ,showReport: (path) => ipcRenderer.invoke('semantic-ops:show-report', path)
}));
