const { app, BrowserWindow, globalShortcut, screen, ipcMain, Tray, Menu, nativeImage, clipboard } = require('electron')
const path = require('path')
const os = require('os')
const net = require('net')
const QRCode = require('qrcode')
const { Bonjour } = require('bonjour-service')
const { startServer, isPrivateIP } = require('./server')

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
  startDiscovery()

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
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoading()) return
  mainWindow.webContents.send('window:state', { hover: !!hover, focus: mainWindow.isFocused() })
}

// カーソルを見張る: ウィンドウ上にあるか / 右下の角に置いたか(ホットコーナー)
function watchCursor() {
  const DWELL_TICKS = 2 // 約0.2秒とどまったら反応。通過しただけでは出さない
  let ticks = 0
  let armed = true // 一度出したら、角から離れるまで再発動しない
  const timer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return // 終了処理中は何もしない
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
  app.on('before-quit', () => clearInterval(timer))
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
  if (!mainWindow || mainWindow.isDestroyed() || !notifyWindow || notifyWindow.isDestroyed()) return
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
  if (notifyWindow && !notifyWindow.isDestroyed()) notifyWindow.hide()
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

// ---- 同じLANのLanTalkを見つける(mDNS)。IPを手で打たなくて済むようにする ----
const SERVICE_TYPE = 'lantalk'
let bonjour
const MAX_NEARBY = 20
let nearby = new Map() // IP -> { name, host, fqdn }(挿入順 = 古い順)

function myAddresses() {
  const set = new Set()
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) if (a.family === 'IPv4') set.add(a.address)
  }
  return set
}

function pushNearby() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('hosts:update', Array.from(nearby.values(), ({ name, host }) => ({ name, host })))
  }
}

let published
function advertise(nickname) {
  const publish = () => {
    published = bonjour.publish({ name: `LanTalk-${nickname}`, type: SERVICE_TYPE, port: PORT })
  }
  if (published) published.stop(publish)
  else publish()
}

ipcMain.on('discovery:name', (e, name) => {
  if (e.sender !== mainWindow.webContents || typeof name !== 'string' || !bonjour) return
  const nickname = name.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 16)
  if (nickname) advertise(nickname)
})

function startDiscovery() {
  bonjour = new Bonjour()
  // 自分を知らせるのは、ニックネームが決まってから(advertise)。Macのホスト名などは流さない
  const mine = myAddresses()
  const browser = bonjour.find({ type: SERVICE_TYPE })
  browser.on('up', (svc) => {
    // 広告は誰でも出せる。LAN内のIPだけを信用し、自分自身は一覧に出さない
    const host = (svc.addresses || []).find(a => net.isIPv4(a) && isPrivateIP(a))
    if (!host || mine.has(host)) return
    // IPごとに1項目。すでにある項目の名前は、あとから来た広告で書き換えない。
    // 満杯のときは新しい広告を断らず、いちばん古い項目を追い出す(偽の広告で本物が出なくなるのを防ぐ)
    if (nearby.has(host)) return
    if (nearby.size >= MAX_NEARBY) nearby.delete(nearby.keys().next().value)
    nearby.set(host, { name: String(svc.name).replace(/^LanTalk-/, '').slice(0, 40), host, fqdn: svc.fqdn || svc.name })
    pushNearby()
  })
  browser.on('down', (svc) => {
    for (const [ip, entry] of Array.from(nearby)) {
      if (entry.fqdn === (svc.fqdn || svc.name)) nearby.delete(ip)
    }
    pushNearby()
  })
}

ipcMain.handle('hosts:list', () => Array.from(nearby.values(), ({ name, host }) => ({ name, host })))

// スマホで開くURLのQRコード
ipcMain.handle('qr:make', (_, url) => {
  if (typeof url !== 'string' || !/^http:\/\/[\d.]+:\d+$/.test(url)) return null
  return QRCode.toDataURL(url, { margin: 1, width: 240, color: { dark: '#17262b', light: '#ffffff' } })
})

ipcMain.handle('clipboard:write', (_, text) => {
  if (typeof text !== 'string' || text.length > 200) return false
  clipboard.writeText(text)
  return true
})

ipcMain.on('window:hide', () => mainWindow.hide())

ipcMain.on('window:resize', (_, size) => {
  if (!mainWindow || !size) return
  // 画面から来る値は信用しない: 数値だけを受け、現実的な範囲に収める
  const clamp = (n) => Math.min(1000, Math.max(80, Math.round(n)))
  if (!Number.isFinite(size.w) || !Number.isFinite(size.h)) return
  const w = clamp(size.w), h = clamp(size.h)
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
  if (bonjour) bonjour.unpublishAll(() => bonjour.destroy())
  globalShortcut.unregisterAll()
})

app.on('before-quit', () => {
  app.isQuitting = true
})
