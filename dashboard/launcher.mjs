import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, appendFile, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDashboard, root } from './server.mjs';

export function findBrowser(env = process.env) {
  for (const base of [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean)) {
    for (const name of ['Microsoft/Edge/Application/msedge.exe', 'Google/Chrome/Application/chrome.exe']) {
      const path = join(base, name);
      if (existsSync(path)) return path;
    }
  }
  return null;
}

export async function launch({ browser = findBrowser(), port = Number(process.env.DASHBOARD_PORT || 5180), openWindow = spawn, createApp = createDashboard } = {}) {
  if (!browser) throw new Error('Chrome / Edge が見つかりません。ブラウザで利用する場合は npm run dashboard:server を実行してください。');
  const app = await createApp();
  try {
    await new Promise((ready, reject) => {
      const onError = error => {
        if (error.code === 'EADDRINUSE' && port !== 0) { port = 0; app.server.listen(0, '127.0.0.1'); }
        else reject(error);
      };
      app.server.on('error', onError);
      app.server.once('listening', () => { app.server.off('error', onError); ready(); });
      app.server.listen(port, '127.0.0.1');
    });
    const url = `http://127.0.0.1:${app.server.address().port}`;
    const profiles = join(root, '.cache/dashboard-window');
    await mkdir(profiles, { recursive: true });
    // An isolated profile gives this window its own process and reliable close detection.
    const profile = await mkdtemp(join(profiles, 'window-'));
    try {
      const child = openWindow(browser, [`--app=${url}`, `--user-data-dir=${profile}`, '--window-size=1440,940',
        '--no-first-run', '--no-default-browser-check', '--disable-background-mode'], { windowsHide: false, stdio: 'ignore' });
      const close = () => { child.kill(); };
      process.once('SIGINT', close); process.once('SIGTERM', close);
      console.log(`AI 学習コントロールパネル → ${url}`);
      try {
        await new Promise((done, reject) => {
          child.once('error', reject);
          child.once('close', code => code === 0 || code === null ? done() : reject(new Error(`ウィンドウが終了しました: ${code}`)));
        });
      } finally { process.off('SIGINT', close); process.off('SIGTERM', close); }
    } finally {
      await app.close();
      const target = resolve(profile), parent = resolve(profiles) + sep;
      if (target.startsWith(parent)) await rm(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }).catch(() => {});
    }
  } finally { await app.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  launch().catch(async error => {
    const folder = join(root, '.cache/dashboard');
    await mkdir(folder, { recursive: true });
    await appendFile(join(folder, 'launcher.log'), `${new Date().toISOString()} ${error.stack}\n`);
    console.error(error.message); process.exitCode = 1;
  });
}
