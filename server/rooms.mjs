import { createHash, randomBytes, randomInt } from 'node:crypto';
import { mkdir, readdir, readFile, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { WasmEngine } from '../web/dist/engine.js';
import { actionLabel } from '../web/dist/presentation.js';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const other = side => side === 'A' ? 'B' : 'A';
const index = side => side === 'A' ? 0 : 1;
const hash = token => createHash('sha256').update(token).digest('hex');
const nameOf = value => {
  if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > 20 || /[\p{Cc}\p{Cf}]/u.test(value)) throw new HttpError(400, 'プレイヤー名は1〜20文字で入力してください。');
  return value.trim();
};

/** One authoritative Rust/WASM session per room. Only publicView crosses HTTP. */
export class RoomService {
  rooms = new Map();
  sessions = new Map();
  allocating = new Set();
  closing = false;
  constructor({ bytes, dataDir, graceMs = 90_000, ttlMs = 86_400_000, maxRooms = 256, initialPosition }) {
    Object.assign(this, { bytes, dataDir, graceMs, ttlMs, maxRooms, initialPosition });
  }
  static async open(options) {
    const service = new RoomService(options);
    await mkdir(service.dataDir, { recursive: true, mode: 0o700 });
    for (const file of await readdir(service.dataDir)) {
      if (!/^\d{6}\.json$/.test(file)) continue;
      try {
        const record = JSON.parse(await readFile(join(service.dataDir, file), 'utf8'));
        if (record.format !== 1 || file !== `${record.code}.json` || !record.players) throw new Error('Invalid room record');
        // The optional promotion of upgraded pieces changed in v0.6. Preserve
        // old rooms privately, without reinterpreting them or blocking startup.
        if (record.replay?.rules?.version === '0.5' && record.replay.rules.profile === 'official-v0.5') {
          const probe = await WasmEngine.fromBytes(service.bytes);
          const current = probe.call({ cmd: 'new' });
          if (!current.ok) throw new Error('Could not read current rules');
          if (current.value.rules.version !== '0.5') {
            const archive = join(service.dataDir, 'archive', 'official-v0.5');
            await mkdir(archive, { recursive: true, mode: 0o700 });
            await rename(join(service.dataDir, file), join(archive, `${record.code}-${Date.now()}-${randomBytes(6).toString('hex')}.json`));
            continue;
          }
        }
        if (Date.now() - record.updatedAt > service.ttlMs) { await unlink(join(service.dataDir, file)); continue; }
        const room = await service.restore(record);
        for (const player of Object.values(room.players).filter(Boolean)) player.disconnectedAt = Date.now();
        service.rooms.set(room.code, room); service.register(room);
      } catch (error) {
        // Never log records: they contain unpublished actions and credential hashes.
        console.error(`Could not restore room ${file}: ${error.name}`);
        throw new Error(`Room storage is unreadable: ${file}`);
      }
    }
    return service;
  }
  call(room, request) {
    const result = room.engine.call(request);
    if (!result.ok) throw new HttpError(400, 'この着手は指定できません。盤面を確認してください。');
    return result.value;
  }
  async restore(record) {
    const room = { ...structuredClone(record), engine: await WasmEngine.fromBytes(this.bytes), connections: new Map(), heartbeats: new Map(), queue: Promise.resolve() };
    room.view = this.call(room, { cmd: 'import', replay: record.replay });
    if (room.phase === 'playing') for (const side of ['A', 'B']) {
      const action = record.pending[index(side)];
      if (action) room.view = this.call(room, { cmd: 'submit', side, action });
    }
    this.refresh(room); return room;
  }
  refresh(room) {
    room.view = this.call(room, { cmd: 'view' });
    room.options = Object.fromEntries(['A', 'B'].map(side => [side, room.phase === 'playing' && !room.view.outcome ? this.call(room, { cmd: 'actions', side }) : []]));
  }
  record(room) {
    return {
      format: 1, code: room.code, createdAt: room.createdAt, updatedAt: room.updatedAt,
      version: room.version, gameId: room.gameId, phase: room.phase, players: room.players,
      result: room.result, pending: room.pending, history: room.history, replay: this.call(room, { cmd: 'export' }),
    };
  }
  async save(room) {
    const file = join(this.dataDir, `${room.code}.json`);
    const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(this.record(room))); await handle.sync();
      await handle.close(); handle = null; await rename(temporary, file);
    } catch (error) {
      await handle?.close().catch(() => {}); await unlink(temporary).catch(() => {}); throw error;
    }
  }
  register(room) {
    for (const side of ['A', 'B']) if (room.players[side]) this.sessions.set(room.players[side].tokenHash, { room, side });
  }
  publicView(room, side) {
    const view = structuredClone(room.view);
    if (room.phase !== 'playing') view.committed = [false, false];
    return {
      version: room.version, serverTime: Date.now(), you: side, history: room.history,
      room: {
        code: room.code, phase: room.phase, gameId: room.gameId, result: room.result,
        players: ['A', 'B'].map(s => {
          const p = room.players[s];
          return p ? { side: s, name: p.name, ready: p.ready, inLobby: p.inLobby, connected: room.connections.has(s), reconnectUntil: room.phase === 'playing' && p.disconnectedAt ? p.disconnectedAt + this.graceMs : null } : null;
        }),
      },
      view, options: room.phase === 'playing' && !view.committed[index(side)] ? room.options[side] : [],
    };
  }
  send(response, event, value) {
    if (response.destroyed || response.writableEnded) return;
    if (response.writableLength > 2 * 1024 * 1024) { response.destroy(); return; }
    response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
  }
  broadcast(room) { for (const [side, response] of room.connections) this.send(response, 'state', this.publicView(room, side)); }
  /** Serialize mutations and acknowledge only after an atomic durable write. */
  mutate(room, change) {
    const result = room.queue.then(async () => {
      if (this.closing || this.rooms.get(room.code) !== room) throw new HttpError(503, 'サーバーに再接続しています。少し待ってください。');
      const before = structuredClone(this.record(room));
      try {
        await change(); room.updatedAt = Date.now(); room.version++; await this.save(room);
      } catch (error) {
        // Validation failures precede any room changes; Rust's rejected submit
        // is atomic. Avoid replaying a long match for a rejected request.
        if (error instanceof HttpError) throw error;
        const restored = await this.restore(before);
        const { connections, heartbeats, queue } = room;
        Object.assign(room, restored, { connections, heartbeats, queue });
        console.error(`Room ${room.code} could not be saved: ${error.name}`);
        throw new HttpError(503, '対局を保存できませんでした。接続を確認して再試行してください。');
      }
      this.broadcast(room);
    });
    room.queue = result.catch(() => {}); return result;
  }
  credentials(name) {
    const token = randomBytes(32).toString('base64url');
    return { token, player: { name: nameOf(name), tokenHash: hash(token), ready: false, inLobby: true, disconnectedAt: Date.now() } };
  }
  async create(name) {
    if (this.rooms.size + this.allocating.size >= this.maxRooms) throw new HttpError(503, 'ただいま満室です。時間をおいてお試しください。');
    const { token, player } = this.credentials(name);
    let code;
    do code = String(randomInt(100000, 1000000)); while (this.rooms.has(code) || this.allocating.has(code));
    this.allocating.add(code);
    try {
      const room = {
        format: 1, code, createdAt: Date.now(), updatedAt: Date.now(), version: 1,
        gameId: randomBytes(12).toString('hex'), phase: 'lobby', players: { A: player, B: null },
        result: null, pending: [null, null], history: [], engine: await WasmEngine.fromBytes(this.bytes), connections: new Map(), heartbeats: new Map(), queue: Promise.resolve(),
      };
      this.call(room, { cmd: 'new', ...(this.initialPosition ? { position: this.initialPosition } : {}) });
      this.refresh(room); await this.save(room);
      this.rooms.set(code, room); this.register(room);
      return { token, ...this.publicView(room, 'A') };
    } finally { this.allocating.delete(code); }
  }
  async join(code, name) {
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) throw new HttpError(400, '部屋番号は6桁の数字です。');
    const room = this.rooms.get(code);
    if (!room) throw new HttpError(404, '部屋が見つかりません。番号を確認してください。');
    const { token, player } = this.credentials(name);
    let side;
    await this.mutate(room, () => {
      if (room.phase === 'playing') throw new HttpError(409, 'この部屋は対局中です。');
      side = ['A', 'B'].find(s => !room.players[s]);
      if (!side) throw new HttpError(409, 'この部屋は満員です。');
      room.players[side] = player;
      for (const p of Object.values(room.players).filter(Boolean)) p.ready = false;
    });
    this.register(room); return { token, ...this.publicView(room, side) };
  }
  authenticate(header) {
    const token = header?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    const session = token ? this.sessions.get(hash(token)) : null;
    if (!session || !this.rooms.has(session.room.code) || session.room.players[session.side]?.tokenHash !== hash(token)) throw new HttpError(401, '部屋の接続情報が失効しました。部屋に入り直してください。');
    return session;
  }
  async subscribe({ room, side }, response) {
    const previous = room.connections.get(side);
    room.connections.set(side, response);
    room.heartbeats.set(side, Date.now());
    if (previous) { this.send(previous, 'replaced', {}); previous.end(); }
    response.on('close', () => {
      if (room.connections.get(side) !== response) return;
      room.connections.delete(side);
      if (this.closing || !room.players[side]) return;
      void this.mutate(room, () => {
        room.players[side].disconnectedAt = Date.now();
        if (room.phase !== 'playing') room.players[side].ready = false;
      }).catch(() => {});
    });
    await this.mutate(room, () => { room.players[side].disconnectedAt = null; });
  }
  ping({ room, side }) { room.heartbeats.set(side, Date.now()); return { ok: true }; }
  async ready({ room, side }, ready) {
    if (typeof ready !== 'boolean') throw new HttpError(400, '準備状態が不正です。');
    await this.mutate(room, () => {
      if (room.phase === 'playing' || !room.players[side].inLobby || !room.connections.has(side)) throw new HttpError(409, 'ルームに戻り、接続を確認してください。');
      room.players[side].ready = ready;
      if (['A', 'B'].every(s => room.players[s]?.ready && room.players[s].inLobby && room.connections.has(s))) {
        room.phase = 'playing'; room.result = null; room.pending = [null, null]; room.history = []; room.gameId = randomBytes(12).toString('hex');
        for (const p of Object.values(room.players)) { p.ready = false; p.inLobby = false; }
        this.call(room, { cmd: 'new', ...(this.initialPosition ? { position: this.initialPosition } : {}) }); this.refresh(room);
      }
    });
    return this.publicView(room, side);
  }
  finish(room, result) {
    room.phase = 'finished'; room.result = result; room.pending = [null, null];
    for (const p of Object.values(room.players).filter(Boolean)) { p.ready = false; p.inLobby = false; }
  }
  async move({ room, side }, { action, round, gameId }) {
    await this.mutate(room, () => {
      if (room.phase !== 'playing') throw new HttpError(409, 'この対局は終了しています。');
      if (gameId !== room.gameId || round !== room.view.round) throw new HttpError(409, '局面が更新されました。最新の盤面を確認してください。');
      if (!['A', 'B'].every(s => room.connections.has(s))) throw new HttpError(409, '対戦相手の再接続を待っています。');
      if (!action || action.side !== side) throw new HttpError(403, '自分の駒だけを操作できます。');
      if (room.pending[index(side)]) {
        if (JSON.stringify(action) === JSON.stringify(room.pending[index(side)])) return;
        throw new HttpError(409, '着手はすでに確定しています。');
      }
      room.view = this.call(room, { cmd: 'submit', side, action }); room.pending[index(side)] = structuredClone(action);
      if (room.view.round !== round) {
        room.pending = [null, null];
        const resolution = room.view.lastResolution;
        room.history.push({ round: room.view.round, labels: ['A', 'B'].map(s => actionLabel(resolution.actions.find(a => a.side === s), resolution.frames[0].pieces)) });
        if (room.view.outcome) this.finish(room, room.view.outcome);
        this.refresh(room);
      }
    });
    return this.publicView(room, side);
  }
  async resign({ room, side }, gameId) {
    await this.mutate(room, () => {
      if (room.phase !== 'playing' || gameId !== room.gameId) throw new HttpError(409, '対局はすでに終了しています。');
      this.finish(room, { winner: other(side), reason: 'resigned' });
    }); return this.publicView(room, side);
  }
  async returnToRoom({ room, side }, gameId) {
    await this.mutate(room, () => {
      if (gameId !== room.gameId || room.phase === 'playing') throw new HttpError(409, '対局中です。');
      room.players[side].inLobby = true; room.players[side].ready = false;
      if (Object.values(room.players).filter(Boolean).every(p => p.inLobby)) room.phase = 'lobby';
    }); return this.publicView(room, side);
  }
  async leave({ room, side }) {
    const tokenHash = room.players[side].tokenHash;
    await this.mutate(room, () => {
      if (room.phase === 'playing') this.finish(room, { winner: other(side), reason: 'opponent_left' });
      room.players[side] = null;
      for (const p of Object.values(room.players).filter(Boolean)) p.ready = false;
    });
    this.sessions.delete(tokenHash);
    const connection = room.connections.get(side); room.connections.delete(side); connection?.end(); this.broadcast(room);
  }
  replay({ room }, round) {
    if (round === undefined) return this.call(room, { cmd: 'export' });
    if (!Number.isInteger(round) || round < 1 || round > room.view.round) throw new HttpError(400, '公開済みのラウンドを選択してください。');
    return this.call(room, { cmd: 'replay_round', round });
  }
  async tick() {
    const now = Date.now();
    for (const room of this.rooms.values()) {
      for (const [side, response] of room.connections) if (now - (room.heartbeats.get(side) ?? now) > 30_000) response.destroy();
      const expired = ['A', 'B'].filter(s => room.players[s]?.disconnectedAt && now - room.players[s].disconnectedAt >= this.graceMs && !room.connections.has(s));
      if (room.phase === 'playing' && expired.length && (room.connections.size || expired.length === 2)) {
        await this.mutate(room, () => {
          if (room.phase !== 'playing') return;
          const missing = ['A', 'B'].filter(s => room.players[s]?.disconnectedAt && Date.now() - room.players[s].disconnectedAt >= this.graceMs && !room.connections.has(s));
          if (missing.length && (room.connections.size || missing.length === 2)) this.finish(room, { winner: missing.length === 2 ? 'draw' : other(missing[0]), reason: 'disconnected' });
        }).catch(() => {});
      }
      if (!room.connections.size && now - room.updatedAt > this.ttlMs) {
        await room.queue;
        if (room.connections.size) continue;
        await unlink(join(this.dataDir, `${room.code}.json`));
        for (const p of Object.values(room.players).filter(Boolean)) this.sessions.delete(p.tokenHash);
        this.rooms.delete(room.code);
      }
    }
  }
  async close() {
    this.closing = true;
    for (const room of this.rooms.values()) for (const connection of room.connections.values()) connection.end();
    await Promise.all([...this.rooms.values()].map(room => room.queue));
  }
}
