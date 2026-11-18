// ブラウザ/PWAで開いたとき、Electronのpreloadが用意する window.api の代わりを用意する
if (!window.api) {
  const secure = location.protocol === 'https:'
  window.api = {
    web: true,
    secure,
    port: Number(location.port) || (secure ? 443 : 80),
    hide() {},
    resize() {},
    lanIp: async () => null,
    onFocus() {}
  }
  document.documentElement.classList.add('web')

  // Service WorkerはHTTPSかlocalhostでのみ有効。LANのIPをHTTPで開いた場合は登録されない
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  }
}
