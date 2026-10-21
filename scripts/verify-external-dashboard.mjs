import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { Window } from 'happy-dom';
import { createDashboard, root } from '../dashboard/server.mjs';
import { externalSeries, externalSummary } from '../dashboard/web/metrics.js';

const cache = join(root, '.cache/tests');
await mkdir(cache, { recursive: true });
const temporary = await mkdtemp(join(cache, 'external-dashboard-'));
const runs = join(temporary, 'runs'), source = join(runs, 'source'), settingsFile = join(temporary, 'settings.json');
const python = process.env.SHOGI_PYTHON || (existsSync(join(root, '.venv/Scripts/python.exe')) ? join(root, '.venv/Scripts/python.exe') : 'python3');
const config = { ...JSON.parse(await readFile(join(root, 'training/config.json'), 'utf8')),
  channels: 8, device: 'cpu', amp: false, workers: 1, environments: 2, games_per_generation: 4,
  round_limit: 2, candidates: 2, cheap_candidates: 2, regret_iterations: 8, batch_size: 2,
  updates: 1, eval_pairs: 1, eval_every: 1, history_fraction: 0, generations: 2,
  external_ai_enabled: true, external_ai_fraction: .5, external_ai_eval_pairs: 1,
  external_ai_command: [python, join(root, 'tests/fixtures/fake_usi.py')] };
await writeFile(settingsFile, JSON.stringify({ source_dir: '', training: config }));
execFileSync(python, ['-c', 'import sys,json; from training.train import Trainer; from pathlib import Path; c=json.loads(Path(sys.argv[2]).read_text())["training"]; t=Trainer(sys.argv[1],c);t.train(1)', source, settingsFile], { cwd: root, stdio: 'pipe', timeout: 60000 });
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const originalWeights = await hash(join(source, 'checkpoints/g0001.pt'));
const app = await createDashboard({ runsDir: runs, configFile: settingsFile });
await new Promise(done => app.server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${app.server.address().port}`;
const fetchOriginal = globalThis.fetch;
async function api(path, input) {
  const response = await fetchOriginal(base + path, input === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  return { status: response.status, data: await response.json() };
}
async function until(test, label) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const state = (await api('/api/state')).data;
    if (test(state)) return state;
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error(`Timeout: ${label}`);
}
let window, ui;
try {
  let state = (await api('/api/state')).data;
  const runId = state.selected.id;
  const trainingData = state.teacher_datasets.find(row => row.run === runId && row.phase === 'training');
  assert.ok(trainingData, 'Completed regular self-play is available as a dashboard dataset');
  assert.equal(trainingData.decisions, 2);
  assert.equal(trainingData.nodes, 2000);
  assert.equal(state.selected.manifest.evaluation_protocol, 'mixed-external-v1');
  for (const training of [{ external_ai_nodes: 0 }, { external_ai_nodes: true }, { external_ai_fraction: 1.1 }, { external_ai_eval_pairs: 0 }]) {
    assert.equal((await api('/api/settings', { training })).status, 400);
  }
  const wrongRules = state.teacher_datasets.find(row => row.rules_hash !== state.selected.manifest.rules_hash);
  if (wrongRules) assert.equal((await api('/api/distill', { run: runId, dataset: wrongRules.id, updates: 1 })).status, 409);
  assert.equal((await api('/api/distill', { run: runId, dataset: '../../teacher.jsonl', updates: 1 })).status, 400);
  assert.equal((await api('/api/evaluate', { run: runId, opponent: 'external_usi', pairs: 1, nodes: 3210 })).status, 202);
  assert.equal((await api('/api/distill', { run: runId, dataset: trainingData.id, updates: 1 })).status, 409, 'Concurrent training/evaluation/distillation must not share a run');
  state = await until(s => !s.job, 'external evaluation');
  assert.equal(state.last_job.code, 0, state.logs.join('\n'));
  const evaluated = state.selected.local_evaluations.find(row => row.opponent === 'external_usi');
  assert.equal(evaluated.engine.nodes, 3210);
  assert.equal(evaluated.games, 2);
  assert.equal(evaluated.win_rate, 0);
  assert.equal(evaluated.score, .5);
  assert.ok(state.selected.local_evaluations.every(row => row.opponent), 'Teacher indexes are not mistaken for evaluation results');

  window = new Window({ url: `${base}/?run=${runId}`, settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true } });
  for (const name of ['document', 'location', 'history', 'MouseEvent']) globalThis[name] = window[name];
  globalThis.window = window;
  globalThis.fetch = (path, options) => fetchOriginal(new URL(path, base), options);
  window.document.write(await readFile(join(root, 'dashboard/web/index.html'), 'utf8'));
  ui = await import('../dashboard/web/app.js');
  ui.stopPolling();
  const $ = id => window.document.getElementById(id);
  assert.match($('externalSummary').textContent, /勝率 0\.0%/);
  assert.match($('externalSummary').textContent, /得点率 50\.0%/);
  assert.match($('externalOpponentTable').textContent, /定期評価/);
  assert.match($('externalOpponentTable').textContent, /学習中/);
  assert.equal($('externalChart').querySelectorAll('polyline.chart-line').length, 2);
  $('settingsBtn').click();
  assert.equal($('externalAIEnabled').checked, true);
  assert.equal(document.querySelector('[data-setting="external_ai_nodes"]').value, '2000');
  document.querySelector('[data-setting="external_ai_nodes"]').value = '4000';
  document.querySelector('[data-setting="external_ai_fraction"]').value = '25';
  $('trainingForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await until(s => s.settings.training.external_ai_nodes === 4000, 'dashboard node setting');
  for (let i = 0; i < 100 && !$('settingsPanel').hidden; i++) await new Promise(done => setTimeout(done, 30));
  state = (await api('/api/state')).data;
  assert.equal(state.settings.training.external_ai_fraction, .25);
  assert.equal(state.selected.resume_config.external_ai_nodes, 4000);
  $('evalOpponent').value = 'external_usi';
  $('evalOpponent').dispatchEvent(new window.Event('change'));
  assert.equal($('evalNodes').value, '4000');
  assert.equal($('evalNodes').disabled, false);
  $('distillDataset').value = trainingData.id;
  $('distillDataset').dispatchEvent(new window.Event('change'));
  $('distillUpdates').value = '1';
  assert.equal($('distillButton').disabled, false);
  $('distillForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  state = await until(s => !s.job && s.runs.some(row => row.id !== runId), 'dashboard distillation');
  assert.equal(state.last_job.code, 0, state.logs.join('\n'));
  assert.equal(await hash(join(source, 'checkpoints/g0001.pt')), originalWeights);
  const distilled = state.runs.find(row => row.id !== runId);
  const details = (await api(`/api/state?run=${distilled.id}`)).data.selected;
  assert.equal(details.manifest.generation, 1);
  assert.equal(details.manifest.external_distillation.evaluated, false);
  assert.equal(details.manifest.config.external_ai_nodes, 4000);
  assert.equal(details.manifest.config.external_ai_fraction, .25);
  const before = (await api(`/api/state?run=${runId}`)).data.selected.history[0];
  const changed = structuredClone(before);
  changed.generation++;
  changed.evaluation.find(row => row.opponent === 'external_usi').opponent_id = 'changed-budget';
  assert.equal(externalSeries([before, changed]).length, 4, 'Changed engine identities get separate curves');
  assert.equal(externalSummary([before, changed]).filter(row => row.phase === 'evaluation').length, 2);
  console.log('Dashboard external-AI settings, regular records, separate win/score curves, teacher catalog, configured-budget evaluation, and actual UI-driven distillation passed. Original weights and rule boundaries are preserved.');
} finally {
  ui?.stopPolling();
  await window?.happyDOM.close();
  globalThis.fetch = fetchOriginal;
  await app.close();
  assert.ok(resolve(temporary).startsWith(resolve(cache) + sep));
  await rm(temporary, { recursive: true, force: true });
}
