// 画面の枠だけをキャッシュする。チャットの通信(WebSocket)は対象外
const CACHE = 'lantalk-v2'
const SHELL = ['/', '/style.css', '/renderer.js', '/shim.js', '/manifest.webmanifest', '/icons/icon-192.png']

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)))
  self.skipWaiting()
})

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  )
  self.clients.claim()
})

// ネットワーク優先。つながらないときだけキャッシュを返す
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)))
})
