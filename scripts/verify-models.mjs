import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { mkdir, mkdtemp, readFile, stat, utimes } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createApplication } from '../server/app.mjs';
import { WasmEngine } from '../web/dist/engine.js';
import { PLAY_RULES } from '../web/dist/rules.js';

const artifacts = resolve('artifacts');
await mkdir(artifacts, { recursive: true });
const folder = await mkdtemp(join(artifacts, 'models-'));
const runsDir = join(folder, 'runs'), configFile = join(folder, 'no-local-config.json');
const python = process.env.SHOGI_PYTHON || (existsSync('.venv') ? resolve('.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python') : process.platform === 'win32' ? 'python' : 'python3');
execFileSync(python, ['-c', `
import json, sys
from pathlib import Path
import torch
from training.common import FORMAT, SCHEMA, load_config, rules_for, rules_hash
from training.model import Net
root = Path(sys.argv[1])
run = root / 'fixture'
(run / 'checkpoints').mkdir(parents=True)
config = load_config(overrides=dict(channels=8, candidates=3, cheap_candidates=2, regret_iterations=32, amp=False, device='cpu',balance=json.loads(sys.argv[2])))
rules = rules_for(config)
torch.manual_seed(42)
for generation in [0, 1]:
    model = Net(8)
    torch.save(dict(format=FORMAT, schema=SCHEMA, channels=8, generation=generation,
                    source_fingerprint='different-training-only-source', rules_hash=rules_hash(rules), model=model.state_dict()),
               run / 'checkpoints' / f'g{generation:04d}.pt')
(run / 'checkpoints/g0002.pt').write_bytes(b'corrupted checkpoint')
manifest = dict(format=FORMAT, schema=SCHEMA, name='Fixture learned model', rules=rules, config=config,
                latest_checkpoint='checkpoints/g0001.pt', champion_checkpoint='checkpoints/g0000.pt')
(run / 'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
old = root / 'incompatible'
(old / 'checkpoints').mkdir(parents=True)
(old / 'checkpoints/g0000.pt').write_bytes((run / 'checkpoints/g0000.pt').read_bytes())
manifest['name'] = 'Incompatible short run'
manifest['rules'] = dict(rules, roundLimit=12)
(old / 'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
`, runsDir, JSON.stringify(PLAY_RULES.balance)], { stdio: 'inherit', windowsHide: true });

const apps = [];
async function open(options = {}) {
  const app = await createApplication({ dataDir: join(folder, 'rooms-'+apps.length), models: { runsDir, configFile, python, ...options } });
  apps.push(app);
  await new Promise(done => app.server.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${app.server.address().port}`;
}
async function request(base, path, input, status = 200, headers = {}) {
  const response = await fetch(base+'/api/ai/'+path, { method: input === undefined ? 'GET' : 'POST',
    headers: { ...(input === undefined ? {} : {'Content-Type':'application/json'}), ...headers },
    body: input === undefined ? undefined : JSON.stringify(input), signal: AbortSignal.timeout(125_000) });
  const result = await response.json();
  assert.equal(response.status, status, `${path}: ${JSON.stringify(result)}`);
  return result;
}
const wasm = await WasmEngine.fromBytes(await readFile('web/dist/engine.wasm'));
function call(input) { const response = wasm.call(input); assert.equal(response.ok, true, response.error); return response.value; }
try {
  const base = await open();
  const catalogue = await request(base, 'models');
  assert.ok(!JSON.stringify(catalogue).includes(folder), 'The catalogue does not disclose filesystem paths');
  const run = catalogue.runs.find(item => item.compatible), incompatible = catalogue.runs.find(item => !item.compatible);
  assert.ok(run,'The fixture must use the actual gameplay rule profile');
  assert.equal(incompatible.compatible, false); assert.match(incompatible.reason, /ルール/);
  const latest = run.checkpoints.find(item => item.latest), champion = run.checkpoints.find(item => item.champion);
  assert.equal(latest.generation, 1); assert.equal(champion.generation, 0);
  const loaded = await request(base, 'load', {model:latest.id});
  assert.equal(loaded.model,latest.id); assert.equal(loaded.generation,1); assert.equal(loaded.rules.roundLimit,200);
  assert.ok(['cpu','cuda'].includes(loaded.device));
  assert.equal(typeof loaded.search_protocol,'string');
  call({cmd:'new',rules:PLAY_RULES});
  const replay = call({cmd:'export'});
  const input = {model:latest.id,side:'B',seed:42,replay};
  const chosen = await request(base,'move',input);
  assert.equal(chosen.search_protocol,loaded.search_protocol);
  assert.equal(chosen.round,0); assert.equal(chosen.action.side,'B');
  assert.deepEqual((await request(base,'move',input)).action,chosen.action,'The same public history and seed produce the same move');
  call({cmd:'submit_ai',side:'A',policy:'hunter',seed:1});
  assert.deepEqual(call({cmd:'export'}),replay,'A human commitment is absent from the exported public replay');
  assert.deepEqual((await request(base,'move',{...input,replay:call({cmd:'export'})})).action,chosen.action,'Inference cannot observe the human commitment');
  const resolved = call({cmd:'submit',side:'B',action:chosen.action});
  assert.equal(resolved.round,1);
  const nextReplay = call({cmd:'export'}), corrupt = structuredClone(nextReplay);
  corrupt.rounds[0].afterHash = 'tampered';
  await request(base,'move',{...input,replay:corrupt},422);
  const next = await request(base,'move',{...input,replay:nextReplay,side:'A'});
  assert.equal(next.round,1); assert.equal(next.action.side,'A');
  assert.ok(call({cmd:'actions',side:'A'}).some(item=>JSON.stringify(item.action)===JSON.stringify(next.action)));
  await request(base,'load',{model:run.checkpoints.find(item=>item.generation===2).id},422);
  assert.equal((await request(base,'load',{model:champion.id})).generation,0,'A bad checkpoint does not poison the worker');
  await request(base,'load',{model:'../../model.pt'},400);
  await request(base,'load',{model:'0'.repeat(24)},404);
  await request(base,'load',{model:incompatible.checkpoints[0].id},404);
  await request(base,'move',{...input,side:'C'},400);
  await request(base,'move',{...input,replay:{...replay,rules:{...replay.rules,version:'old'}}},422);
  const untrustedHost = await new Promise((done, reject) => {
    const req = httpRequest(base+'/api/ai/models', {headers:{Host:'untrusted.example'}}, response => { response.resume(); done(response.statusCode); });
    req.once('error',reject); req.end();
  });
  assert.equal(untrustedHost,403);
  await request(base,'load',{model:latest.id},403,{Origin:'https://untrusted.example'});
  await request(base,'move',{...input,padding:'x'.repeat(2*1024*1024)},413);
  assert.equal((await fetch(base+'/dashboard/runs/fixture/checkpoints/g0001.pt')).status,404);

  // Send a valid history larger than the ordinary room API's 16 KiB limit.
  let longReplay;
  for (let seed=1;seed<=8 && !longReplay;seed++) {
    call({cmd:'new',rules:PLAY_RULES});
    for (let round=0;round<90;round++) {
      call({cmd:'submit_ai',side:'A',policy:'random',seed:seed*1000+round*2});
      const view=call({cmd:'submit_ai',side:'B',policy:'random',seed:seed*1000+round*2+1});
      if (view.outcome) break;
      const candidate=call({cmd:'export'});
      if (Buffer.byteLength(JSON.stringify(candidate))>17_000) { longReplay=candidate; break; }
    }
  }
  assert.ok(longReplay,'A non-terminal long replay was generated');
  assert.equal((await request(base,'move',{...input,replay:longReplay})).round,longReplay.rounds.length);
  const file=join(runsDir,'fixture/checkpoints/g0001.pt'), original=await stat(file);
  await utimes(file,original.atime,new Date(original.mtimeMs+1000));
  await request(base,'load',{model:latest.id},409);
  const refreshed=await request(base,'models');
  const replacement=refreshed.runs.find(item=>item.compatible).checkpoints.find(item=>item.latest);
  assert.notEqual(replacement.id,latest.id,'A replaced file requires an explicit new selection');
  assert.equal((await request(base,'load',{model:replacement.id})).generation,1);

  const missing=await open({python:join(folder,'missing-python.exe')});
  await request(missing,'load',{model:replacement.id},503);
  console.log('Learned-model integration passed: real PyTorch/native inference, model/generation selection, seeded moves for both sides, public-only input, replay validation/recovery, long games, invalid models, local access, replaced files, optional Python and worker shutdown.');
} finally {
  await Promise.all(apps.map(app=>app.close()));
}
