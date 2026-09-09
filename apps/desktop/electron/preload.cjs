const { contextBridge, ipcRenderer } = require('electron');

const apiArgument = process.argv.find((value) => value.startsWith('--zhinao-api-base-url='));
const apiBaseUrl = apiArgument ? apiArgument.slice('--zhinao-api-base-url='.length) : 'http://127.0.0.1:3001/api';

contextBridge.exposeInMainWorld('zhinaoDesktop', Object.freeze({
  runtime: 'electron',
  apiBaseUrl,
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  desktop: Object.freeze({
    capabilities: () => ipcRenderer.invoke('desktop:capabilities'),
    endpointStatus: () => ipcRenderer.invoke('desktop:endpoint-status'),
    execute: (dispatch) => ipcRenderer.invoke('desktop:execute', dispatch),
    listArtifacts: () => ipcRenderer.invoke('desktop:list-artifacts'),
    openArtifact: (fileName, destination) => ipcRenderer.invoke('desktop:open-artifact', fileName, destination)
  }),
  window: Object.freeze({
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
    close: () => ipcRenderer.invoke('window:close')
  })
}));
