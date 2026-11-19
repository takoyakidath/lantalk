const { app, BrowserWindow, globalShortcut, screen, ipcMain, Tray, Menu, nativeImage, clipboard } = require('electron')
const path = require('path')
const os = require('os')
const { startServer } = require('./server')

const PORT = 7823
let mainWindow
let notifyWindow
let tray
let unseen = 0 // 見ていない新着の数(通知はあるかないかだけ見せる)
let notifyTimer
const NOTIFY_MS = 10000

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
  const W = 320, H = 380

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
  mainWindow.webContents.on('did-finish-load', sendState)
  mainWindow.on('focus', () => {
    mainWindow.webContents.send('window:focused')
    clearUnseen()
    sendState()
  })
  mainWindow.on('blur', sendState)

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
  createNotifyWindow()
  createTray()
  watchCursor()

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

// 画面の状態(カーソルが乗っているか、フォーカスがあるか)を画面側へ伝える。
// 使われていないときは薄くぼかして、後ろから読まれにくくするために使う
let hover = null
function sendState() {
  if (!mainWindow || mainWindow.webContents.isLoading()) return
  mainWindow.webContents.send('window:state', { hover: !!hover, focus: mainWindow.isFocused() })
}

// カーソルを見張る: ウィンドウ上にあるか / 右下の角に置いたか(ホットコーナー)
function watchCursor() {
  const DWELL_TICKS = 2 // 約0.2秒とどまったら反応。通過しただけでは出さない
  let ticks = 0
  let armed = true // 一度出したら、角から離れるまで再発動しない
  setInterval(() => {
    if (!mainWindow) return
    const p = screen.getCursorScreenPoint()

    const wb = mainWindow.getBounds()
    const over = mainWindow.isVisible() &&
      p.x >= wb.x && p.x < wb.x + wb.width && p.y >= wb.y && p.y < wb.y + wb.height
    if (over !== hover) { hover = over; sendState() }

    const b = screen.getPrimaryDisplay().bounds
    const inCorner = p.x >= b.x + b.width - 2 && p.y >= b.y + b.height - 2
    if (!inCorner) { ticks = 0; armed = true; return }
    if (!armed || mainWindow.isVisible()) return
    if (++ticks >= DWELL_TICKS) {
      armed = false
      mainWindow.show()
      mainWindow.focus()
    }
  }, 100)
}

// ---- 新着の通知(画面の右上にアイコンと点だけ出す。名前も本文も出さない) ----
function createNotifyWindow() {
  const { workArea } = screen.getPrimaryDisplay()
  const W = 44, H = 44
  notifyWindow = new BrowserWindow({
    width: W,
    height: H,
    x: workArea.x + workArea.width - W - 12,
    y: workArea.y + 12,
    show: false,
    frame: false,
    resizable: false,
    transparent: true,
    hasShadow: false,
    focusable: false, // 作業中の入力を奪わない
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  notifyWindow.setAlwaysOnTop(true, 'screen-saver')
  notifyWindow.loadFile('notify.html')
}

function notify() {
  if (mainWindow.isVisible() && mainWindow.isFocused()) return // 見ている最中は出さない
  unseen++
  if (process.platform === 'darwin' && tray) tray.setTitle('•')
  notifyWindow.showInactive()
  clearTimeout(notifyTimer)
  notifyTimer = setTimeout(() => notifyWindow.hide(), NOTIFY_MS)
}

function clearUnseen() {
  unseen = 0
  if (process.platform === 'darwin' && tray) tray.setTitle('')
  clearTimeout(notifyTimer)
  if (notifyWindow) notifyWindow.hide()
}

ipcMain.on('notify', (e) => {
  if (e.sender !== mainWindow.webContents) return
  notify()
})

ipcMain.on('window:open', (e) => {
  if (e.sender !== notifyWindow.webContents) return
  mainWindow.show()
  mainWindow.focus()
})

ipcMain.handle('clipboard:write', (_, text) => {
  if (typeof text !== 'string' || text.length > 200) return false
  clipboard.writeText(text)
  return true
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
