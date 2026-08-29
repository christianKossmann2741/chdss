const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chdss', {
  details: () => ipcRenderer.invoke('chdss:details'),
  sources: () => ipcRenderer.invoke('chdss:sources'),
  selectSource: sourceId => ipcRenderer.invoke('chdss:select-source', sourceId),
  copy: text => ipcRenderer.invoke('chdss:copy', text),
  openPermissions: () => ipcRenderer.invoke('chdss:permissions')
});
