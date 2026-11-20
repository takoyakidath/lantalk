const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  hide: () => ipcRenderer.send('window:hide'),
  resize: (w, h) => ipcRenderer.send('window:resize', { w, h }),
  copy: (text) => ipcRenderer.invoke('clipboard:write', text),
  lanIp: () => ipcRenderer.invoke('net:lan-ip'),
  onFocus: (cb) => ipcRenderer.on('window:focused', () => cb()),
  onState: (cb) => ipcRenderer.on('window:state', (_, state) => cb(state)),
  notify: () => ipcRenderer.send('notify'),
  setHostName: (name) => ipcRenderer.send('discovery:name', name),
  hosts: () => ipcRenderer.invoke('hosts:list'),
  onHosts: (cb) => ipcRenderer.on('hosts:update', (_, list) => cb(list)),
  qr: (url) => ipcRenderer.invoke('qr:make', url),
  openMain: () => ipcRenderer.send('window:open'),
  port: Number((process.argv.find(a => a.startsWith('--lantalk-port=')) || '').split('=')[1]) || 7823
})
