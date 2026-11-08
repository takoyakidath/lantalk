const { app, BrowserWindow, globalShortcut, screen, ipcMain, Tray, Menu, nativeImage } = require('electron')
const path = require('path')
const os = require('os')
const { startServer } = require('./server')

const PORT = 7823
let mainWindow
let tray

function createTray() {
  // 16x16 simple colored dot as tray icon
  const size = 16
  const canvas = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = x - size / 2, cy = y - size / 2
      const r = Math.sqrt(cx * cx + cy * cy)
      const i = (y * size + x) * 4
      if (r < 6) {
        canvas[i] = 91; canvas[i + 1] = 141; canvas[i + 2] = 239; canvas[i + 3] = 255
      } else {
        canvas[i + 3] = 0
      }
    }
  }
  const icon = nativeImage.createFromBuffer(canvas, { width: size, height: size })
  tray = new Tray(icon)
  tray.setToolTip('LanTalk')
  const menu = Menu.buildFromTemplate([
    { label: '表示/非表示', click: toggleWindow },
    { type: 'separator' },
    { label: '終了', click: () => { app.isQuitting = true; app.quit() } }
  ])
  tray.setContextMenu(menu)
  tray.on('click', toggleWindow)
}

function toggleWindow() {
  if (mainWindow.isVisible()) {
    mainWindow.hide()
  } else {
    mainWindow.show()
    mainWindow.focus()
  }
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay()
  const W = 240, H = 192

  mainWindow = new BrowserWindow({
    width: W,
    height: H,
    x: workArea.x + workArea.width - W - 12,
    y: workArea.y + workArea.height - H - 12,
    alwaysOnTop: true,
    skipTaskbar: true,
    frame: false,
    resizable: false,
    transparent: true,
    hasShadow: false,
    vibrancy: 'under-window',
    visualEffectState: 'active',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.loadFile('index.html')

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault()
      mainWindow.hide()
    }
  })
}

app.whenReady().then(() => {
  startServer(PORT)
  createWindow()
  createTray()

  globalShortcut.register('CommandOrControl+Shift+C', toggleWindow)
})

ipcMain.handle('net:lan-ip', () => {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) return a.address
    }
  }
  return null
})

ipcMain.on('window:hide', () => mainWindow.hide())

ipcMain.on('window:resize', (_, { w, h }) => {
  if (!mainWindow) return
  const { workArea } = screen.getPrimaryDisplay()
  mainWindow.setSize(w, h)
  mainWindow.setPosition(
    workArea.x + workArea.width - w - 12,
    workArea.y + workArea.height - h - 12
  )
})

app.on('window-all-closed', () => {
  // Keep running in tray
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

app.on('before-quit', () => {
  app.isQuitting = true
})
