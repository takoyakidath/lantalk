// macOS(特にApple Silicon)は、署名が壊れたアプリを「壊れている」として実行を拒否する。
// Electron本体に付いている署名は、アプリの名前や中身を差し替えると食い違って無効になるため、
// 開発者証明書が無くても、アプリ全体にad-hoc署名(-)を付け直す。
// (Apple Developer IDによる署名・公証ではないので、初回起動の警告は残る)
const { execFileSync } = require('child_process')
const path = require('path')

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
  console.log('  • ad-hoc署名を付けて、検証しました:', app)
}
