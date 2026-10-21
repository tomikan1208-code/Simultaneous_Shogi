import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RoomService, HttpError } from './rooms.mjs';
import { ModelService } from './models.mjs';
import { ExternalService } from './external.mjs';
import { WasmEngine } from '../web/dist/engine.js';
import { PLAY_RULES } from '../web/dist/rules.js';

const webRoot = fileURLToPath(new URL('../web/dist/', import.meta.url));
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.map': 'application/json', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8', '.wav': 'audio/wav' };
const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
async function body(req, maximum = 16_384) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'JSON形式で送信してください。');
  let value = '';
  for await (const chunk of req) {
    value += chunk;
    if (Buffer.byteLength(value) > maximum) throw new HttpError(413, '送信データが大きすぎます。');
  }
  try {
    const result = JSON.parse(value);
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
    return result;
  } catch { throw new HttpError(400, '送信データを確認してください。'); }
}

export async function createApplication(options = {}) {
  const bytes = await readFile(new URL('../web/dist/engine.wasm', import.meta.url));
  const service = await RoomService.open({ bytes, dataDir: resolve(process.env.DATA_DIR || 'data/rooms'), ...options });
  const probe = await WasmEngine.fromBytes(bytes);
  const rules = probe.call({ cmd: 'new',rules:PLAY_RULES }).value.rules;
  const models = new ModelService({ ...options.models, rules });
  const external = new ExternalService({ ...options.external, rules });
  const rates = new Map();
  function rate(req, lobby = false) {
    const key = `${req.socket.remoteAddress}:${lobby ? 'lobby' : 'api'}`;
    let entry = rates.get(key);
    if (!entry || Date.now() - entry.since >= 60_000) { entry = { since: Date.now(), count: 0 }; rates.set(key, entry); }
    if (++entry.count > (lobby ? 30 : 600)) throw new HttpError(429, '操作が多すぎます。少し待ってから再試行してください。');
  }
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      if (path === '/healthz') { json(res, 200, { ok: true }); return; }
      if (path.startsWith('/api/')) {
        const origin = req.headers.origin;
        if (origin && (process.env.PUBLIC_ORIGIN ? origin !== process.env.PUBLIC_ORIGIN : new URL(origin).host !== req.headers.host)) throw new HttpError(403, 'この接続元からは操作できません。');
        if (!['GET', 'POST'].includes(req.method)) throw new HttpError(405, '対応していない操作です。');
        rate(req, path === '/api/rooms' || path === '/api/join');
        if (path.startsWith('/api/ai/')) {
          const address = req.socket.remoteAddress, hostname = new URL(`http://${req.headers.host}`).hostname;
          if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address) || !['localhost', '127.0.0.1', '[::1]'].includes(hostname)) throw new HttpError(403, 'AI対戦は、サーバーを起動したPCのlocalhostから利用してください。');
          if (req.method === 'GET' && path === '/api/ai/external') { json(res, 200, await external.status()); return; }
          if (req.method === 'POST' && path === '/api/ai/external/load') { await body(req); json(res, 200, await external.load()); return; }
          if (req.method === 'POST' && path === '/api/ai/external/move') { json(res, 200, await external.choose(await body(req, 2 * 1024 * 1024))); return; }
          if (req.method === 'GET' && path === '/api/ai/models') { json(res, 200, await models.catalogue()); return; }
          if (req.method === 'POST' && path === '/api/ai/load') { json(res, 200, await models.load((await body(req)).model)); return; }
          if (req.method === 'POST' && path === '/api/ai/move') { json(res, 200, await models.choose(await body(req, 2 * 1024 * 1024))); return; }
          throw new HttpError(404, 'モデル操作が見つかりません。');
        }
        if (req.method === 'POST' && path === '/api/rooms') { json(res, 201, await service.create((await body(req)).name)); return; }
        if (req.method === 'POST' && path === '/api/join') { const input = await body(req); json(res, 200, await service.join(input.code, input.name)); return; }
        const session = service.authenticate(req.headers.authorization);
        if (req.method === 'GET') {
          if (path === '/api/state') { await session.room.queue; json(res, 200, service.publicView(session.room, session.side)); return; }
          if (path === '/api/events') {
            res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
            res.flushHeaders(); await service.subscribe(session, res); return;
          }
          if (path === '/api/replay') {
            await session.room.queue;
            json(res, 200, service.replay(session, url.searchParams.has('round') ? Number(url.searchParams.get('round')) : undefined)); return;
          }
        } else {
          const input = await body(req);
          if (path === '/api/ping') { json(res, 200, service.ping(session)); return; }
          if (path === '/api/ready') { json(res, 200, await service.ready(session, input.ready)); return; }
          if (path === '/api/move') { json(res, 200, await service.move(session, input)); return; }
          if (path === '/api/resign') { json(res, 200, await service.resign(session, input.gameId)); return; }
          if (path === '/api/return') { json(res, 200, await service.returnToRoom(session, input.gameId)); return; }
          if (path === '/api/leave') { await service.leave(session); json(res, 200, { ok: true }); return; }
        }
        throw new HttpError(404, '操作が見つかりません。');
      }
      if (!['GET', 'HEAD'].includes(req.method)) throw new HttpError(405, '対応していない操作です。');
      const pathname = decodeURIComponent(path);
      const file = resolve(webRoot, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!file.startsWith(webRoot.endsWith(sep) ? webRoot : webRoot + sep) || !(await stat(file)).isFile()) throw new HttpError(404, 'Not found');
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      const status = error instanceof HttpError ? error.status : error.code === 'ENOENT' ? 404 : 500;
      if (status === 500) console.error(`Request failed: ${error.name}`);
      json(res, status, { error: status === 500 ? 'サーバーで問題が起きました。再接続をお試しください。' : error.message });
    }
  });
  server.requestTimeout = 30_000; server.headersTimeout = 15_000;
  let ticking = false;
  const tick = setInterval(async () => {
    if (ticking) return;
    ticking = true;
    try { await service.tick(); } catch (error) { console.error(`Room maintenance failed: ${error.name}`); }
    finally { ticking = false; }
    for (const [key, value] of rates) if (Date.now() - value.since > 60_000) rates.delete(key);
  }, options.tickMs ?? 1000);
  const heartbeat = setInterval(() => {
    for (const room of service.rooms.values()) for (const response of room.connections.values()) service.send(response, 'ping', Date.now());
  }, 10_000);
  tick.unref(); heartbeat.unref();
  return {
    server, service,
    async close() {
      clearInterval(tick); clearInterval(heartbeat); await Promise.all([models.close(), external.close()]); await service.close(); server.closeIdleConnections();
      await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
    },
  };
}
