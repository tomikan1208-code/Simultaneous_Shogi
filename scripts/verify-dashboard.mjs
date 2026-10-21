import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { isDeepStrictEqual } from 'node:util';
import { Window } from 'happy-dom';
import { createDashboard, sourceFingerprint, root } from '../dashboard/server.mjs';

const cache = join(root, '.cache/dashboard-tests');
await mkdir(cache, { recursive: true });
const temporary = await mkdtemp(join(cache, 'test-'));
await writeFile(join(temporary, 'local.json'), JSON.stringify({ source_dir: '', training: { device: 'cuda', generations: 0 } }));
const app = await createDashboard({ runsDir: join(temporary, 'runs'), configFile: join(temporary, 'local.json') });
await new Promise(resolveReady => app.server.listen(0, '127.0.0.1', resolveReady));
const base = `http://127.0.0.1:${app.server.address().port}`;
const python = process.platform === 'win32' ? join(root, '.venv/Scripts/python.exe') : join(root, '.venv/bin/python');
async function api(path, input) {
  // Synchronous Python fixtures block this shared server/client event loop;
  // do not reuse an idle connection across those long fixture builds.
  const response = await fetch(base + path, input === undefined ? { headers: { Connection: 'close' } } : { method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close' }, body: JSON.stringify(input) });
  return { status: response.status, data: await response.json() };
}
async function until(check, label, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = (await api('/api/state')).data;
    if (check(result)) return result;
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out: ${label}`);
}
let ui = null, window = null;
try {
  const initial = (await api('/api/state')).data;
  assert.equal(initial.runs.length, 0);
  assert.equal(initial.selected, null);
  assert.equal(initial.settings.training.generations, 0, 'New runs default to continuous training');
  assert.equal(initial.settings.training.value_batch_size, 256, 'The default trainer uses the accelerated value batch');
  assert.equal((await api('/api/settings', { training: { value_batch_size: 0 } })).status, 400);
  const configured = await api('/api/settings', { training: { value_batch_size: 128 } });
  assert.equal(configured.status, 200);
  assert.equal((await api('/api/state')).data.settings.training.value_batch_size, 128);
  const fingerprint = execFileSync(python, ['-c', 'from training.common import fingerprint; print(fingerprint())'], { cwd: root, encoding: 'utf8' }).trim();
  assert.equal(await sourceFingerprint(), fingerprint, 'Python and Node source identity must match');
  assert.equal((await api('/api/settings', { source_dir: '../bad' })).status, 400);
  const crossOrigin = await fetch(base + '/api/start', { method: 'POST', headers: { Origin: 'https://example.com', 'Content-Type': 'application/json' }, body: '{"mode":"smoke"}' });
  assert.equal(crossOrigin.status, 403);
  const spoofedHostStatus = await new Promise((resolveStatus, reject) => {
    const req = httpRequest(base + '/api/state', { headers: { Host: `evil.example:${app.server.address().port}` } }, res => { res.resume(); resolveStatus(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(spoofedHostStatus, 403);
  const bundle = await fetch(base + '/api/bundle');
  assert.equal(bundle.status, 200);
  const bundlePath = join(temporary, 'source.zip');
  await writeFile(bundlePath, Buffer.from(await bundle.arrayBuffer()));
  const names = JSON.parse(execFileSync(python, ['-c', 'import zipfile,json,sys; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))', bundlePath], { encoding: 'utf8' }));
  assert.ok(names.includes('training/colab.ipynb'));
  assert.ok(names.includes('crates/shogi-core/src/resolution.rs'));
  assert.ok(!names.some(n => /credentials|token|\.git\/|\.venv\/|runs\//.test(n)));
  console.log('Source identity, ZIP contract, empty state and local API origin checks passed.');

  assert.equal((await api('/api/start', { mode: 'smoke' })).status, 202);
  assert.equal((await api('/api/start', { mode: 'smoke' })).status, 409);
  assert.equal((await api('/api/stop', {})).status, 200);
  const stopped = await until(s => !s.job && s.selected?.status.phase === 'stopped', 'graceful stop');
  assert.equal(stopped.selected.manifest.generation, 0);
  const runId = stopped.selected.id;
  await api('/api/settings', { training: { generations: 1, games_per_generation: 2,
    environments: 2, workers: 1, candidates: 3, cheap_candidates: 2, batch_size: 8, updates: 2,
    eval_pairs: 1, eval_every: 5 } });
  assert.equal((await api('/api/resume', { run: runId, device: 'cpu' })).status, 202);
  const finished = await until(s => !s.job && s.selected?.status.phase === 'complete', 'resume through evaluation');
  assert.equal(finished.selected.manifest.generation, 1);
  assert.equal(finished.selected.history.length, 1);
  assert.equal(finished.selected.history[0].evaluation.length, 1);
  assert.equal(finished.selected.history[0].evaluation[0].opponent, 'adapted_self');
  assert.equal(finished.selected.history[0].promoted, false, 'Short smoke limits cannot promote a champion');
  assert.equal(finished.selected.compatible, true);
  assert.equal(finished.selected.source_snapshot, true);
  const sourceSnapshot = await fetch(base + `/api/source-snapshot?run=${runId}`);
  assert.equal(sourceSnapshot.status, 200);
  const snapshotPath = join(temporary, 'snapshot.zip');
  await writeFile(snapshotPath, Buffer.from(await sourceSnapshot.arrayBuffer()));
  const restoredSourceHash = execFileSync(python, ['-c', 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2]); sys.path.insert(0,sys.argv[2]); from training.common import fingerprint; print(fingerprint())', snapshotPath, join(temporary, 'snapshot-source')], { cwd: temporary, encoding: 'utf8' }).trim();
  assert.equal(restoredSourceHash, fingerprint, 'A source snapshot must reproduce the training source identity');
  console.log('Actual CPU training: immediate stop, durable G0, resume, optimizer update and learned-only paired evaluation passed.');

  const file = finished.selected.artifacts.find(n => n.startsWith('games/'));
  assert.ok(file);
  const replay = await api(`/api/replay?run=${runId}&file=${encodeURIComponent(file)}&round=1`);
  assert.equal(replay.status, 200);
  assert.equal(replay.data.verified, true);
  assert.ok(replay.data.resolution.frames.length > 0);
  assert.equal((await api(`/api/artifact?run=${runId}&file=../../package.json`)).status, 404);
  assert.equal((await api('/api/evaluate', { run: runId, opponent: 'hunter', pairs: 0 })).status, 400);
  assert.equal((await api('/api/evaluate', { run: runId, opponent: 'hunter', pairs: 1 })).status, 202);
  const evaluated = await until(s => !s.job && s.selected?.local_evaluations.length === 1, 'local checkpoint evaluation');
  assert.equal(evaluated.last_job.code, 0);
  assert.equal((await api('/api/probe', { run: runId, file, round: 1 })).status, 202);
  const probed = await until(s => !s.job && s.selected?.artifacts.some(n => n.startsWith('probes/local-')), 'wider counterfactual search');
  assert.equal(probed.last_job.code, 0);
  const savedProbePath = probed.selected.artifacts.find(n => n.startsWith('probes/local-'));
  const savedProbe = (await api(`/api/artifact?run=${runId}&file=${encodeURIComponent(savedProbePath)}`)).data;
  for (const side of [0, 1]) assert.ok(savedProbe.candidates[side].some(action => isDeepStrictEqual(action, savedProbe.actual_actions[side])), 'The actual replay action must be analyzed even when excluded from the network shortlist');
  console.log('Verified replay, range validation, local model evaluation and wider 16×16 analysis passed.');

  const exported = await fetch(base + `/api/export?run=${runId}`);
  assert.equal(exported.status, 200);
  const resultsBytes = await exported.arrayBuffer();
  const imported = await fetch(base + '/api/import', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: resultsBytes });
  assert.equal(imported.status, 201, await imported.text());
  const both = (await api('/api/state')).data;
  assert.equal(both.runs.length, 2);
  assert.ok(both.runs.every(r => r.compatible));
  console.log('Artifact ZIP export/import restored the actual model, numeric replay and provenance.');

  window = new Window({ url: base, settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true, enableFileSystemHttpRequests: false } });
  for (const name of ['document', 'location', 'history', 'MouseEvent']) globalThis[name] = window[name];
  globalThis.window = window;
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = (path, options) => nativeFetch(new URL(path, base), options);
  window.document.write(await readFile(join(root, 'dashboard/web/index.html'), 'utf8'));
  ui = await import('../dashboard/web/app.js');
  ui.stopPolling();
  const $ = id => window.document.getElementById(id);
  assert.ok($('kpis').textContent.includes('自己対戦'));
  assert.equal($('generationTable').querySelectorAll('tr').length, 1);
  assert.equal($('strengthChart').querySelectorAll('svg').length, 0,'G1 has no learned reference opponent yet');
  assert.equal($('roundsChart').querySelectorAll('svg').length, 1);
  assert.equal($('drawChart').querySelectorAll('svg').length, 1);
  assert.equal($('evaluateButton').disabled, false);
  for (const tab of ['evaluation', 'analysis', 'colab', 'research', 'charts', 'overview']) {
    window.document.querySelector(`.nav-item[data-view="${tab}"]`).click();
    assert.equal($(`view-${tab}`).hidden, false);
    assert.equal(window.document.querySelectorAll('.view:not([hidden])').length, 1);
  }
  $('settingsBtn').click();
  assert.equal($('settingsPanel').hidden, false);
  assert.equal($('deviceInput').value, 'cuda');
  $('deviceInput').value = 'cpu';
  $('trainingForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  for (let i = 0; i < 100 && !$('settingsPanel').hidden; i++) await new Promise(r => setTimeout(r, 30));
  assert.equal($('settingsPanel').hidden, true);
  assert.equal((await api('/api/state')).data.settings.training.device, 'cpu');
  $('settingsBtn').click(); $('settingsClose').click();
  assert.equal($('settingsPanel').hidden, true);
  assert.equal((await api('/api/settings', { training: { generations: 0 } })).status, 200);
  assert.equal((await api('/api/settings', { training: { generations: -1 } })).status, 400);
  assert.equal((await api('/api/settings', { training: { device: 'invalid' } })).status, 400);
  assert.equal((await api('/api/start', { mode: 'local', training: { candidates: 2, cheap_candidates: 8 } })).status, 400);
  $('replaySelect').value = file;
  $('replaySelect').dispatchEvent(new window.Event('change'));
  for (let i = 0; i < 100 && !$('board').querySelector('.shogi-board'); i++) await new Promise(r => setTimeout(r, 30));
  assert.equal($('board').querySelectorAll('.board-cell').length, 81);
  assert.ok($('board').querySelectorAll('.piece').length > 0);
  assert.ok($('replayVerified').textContent.includes('検証済み'));
  assert.equal($('probeButton').disabled, false);
  const probeFile = probed.selected.artifacts.find(n => n.startsWith('probes/local-'));
  $('probeSelect').value = probeFile;
  $('probeSelect').dispatchEvent(new window.Event('change'));
  for (let i = 0; i < 100 && !$('probeDetails').querySelector('table'); i++) await new Promise(r => setTimeout(r, 30));
  assert.ok($('probeDetails').textContent.includes('候補内の最適応答差'));
  assert.ok($('probeDetails').querySelectorAll('td').length > 0);
  const fetchBeforeDelay = globalThis.fetch;
  let releaseReplay;
  globalThis.fetch = (path, options) => String(path).startsWith('/api/replay?')
    ? new Promise(resolveDelayed => { releaseReplay = async () => resolveDelayed(await fetchBeforeDelay(path, options)); })
    : fetchBeforeDelay(path, options);
  $('replaySelect').dispatchEvent(new window.Event('change'));
  assert.equal(typeof releaseReplay, 'function');
  const otherRun = [...$('runSelect').options].find(o => o.value !== $('runSelect').value);
  $('runSelect').value = otherRun.value;
  $('runSelect').dispatchEvent(new window.Event('change'));
  for (let i = 0; i < 100 && $('replayVerified').textContent !== '未選択'; i++) await new Promise(r => setTimeout(r, 30));
  assert.equal($('replayVerified').textContent, '未選択');
  assert.equal($('board').querySelector('.shogi-board'), null, 'Changing runs must clear the previous replay');
  assert.equal($('replaySelect').value, '');
  await releaseReplay();
  await new Promise(r => setTimeout(r, 100));
  assert.equal($('board').querySelector('.shogi-board'), null, 'A delayed old-run response must not repaint the new run');
  globalThis.fetch = fetchBeforeDelay;
  const previousRun = $('runSelect').value;
  await api('/api/settings', { training: { device: 'cpu', generations: 0, games_per_generation: 2,
    environments: 2, workers: 1, candidates: 2, cheap_candidates: 2, batch_size: 8, updates: 2, eval_pairs: 1 } });
  await ui.refresh();
  $('localStart').click();
  await until(s => s.job?.run && s.selected?.id === s.job.run, 'new run initialized');
  await ui.refresh();
  assert.notEqual($('runSelect').value, previousRun, 'Starting a run must follow new progress rather than the old selected run');
  assert.ok($('liveStatus').textContent.includes('停止まで継続'));
  assert.ok(!$('liveStatus').textContent.includes('0%'));
  $('stopJob').click();
  await until(s => !s.job, 'UI stop');
  await ui.refresh();
  assert.equal($('resumeButton').disabled, false, 'Stopped continuous runs remain resumable');
  await api('/api/settings',{training:{games_per_generation:4,environments:3,batch_size:16,updates:3,eval_pairs:2,eval_every:2}});
  const pending=(await api(`/api/state?run=${runId}`)).data.selected;
  assert.equal(pending.manifest.config.games_per_generation,2);
  assert.equal(pending.resume_config.games_per_generation,4);
  assert.equal(pending.resume_config.environments,3);
  assert.equal((await api('/api/resume',{run:runId,device:'cpu',until_generation:2})).status,202);
  const extended=await until(s=>!s.job&&s.selected?.manifest.generation===2,'extend completed finite run');
  assert.equal(extended.selected.manifest.parent.kind,'state_continuation');
  assert.equal(extended.selected.manifest.parent.generation,1);
  assert.equal(extended.selected.manifest.config.generations,0);
  assert.equal(extended.selected.manifest.config.games_per_generation,4);
  assert.equal(extended.selected.manifest.config.environments,3);
  assert.equal(extended.selected.history.at(-1).self_play.games,4);
  assert.equal(extended.selected.history.at(-1).optimization.updates,3);
  assert.equal(extended.selected.history.at(-1).optimization.presentations,48);
  assert.equal(extended.selected.history.at(-1).config.eval_pairs,2);
  assert.deepEqual(extended.selected.history.map(r=>r.generation),[1,2],'Continuation must retain earlier graph points');
  assert.equal(extended.selected.manifest.config.channels,8,'Model architecture is inherited, rather than replaced by global defaults');
  assert.equal(extended.selected.manifest.config_history.at(-1).from_generation,2);
  const original=(await api(`/api/state?run=${runId}`)).data;
  assert.equal(original.selected.manifest.generation,1,'Extending a completed plan preserves its original record');
  assert.equal((await api('/api/continue',{run:runId,device:'cpu'})).status,202);
  const prepared=await until(s=>!s.job&&s.selected?.status.phase==='ready','prepare preserved training state');
  assert.equal(prepared.selected.manifest.generation,1,'Continuation keeps the committed generation number');
  assert.equal(prepared.selected.manifest.evaluation_protocol,'learned-only-v1');
  assert.equal(prepared.selected.manifest.parent.kind,'state_continuation');
  assert.equal(prepared.selected.manifest.config.games_per_generation,4);
  assert.equal((await api('/api/settings',{training:{generations:1}})).status,200);
  assert.equal((await api('/api/resume',{run:prepared.selected.id,device:'cpu'})).status,400,'An already reached generation limit must be explained');
  await api('/api/settings',{training:{generations:0}});

  // A synthetic saved-source run exercises the same migration used by existing user models.
  execFileSync(python,['-c',`
import contextlib,io,json,sys,zipfile,torch
from pathlib import Path
from training.common import load_config,read_json
from training.train import Trainer
from training.rules import balance_for
from training.launch import snapshot_fingerprint
folder=Path(sys.argv[1]);run=folder/'runs/archived-balanced';tree=folder/'old-source'
config=load_config(overrides=dict(generations=0,games_per_generation=2,environments=2,workers=1,candidates=2,cheap_candidates=2,regret_iterations=8,updates=1,batch_size=2,eval_pairs=1,eval_every=1,round_limit=2,channels=8,device='cpu',amp=False,bootstrap_weight=0,balance=balance_for('D+B2-C1'),balance_logging=True))
with contextlib.redirect_stdout(io.StringIO()):
    trainer=Trainer(run,config);trainer.train(2)
with zipfile.ZipFile(run/'source.zip') as archive:archive.extractall(tree)
runtime=tree/'training/runtime.py';runtime.write_bytes(runtime.read_bytes()+b'\\n# Archived API fixture.\\n')
expected=snapshot_fingerprint(tree)
with zipfile.ZipFile(run/'source.zip','w',zipfile.ZIP_DEFLATED) as archive:
    for file in tree.rglob('*'):
        if file.is_file():archive.write(file,file.relative_to(tree).as_posix())
for file in (run/'checkpoints').glob('*.pt'):
    saved=torch.load(file,map_location='cpu',weights_only=True);saved['source_fingerprint']=expected;torch.save(saved,file)
manifest=read_json(run/'manifest.json');manifest['source_fingerprint']=expected
(run/'manifest.json').write_text(json.dumps(manifest),encoding='utf-8')
`,temporary],{cwd:root,encoding:'utf8'});
  const scanned=(await api('/api/state')).data;
  const archived=scanned.runs.find(run=>run.name==='archived-balanced');
  assert.ok(archived);
  const before=(await api(`/api/state?run=${archived.id}`)).data.selected;
  assert.equal(before.compatible,false);
  assert.deepEqual(before.resume_config.balance,before.manifest.config.balance,'Global default rules must never overwrite the learned rules');
  assert.equal(before.resume_config.bootstrap_weight,0,'The removed bootstrap must stay disabled');
  await ui.refresh();
  $('runSelect').value=archived.id;$('runSelect').dispatchEvent(new window.Event('change'));
  for(let i=0;i<100&&$('runSelect').value!==archived.id;i++)await new Promise(r=>setTimeout(r,30));
  await ui.refresh();
  assert.equal($('resumeSettingsNotice').hidden,false);
  assert.ok($('resumeSettingsNotice').textContent.includes('4局／世代・同時3対局'));
  $('resumeUntil').value='3';
  $('resumeButton').click();
  const migrated=await until(s=>!s.job&&s.selected?.manifest.generation===3&&s.selected?.manifest.parent?.source_fingerprint===before.manifest.source_fingerprint,'saved-source resume with edited settings');
  assert.equal(migrated.last_job.code,0,JSON.stringify(migrated.logs));
  assert.notEqual(migrated.selected.id,archived.id);
  assert.equal(migrated.selected.manifest.config.games_per_generation,4);
  assert.equal(migrated.selected.manifest.config.environments,3);
  assert.equal(migrated.selected.history.at(-1).self_play.games,4);
  assert.deepEqual(migrated.selected.manifest.config.balance,before.manifest.config.balance);
  assert.equal(migrated.selected.manifest.initial_generation,0,'Changing budgets does not reset the learning lineage');
  assert.equal((await api(`/api/state?run=${archived.id}`)).data.selected.manifest.generation,2);
  await ui.refresh();
  assert.equal($('runSelect').value,migrated.selected.id,'Resume follows the new progress after saved-source migration');
  assert.equal($('resumeSettingsNotice').hidden,true);
  const fullArchive=await fetch(base+`/api/export?run=${migrated.selected.id}`);
  assert.equal(fullArchive.status,200);
  const fullBytes=await fullArchive.arrayBuffer();
  const ancestorPath=resolve(temporary,'runs','archived-balanced'),hiddenAncestor=resolve(temporary,'hidden-ancestor');
  assert.ok(ancestorPath.startsWith(resolve(temporary)+ (process.platform==='win32'?'\\':'/')));
  assert.ok(hiddenAncestor.startsWith(resolve(temporary)+ (process.platform==='win32'?'\\':'/')));
  await rename(ancestorPath,hiddenAncestor);
  const restored=await fetch(base+'/api/import',{method:'POST',headers:{'Content-Type':'application/zip'},body:fullBytes});
  assert.equal(restored.status,201,await restored.clone().text());
  const importedState=(await api('/api/state')).data;
  const importedRun=importedState.runs.find(run=>run.generation===3&&run.name===migrated.selected.manifest.name&&run.id!==migrated.selected.id);
  assert.ok(importedRun);
  const importedHistory=(await api(`/api/state?run=${importedRun.id}`)).data.selected;
  assert.deepEqual(importedHistory.history.map(row=>row.generation),[1,2,3],'ZIP keeps all graph data even when the original ancestor folder is unavailable');
  assert.equal(importedHistory.history[0].config.games_per_generation,2);
  assert.ok(importedHistory.artifacts.some(name=>name.includes('ancestor-')&&name.startsWith('games/')),'ZIP includes inherited replays');
  console.log('Saved UI settings apply to resumed and archived runs; actual games, updates, budget logs, rules and full-state lineage are preserved.');
  console.log('Completed finite plans extend into preserved-state runs, and continuation preparation keeps generation/optimizer/replay provenance.');
  console.log('DOM integration: all views, actual metrics/charts, verified 81-square replay, stage controls and matrix diagnostics passed.');
} finally {
  ui?.stopPolling();
  await window?.happyDOM.close();
  await app.close();
  const target = resolve(temporary);
  assert.ok(target.startsWith(resolve(cache) + (process.platform === 'win32' ? '\\' : '/')));
  await rm(target, { recursive: true, force: true });
}
