const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  hide: () => ipcRenderer.send('window:hide'),
  resize: (w, h) => ipcRenderer.send('window:resize', { w, h }),
  lanIp: () => ipcRenderer.invoke('net:lan-ip'),
  port: 7823
})
