const PORT = window.api.port
const WEB = window.api.web === true
const UUID = /^[0-9a-f-]{36}$/i

let ws
let connectGen = 0
let nickname = localStorage.getItem('nickname') || ''
let serverHost = localStorage.getItem('serverHost') || ''

// この端末を見分ける値。**接続先ごとに別の値**を持つ。
// (参加先のサーバーには、この値が送られる。偽のホストに参加してしまっても、
//  そこで知られた値を、本物のホストでの「なりすまし」に使えないようにするため)
// HTTPのLANではcrypto.randomUUIDが使えないので、getRandomValuesで作る。
// サーバーはこの値をそのまま配らず、別の値に変えて配る
const currentHost = () => (WEB ? location.host : (serverHost || 'localhost'))
function clientIdFor(host) {
  const key = `clientId:${host}`
  let id = localStorage.getItem(key)
  if (!id) {
    id = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('')
    localStorage.setItem(key, id)
  }
  return id
}
let lastJoin = null   // 直近に入った部屋(再接続したとき、自動で入り直すため。パスワードはメモリ上だけ)
let rejoining = false
let myTag = '' // サーバーが入室時に教えてくれる、自分の発言者ID
let currentRoomId = null
let pendingJoinRoomId = null
let pendingCreatePassword = ''
let allRooms = []
let unreadCounts = {}
let lastMsgUser = null
let toastTimer = null
let miniMode = !WEB && localStorage.getItem('mini') === '1'

// ---- WebSocket ----
function connect() {
  const gen = ++connectGen
  if (ws) ws.close()
  // ブラウザ(PWA)は開いたページのホストにつなぐ。Electronは入力された接続先、空なら自分自身
  const host = WEB ? location.hostname : (serverHost || 'localhost')
  ws = new WebSocket(`${window.api.secure ? 'wss' : 'ws'}://${host}:${PORT}`)
  const sock = ws

  sock.onopen = () => {
    setOnline(true)
    // ホストが再起動した・つなぎ直したときは、サーバー側の入室が消えているので、入り直す
    if (currentRoomId && lastJoin && lastJoin.roomId === currentRoomId) {
      rejoining = true
      send({ type: 'room:join', roomId: lastJoin.roomId, password: lastJoin.password, nickname, clientId: clientIdFor(currentHost()) })
    }
  }

  sock.onmessage = (e) => {
    try { handleMessage(JSON.parse(e.data)) } catch (err) { console.error(err) }
  }

  sock.onclose = () => {
    if (gen !== connectGen) return // 設定変更で張り直し済み
    setOnline(false)
    setTimeout(() => { if (gen === connectGen) connect() }, 2000)
  }

  sock.onerror = () => sock.close()
}

function send(data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data))
}

function setOnline(online) {
  $('conn-banner').classList.toggle('hidden', online)
  $('conn-banner-chat').classList.toggle('hidden', online)
  if (!online) allRooms = []
  if (!online) renderRoomList()
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'room:list':
      allRooms = Array.isArray(msg.rooms) ? msg.rooms : []
      renderRoomList()
      break

    case 'room:created':
      // 作成者はパスワード付きでもそのまま入室する
      lastJoin = { roomId: msg.room.id, password: pendingCreatePassword }
      send({ type: 'room:join', roomId: msg.room.id, nickname, password: pendingCreatePassword, clientId: clientIdFor(currentHost()) })
      pendingCreatePassword = ''
      break

    case 'room:joined':
      rejoining = false
      currentRoomId = msg.room.id
      myTag = String(msg.you || '')
      unreadCounts[msg.room.id] = 0
      renderChat(msg.room, msg.messages, msg.memberCount)
      showView('chat')
      break

    case 'room:error':
      if (rejoining) { // 入り直せなかった(部屋が片付けられた・パスワードが変わった等)
        rejoining = false
        currentRoomId = null
        lastJoin = null
        showView('rooms')
      }
      showToast(msg.message)
      break

    case 'chat:message':
      if (!myTag || msg.message.userTag !== myTag) window.api.notify()
      if (msg.message.roomId === currentRoomId) {
        appendMessage(msg.message)
      } else {
        unreadCounts[msg.message.roomId] = (unreadCounts[msg.message.roomId] || 0) + 1
        renderRoomList()
      }
      break
  }
}

// ---- Views ----
const VIEW_SIZES = { setup: [320, 440], rooms: [320, 480], chat: [320, 500], mini: [320, 88] }

function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'))
  $(`view-${name}`).classList.remove('hidden')
  // ミニ表示はチャット画面だけ。後ろから覗かれにくいよう、最新1件と入力欄だけにする
  const mini = name === 'chat' && miniMode
  document.body.classList.toggle('mini', mini)
  const [w, h] = VIEW_SIZES[mini ? 'mini' : name]
  window.api.resize(w, h)
  if (name === 'chat') setTimeout(() => $('input-message').focus(), 50)
  if (name === 'setup') setTimeout(() => $('input-nickname').focus(), 50)
}

function setMini(on) {
  miniMode = on
  localStorage.setItem('mini', on ? '1' : '0')
  showView('chat')
}
$('btn-mini').addEventListener('click', () => setMini(true))
$('btn-expand').addEventListener('click', () => setMini(false))

// 出てきたときはすぐ入力できるようにする
window.api.onFocus(() => {
  if (!$('view-chat').classList.contains('hidden')) $('input-message').focus()
})

// 使われていない間(フォーカスもカーソルも無い)は、薄くしてぼかす
window.api.onState((s) => document.body.classList.toggle('idle', !s.hover && !s.focus))

document.querySelectorAll('.btn-hide').forEach(b => b.addEventListener('click', () => window.api.hide()))

// ---- Setup (初回 / 設定変更) ----
function initApp() {
  if (nickname) {
    enterRooms()
    connect()
  } else {
    showView('setup')
  }
}

function enterRooms() {
  window.api.setHostName(nickname)
  $('user-name-display').textContent = nickname
  paintAvatar($('profile-avatar'), nickname)
  showHost()
  renderRoomList()
  showView('rooms')
}

async function showHost() {
  const ip = WEB ? '' : (serverHost || await window.api.lanIp())
  $('host-display').textContent = ip || ''
}

// 押すと、スマホで開くURLのQRコードを出す
let shareUrl = ''
$('host-display').addEventListener('click', async () => {
  const ip = $('host-display').textContent
  if (!ip) return
  shareUrl = `http://${ip}:${PORT}`
  $('share-url').textContent = shareUrl
  $('qr-img').src = (await window.api.qr(shareUrl)) || ''
  openModal('modal-share')
})
$('btn-close-share').addEventListener('click', () => closeModal('modal-share'))
$('btn-copy-url').addEventListener('click', async () => {
  try {
    await window.api.copy(shareUrl)
    showToast('URLをコピーしました')
  } catch {
    showToast('コピーできませんでした')
  }
})

// 同じLANのLanTalkを一覧に出して、選ぶだけで参加先を入力できるようにする
function renderNearby(list) {
  const items = (Array.isArray(list) ? list : []).filter(h => h && /^[\d.]+$/.test(String(h.host)))
  const ul = $('nearby-list')
  ul.replaceChildren()
  $('nearby').classList.toggle('hidden', items.length === 0)
  items.forEach(h => {
    const li = el('li')
    const btn = el('button', 'nearby-item')
    btn.type = 'button'
    btn.append(avatarEl(String(h.name || '?')))
    const text = el('span', 'nearby-text')
    text.append(el('span', 'nearby-name', String(h.name || h.host)))
    text.append(el('span', 'nearby-ip', String(h.host)))
    btn.append(text)
    btn.addEventListener('click', () => {
      $('input-host').value = h.host
      $('input-host').focus()
    })
    li.append(btn)
    ul.append(li)
  })
}
window.api.hosts().then(renderNearby)
window.api.onHosts(renderNearby)

$('btn-profile').addEventListener('click', () => {
  $('input-nickname').value = nickname
  $('input-host').value = serverHost
  $('btn-cancel-setup').classList.remove('hidden')
  showView('setup')
})

$('btn-cancel-setup').addEventListener('click', enterRooms)

$('setup-form').addEventListener('submit', (e) => {
  e.preventDefault()
  const name = $('input-nickname').value.trim()
  if (!name) { $('input-nickname').focus(); return }
  const host = $('input-host').value.trim()
  const changed = name !== nickname || host !== serverHost
  nickname = name
  serverHost = host
  localStorage.setItem('nickname', nickname)
  localStorage.setItem('serverHost', serverHost)
  currentRoomId = null
  $('btn-cancel-setup').classList.add('hidden')
  enterRooms()
  if (changed || !ws) connect()
})

// ---- Room list ----
function renderRoomList() {
  const list = $('room-list')
  // 接続先を自由に指定できるので、受信した値は型を確認してから描画する
  const rooms = allRooms.filter(r => r && UUID.test(String(r.id)))
  list.replaceChildren()
  $('no-rooms').classList.toggle('hidden', rooms.length > 0)
  list.classList.toggle('hidden', rooms.length === 0)

  rooms.forEach(room => {
    const name = String(room.name || '')
    const count = Number(room.memberCount) || 0
    const unread = Number(unreadCounts[room.id]) || 0
    const locked = room.hasPassword === true

    const li = el('li', 'room-item')
    li.tabIndex = 0
    li.append(avatarEl(name, true))

    const main = el('div', 'room-main')
    main.append(el('span', 'room-name', name))
    const meta = el('span', 'room-meta')
    meta.append(el('span', count > 0 ? 'dot live' : 'dot'))
    meta.append(document.createTextNode(`${count}人${locked ? ' ・ パスワードあり' : ''}`))
    main.append(meta)
    li.append(main)

    if (unread > 0) li.append(el('span', 'unread-badge', String(unread)))

    const open = () => joinOrAsk(room.id, name, locked)
    li.addEventListener('click', open)
    li.addEventListener('keydown', e => { if (e.key === 'Enter') open() })
    list.append(li)
  })
}

function joinOrAsk(roomId, roomName, locked) {
  if (locked) {
    pendingJoinRoomId = roomId
    $('modal-password-title').textContent = `「${roomName}」のパスワード`
    openModal('modal-password')
    setTimeout(() => $('input-join-password').focus(), 50)
  } else {
    doJoin(roomId, '')
  }
}

function doJoin(roomId, password) {
  if (currentRoomId && currentRoomId !== roomId) {
    send({ type: 'room:leave', roomId: currentRoomId })
    currentRoomId = null
  }
  unreadCounts[roomId] = 0
  lastJoin = { roomId, password }
  send({ type: 'room:join', roomId, password, nickname, clientId: clientIdFor(currentHost()) })
}

// ---- Create room ----
function openCreate() {
  openModal('modal-create-room')
  setTimeout(() => $('input-room-name').focus(), 50)
}
$('btn-create-room').addEventListener('click', openCreate)
$('btn-empty-create').addEventListener('click', openCreate)
$('btn-cancel-create').addEventListener('click', closeCreateModal)

$('create-form').addEventListener('submit', (e) => {
  e.preventDefault()
  const name = $('input-room-name').value.trim()
  if (!name) { $('input-room-name').focus(); return }
  pendingCreatePassword = $('input-room-password').value
  send({ type: 'room:create', name, password: pendingCreatePassword })
  closeCreateModal()
})

function closeCreateModal() {
  closeModal('modal-create-room')
  $('input-room-name').value = ''
  $('input-room-password').value = ''
}

// ---- Password modal ----
$('btn-cancel-join').addEventListener('click', closePasswordModal)

$('join-form').addEventListener('submit', (e) => {
  e.preventDefault()
  const password = $('input-join-password').value
  const roomId = pendingJoinRoomId
  closePasswordModal()
  if (roomId) doJoin(roomId, password)
})

function closePasswordModal() {
  closeModal('modal-password')
  $('input-join-password').value = ''
  pendingJoinRoomId = null
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return
  if ($('modal-create-room').classList.contains('hidden') && $('modal-password').classList.contains('hidden') && $('modal-share').classList.contains('hidden')) {
    window.api.hide()
    return
  }
  if (!$('modal-share').classList.contains('hidden')) closeModal('modal-share')
  else if (!$('modal-create-room').classList.contains('hidden')) closeCreateModal()
  else if (!$('modal-password').classList.contains('hidden')) closePasswordModal()
})

// ---- Chat ----
function renderChat(room, msgs, memberCount) {
  $('chat-room-name').textContent = room.name
  $('chat-member-count').textContent = `${Number(memberCount) || 0}人が参加中`
  const container = $('messages')
  container.replaceChildren()
  lastMsgUser = null
  msgs.forEach(m => appendMessage(m, false))
  if (msgs.length === 0) $('mini-text').textContent = 'まだメッセージがありません'
  container.scrollTop = container.scrollHeight
}

function appendMessage(msg, scroll = true) {
  const container = $('messages')
  const user = String(msg.user || '')
  const isOwn = !!myTag && msg.userTag === myTag // 名前ではなくサーバーの識別子で判定する(同名のなりすまし対策)
  const cont = lastMsgUser === user // 同じ人の連続投稿は名前とアイコンを省く
  lastMsgUser = user

  const row = el('div', `message ${isOwn ? 'own' : 'other'}${cont ? ' cont' : ''}`)
  if (!isOwn) row.append(avatarEl(user, false, String(msg.userTag || user)))

  const body = el('div', 'msg-body')
  if (!isOwn && !cont) body.append(el('span', 'msg-user', user))
  body.append(el('div', 'msg-text', String(msg.text || '')))
  const time = new Date(msg.createdAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
  body.append(el('span', 'msg-time', time))
  row.append(body)

  container.append(row)
  $('mini-text').textContent = `${isOwn ? 'あなた' : user}: ${msg.text}`
  if (scroll) container.scrollTop = container.scrollHeight
}

$('btn-back').addEventListener('click', () => {
  if (currentRoomId) {
    send({ type: 'room:leave', roomId: currentRoomId })
    currentRoomId = null
  }
  showView('rooms')
})

$('chat-form').addEventListener('submit', (e) => {
  e.preventDefault()
  const input = $('input-message')
  const text = input.value.trim()
  if (!text || !currentRoomId) return
  send({ type: 'chat:send', roomId: currentRoomId, text })
  input.value = ''
})

// ---- Utilities ----
function $(id) { return document.getElementById(id) }

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

// ニックネームから色を決めて、同じ人は常に同じ色で表示する
// seed には、発言者の識別子があればそれを渡す。名前が似ていても、別の人なら色が変わる
function paintAvatar(node, name, seed = name) {
  let h = 0
  for (const ch of seed) h = (h * 31 + ch.codePointAt(0)) % 360
  node.style.setProperty('--hue', String(h))
  node.textContent = [...name][0] || '?'
}

function avatarEl(name, square = false, seed = name) {
  const a = el('span', square ? 'avatar sq' : 'avatar')
  paintAvatar(a, name, seed)
  return a
}

function openModal(id) { $(id).classList.remove('hidden') }
function closeModal(id) { $(id).classList.add('hidden') }

function showToast(msg) {
  const t = $('toast')
  t.textContent = msg
  t.classList.remove('hidden')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3000)
}

// ---- Start ----
initApp()
