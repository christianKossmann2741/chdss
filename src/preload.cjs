const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chdss', {
  details: () => ipcRenderer.invoke('chdss:details'),
  sources: () => ipcRenderer.invoke('chdss:sources'),
  selectSource: sourceId => ipcRenderer.invoke('chdss:select-source', sourceId),
  copy: text => ipcRenderer.invoke('chdss:copy', text),
  openPermissions: () => ipcRenderer.invoke('chdss:permissions'),
  setSharing: active => ipcRenderer.invoke('chdss:sharing', active),
  createRelay: (url, key) => ipcRenderer.invoke('chdss:relay-create', url, key),
  endRelay: () => ipcRenderer.invoke('chdss:relay-end'),
  onCommand: callback => {
    const listener = (_event, command) => callback(command);
    ipcRenderer.on('chdss:command', listener);
    return () => ipcRenderer.removeListener('chdss:command', listener);
  }
});
