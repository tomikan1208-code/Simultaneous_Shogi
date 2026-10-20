import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { launch, findBrowser } from '../dashboard/launcher.mjs';

const occupied = createServer((_, res) => res.end('occupied'));
await new Promise(done => occupied.listen(0, '127.0.0.1', done));
let closed = false, profile, shutdownFinished = false;
const server = createServer((_, res) => res.end('ready'));
try {
  await launch({
    browser: findBrowser() || 'test-browser',
    port: occupied.address().port,
    createApp: async () => ({ server, close: async () => {
      if (shutdownFinished) return;
      closed = true;
      await new Promise(done => setTimeout(done, 50));
      await new Promise(done => server.close(done));
      shutdownFinished = true;
    } }),
    openWindow: (browser, args, options) => {
      assert.ok(browser);
      assert.ok(args.some(arg => arg.startsWith('--app=http://127.0.0.1:')));
      assert.ok(args.includes('--disable-background-mode'));
      profile = args.find(arg => arg.startsWith('--user-data-dir=')).split('=').slice(1).join('=');
      assert.ok(existsSync(profile));
      assert.notEqual(server.address().port, occupied.address().port, 'Occupied ports must fall back');
      assert.equal(options.windowsHide, false, 'The interactive app window must be visible even when its Node launcher is hidden');
      const child = new EventEmitter();
      child.kill = () => child.emit('close', null);
      setTimeout(() => child.emit('close', 0), 25);
      return child;
    }
  });
  assert.equal(closed, true);
  assert.equal(shutdownFinished, true);
  assert.equal(existsSync(profile), false, 'Only the owned, temporary window profile is removed');
  console.log('Dedicated app args, separate profile, occupied-port fallback, window-close cleanup and awaited shutdown passed.');
} finally { await new Promise(done => occupied.close(done)); }
