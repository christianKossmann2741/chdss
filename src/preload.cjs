const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chdss', {
  details: () => ipcRenderer.invoke('chdss:details'),
  sources: () => ipcRenderer.invoke('chdss:sources'),
  selectSource: sourceId => ipcRenderer.invoke('chdss:select-source', sourceId),
  startAudio: sourceId => ipcRenderer.invoke('chdss:audio-start', sourceId),
  stopAudio: () => ipcRenderer.invoke('chdss:audio-stop'),
  onAudio: callback => {
    const listener = (_event, packet) => {
      ipcRenderer.send('chdss:audio-ack', packet.captureId);
      callback(packet);
    };
    ipcRenderer.on('chdss:audio-data', listener);
    return () => ipcRenderer.removeListener('chdss:audio-data', listener);
  },
  onAudioFailure: callback => {
    const listener = (_event, packet) => callback(packet);
    ipcRenderer.on('chdss:audio-failure', listener);
    return () => ipcRenderer.removeListener('chdss:audio-failure', listener);
  },
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
