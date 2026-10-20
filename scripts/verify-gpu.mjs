import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createDashboard, root } from '../dashboard/server.mjs';

const cache = join(root, '.cache/gpu-tests');
await mkdir(cache, { recursive: true });
const temp = await mkdtemp(join(cache, 'test-'));
const app = await createDashboard({ runsDir: join(temp, 'runs'), configFile: join(temp, 'local.json') });
await new Promise(ready => app.server.listen(0, '127.0.0.1', ready));
const base = `http://127.0.0.1:${app.server.address().port}`;
const api = async (path, input) => {
  const response = await fetch(base + path, input === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  const data = await response.json();
  assert.ok(response.ok, JSON.stringify(data));
  return data;
};
async function until(test, label, seconds = 240) {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    const state = await api('/api/state');
    if (state.last_job?.code && !state.job) throw new Error(state.logs.join('\n'));
    if (test(state)) return state;
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error(`Timed out: ${label}`);
}
try {
  const runtime = await api('/api/runtime');
  assert.equal(runtime.cuda_available, true, JSON.stringify(runtime));
  console.log(`CUDA operation verified: ${runtime.gpu}, torch ${runtime.torch}.`);
  await api('/api/settings', { training: { device: 'cuda', amp: true, generations: 2, games_per_generation: 2,
    environments: 2, workers: 2, candidates: 2, cheap_candidates: 2, batch_size: 8, updates: 2, eval_pairs: 1, eval_every: 2 } });
  await api('/api/start', { mode: 'local' });
  const initialized = await until(s => s.selected?.manifest.generation === 0, 'GPU initialization');
  assert.equal(initialized.selected.manifest.hardware.device, 'cuda');
  assert.equal(initialized.selected.manifest.rules.roundLimit, 200);
  await api('/api/stop', {});
  const stopped = await until(s => !s.job && s.selected?.status.phase === 'stopped', 'GPU stop');
  const run = stopped.selected.id;
  assert.equal(stopped.selected.manifest.generation, 0);
  console.log('Local GPU start, durable G0 and graceful stop verified.');
  await api('/api/resume', { run, device: 'cuda' });
  const finished = await until(s => !s.job && s.selected?.status.phase === 'complete', 'GPU generations');
  assert.equal(finished.selected.history.length, 2);
  assert.ok(finished.selected.history.every(r => r.hardware.device === 'cuda' && Number.isFinite(r.optimization.policy_loss)));
  assert.equal(finished.selected.manifest.last_hardware.device, 'cuda');
  const runs = join(temp, 'runs');
  const { readdir } = await import('node:fs/promises');
  const folder = join(runs, (await readdir(runs))[0]);
  const python = process.platform === 'win32' ? join(root, '.venv/Scripts/python.exe') : join(root, '.venv/bin/python');
  const script = [
    'import sys,torch,json',
    'from pathlib import Path',
    'p=Path(sys.argv[1])',
    'a=torch.load(p/"checkpoints/g0000.pt",map_location="cpu",weights_only=True)',
    'b=torch.load(p/"checkpoints/g0002.pt",map_location="cpu",weights_only=True)',
    'assert b["cuda_rng"] and b["scaler"]',
    'assert all(torch.isfinite(v).all() for v in b["model"].values())',
    'assert any(not torch.equal(v,b["model"][k]) for k,v in a["model"].items())',
    'print("CUDA AMP optimizer updated real weights; finite checkpoint and CUDA RNG/scaler saved.")'
  ].join('\n');
  console.log(execFileSync(python, ['-c', script, folder], { encoding: 'utf8' }).trim());
  console.log('Two official-rule generations, all paired evaluations and saved-G0 CUDA resume passed.');
  await mkdir(join(root, 'artifacts'), { recursive: true });
  const report = { runtime, generations: finished.selected.history.map(r => ({ generation: r.generation, seconds: r.seconds,
    rounds: r.self_play.rounds, optimization: r.optimization, device: r.hardware.device })), verified: new Date().toISOString() };
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(root, 'artifacts/gpu-validation.json'), JSON.stringify(report, null, 2));
  await api('/api/start', { mode: 'local' });
  await app.close();
  const closedRun = (await readdir(runs)).find(name => name !== folder.split(sep).at(-1));
  assert.ok(closedRun);
  assert.equal(JSON.parse(await readFile(join(runs, closedRun, 'status.json'), 'utf8')).phase, 'stopped');
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(join(runs, closedRun, 'RUNNING')), false);
  console.log('Closing the window waits for GPU trainer cleanup and removes its running lock.');
} finally {
  await app.close();
  assert.ok(resolve(temp).startsWith(resolve(cache) + sep));
  await rm(temp, { recursive: true, force: true });
}
