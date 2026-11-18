const WebSocket = require('ws')
const bcrypt = require('bcryptjs')
const crypto = require('crypto')
const http = require('http')
const fs = require('fs')
const path = require('path')

const SALT_ROUNDS = 10

// In-memory storage
const rooms = new Map()       // roomId -> { id, name, passwordHash, createdAt }
const messages = new Map()    // roomId -> [message]
const roomMembers = new Map() // roomId -> Set of ws connections

function isPrivateIP(ip) {
  ip = (ip || '').replace(/^::ffff:/, '')
  if (ip === '::1' || ip === 'localhost' || ip === '127.0.0.1') return true
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4) return false
  if (parts[0] === 10) return true
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true
  if (parts[0] === 192 && parts[1] === 168) return true
  if (parts[0] === 127) return true
  return false
}

// ブラウザ/PWA向けに配信するファイル。ここに無いパスは返さない
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/renderer.js': ['renderer.js', 'text/javascript; charset=utf-8'],
  '/shim.js': ['shim.js', 'text/javascript; charset=utf-8'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/icons/icon.svg': ['icons/icon.svg', 'image/svg+xml'],
  '/icons/icon-180.png': ['icons/icon-180.png', 'image/png'],
  '/icons/icon-192.png': ['icons/icon-192.png', 'image/png'],
  '/icons/icon-512.png': ['icons/icon-512.png', 'image/png']
}

function handleHttp(req, res) {
  if (!isPrivateIP(req.socket.remoteAddress)) {
    res.writeHead(403).end('LAN only')
    return
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end()
    return
  }
  const pathname = new URL(req.url, 'http://x').pathname
  const entry = Object.hasOwn(STATIC, pathname) ? STATIC[pathname] : null
  if (!entry) {
    res.writeHead(404).end('Not found')
    return
  }
  fs.readFile(path.join(__dirname, entry[0]), (err, body) => {
    if (err) {
      res.writeHead(404).end('Not found')
      return
    }
    res.writeHead(200, { 'Content-Type': entry[1], 'Cache-Control': 'no-cache' })
    res.end(req.method === 'HEAD' ? undefined : body)
  })
}

function buildRoomList() {
  return Array.from(rooms.values()).map(room => ({
    id: room.id,
    name: room.name,
    hasPassword: !!room.passwordHash,
    memberCount: (roomMembers.get(room.id) || new Set()).size
  }))
}

function broadcastRoomList(wss) {
  const data = JSON.stringify({ type: 'room:list', rooms: buildRoomList() })
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(data)
  })
}

function startServer(port) {
  // 同じポートでHTTP(PWAの配信)とWebSocketの両方を受ける
  const httpServer = http.createServer(handleHttp)
  const wss = new WebSocket.Server({ server: httpServer, maxPayload: 16 * 1024 })
  wss.httpServer = httpServer
  httpServer.on('error', (err) => console.error('[server]', err.message))
  httpServer.listen(port, () => console.log(`[server] HTTP + WebSocket listening on port ${port}`))

  wss.on('connection', (ws, req) => {
    const clientIP = req.socket.remoteAddress || ''
    if (!isPrivateIP(clientIP)) {
      ws.close(1008, 'LAN only')
      return
    }

    ws.joinedRooms = new Set()
    ws.nickname = 'Anonymous'

    // Send room list on connect
    ws.send(JSON.stringify({ type: 'room:list', rooms: buildRoomList() }))

    ws.on('message', async (data) => {
      let msg
      try { msg = JSON.parse(data.toString()) } catch { return }

      switch (msg.type) {

        case 'room:list': {
          ws.send(JSON.stringify({ type: 'room:list', rooms: buildRoomList() }))
          break
        }

        case 'room:create': {
          const name = String(msg.name || '').trim().slice(0, 20)
          if (!name) {
            ws.send(JSON.stringify({ type: 'room:error', message: '部屋名を入力してください' }))
            break
          }
          const id = crypto.randomUUID()
          let passwordHash = null
          if (typeof msg.password === 'string' && msg.password.trim()) {
            passwordHash = await bcrypt.hash(msg.password.slice(0, 32), SALT_ROUNDS)
          }
          rooms.set(id, { id, name, passwordHash, createdAt: Date.now() })
          messages.set(id, [])
          roomMembers.set(id, new Set())
          broadcastRoomList(wss)
          ws.send(JSON.stringify({ type: 'room:created', room: { id, name } }))
          break
        }

        case 'room:join': {
          const room = rooms.get(msg.roomId)
          if (!room) {
            ws.send(JSON.stringify({ type: 'room:error', message: '部屋が見つかりません' }))
            break
          }
          if (room.passwordHash) {
            const valid = typeof msg.password === 'string' && msg.password
              ? await bcrypt.compare(msg.password.slice(0, 32), room.passwordHash)
              : false
            if (!valid) {
              ws.send(JSON.stringify({ type: 'room:error', message: 'パスワードが違います' }))
              break
            }
          }
          if (typeof msg.nickname === 'string' && msg.nickname.trim()) ws.nickname = msg.nickname.trim().slice(0, 16)
          const members = roomMembers.get(room.id)
          members.add(ws)
          ws.joinedRooms.add(room.id)
          ws.send(JSON.stringify({
            type: 'room:joined',
            room: { id: room.id, name: room.name },
            messages: (messages.get(room.id) || []).slice(-50),
            memberCount: members.size
          }))
          broadcastRoomList(wss)
          break
        }

        case 'room:leave': {
          const members = roomMembers.get(msg.roomId)
          if (members) {
            members.delete(ws)
            ws.joinedRooms.delete(msg.roomId)
          }
          broadcastRoomList(wss)
          break
        }

        case 'chat:send': {
          const { roomId, text } = msg
          if (typeof text !== 'string' || !text.trim()) break
          const members = roomMembers.get(roomId)
          if (!members || !members.has(ws)) {
            ws.send(JSON.stringify({ type: 'room:error', message: '部屋に参加していません' }))
            break
          }
          const message = {
            id: crypto.randomUUID(),
            roomId,
            user: ws.nickname,
            text: text.trim().slice(0, 200),
            createdAt: Date.now()
          }
          const log = messages.get(roomId)
          log.push(message)
          if (log.length > 200) log.shift()
          const payload = JSON.stringify({ type: 'chat:message', message })
          members.forEach(c => {
            if (c.readyState === WebSocket.OPEN) c.send(payload)
          })
          break
        }
      }
    })

    ws.on('close', () => {
      ws.joinedRooms.forEach(roomId => {
        const members = roomMembers.get(roomId)
        if (members) members.delete(ws)
      })
      broadcastRoomList(wss)
    })
  })

  return wss
}

module.exports = { startServer }
