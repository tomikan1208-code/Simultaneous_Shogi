import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { createApplication } from '../server/app.mjs';
import { WasmEngine } from '../web/dist/engine.js';

const artifacts = resolve('artifacts');
await mkdir(artifacts, { recursive: true });
const dataDir = await mkdtemp(resolve(artifacts, 'online-'));
let app, base;
const clients = [];
async function start(options = {}) {
  app = await createApplication({ dataDir, graceMs: 250, tickMs: 25, ...options });
  await new Promise(resolveListen => app.server.listen(0, '127.0.0.1', resolveListen));
  base = `http://127.0.0.1:${app.server.address().port}`;
}
async function until(check, label) {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise(resolveWait => setTimeout(resolveWait, 10));
  }
}
async function request(path, token, input, expected = 200) {
  const response = await fetch(base + '/api/' + path, {
    method: input === undefined ? 'GET' : 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(input === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: input === undefined ? undefined : JSON.stringify(input), signal: AbortSignal.timeout(10_000),
  });
  const value = await response.json();
  assert.equal(response.status, expected, `${path}: ${JSON.stringify(value)}`); return value;
}
class Client {
  constructor(entry) { this.token = entry.token; this.state = entry; this.traffic = []; clients.push(this); }
  async connect() {
    this.abort?.abort(); this.abort = new AbortController();
    const response = await fetch(base + '/api/events', { headers: { Authorization: `Bearer ${this.token}` }, signal: this.abort.signal });
    assert.equal(response.status, 200);
    this.reader = (async () => {
      const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
      try {
        while (true) {
          const chunk = await reader.read(); if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const event = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            if (event.startsWith('event: state')) {
              const data = JSON.parse(event.split('\ndata: ')[1]); this.traffic.push(data);
              if (data.version >= this.state.version) this.state = data;
            }
          }
        }
      } catch (error) { if (!this.abort.signal.aborted && error.name !== 'AbortError') throw error; }
    })();
    await until(() => this.state.room.players.find(p => p?.side === this.state.you)?.connected, 'client connected');
  }
  async post(path, input, expected = 200) {
    const value = await request(path, this.token, input, expected);
    if (value.room && value.version >= this.state.version) this.state = value;
    return value;
  }
  move(action, expected = 200) { return this.post('move', { action, round: this.state.view.round, gameId: this.state.room.gameId }, expected); }
  async disconnect() { this.abort?.abort(); await this.reader; }
}
const move = (side, piece, to) => ({ type: 'move', side, piece, to, choice: 'none' });
const initialPosition = {
  pieces: [
    { id: 'AK', side: 'A', kind: 'K', at: [9, 9] }, { id: 'BK', side: 'B', kind: 'K', at: [9, 1] },
    { id: 'AR', side: 'A', kind: 'R', at: [5, 7] }, { id: 'BP', side: 'B', kind: 'P', at: [5, 5] },
  ], hands: { A: { P: 1 }, B: { P: 1 } },
};
try {
  await start({ initialPosition });
  await request('state', '', undefined, 401);
  await request('rooms', '', { name: '' }, 400);
  const a = new Client(await request('rooms', '', { name: '検証 A' }, 201));
  assert.match(a.state.room.code, /^\d{6}$/);
  const b = new Client(await request('join', '', { name: '検証 B', code: a.state.room.code }));
  await request('join', '', { name: '第三者', code: a.state.room.code }, 409);
  await a.connect(); await b.connect();
  await until(() => a.state.room.players.every(p => p?.connected), 'both clients online');
  await a.post('ready', { ready: true }); assert.equal(a.state.room.phase, 'lobby');
  await b.post('ready', { ready: true });
  await until(() => a.state.room.phase === 'playing', 'both ready starts match');
  const originalHash = a.state.view.stateHash, originalPosition = structuredClone(a.state.view.position);
  const secret = move('A', 'AR', [5, 5]);
  const save = app.service.save.bind(app.service);
  app.service.save = async () => { throw new Error('Simulated storage failure'); };
  await a.move(secret, 503);
  app.service.save = save;
  const unchanged = await request('state', a.token);
  assert.equal(unchanged.view.stateHash, originalHash);
  assert.deepEqual(unchanged.view.committed, [false, false], 'failed persistence rolls back an unacknowledged commitment');
  await a.move(move('B', 'BP', [5, 6]), 403);
  await a.move(move('A', 'BP', [5, 6]), 400);
  await a.move(secret);
  await until(() => b.state.view.committed[0], 'opponent sees commitment only');
  assert.equal(b.state.view.stateHash, originalHash);
  assert.deepEqual(b.state.view.position, originalPosition);
  assert.equal(b.state.view.lastResolution, null);
  assert.deepEqual(b.state.history, []);
  assert.ok(b.state.options.every(option => option.action.side === 'B'));
  assert.ok(!JSON.stringify(b.traffic).includes(JSON.stringify(secret)), 'unpublished intent never crosses the opponent stream');
  assert.equal((await request('replay', b.token)).rounds.length, 0);
  await request('replay?round=1', b.token, undefined, 400);
  await a.move(secret); // Lost acknowledgements can be retried in this round.
  await a.move(move('A', 'AR', [5, 6]), 409);
  await b.move(move('B', 'BP', [6, 6]), 400);
  await b.move(move('B', 'BP', [5, 6]));
  await until(() => a.state.view.round === 1, 'simultaneous reveal');
  assert.equal(a.state.view.stateHash, b.state.view.stateHash);
  assert.equal(a.state.view.lastResolution.events.find(e => e.type === 'contact').winner, 'AR');
  assert.equal(a.state.view.lastResolution.captures[0].victim, 'BP');
  assert.equal(a.state.history.length, 1);
  const replay = await request('replay', a.token);
  const wasm = await WasmEngine.fromBytes(await readFile(new URL('../web/dist/engine.wasm', import.meta.url)));
  assert.equal(wasm.call({ cmd: 'import', replay }).value.stateHash, a.state.view.stateHash);
  assert.deepEqual(await request('replay?round=1', b.token), a.state.view.lastResolution);
  const oldId = a.state.room.gameId;
  await b.post('resign', { gameId: oldId });
  await until(() => a.state.room.phase === 'finished', 'resignation ends match');
  assert.equal(a.state.room.result.winner, 'A');
  await b.post('return', { gameId: oldId }); await b.post('ready', { ready: true });
  assert.equal(b.state.room.phase, 'finished', 'reviewing opponent is not pulled into another game');
  await a.post('return', { gameId: oldId }); await a.post('ready', { ready: true });
  await until(() => b.state.room.phase === 'playing', 'rematch in the same room');
  assert.notEqual(b.state.room.gameId, oldId); assert.equal(b.state.view.round, 0);
  assert.equal(b.state.view.stateHash, originalHash); assert.deepEqual(b.state.view.committed, [false, false]);
  await a.post('move', { gameId: oldId, round: 0, action: secret }, 409);

  // Recover both the public replay and a single unpublished move across process restart.
  await a.move(secret); await b.disconnect();
  await until(() => !a.state.room.players[1].connected, 'disconnect is visible');
  await a.move(secret, 409); // The game pauses during a connection interruption.
  await app.close();
  const stored = await readFile(resolve(dataDir, a.state.room.code + '.json'), 'utf8');
  assert.ok(!stored.includes(a.token) && !stored.includes(b.token), 'only credential hashes are persisted');
  const legacy = JSON.parse(stored); legacy.code = '000001'; legacy.replay.rules.version = '0.5'; legacy.replay.rules.profile = 'official-v0.5';
  const legacyBytes = JSON.stringify(legacy);
  await writeFile(resolve(dataDir,'000001.json'),legacyBytes);
  await start({ initialPosition });
  const legacyFiles = await readdir(resolve(dataDir,'archive','official-v0.5'));
  assert.equal(legacyFiles.length,1);
  assert.equal(await readFile(resolve(dataDir,'archive','official-v0.5',legacyFiles[0]),'utf8'),legacyBytes,'old rule rooms are archived without modifying their private contents');
  assert.ok(!(await readdir(dataDir)).includes('000001.json'),'incompatible rooms do not prevent current games from resuming');
  a.state = await request('state', a.token); b.state = await request('state', b.token);
  await a.connect(); await b.connect();
  await until(() => a.state.room.players.every(p => p?.connected), 'reconnect after restart');
  assert.deepEqual(b.state.view.committed, [true, false]);
  assert.equal(b.state.view.stateHash, originalHash);
  assert.equal((await request('replay', b.token)).rounds.length, 0);
  await b.move(move('B', 'BP', [5, 6]));
  await until(() => a.state.view.round === 1, 'restored secrets resolve correctly');
  assert.equal(a.state.view.stateHash, b.state.view.stateHash);
  assert.equal(a.state.view.lastResolution.events.find(e => e.type === 'contact').winner, 'AR');
  await a.post('move', { gameId: a.state.room.gameId, round: 0, action: secret }, 409);

  await b.disconnect();
  await until(() => a.state.room.phase === 'finished', 'disconnect grace expires');
  assert.deepEqual(a.state.room.result, { winner: 'A', reason: 'disconnected' });
  await b.connect();
  await until(() => b.state.room.result?.reason === 'disconnected', 'late reconnect sees result');
  await b.post('leave', {}); await request('state', b.token, undefined, 401);
  await a.post('return', { gameId: a.state.room.gameId });
  const c = new Client(await request('join', '', { name: '新しい相手', code: a.state.room.code }));
  await c.connect(); await a.post('ready', { ready: true }); await c.post('ready', { ready: true });
  await until(() => a.state.room.phase === 'playing', 'a vacated seat can be filled');
  await c.post('leave', {});
  await until(() => a.state.room.result?.reason === 'opponent_left', 'leaving a running game forfeits');
  assert.equal(a.state.room.result.winner, 'A');
  const forbidden = await fetch(base + '/api/state', { headers: { Authorization: `Bearer ${a.token}`, Origin: 'https://unrelated.example' } });
  assert.equal(forbidden.status, 403);
  assert.equal((await fetch(base + '/server/rooms.mjs')).status, 404);
  assert.equal((await fetch(base + '/data/rooms/' + a.state.room.code + '.json')).status, 404);
  assert.equal((await fetch(base + '/data/rooms/archive/official-v0.5/' + legacyFiles[0])).status,404);
  console.log('Online integration passed: authenticated two-client SSE, ready/start, server-authoritative collisions, secret isolation, invalid/stale/duplicate inputs, storage-failure rollback, replay verification, rematch, disconnect pause/timeout, persistent pending-input recovery, leave/rejoin, and origin/access checks.');
} finally {
  await Promise.allSettled(clients.map(client => client.disconnect()));
  if (app) await app.close();
  const target = resolve(dataDir);
  assert.ok(target.startsWith(artifacts + sep), 'cleanup must stay in artifacts');
  await rm(target, { recursive: true, force: true });
}
