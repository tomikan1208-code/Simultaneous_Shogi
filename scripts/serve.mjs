import { existsSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.env.PORT ?? 5173);
const host = process.env.HOST ?? '0.0.0.0';
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORTは0〜65535の整数を指定してください。');
if (!existsSync(new URL('../web/dist/engine.wasm', import.meta.url)) || !existsSync(new URL('../web/dist/main.js', import.meta.url))) {
  execFileSync(process.execPath, ['scripts/build-wasm.mjs'], { cwd: root, stdio: 'inherit' });
  execFileSync(process.execPath, ['scripts/build-web.mjs'], { cwd: root, stdio: 'inherit' });
}
const { createApplication } = await import('../server/app.mjs');
const app = await createApplication();
app.server.once('error', error => {
  console.error(error.code === 'EADDRINUSE'
    ? `ポート${port}は使用中です。起動済みのサーバーを終了するか、環境変数PORTで別のポートを指定してください。`
    : `サーバーを起動できません: ${error.message}`);
  void app.close().catch(() => {}).finally(() => { process.exitCode = 1; });
});
app.server.listen(port, host, () => {
  const browserHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  const url = `http://${browserHost.includes(':') ? `[${browserHost}]` : browserHost}:${app.server.address().port}/`;
  console.log(`同時着手将棋 → ${url} (listen: ${host})`);
  if (process.argv.includes('--open')) {
    const [program, args] = process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    const browser = spawn(program, args, { stdio: 'ignore', windowsHide: true });
    const manualOpen = () => console.error(`ブラウザーを開けませんでした。${url} を手動で開いてください。`);
    browser.once('error', manualOpen);
    browser.once('exit', code => { if (code !== null && code !== 0) manualOpen(); });
    browser.unref();
  }
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void app.close().then(() => process.exit(0)); });
