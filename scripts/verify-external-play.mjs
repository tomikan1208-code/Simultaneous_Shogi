import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createApplication } from '../server/app.mjs';
import { WasmEngine } from '../web/dist/engine.js';
import { PLAY_RULES } from '../web/dist/rules.js';

await mkdir('artifacts', { recursive: true });
const folder = await mkdtemp(resolve('artifacts/external-play-'));
const configFile = join(folder, 'local.json');
const python = process.env.SHOGI_PYTHON || (existsSync('.venv') ? resolve('.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python') : process.platform === 'win32' ? 'python' : 'python3');
const config = { external_ai_command: [python, resolve('tests/fixtures/fake_usi.py')], external_ai_nodes: 2000,
  external_ai_options: {}, external_ai_weights: '', external_ai_enabled: false };
const save = values => writeFile(configFile, JSON.stringify({ training: { ...config, ...values } }));
const apps = [];
async function open(options = {}) {
  const app = await createApplication({ dataDir: join(folder, 'rooms-' + apps.length),
    models: { runsDir: join(folder, 'no-models'), configFile, python }, external: { configFile, python, ...options } });
  apps.push(app);
  await new Promise(done => app.server.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${app.server.address().port}`;
}
async function request(base, path, input, expected = 200, headers = {}) {
  const response = await fetch(base + '/api/ai/' + path, { method: input === undefined ? 'GET' : 'POST',
    headers: { ...(input === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: input === undefined ? undefined : JSON.stringify(input), signal: AbortSignal.timeout(125_000) });
  const value = await response.json();
  assert.equal(response.status, expected, JSON.stringify(value));
  return value;
}
const wasm = await WasmEngine.fromBytes(await readFile('web/dist/engine.wasm'));
function call(input) { const response = wasm.call(input); assert.equal(response.ok, true, response.error); return response.value; }
try {
  await save({});
  const base = await open();
  assert.deepEqual((await request(base, 'models')).runs, [], 'USI play works without a learned model');
  const status = await request(base, 'external');
  assert.equal(status.available, true); assert.equal(status.nodes, 2000);
  assert.ok(!JSON.stringify(status).includes(folder), 'Status does not expose local paths');
  const loaded = await request(base, 'external/load', {});
  assert.match(loaded.engine, /^[a-f0-9]{24}$/); assert.equal(loaded.name, 'USI transport fixture');
  assert.equal(loaded.nodes, 2000); assert.equal(loaded.rules.version, PLAY_RULES.version);
  call({ cmd: 'new', rules: PLAY_RULES });
  const replay = call({ cmd: 'export' });
  execFileSync(python, ['-c', `
import importlib.abc, json, sys
class NoTorch(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, *args):
        if fullname.split('.')[0] == 'torch':
            raise ModuleNotFoundError('PyTorch is intentionally unavailable in this gameplay test')
sys.meta_path.insert(0, NoTorch())
from server.external_worker import Player
request = json.load(sys.stdin)
player = Player()
try:
    loaded = player.request(dict(request, cmd='load'))
    move = player.request(dict(request, cmd='choose', engine=loaded['engine'], side='B', seed=42))
    assert move['source'] == 'usi' and move['action']['to'] == [3, 4]
    assert 'torch' not in sys.modules
finally:
    player.close()
`], { input: JSON.stringify({ config, rules: replay.rules, replay }), encoding: 'utf8', windowsHide: true });
  const input = { engine: loaded.engine, side: 'B', seed: 42, replay };
  const chosen = await request(base, 'external/move', input);
  assert.equal(chosen.source, 'usi'); assert.equal(chosen.action.side, 'B'); assert.deepEqual(chosen.action.to, [3, 4]);
  const aMove = await request(base, 'external/move', { ...input, side: 'A' });
  assert.equal(aMove.source, 'usi'); assert.deepEqual(aMove.action.to, [7, 6]);
  call({ cmd: 'submit', side: 'A', action: aMove.action });
  assert.deepEqual(call({ cmd: 'export' }), replay, 'Pending human input stays private');
  assert.deepEqual((await request(base, 'external/move', { ...input, replay: call({ cmd: 'export' }) })).action, chosen.action);
  const resolved = call({ cmd: 'submit', side: 'B', action: chosen.action });
  assert.equal(resolved.round, 1);
  const nextReplay = call({ cmd: 'export' });
  const next = await request(base, 'external/move', { ...input, replay: nextReplay });
  assert.equal(next.round, 1); assert.equal(next.source, 'hunter', 'An incompatible USI move uses the existing adapter');
  assert.ok(call({ cmd: 'actions', side: 'B' }).some(option => isDeepStrictEqual(option.action, next.action)));
  const corrupt = structuredClone(nextReplay); corrupt.rounds[0].afterHash = '0'.repeat(64);
  await request(base, 'external/move', { ...input, replay: corrupt }, 422);
  assert.deepEqual((await request(base, 'external/move', { ...input, replay: nextReplay })).action, next.action, 'A rejected replay can be retried');
  await request(base, 'external/move', { ...input, engine: '../../engine' }, 400);
  await request(base, 'external/move', { ...input, engine: '0'.repeat(24) }, 404);
  await request(base, 'external/move', { ...input, seed: -1 }, 400);
  await request(base, 'external/move', { ...input, side: 'C' }, 400);
  await request(base, 'external/move', { ...input, replay: { ...replay, rules: { ...replay.rules, roundLimit: 2 } } }, 422);
  await request(base, 'external/load', {}, 403, { Origin: 'https://untrusted.example' });
  const forbidden = await new Promise((done, reject) => {
    const req = httpRequest(base + '/api/ai/external', { headers: { Host: 'untrusted.example' } }, response => { response.resume(); done(response.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(forbidden, 403);
  await save({ external_ai_nodes: 100 });
  const changed = await request(base, 'external/load', {});
  assert.notEqual(changed.engine, loaded.engine); assert.equal(changed.nodes, 100);
  assert.equal((await request(base, 'external/move', input)).nodes, 2000, 'A running game keeps its engine and search budget');
  await save({ external_ai_command: [join(folder, 'missing-engine.exe')] });
  const missing = await request(base, 'external');
  assert.equal(missing.available, false); assert.match(missing.reason, /既存AIを準備/);
  await request(base, 'external/load', {}, 422);
  assert.equal((await request(base, 'external/move', input)).source, 'usi', 'Unavailable new settings do not replace a running opponent');
  await save({ external_ai_command: [...config.external_ai_command, '--stall'], external_ai_timeout: 1 });
  const stalled = await request(base, 'external/load', {});
  assert.match((await request(base, 'external/move', { ...input, engine: stalled.engine }, 422)).error, /bestmove/);
  await save({});
  assert.equal((await request(base, 'external/load', {})).engine, loaded.engine);
  assert.equal((await request(base, 'external/move', input)).source, 'usi', 'A timed-out engine is closed before retry');
  const noPython = await open({ python: join(folder, 'missing-python.exe') });
  await request(noPython, 'external', undefined, 503);
  if (process.argv.includes('--real')) {
    const real = await open({ configFile: join(folder, 'default-config.json') });
    assert.equal((await request(real, 'external')).available, true);
    const engine = await request(real, 'external/load', {});
    for (const side of ['A', 'B']) {
      const move = await request(real, 'external/move', { ...input, engine: engine.engine, side });
      call({ cmd: 'new', rules: PLAY_RULES });
      assert.equal(move.source, 'usi');
      assert.ok(call({ cmd: 'actions', side }).some(option => isDeepStrictEqual(option.action, move.action)), JSON.stringify(move));
    }
    console.log(`Real USI gameplay passed: ${engine.label}, ${engine.nodes} nodes, both sides.`);
  }
  console.log('External-AI gameplay passed: no learned model, both sides, public-only input, native legality and replay verification, pinned budget, USI fallback, retries, missing files/Python, local access and shutdown.');
} finally {
  await Promise.all(apps.map(app => app.close()));
}
