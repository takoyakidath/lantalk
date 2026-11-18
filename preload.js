const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  hide: () => ipcRenderer.send('window:hide'),
  resize: (w, h) => ipcRenderer.send('window:resize', { w, h }),
  lanIp: () => ipcRenderer.invoke('net:lan-ip'),
  onFocus: (cb) => ipcRenderer.on('window:focused', cb),
  port: 7823
})
