const PORT = window.api.port
let ws
let nickname = localStorage.getItem('nickname') || ''
let currentRoomId = null
let pendingJoinRoomId = null
let pendingJoinRoomName = null
let allRooms = []
let unreadCounts = {}
let recentRooms = JSON.parse(localStorage.getItem('recentRooms') || '[]')
let pendingCreatePassword = ''

// ---- WebSocket ----
function connect() {
  ws = new WebSocket(`ws://localhost:${PORT}`)

  ws.onopen = () => {
    console.log('[WS] connected')
  }

  ws.onmessage = (e) => {
    try { handleMessage(JSON.parse(e.data)) } catch (err) { console.error(err) }
  }

  ws.onclose = () => {
    console.log('[WS] disconnected, retrying...')
    setTimeout(connect, 2000)
  }

  ws.onerror = () => ws.close()
}

function send(data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data))
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'room:list':
      allRooms = msg.rooms
      renderRoomList()
      break

    case 'room:created':
      // Auto-join after creating — pass the password so owner isn't rejected
      send({ type: 'room:join', roomId: msg.room.id, nickname, password: pendingCreatePassword })
      pendingCreatePassword = ''
      saveRecentRoom(msg.room.id)
      break

    case 'room:joined':
      currentRoomId = msg.room.id
      saveRecentRoom(msg.room.id)
      unreadCounts[msg.room.id] = 0
      renderChat(msg.room, msg.messages, msg.memberCount)
      showView('chat')
      break

    case 'room:error':
      showError(msg.message)
      break

    case 'chat:message':
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
const VIEW_SIZES = { nickname: [240, 132], rooms: [240, 192], chat: [240, 110] }

function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'))
  document.getElementById(`view-${name}`).classList.remove('hidden')
  const [w, h] = VIEW_SIZES[name] || [240, 200]
  window.api.resize(w, h)
  if (name === 'chat') setTimeout(() => document.getElementById('input-message').focus(), 50)
  if (name === 'nickname') setTimeout(() => document.getElementById('input-nickname').focus(), 50)
}

// ---- Nickname ----
function initApp() {
  if (nickname) {
    document.getElementById('user-name-display').textContent = nickname
    showView('rooms')
    connect()
  } else {
    showView('nickname')
  }
}

function setNickname() {
  const val = document.getElementById('input-nickname').value.trim()
  if (!val) { document.getElementById('input-nickname').focus(); return }
  nickname = val
  localStorage.setItem('nickname', nickname)
  document.getElementById('user-name-display').textContent = nickname
  showView('rooms')
  connect()
}

$('btn-set-nickname').addEventListener('click', setNickname)
$('input-nickname').addEventListener('keydown', e => { if (e.key === 'Enter') setNickname() })

// ---- Room list ----
function renderRoomList() {
  const list = $('room-list')
  const noRooms = $('no-rooms')

  if (allRooms.length === 0) {
    list.innerHTML = ''
    noRooms.classList.remove('hidden')
    return
  }

  noRooms.classList.add('hidden')
  list.innerHTML = allRooms.map(room => {
    const unread = unreadCounts[room.id] || 0
    const lockHtml = room.hasPassword ? '<span class="lock-icon">🔒</span>' : ''
    const badgeHtml = unread > 0 ? `<span class="unread-badge">${unread}</span>` : ''
    return `<div class="room-item" data-id="${room.id}" data-has-pw="${room.hasPassword}" data-name="${esc(room.name)}">
      <div class="room-item-left">
        <span class="room-name">${esc(room.name)}</span>${lockHtml}
      </div>
      <div class="room-item-right">
        <span class="member-count">${room.memberCount}人</span>${badgeHtml}
      </div>
    </div>`
  }).join('')

  list.querySelectorAll('.room-item').forEach(el => {
    el.addEventListener('click', () => {
      const roomId = el.dataset.id
      const hasPw = el.dataset.hasPw === 'true'
      const roomName = el.dataset.name
      if (hasPw) {
        pendingJoinRoomId = roomId
        pendingJoinRoomName = roomName
        $('modal-password-title').textContent = `「${roomName}」のパスワード`
        openModal('modal-password')
        setTimeout(() => $('input-join-password').focus(), 50)
      } else {
        doJoin(roomId, '')
      }
    })
  })
}

function doJoin(roomId, password) {
  if (currentRoomId && currentRoomId !== roomId) {
    send({ type: 'room:leave', roomId: currentRoomId })
    currentRoomId = null
  }
  unreadCounts[roomId] = 0
  send({ type: 'room:join', roomId, password, nickname })
}

// ---- Create room ----
$('btn-create-room').addEventListener('click', () => {
  openModal('modal-create-room')
  setTimeout(() => $('input-room-name').focus(), 50)
})

$('btn-cancel-create').addEventListener('click', closeCreateModal)
$('btn-confirm-create').addEventListener('click', createRoom)
$('input-room-password').addEventListener('keydown', e => { if (e.key === 'Enter') createRoom() })
$('input-room-name').addEventListener('keydown', e => { if (e.key === 'Enter') $('input-room-password').focus() })

function createRoom() {
  const name = $('input-room-name').value.trim()
  const password = $('input-room-password').value
  if (!name) { $('input-room-name').focus(); return }
  pendingCreatePassword = password
  send({ type: 'room:create', name, password })
  closeCreateModal()
}

function closeCreateModal() {
  closeModal('modal-create-room')
  $('input-room-name').value = ''
  $('input-room-password').value = ''
}

// ---- Password modal ----
$('btn-cancel-join').addEventListener('click', closePasswordModal)
$('btn-confirm-join').addEventListener('click', confirmJoin)
$('input-join-password').addEventListener('keydown', e => { if (e.key === 'Enter') confirmJoin() })

function confirmJoin() {
  const password = $('input-join-password').value
  const roomId = pendingJoinRoomId
  closePasswordModal()
  if (roomId) doJoin(roomId, password)
}

function closePasswordModal() {
  closeModal('modal-password')
  $('input-join-password').value = ''
  pendingJoinRoomId = null
  pendingJoinRoomName = null
}

// ---- Chat ----
function renderChat(room, msgs, memberCount) {
  $('chat-room-name').textContent = room.name
  $('chat-member-count').textContent = `${memberCount}人`
  const container = $('messages')
  container.innerHTML = ''
  msgs.forEach(m => appendMessage(m, false))
  container.scrollTop = container.scrollHeight
}

function appendMessage(msg, scroll = true) {
  const container = $('messages')
  const isOwn = msg.user === nickname
  const div = document.createElement('div')
  div.className = `message ${isOwn ? 'own' : 'other'}`
  const time = new Date(msg.createdAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
  div.innerHTML = `
    ${!isOwn ? `<span class="msg-user">${esc(msg.user)}</span>` : ''}
    <div class="msg-bubble">
      <span class="msg-text">${esc(msg.text)}</span>
      <span class="msg-time">${time}</span>
    </div>`
  container.appendChild(div)
  if (scroll) container.scrollTop = container.scrollHeight
}

$('btn-back').addEventListener('click', () => {
  if (currentRoomId) {
    send({ type: 'room:leave', roomId: currentRoomId })
    currentRoomId = null
  }
  showView('rooms')
})

$('btn-send').addEventListener('click', sendMessage)
$('input-message').addEventListener('keydown', e => { if (e.key === 'Enter') sendMessage() })

function sendMessage() {
  const input = $('input-message')
  const text = input.value.trim()
  if (!text || !currentRoomId) return
  send({ type: 'chat:send', roomId: currentRoomId, text, nickname })
  input.value = ''
}

// ---- Recent rooms ----
function saveRecentRoom(roomId) {
  recentRooms = [roomId, ...recentRooms.filter(id => id !== roomId)].slice(0, 5)
  localStorage.setItem('recentRooms', JSON.stringify(recentRooms))
}

// ---- Window controls ----
// Titlebar removed — hide via tray or Cmd+Shift+C

// ---- Utilities ----
function $(id) { return document.getElementById(id) }

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function openModal(id) { $(id).classList.remove('hidden') }
function closeModal(id) { $(id).classList.add('hidden') }

function showError(msg) {
  const existing = document.querySelector('.error-toast')
  if (existing) existing.remove()
  const el = document.createElement('div')
  el.className = 'error-toast'
  el.textContent = msg
  document.getElementById('app').appendChild(el)
  setTimeout(() => el.remove(), 3000)
}

// ---- Start ----
initApp()
