import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { isDeepStrictEqual } from 'node:util';
import { Window } from 'happy-dom';
import { createDashboard, sourceFingerprint, root } from '../dashboard/server.mjs';

const cache = join(root, '.cache/dashboard-tests');
await mkdir(cache, { recursive: true });
const temporary = await mkdtemp(join(cache, 'test-'));
const app = await createDashboard({ runsDir: join(temporary, 'runs'), configFile: join(temporary, 'local.json') });
await new Promise(resolveReady => app.server.listen(0, '127.0.0.1', resolveReady));
const base = `http://127.0.0.1:${app.server.address().port}`;
const python = process.platform === 'win32' ? join(root, '.venv/Scripts/python.exe') : join(root, '.venv/bin/python');
async function api(path, input) {
  const response = await fetch(base + path, input === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
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
  assert.equal((await api('/api/resume', { run: runId })).status, 202);
  const finished = await until(s => !s.job && s.selected?.status.phase === 'complete', 'resume through evaluation');
  assert.equal(finished.selected.manifest.generation, 1);
  assert.equal(finished.selected.history.length, 1);
  assert.equal(finished.selected.history[0].evaluation.length, 4);
  assert.equal(finished.selected.history[0].promoted, false, 'Short smoke limits cannot promote a champion');
  assert.equal(finished.selected.compatible, true);
  assert.equal(finished.selected.source_snapshot, true);
  const sourceSnapshot = await fetch(base + `/api/source-snapshot?run=${runId}`);
  assert.equal(sourceSnapshot.status, 200);
  const snapshotPath = join(temporary, 'snapshot.zip');
  await writeFile(snapshotPath, Buffer.from(await sourceSnapshot.arrayBuffer()));
  const restoredSourceHash = execFileSync(python, ['-c', 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2]); sys.path.insert(0,sys.argv[2]); from training.common import fingerprint; print(fingerprint())', snapshotPath, join(temporary, 'snapshot-source')], { cwd: temporary, encoding: 'utf8' }).trim();
  assert.equal(restoredSourceHash, fingerprint, 'A source snapshot must reproduce the training source identity');
  console.log('Actual CPU training: immediate stop, durable G0, resume, optimizer update and all four paired evaluations passed.');

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
  assert.equal($('strengthChart').querySelectorAll('svg').length, 1);
  assert.equal($('evaluateButton').disabled, false);
  for (const tab of ['evaluation', 'analysis', 'colab', 'research', 'overview']) {
    window.document.querySelector(`.nav-item[data-view="${tab}"]`).click();
    assert.equal($(`view-${tab}`).hidden, false);
    assert.equal(window.document.querySelectorAll('.view:not([hidden])').length, 1);
  }
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
  console.log('DOM integration: all views, actual metrics/charts, verified 81-square replay, stage controls and matrix diagnostics passed.');
} finally {
  ui?.stopPolling();
  await window?.happyDOM.close();
  await app.close();
  const target = resolve(temporary);
  assert.ok(target.startsWith(resolve(cache) + (process.platform === 'win32' ? '\\' : '/')));
  await rm(target, { recursive: true, force: true });
}
