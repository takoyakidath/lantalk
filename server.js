const WebSocket = require('ws')
const bcrypt = require('bcryptjs')
const crypto = require('crypto')
const http = require('http')
const fs = require('fs')
const path = require('path')
const net = require('net')

const SALT_ROUNDS = 10

// 1台のLAN端末が、ホストのメモリやCPUを使い切れないようにする上限
const MAX_ROOMS = 50
const EVICT_GRACE = 5 * 60 * 1000 // 満杯のときに追い出せるのは、作って5分たった未使用の部屋だけ(作った直後の部屋は、これから入室するところ)
const MAX_ROOMS_PER_IP = 10 // 1台が持てる部屋の数。発言のある部屋は7日残るので、枠を独占させない
const MAX_CONN_PER_IP = 20
const MAX_CONN_TOTAL = 200
const UNUSED_ROOM_TTL = 30 * 60 * 1000          // 発言が一度もなく、誰もいない部屋は30分で片付ける
const IDLE_ROOM_TTL = 7 * 24 * 60 * 60 * 1000   // 発言のある部屋は、7日間だれも使わなければ片付ける

// 発言者の識別用。クライアントが送るclientIdは、そのままは配らず、サーバーだけが知る鍵で別の値にして配る
// (配られた値からclientIdは分からないので、他人のclientIdを名乗れない)
let SECRET = crypto.randomBytes(16) // 保存した履歴があれば、再起動しても同じ値を使う(発言者の識別子を保つため)
const tagOf = (clientId) => crypto.createHmac('sha256', SECRET).update(clientId).digest('hex').slice(0, 12)

// 発言: 制御文字と、表示の向きを入れ替える文字(RTL override など)、行・段落の区切りを取り除く。
// ゼロ幅接合子(絵文字の組み合わせに使われる)は残す
const clean = (s) => String(s).replace(/[\u0000-\u0008\u000B-\u001F\u007F\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g, '')

// 名前: 制御文字・フォーマット文字・「表示されない」文字(ゼロ幅、ハングルの空白、点字の空白など)を
// すべて取り除き、空白を詰める。見えない文字を足して別の名前に見せかけるのを防ぐ
const cleanName = (s) => String(s)
  .replace(/[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u2800\u3164\u115F\u1160\uFFA0\u180E]/gu, '')
  .replace(/\s+/g, ' ')
  .trim()

// ラテン文字と見分けがつかない、キリル文字・ギリシャ文字など(UTS #39 の代表的なもの)
const LOOKALIKE = {
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'х': 'x', 'у': 'y', 'і': 'i', 'ј': 'j', 'ѕ': 's',
  'ԁ': 'd', 'һ': 'h', 'ԛ': 'q', 'ԝ': 'w', 'ӏ': 'l', 'ɡ': 'g', 'ı': 'i', 'ℓ': 'l',
  'ο': 'o', 'ν': 'v', 'ι': 'i', 'ρ': 'p', 'υ': 'u', 'κ': 'k', 'α': 'a', 'χ': 'x'
}
// 同じ名前かどうかの比較用。全角と半角、大文字と小文字、見た目が同じ文字の違いを、同じとみなす。
// (濁点など、日本語の区別は保つ。分解して記号を消すことはしない)
const nameKey = (s) => Array.from(cleanName(s).normalize('NFKC').toLowerCase(), ch => LOOKALIKE[ch] || ch).join('')

// ---- 履歴の保存(ホストの端末のファイルに保存。本人だけが読めるファイル権限にする) ----
const UUID_RE = /^[0-9a-f-]{36}$/i
let dataFile = null
let saveTimer = null

function snapshot() {
  return {
    version: 1,
    secret: SECRET.toString('hex'),
    rooms: Array.from(rooms.values()).map(r => ({
      id: r.id, name: r.name, passwordHash: r.passwordHash, createdAt: r.createdAt, lastActiveAt: r.lastActiveAt, creatorIp: r.creatorIp,
      messages: messages.get(r.id) || []
    }))
  }
}

function writeNow() {
  if (!dataFile) return
  clearTimeout(saveTimer)
  saveTimer = null
  try {
    const tmp = dataFile + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(snapshot()), { mode: 0o600 })
    fs.renameSync(tmp, dataFile) // 書き込み途中で止まっても、元のファイルを壊さない
  } catch (err) {
    console.error('[server] 履歴を保存できませんでした:', err.message)
  }
}

// 短い間に何度変わっても、まとめて1回だけ書く
function persist() {
  if (!dataFile || saveTimer) return
  saveTimer = setTimeout(writeNow, 500)
  saveTimer.unref()
}

// 保存したファイルは、念のため中身を検査してから読み込む(壊れていても、起動できるように)
function loadData(file) {
  let raw
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return }
  if (!raw || raw.version !== 1 || !Array.isArray(raw.rooms)) return
  if (typeof raw.secret === 'string' && /^[0-9a-f]{32}$/.test(raw.secret)) SECRET = Buffer.from(raw.secret, 'hex')
  for (const r of raw.rooms.slice(0, MAX_ROOMS)) {
    if (!r || typeof r.id !== 'string' || !UUID_RE.test(r.id) || typeof r.name !== 'string') continue
    // パスワード付きの部屋のハッシュが壊れていたら、その部屋は読み込まない
    // (読み込むと、パスワードなしで入れる部屋になってしまう)
    const hasHash = r.passwordHash !== null && r.passwordHash !== undefined
    const hash = typeof r.passwordHash === 'string' && /^\$2[aby]\$/.test(r.passwordHash) && r.passwordHash.length <= 100 ? r.passwordHash : null
    if (hasHash && !hash) continue
    const list = (Array.isArray(r.messages) ? r.messages : []).slice(-200)
      .filter(m => m && typeof m.text === 'string' && typeof m.user === 'string')
      .map(m => ({
        id: String(m.id || crypto.randomUUID()).slice(0, 40),
        roomId: r.id,
        user: m.user.slice(0, 16),
        userTag: String(m.userTag || '').slice(0, 12),
        text: m.text.slice(0, 200),
        createdAt: Number(m.createdAt) || Date.now()
      }))
    rooms.set(r.id, {
      id: r.id, name: r.name.slice(0, 20), passwordHash: hash,
      createdAt: Number(r.createdAt) || Date.now(), lastActiveAt: Number(r.lastActiveAt) || Date.now(),
      creatorIp: typeof r.creatorIp === 'string' ? r.creatorIp.slice(0, 45) : undefined
    })
    messages.set(r.id, list)
    roomMembers.set(r.id, new Set())
  }
}

// 一定時間あたりの回数制限
function makeLimiter(max, windowMs) {
  const hits = new Map() // key -> { n, reset }
  return {
    hit(key) { // 数えて、上限以内なら true
      const now = Date.now()
      let e = hits.get(key)
      if (!e || now > e.reset) { e = { n: 0, reset: now + windowMs }; hits.set(key, e) }
      e.n++
      return e.n <= max
    },
    refund(key) { // 数えた1回を取り消す
      const e = hits.get(key)
      if (e && e.n > 0) e.n--
    },
    prune() {
      const now = Date.now()
      for (const [k, e] of hits) if (now > e.reset) hits.delete(k)
    }
  }
}

// In-memory storage
const rooms = new Map()       // roomId -> { id, name, passwordHash, createdAt }
const messages = new Map()    // roomId -> [message]
const roomMembers = new Map() // roomId -> Set of ws connections
// room: { id, name, passwordHash, createdAt, lastActiveAt, creatorIp }

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

// Hostヘッダーが IPアドレス か localhost のときだけ受け付ける(DNSリバインディング対策)
function isTrustedHost(hostHeader) {
  const host = String(hostHeader || '')
  const name = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0]
  return name === 'localhost' || net.isIP(name) !== 0
}

// WebSocketを開いてよい接続元か。
// Originなし(Electron以外のクライアント)、Electronの file://、配信元と同じホスト(PWA)だけ通す。
// 他サイトのページがユーザーのブラウザ経由でLAN内のサーバーに接続するのを防ぐ
function isAllowedOrigin(req) {
  if (!isTrustedHost(req.headers.host)) return false
  const origin = req.headers.origin
  if (!origin || origin === 'file://') return true
  try { return new URL(origin).host === req.headers.host } catch { return false }
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
  if (!isTrustedHost(req.headers.host)) {
    res.writeHead(400).end('Bad host')
    return
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end()
    return
  }
  // URLとして解釈できない値でも例外にならないよう、クエリを落とすだけにする
  const pathname = String(req.url).split('?')[0]
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
    res.writeHead(200, {
      'Content-Type': entry[1],
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY', // 他のサイトのiframeに埋め込ませない
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src ws: wss:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
    })
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

function startServer(port, opts = {}) {
  // opts: dataFile(履歴の保存先) / unusedRoomTtlMs / idleRoomTtlMs / sweepMs(検証用に時間を縮める)
  const unusedTtl = opts.unusedRoomTtlMs ?? UNUSED_ROOM_TTL
  const idleTtl = opts.idleRoomTtlMs ?? IDLE_ROOM_TTL
  const sweepMs = opts.sweepMs ?? 60_000
  const maxRooms = opts.maxRooms ?? MAX_ROOMS
  const maxRoomsPerIp = opts.maxRoomsPerIp ?? MAX_ROOMS_PER_IP
  const evictGrace = opts.evictGraceMs ?? EVICT_GRACE
  rooms.clear(); messages.clear(); roomMembers.clear()
  dataFile = opts.dataFile || null
  if (dataFile) loadData(dataFile)

  // 同じポートでHTTP(PWAの配信)とWebSocketの両方を受ける
  const httpServer = http.createServer(handleHttp)
  const wss = new WebSocket.Server({
    server: httpServer,
    maxPayload: 16 * 1024,
    verifyClient: ({ req }) => isAllowedOrigin(req)
  })
  wss.httpServer = httpServer
  httpServer.on('error', (err) => console.error('[server]', err.message))
  httpServer.listen(port, () => console.log(`[server] HTTP + WebSocket listening on port ${port}`))

  const ipConns = new Map()                    // ip -> 接続数
  const joinTries = makeLimiter(5, 60_000)     // パスワード付きの部屋への入室の試行: 1分に5回まで
  const createRate = makeLimiter(opts.createPerMinute ?? 10, 60_000) // 部屋の作成: 1分に10回まで
  const msgRate = makeLimiter(40, 10_000)      // 1接続あたりのメッセージ: 10秒に40通まで

  // 部屋を作ってよいかを調べる。だめなら理由(文字列)を返し、よければ null を返す。
  // evict が true のときは、満杯なら「誰もおらず発言も一度もない、作って一定時間たった、いちばん古い部屋」を
  // 片付けて枠を空ける。発言のある部屋(履歴)と、作ったばかりの部屋は追い出さない
  const claimSlot = (ip, evict) => {
    const mine = Array.from(rooms.values()).filter(r => r.creatorIp === ip).length
    if (mine >= maxRoomsPerIp) return `この端末でつくれる部屋は${maxRoomsPerIp}個までです`
    if (rooms.size >= maxRooms) {
      const now = Date.now()
      let stale = null
      for (const r of rooms.values()) {
        const empty = !(roomMembers.get(r.id) || { size: 0 }).size
        const unused = !(messages.get(r.id) || []).length
        if (empty && unused && now - r.lastActiveAt > evictGrace && (!stale || r.lastActiveAt < stale.lastActiveAt)) stale = r
      }
      if (!stale) return '部屋が多すぎます。使われていない部屋が片付くまでお待ちください'
      if (evict) { rooms.delete(stale.id); messages.delete(stale.id); roomMembers.delete(stale.id) }
    }
    return null
  }

  // 部屋一覧は、短い間に何度変わってもまとめて1回だけ配る
  let listTimer = null
  const scheduleRoomList = () => {
    if (listTimer) return
    listTimer = setTimeout(() => { listTimer = null; broadcastRoomList(wss) }, 150)
  }

  // 誰もいない部屋を片付け、使い終わった回数の記録を捨てる
  // (一度も発言がなかった部屋は早く、発言のある部屋は履歴を残すため長く置く)
  const sweep = setInterval(() => {
    const now = Date.now()
    let removed = false
    for (const room of Array.from(rooms.values())) {
      const members = roomMembers.get(room.id)
      if (members && members.size > 0) continue
      const used = (messages.get(room.id) || []).length > 0
      if (now - room.lastActiveAt > (used ? idleTtl : unusedTtl)) {
        rooms.delete(room.id); messages.delete(room.id); roomMembers.delete(room.id)
        removed = true
      }
    }
    joinTries.prune(); createRate.prune(); msgRate.prune()
    if (removed) { scheduleRoomList(); persist() }
  }, sweepMs)

  // 切れたまま残った接続(ゴースト)を片付ける
  const heartbeat = setInterval(() => {
    wss.clients.forEach(c => {
      if (c.isAlive === false) return c.terminate()
      c.isAlive = false
      c.ping()
    })
  }, 30_000)
  sweep.unref(); heartbeat.unref()
  wss.on('close', () => { clearInterval(sweep); clearInterval(heartbeat); clearTimeout(listTimer); writeNow() })
  wss.flush = writeNow // 終了前に、保存し残しがないようにする
  wss.clearAll = () => { // すべての部屋と履歴を消す(保存したファイルの中身も)
    rooms.clear(); messages.clear(); roomMembers.clear()
    scheduleRoomList()
    writeNow()
  }

  wss.on('connection', (ws, req) => {
    const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '')
    if (!isPrivateIP(ip)) {
      ws.close(1008, 'LAN only')
      return
    }
    const conns = (ipConns.get(ip) || 0) + 1
    if (conns > MAX_CONN_PER_IP || wss.clients.size > MAX_CONN_TOTAL) {
      ws.close(1013, 'Too many connections')
      return
    }
    ipConns.set(ip, conns)

    ws.isAlive = true
    ws.on('pong', () => { ws.isAlive = true })
    ws.on('error', () => {})

    ws.joinedRooms = new Set()
    ws.id = crypto.randomUUID()
    // 名前と識別子は「部屋ごと」に持つ。別の部屋に入るときの名前で、すでに入っている部屋の名前が変わらないように
    ws.memberships = new Map() // roomId -> { nickname, tag }

    const reply = (obj) => ws.send(JSON.stringify(obj))
    const fail = (message) => reply({ type: 'room:error', message })

    // Send room list on connect
    reply({ type: 'room:list', rooms: buildRoomList() })

    ws.on('message', async (data) => {
      if (!msgRate.hit(ws.id)) return // 送りすぎた分は捨てる

      let msg
      try { msg = JSON.parse(data.toString()) } catch { return }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return

      try {
        switch (msg.type) {

          case 'room:list': {
            reply({ type: 'room:list', rooms: buildRoomList() })
            break
          }

          case 'room:create': {
            const name = clean(msg.name || '').trim().slice(0, 20)
            if (!name) { fail('部屋名を入力してください'); break }
            if (!createRate.hit(ip)) { fail('部屋をつくる回数が多すぎます。しばらくしてからやり直してください'); break }
            // 時間のかかるハッシュ計算の前に、無理な要求は早めに断る
            const early = claimSlot(ip, false)
            if (early) { fail(early); break }
            const id = crypto.randomUUID()
            let passwordHash = null
            if (typeof msg.password === 'string' && msg.password.trim()) {
              passwordHash = await bcrypt.hash(msg.password.slice(0, 32), SALT_ROUNDS)
            }
            // ハッシュ計算の間に、一斉に送られた他の要求が枠を使っていることがある。
            // そのため、確認と登録の間に await を挟まずに、ここでもう一度確認する
            const denied = claimSlot(ip, true)
            if (denied) { fail(denied); break }
            rooms.set(id, { id, name, passwordHash, createdAt: Date.now(), lastActiveAt: Date.now(), creatorIp: ip })
            persist()
            messages.set(id, [])
            roomMembers.set(id, new Set())
            scheduleRoomList()
            reply({ type: 'room:created', room: { id, name } })
            break
          }

          case 'room:join': {
            const room = typeof msg.roomId === 'string' ? rooms.get(msg.roomId) : null
            if (!room) { fail('部屋が見つかりません'); break }
            if (room.passwordHash) {
              // パスワードの総当たり対策。試行は照合の「前」に数える
              // (照合は時間がかかるので、後で数えると、一斉に送られた分がすべてすり抜ける)
              if (!joinTries.hit(ip)) { fail('試行が多すぎます。しばらくしてからやり直してください'); break }
              const valid = typeof msg.password === 'string' && msg.password
                ? await bcrypt.compare(msg.password.slice(0, 32), room.passwordHash)
                : false
              if (!valid) { fail('パスワードが違います'); break }
              joinTries.refund(ip) // 正しいパスワードで入れた分は、数えなかったことにする
            }

            // 発言者の識別。同じ端末が入り直したときは同じ値になる
            const tag = typeof msg.clientId === 'string' && /^[\w-]{8,64}$/.test(msg.clientId)
              ? tagOf(msg.clientId)
              : tagOf(ws.id)
            const wanted = (typeof msg.nickname === 'string' && cleanName(msg.nickname).slice(0, 16).trim()) || 'Anonymous'
            const members = roomMembers.get(room.id)
            // 同じ部屋で、別の人が同じ(に見える)名前を名乗ってなりすますのを防ぐ
            const taken = Array.from(members).some(m => {
              const other = m.memberships.get(room.id)
              return m !== ws && other && other.tag !== tag && nameKey(other.nickname) === nameKey(wanted)
            })
            if (taken) { fail('その名前はこの部屋で使われています。別の名前にしてください'); break }

            ws.memberships.set(room.id, { nickname: wanted, tag })
            members.add(ws)
            ws.joinedRooms.add(room.id)
            room.lastActiveAt = Date.now()
            persist()
            reply({
              type: 'room:joined',
              room: { id: room.id, name: room.name },
              messages: (messages.get(room.id) || []).slice(-50),
              memberCount: members.size,
              you: tag
            })
            scheduleRoomList()
            break
          }

          case 'room:leave': {
            const members = typeof msg.roomId === 'string' ? roomMembers.get(msg.roomId) : null
            if (members) {
              members.delete(ws)
              ws.joinedRooms.delete(msg.roomId)
              ws.memberships.delete(msg.roomId)
              if (rooms.has(msg.roomId)) rooms.get(msg.roomId).lastActiveAt = Date.now()
            }
            scheduleRoomList()
            break
          }

          case 'chat:send': {
            const { roomId } = msg
            if (typeof msg.text !== 'string') break
            const text = clean(msg.text).trim()
            if (!text) break
            const members = typeof roomId === 'string' ? roomMembers.get(roomId) : null
            const me = ws.memberships.get(roomId)
            if (!members || !members.has(ws) || !me) { fail('部屋に参加していません'); break }
            const message = {
              id: crypto.randomUUID(),
              roomId,
              user: me.nickname,
              userTag: me.tag,
              text: text.slice(0, 200),
              createdAt: Date.now()
            }
            const log = messages.get(roomId)
            const roomOfMsg = rooms.get(roomId)
            if (roomOfMsg) roomOfMsg.lastActiveAt = Date.now()
            log.push(message)
            if (log.length > 200) log.shift()
            const payload = JSON.stringify({ type: 'chat:message', message })
            members.forEach(c => {
              if (c.readyState === WebSocket.OPEN) c.send(payload)
            })
            persist()
            break
          }
        }
      } catch (err) {
        // 1通の不正なメッセージで、サーバー全体を止めない
        console.error('[server] message error:', err.message)
      }
    })

    ws.on('close', () => {
      const left = (ipConns.get(ip) || 1) - 1
      if (left <= 0) ipConns.delete(ip); else ipConns.set(ip, left)
      ws.joinedRooms.forEach(roomId => {
        const members = roomMembers.get(roomId)
        if (members) members.delete(ws)
        if (rooms.has(roomId)) rooms.get(roomId).lastActiveAt = Date.now()
      })
      scheduleRoomList()
    })
  })

  return wss
}

module.exports = { startServer, isPrivateIP }
