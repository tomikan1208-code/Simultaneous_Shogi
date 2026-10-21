import { existsSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connectionURLs } from './server-addresses.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.env.PORT ?? 5173);
let host = process.env.HOST || '::';
const publicURL = process.env.PUBLIC_URL || process.env.PUBLIC_ORIGIN || '';
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORTは0〜65535の整数を指定してください。');
connectionURLs({ host, port, publicURL, interfaces: {} });
if (!existsSync(new URL('../web/dist/engine.wasm', import.meta.url)) || !existsSync(new URL('../web/dist/main.js', import.meta.url))) {
  execFileSync(process.execPath, ['scripts/build-wasm.mjs'], { cwd: root, stdio: 'inherit' });
  execFileSync(process.execPath, ['scripts/build-web.mjs'], { cwd: root, stdio: 'inherit' });
}
const { createApplication } = await import('../server/app.mjs');
const app = await createApplication();
let closing;
const close = () => closing ??= app.close();
const stop = () => { void close().finally(() => process.exit(0)); };
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);
try {
  const listen = () => new Promise((ready, reject) => {
    const failed = error => { app.server.off('listening', listening); reject(error); };
    const listening = () => { app.server.off('error', failed); ready(); };
    app.server.once('error', failed);
    app.server.once('listening', listening);
    app.server.listen(port, host);
  });
  try { await listen(); }
  catch (error) {
    if (process.env.HOST || !['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code)) throw error;
    host = '0.0.0.0'; await listen();
  }
  const actualPort = app.server.address().port;
  const urls = connectionURLs({ host, port: actualPort, publicURL });
  const url = urls.local;
  console.log(`同時着手将棋 (listen: ${host}:${actualPort})`);
  console.log(`このPC: ${url}`);
  for (const lanURL of urls.lan) console.log(`LAN: ${lanURL}`);
  for (const internetURL of urls.internet) console.log(`インターネット (直接接続): ${internetURL}`);
  console.log('対戦通信は、このPCと相手の端末で直接行います。');
  console.log('Windowsの受信許可は start-server.bat が自動設定します（初回は管理者確認）。');
  console.log(`外部から接続するには、ルーターでもTCP ${actualPort}番の受信を許可してください。`);
  if (urls.internet.some(value => new URL(value).hostname.startsWith('['))) console.log('IPv6のURLは、相手のインターネット接続もIPv6に対応している必要があります。');
  console.log('IPv4で外部接続する場合は、ルーターでポート転送を設定してください。');
  if (!publicURL) console.log('IPv4の外部IPはルーターで確認できます。PUBLIC_URLに設定すると、その共有用URLも表示します。');
  if (process.argv.includes('--open')) {
    const [program, args] = process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    const browser = spawn(program, args, { stdio: 'ignore', windowsHide: true });
    const manualOpen = () => console.error(`ブラウザーを開けませんでした。${url} を手動で開いてください。`);
    browser.once('error', manualOpen);
    browser.once('exit', code => { if (code !== null && code !== 0) manualOpen(); });
    browser.unref();
  }
} catch (error) {
  if (!closing) {
    console.error(error.code === 'EADDRINUSE'
      ? `ポート${port}は使用中です。起動済みのサーバーを終了するか、環境変数PORTで別のポートを指定してください。`
      : `サーバーを起動できません: ${error.message}`);
    await close().catch(() => {});
    process.exitCode = 1;
  }
}
