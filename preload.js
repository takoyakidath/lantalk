const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  hide: () => ipcRenderer.send('window:hide'),
  resize: (w, h) => ipcRenderer.send('window:resize', { w, h }),
  copy: (text) => ipcRenderer.invoke('clipboard:write', text),
  lanIp: () => ipcRenderer.invoke('net:lan-ip'),
  onFocus: (cb) => ipcRenderer.on('window:focused', () => cb()),
  onState: (cb) => ipcRenderer.on('window:state', (_, state) => cb(state)),
  notify: () => ipcRenderer.send('notify'),
  openMain: () => ipcRenderer.send('window:open'),
  port: 7823
})
