import { createServer } from 'node:http';
import { readFile, writeFile, readdir, stat, mkdir, rename, unlink, realpath } from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cpus } from 'node:os';
import { resolve, dirname, relative, sep, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipFiles } from './zip.mjs';
import { readLineage, readGenerationHistory, lineageArtifact } from './history.mjs';

export const root = fileURLToPath(new URL('../', import.meta.url));
const web = join(root, 'dashboard/web'), localRuns = join(root, 'dashboard/runs'), cache = join(root, '.cache/dashboard');
const FORMAT = 'simultaneous-shogi/training-v1', SCHEMA = 'simultaneous-shogi/net-v1-54x24';
const schemas = new Set([SCHEMA, 'simultaneous-shogi/net-v2-62x24']);
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
const readJSON = async (path, fallback = null) => { try { return JSON.parse(await readFile(path, 'utf8')); } catch (e) { if (e.code === 'ENOENT' || e instanceof SyntaxError) return fallback; throw e; } };
const within = (base, file) => file === base || file.startsWith(base.endsWith(sep) ? base : base + sep);
const safeFile = name => !name.includes('..') && !name.includes('\\') && /^(games|probes|evidence|comparisons|evaluations|local-evaluations)\/[\w./-]+\.json$/.test(name);
const committed = (name, generation) => !/^(checkpoints|replay|generations|games|probes|evidence|comparisons|evaluations)\//.test(name) || !name.split('/').some(part => { const match = /^g(\d+)(?:[-.]|$)/.exec(part); return match && Number(match[1]) > generation; });

async function filesUnder(folder, depth = 5) {
  if (!existsSync(folder) || depth < 0) return [];
  const entries = await readdir(folder, { withFileTypes: true });
  const groups = await Promise.all(entries.slice(0, 10000).map(async entry => {
    if (entry.isSymbolicLink()) return [];
    const path = join(folder, entry.name);
    return entry.isDirectory() ? filesUnder(path, depth - 1) : [path];
  }));
  return groups.flat();
}
export async function codeFiles() {
  const paths = ['Cargo.toml', 'Cargo.lock', 'RULES.md'].map(n => join(root, n));
  paths.push(...(await filesUnder(join(root, 'crates'))).filter(p => p.endsWith('.rs') || p.endsWith('Cargo.toml')));
  paths.push(...(await filesUnder(join(root, 'training'))).filter(p => !p.includes('__pycache__') && /\.py$|\.json$|requirements\.txt$/.test(p)));
  return [...new Set(paths)].sort((a, b) => { const x = relative(root, a).split(sep).join('/'), y = relative(root, b).split(sep).join('/'); return x < y ? -1 : x > y ? 1 : 0; });
}
export async function sourceFingerprint() {
  const h = createHash('sha256');
  for (const path of await codeFiles()) {
    h.update(relative(root, path).split(sep).join('/')); h.update('\0');
    h.update((await readFile(path, 'utf8')).replaceAll('\r\n', '\n'));
  }
  return h.digest('hex');
}
async function binaryBody(req, maximum) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maximum) throw new HttpError(413, '送信サイズの上限を超えています。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'JSON形式で送信してください。');
  try {
    const value = JSON.parse((await binaryBody(req, 16384)).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch (e) { if (e.status) throw e; throw new HttpError(400, '入力を確認してください。'); }
}
function python() {
  const candidates = [process.env.SHOGI_PYTHON, join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
    process.platform === 'win32' && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs/Python/Python311/python.exe') : null];
  return candidates.find(p => p && existsSync(p)) || (process.platform === 'win32' ? 'python' : 'python3');
}
async function execute(command, args, input = '', timeout = 120000) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', oversized = false;
    const timer = setTimeout(() => { child.kill(); reject(new Error('処理がタイムアウトしました。')); }, timeout);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.stdout.on('data', data => { stdout += data; if (stdout.length > 32 * 1024 ** 2) { oversized = true; child.kill(); } });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-8000); });
    child.on('close', code => { clearTimeout(timer); code === 0 && !oversized ? resolveResult(stdout) : reject(new Error(stderr || `終了コード ${code}`)); });
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}

export async function createDashboard(options = {}) {
  const runRoot = options.runsDir ?? localRuns, configFile = options.configFile ?? join(root, 'dashboard/local.json');
  await mkdir(runRoot, { recursive: true }); await mkdir(cache, { recursive: true });
  const defaults = await readJSON(join(root, 'training/config.json'));
  let settings = { source_dir: '', training: { ...defaults, device: 'cuda' }, ...await readJSON(configFile, {}) };
  settings.training = { ...defaults, device: 'cuda', ...settings.training };
  let job = null, logs = [], lastJob = null, knownRuns = new Map(), closing = false;
  let runtimeCache = null, runtimeAt = 0, runtimePending = null, closePromise = null;
  async function runtime(force = false) {
    if (!runtimePending && (force || !runtimeCache || Date.now() - runtimeAt > 60000)) {
      runtimePending = execute(python(), ['-m', 'training.runtime'], '', 45000)
        .then(output => JSON.parse(output)).catch(error => ({ ready: false, cuda_available: false, error: error.message }))
        .then(value => { runtimeCache = value; runtimeAt = Date.now(); runtimePending = null; return value; });
    }
    return runtimePending || runtimeCache;
  }
  const editable = { generations: [0, 100000], games_per_generation: [2, 4096], environments: [1, 256], workers: [1, 32],
    candidates: [2, 32], cheap_candidates: [2, 32], batch_size: [2, 4096], value_batch_size: [1, 4096], updates: [1, 4096], eval_pairs: [1, 512], eval_every: [1, 100000],
    external_ai_nodes: [1, 100000000], external_ai_eval_pairs: [1, 512] };
  function trainingConfig(input, base = settings.training) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, '学習設定を確認してください。');
    const config = { ...defaults, ...base };
    for (const [key, value] of Object.entries(input)) {
      if (key in editable) {
        const [lo, hi] = editable[key];
        if (!Number.isInteger(value) || value < lo || value > hi) throw new HttpError(400, `${key}: ${lo}〜${hi}の整数を指定してください。`);
      } else if (key === 'device') { if (!['cpu', 'cuda', 'auto'].includes(value)) throw new HttpError(400, '実行デバイスを確認してください。'); }
      else if (['amp', 'external_ai_enabled', 'external_ai_save_teacher'].includes(key)) { if (typeof value !== 'boolean') throw new HttpError(400, '有効・無効の設定を確認してください。'); }
      else if (key === 'external_ai_fraction') { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new HttpError(400, '既存AIの対局割合は0〜100%で指定してください。'); }
      else throw new HttpError(400, `変更できない設定です: ${key}`);
      config[key] = value;
    }
    if (config.cheap_candidates > config.candidates) throw new HttpError(400, '通常候補数は最大候補数以下にしてください。');
    return config;
  }
  function continuationConfig(run, device = settings.training.device) {
    // Apply only the controls exposed by the settings panel. Rules, network shape,
    // replay policy and the removed bootstrap opponents belong to the saved run.
    const values = Object.fromEntries([...Object.keys(editable), 'amp', 'external_ai_enabled', 'external_ai_fraction', 'external_ai_save_teacher'].map(key => [key, settings.training[key]]));
    return trainingConfig({ ...values, device }, run.manifest.config);
  }
  async function checkDevice(device) {
    const info = await runtime();
    if (!info.ready) throw new HttpError(409, '学習環境を確認してください。dashboard/setup-gpu.bat でセットアップできます。');
    if (device === 'cuda' && !info.cuda_available) throw new HttpError(409, 'GPUを使用できません。dashboard/setup-gpu.bat を実行するか、設定でCPUを選択してください。');
  }
  function externalAvailability(config = settings.training) {
    const command = config.external_ai_command || [];
    const executable = command[0] || join(root, '.cache/external-shogi/yaneuraou/NNUE_halfkp_256x2_32_32/YaneuraOu_NNUE_halfkp_256x2_32_32-V900Git_AVX2.exe');
    const weights = config.external_ai_weights || (!command.length ? join(root, '.cache/external-shogi/tanuki/eval/nn.bin') : null);
    return { available: existsSync(executable) && (!weights || existsSync(weights)), nodes: config.external_ai_nodes ?? 2000 };
  }
  function checkExternal(config) {
    if (config.external_ai_enabled && !externalAvailability(config).available) throw new HttpError(409, '既存AIの準備が必要です。scripts/setup-external-shogi.ps1 を実行するか、設定で既存AIとの対戦を無効にしてください。');
  }
  let datasetCache = [], datasetMap = new Map(), datasetSignature = '', datasetAt = 0;
  async function teacherDatasets(force = false) {
    const signature = [...knownRuns.values()].map(run => `${run.id}:${run.manifest.generation}`).join('|');
    if (!force && signature === datasetSignature && Date.now() - datasetAt < 10000) return datasetCache;
    const found = new Map();
    async function add(path, metadata, label, run = null) {
      if (!(metadata.decisions > 0) || !metadata.rules_hash) return;
      const canonical = await realpath(path).catch(() => null);
      if (!canonical || !(run ? within(run.dir, canonical) : within(join(root, '.cache/external-shogi/experiments'), canonical))) return;
      const info = await stat(canonical);
      const id = createHash('sha256').update(canonical).digest('hex').slice(0, 24);
      found.set(id, { id, path: canonical, metadata, name: label, run: run?.id,
        generation: metadata.generation ?? metadata.model?.generation ?? null, phase: metadata.phase || 'experiment',
        rules_hash: metadata.rules_hash, games: metadata.games, decisions: metadata.decisions,
        nodes: metadata.engine?.nodes ?? metadata.nodes_per_query ?? null, updated: info.mtimeMs / 1000 });
    }
    for (const run of knownRuns.values()) {
      for (const path of (await filesUnder(run.dir, 4)).filter(p => p.endsWith('-teacher.json'))) {
        const relativeName = relative(run.dir, path).split(sep).join('/');
        if (!committed(relativeName, run.manifest.generation)) continue;
        const summary = await readJSON(path);
        if (summary?.format !== 'simultaneous-shogi/usi-dataset-v1' || !summary.complete ||
            !/^[\w.-]+\.jsonl\.gz$/.test(summary.file || '') || summary.file.includes('..')) continue;
        await add(join(dirname(path), summary.file), summary,
          `${run.manifest.name} · G${summary.generation} ${summary.phase === 'training' ? '自己対戦' : '定期評価'}`, run);
      }
    }
    const experimentsRoot = join(root, '.cache/external-shogi/experiments');
    for (const entry of await readdir(experimentsRoot, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const directory = join(experimentsRoot, entry.name), environment = await readJSON(join(directory, 'environment.json'));
      const result = await readJSON(join(directory, 'result.json'));
      if (!environment || !result) continue;
      await add(join(directory, 'teacher.jsonl'), { ...environment, games: result.games, decisions: result.adapter?.usi_actions },
        `保存済み外部AI対局 · ${entry.name}`);
    }
    datasetMap = found;
    datasetCache = [...found.values()].sort((a, b) => b.updated - a.updated).map(({ path, metadata, ...item }) => item);
    datasetSignature = signature; datasetAt = Date.now();
    return datasetCache;
  }
  let fingerprintCache = null, fingerprintAt = 0;
  const currentFingerprint = async () => {
    if (!fingerprintCache || Date.now() - fingerprintAt > 10000) { fingerprintCache = await sourceFingerprint(); fingerprintAt = Date.now(); }
    return fingerprintCache;
  };
  async function scan() {
    const sources = [{ dir: runRoot, label: 'Local' }];
    if (settings.source_dir && resolve(settings.source_dir) !== resolve(runRoot)) sources.push({ dir: settings.source_dir, label: 'Drive / 同期フォルダー' });
    const found = new Map(), warnings = [];
    const fingerprint = await currentFingerprint();
    for (const source of sources) {
      let dirs;
      try {
        dirs = [source.dir, ...(await readdir(source.dir, { withFileTypes: true })).filter(e => e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith('.')).slice(0, 200).map(e => join(source.dir, e.name))];
      } catch { warnings.push(`同期フォルダーを読めません: ${source.dir}`); continue; }
      if (resolve(source.dir) === resolve(runRoot)) {
        for (const item of await experiments()) {
          for (const child of item.children) dirs.push(join(item.dir, child.directory));
        }
      }
      for (const dir of dirs) {
        const manifest = await readJSON(join(dir, 'manifest.json'));
        if (manifest?.format !== FORMAT || !schemas.has(manifest.schema)) continue;
        const canonical = await realpath(dir);
        const id = createHash('sha256').update(canonical).digest('hex').slice(0, 20);
        const status = await readJSON(join(canonical, 'status.json'), {});
        const resumable = existsSync(join(canonical,manifest.latest_checkpoint || 'missing')) &&
          existsSync(join(canonical,manifest.replay_file || 'missing')) && existsSync(join(canonical,manifest.rng_file || 'missing')) &&
          (manifest.source_fingerprint === fingerprint || existsSync(join(canonical,'source.zip')));
        found.set(id, { id, dir: canonical, manifest, status, source: source.label, compatible: manifest.source_fingerprint === fingerprint,resumable });
        if (job?.run?.dir === canonical) job.run.id = id;
      }
    }
    knownRuns = found;
    return { runs: [...found.values()].sort((a, b) => b.manifest.created - a.manifest.created), warnings };
  }
  async function select(id) {
    if (!knownRuns.has(id)) await scan();
    const run = knownRuns.get(id);
    if (!run) throw new HttpError(404, '実行記録が見つかりません。');
    return run;
  }
  async function experiments() {
    const base = join(runRoot, 'experiments');
    const entries = await readdir(base, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    const values = [];
    for (const entry of entries.filter(e => e.isDirectory() && !e.isSymbolicLink()).slice(0, 200)) {
      const dir = join(base, entry.name), manifest = await readJSON(join(dir, 'experiment.json'));
      if (manifest?.format !== 'simultaneous-shogi/balance-experiment-v1') continue;
      const children = await Promise.all(manifest.runs.map(async row => {
        const path = resolve(dir, row.directory);
        if (!within(resolve(dir, 'runs'), path)) throw new HttpError(400, '実験の保存先が不正です。');
        const child = await readJSON(join(path, 'manifest.json'));
        return { ...row, generation: child?.generation ?? 0, status: await readJSON(join(path, 'status.json'), {}) };
      }));
      values.push({ id: entry.name, dir, manifest, status: await readJSON(join(dir, 'status.json'), {}), report: await readJSON(join(dir, 'report.json')), children });
    }
    return values.sort((a, b) => b.manifest.created - a.manifest.created);
  }
  async function selectExperiment(id) {
    const result = (await experiments()).find(e => e.id === id);
    if (!result) throw new HttpError(404, '比較実験が見つかりません。');
    return result;
  }
  async function artifactIndex(run, lineage = null) {
    lineage ||= (await readLineage(run, [runRoot, settings.source_dir])).lineage;
    const index = new Map();
    for (const source of lineage.slice().reverse()) {
      const paths = await filesUnder(source.dir, 4);
      for (const path of paths) {
        const name = relative(source.dir, path).split(sep).join('/');
        if (safeFile(name) && committed(name, source.ceiling)) index.set(lineageArtifact(source, name), { path, directory: source.dir });
      }
    }
    return index;
  }
  async function artifacts(run) {
    return [...(await artifactIndex(run)).keys()].sort().reverse();
  }
  async function artifact(run, file) {
    const entry = safeFile(file) ? (await artifactIndex(run)).get(file) : null;
    if (!entry) throw new HttpError(404, '記録が見つかりません。');
    const path = await realpath(entry.path);
    if (!within(entry.directory, path)) throw new HttpError(400, '記録のパスが不正です。');
    return path;
  }
  async function details(run) {
    const { lineage, warnings } = await readLineage(run, [runRoot, settings.source_dir]);
    const [history, index] = await Promise.all([readGenerationHistory(lineage), artifactIndex(run, lineage)]);
    return { id: run.id, manifest: run.manifest, status: run.status, source: run.source, compatible: run.compatible,resumable:run.resumable,
      history, history_warnings: warnings, lineage: lineage.map(s => ({ id: s.id, name: s.manifest.name, generation: s.ceiling, inherited: s.inherited })),
      warm_start: run.manifest.parent?.kind === 'weights_only' ? {generation:run.manifest.parent.generation,
        run:[...knownRuns.values()].find(parent=>parent.dir===run.manifest.parent.run)?.id,
        different_rules:run.manifest.parent.rules_hash!==run.manifest.rules_hash} : null,
      resume_config: continuationConfig(run), artifacts: [...index.keys()].sort().reverse(), source_snapshot: existsSync(join(run.dir, 'source.zip')), local_evaluations: await Promise.all([...index.keys()].filter(n => /^local-evaluations\/[^/]+\/[^/]+\.json$/.test(n) && !n.includes('replay') && !n.includes('teacher') && !n.endsWith('environment.json')).slice(0, 20).map(n => readJSON(index.get(n).path))) };
  }
  function startJob(kind, command, args, run = null, onSuccess = null) {
    if (job) throw new HttpError(409, '別の処理を実行中です。完了か停止を待ってください。');
    logs = [];
    const child = spawn(command, args, { cwd: root, windowsHide: true, env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
    job = { kind, child, run, started: Date.now() / 1000 };
    const append = data => { logs.push(...data.toString('utf8').split(/\r?\n/).filter(Boolean)); logs = logs.slice(-120); };
    child.stdout.on('data', append); child.stderr.on('data', append);
    child.on('error', error => { logs.push(error.message); });
    child.on('close', async code => {
      lastJob = { kind, code, finished: Date.now() / 1000, run: run?.id };
      if (code === 0 && onSuccess) { try { await onSuccess(logs.join('\n')); } catch (e) { logs.push(e.message); lastJob.code = 1; } }
      job = null;
    });
    return { started: true, kind };
  }
  const binary = join(root, 'target/balance/release', process.platform === 'win32' ? 'shogi.exe' : 'shogi');
  const replayCache = new Map();
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      if (closing) throw new HttpError(503, '終了処理中です。');
      const host = req.headers.host || '', port = server.address()?.port;
      if (![ `localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}` ].includes(host)) throw new HttpError(403, 'ローカルから接続してください。');
      const url = new URL(req.url, `http://${host}`), path = url.pathname;
      if (req.headers.origin && req.headers.origin !== `http://${host}`) throw new HttpError(403, 'この接続元からは操作できません。');
      if (req.method === 'GET') {
        if (path === '/api/runtime') { json(res, 200, await runtime(url.searchParams.has('refresh'))); return; }
        if (path === '/api/generation') {
          const run = await select(url.searchParams.get('run')), generation = Number(url.searchParams.get('generation'));
          if (!Number.isInteger(generation) || generation < 1 || generation > run.manifest.generation) throw new HttpError(400, '保存済みの世代番号を指定してください。');
          const { lineage } = await readLineage(run, [runRoot, settings.source_dir]);
          const record = (await readGenerationHistory(lineage)).find(row => row.generation === generation);
          if (!record) throw new HttpError(404, 'この世代の保存記録が見つかりません。');
          res.setHeader('Content-Disposition', `attachment; filename="g${String(generation).padStart(4, '0')}.json"`);
          json(res, 200, record); return;
        }
        if (path === '/api/state') {
          const { runs, warnings } = await scan();
          const selected = runs.find(r => r.id === url.searchParams.get('run')) || runs[0];
          json(res, 200, { runs: runs.map(r => ({ id: r.id, name: r.manifest.name, source: r.source, generation: r.manifest.generation, rules_hash: r.manifest.rules_hash, compatible: r.compatible, phase: r.status.phase, round_limit: r.manifest.rules.roundLimit })),
            selected: selected ? await details(selected) : null, settings, warnings, experiments: await experiments(),
            teacher_datasets: await teacherDatasets(), external_ai: externalAvailability(),
            source_fingerprint: await currentFingerprint(), job: job ? { kind: job.kind, started: job.started, run: job.run?.id, device: job.device } : null,
            last_job: lastJob, logs, rules_version: (await readFile(join(root, 'crates/shogi-core/src/types.rs'), 'utf8')).match(/pub const RULE_VERSION: &str = "([^"]+)"/)?.[1], benchmark: await readJSON(join(runRoot, 'action-benchmark.json')) }); return;
        }
        if (path === '/api/artifact') {
          const run = await select(url.searchParams.get('run')), file = await artifact(run, url.searchParams.get('file') || '');
          json(res, 200, await readJSON(file)); return;
        }
        if (path === '/api/replay') {
          const run = await select(url.searchParams.get('run')), file = await artifact(run, url.searchParams.get('file') || '');
          const raw = await readJSON(file), replay = raw?.replay;
          const round = Number(url.searchParams.get('round') ?? 1);
          if (!replay || !Number.isInteger(round) || round < 1 || round > replay.rounds.length) throw new HttpError(400, '棋譜のラウンドを確認してください。');
          if (!existsSync(binary)) throw new HttpError(409, '棋譜検証には npm run ai:build を一度実行してください。');
          const stamp = (await stat(file)).mtimeMs, cacheKey = `${file}:${stamp}:${round}`;
          let result = replayCache.get(cacheKey);
          if (!result) {
            const lines = (await execute(binary, ['api'], [{ cmd: 'import', replay }, { cmd: 'replay_round', round }].map(r => JSON.stringify(r)).join('\n') + '\n')).trim().split(/\r?\n/).map(JSON.parse);
            if (!lines.every(r => r.ok)) throw new HttpError(422, lines.find(r => !r.ok).error);
            result = { verified: true, resolution: lines[1].value, record: replay.rounds[round - 1], rounds: replay.rounds.length, label: raw.label || file, rules: replay.rules };
            if (replayCache.size > 128) replayCache.clear(); replayCache.set(cacheKey, result);
          }
          json(res, 200, result); return;
        }
        if (path === '/api/bundle') {
          const files = await codeFiles();
          files.push(join(root, 'training/colab.ipynb'), join(root, 'training/README.md'));
          const zip = await zipFiles([...new Set(files)].filter(p => existsSync(p)).map(p => ({ name: relative(root, p).split(sep).join('/'), path: p })));
          res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="shogi-colab.zip"', 'Content-Length': zip.length }); res.end(zip); return;
        }
        if (path === '/api/source-snapshot') {
          const run = await select(url.searchParams.get('run'));
          const data = await readFile(join(run.dir, 'source.zip'));
          res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="shogi-colab.zip"', 'Content-Length': data.length }); res.end(data); return;
        }
        if (path === '/api/export') {
          const run = await select(url.searchParams.get('run'));
          const files = (await filesUnder(run.dir)).filter(p => /(?:^|[\\/])(?:manifest|status)\.json$|\.(?:pt|npz|json|jsonl\.gz)$|[\\/]source\.zip$/.test(p) && !p.endsWith('.tmp') && committed(relative(run.dir,p).split(sep).join('/'),run.manifest.generation));
          const entries = new Map(files.map(p => { const name=relative(run.dir,p).split(sep).join('/');return [name,{name,path:p}]; }));
          const {lineage}=await readLineage(run,[runRoot,settings.source_dir]);
          const [history,index]=await Promise.all([readGenerationHistory(lineage),artifactIndex(run,lineage)]);
          for(const row of history){const name=`generations/g${String(row.generation).padStart(4,'0')}.json`;entries.set(name,{name,data:Buffer.from(JSON.stringify(row))});}
          for(const [name,entry] of index)if(!entries.has(name))entries.set(name,{name,path:entry.path});
          const zip = await zipFiles([...entries.values()]);
          res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="shogi-results.zip"', 'Content-Length': zip.length }); res.end(zip); return;
        }
        if (path === '/api/experiment/export') {
          const item = await selectExperiment(url.searchParams.get('experiment'));
          if (job) throw new HttpError(409, '処理を停止または完了してから比較ログを保存してください。');
          const output = join(cache, `balance-${randomUUID()}.zip`);
          try {
            await execute(python(), ['-m', 'training.experiments', 'export', '--directory', item.dir, '--output', output], '', 600000);
            res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="shogi-balance-logs.zip"', 'Content-Length': (await stat(output)).size });
            await pipeline(createReadStream(output),res);
          } finally { await unlink(output).catch(() => {}); }
          return;
        }
        if (path === '/colab.ipynb') {
          const data = await readFile(join(root, 'training/colab.ipynb'));
          res.writeHead(200, { 'Content-Type': 'application/x-ipynb+json', 'Content-Disposition': 'attachment; filename="Simultaneous_Shogi_Colab.ipynb"' }); res.end(data); return;
        }
        if (path === '/api/research') { json(res, 200, await readJSON(join(root, 'training/research.json'), [])); return; }
        const allowed = { '/': 'index.html', '/app.js': 'app.js', '/metrics.js': 'metrics.js', '/style.css': 'style.css', '/icon.svg': 'icon.svg' };
        if (!allowed[path]) throw new HttpError(404, 'Not found');
        const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
        const file = allowed[path], data = await readFile(join(web, file));
        res.writeHead(200, { 'Content-Type': mime[file.slice(file.lastIndexOf('.'))], 'Cache-Control': 'no-cache' }); res.end(data); return;
      }
      if (req.method !== 'POST') throw new HttpError(405, '対応していない操作です。');
      if (path === '/api/import') {
        if (job) throw new HttpError(409, '実行中の処理が完了するまでお待ちください。');
        const data = await binaryBody(req, 256 * 1024 ** 2), temp = join(cache, `import-${randomUUID()}.zip`);
        await writeFile(temp, data);
        const dest = join(runRoot, `import-${Date.now()}`);
        try { await execute(python(), ['-m', 'training.transfer', 'import', '--run-dir', dest, '--archive', temp]); }
        finally { await unlink(temp); }
        json(res, 201, { imported: true }); return;
      }
      const input = await body(req);
      if (path === '/api/experiment/init') {
        if (job) throw new HttpError(409, '別の処理を実行中です。');
        const source = await select(input.run);
        const config = trainingConfig(input.training ?? {},{...defaults,...source.manifest.config,generations:0,
          device:settings.training.device,workers:settings.training.workers,amp:settings.training.amp,value_batch_size:settings.training.value_batch_size});
        const pairs = input.pairs ?? 512, parallel = input.parallel ?? 1;
        if (!Number.isInteger(pairs) || pairs < 1 || pairs > 4096 || !Number.isInteger(parallel) || parallel < 1 || parallel > 32) throw new HttpError(400, '対局ペア数・並列数を確認してください。');
        await checkDevice(config.device);
        if (job || closing) throw new HttpError(409, '別の処理を実行中です。');
        const dir = join(runRoot, 'experiments', `balance-${Date.now()}`), plan = join(cache, `balance-plan-${randomUUID()}.json`);
        await writeFile(plan, JSON.stringify({ training: config, short_pairs: pairs, long_pairs: pairs, max_parallel: parallel, ...(input.grid ? { grid: input.grid } : {}) }));
        json(res, 202, startJob('experiment_init', python(), ['-m', 'training.experiments', 'init', '--directory', dir, '--source-run', source.dir, '--plan', plan], { dir })); return;
      }
      if (path === '/api/experiment/run') {
        if (job) throw new HttpError(409, '別の処理を実行中です。');
        const item = await selectExperiment(input.experiment);
        if (!['short', 'train', 'long'].includes(input.stage)) throw new HttpError(400, '比較段階を選んでください。');
        const generations = input.generations ?? 0;
        if (!Number.isInteger(generations) || generations < 0 || generations > 100000) throw new HttpError(400, '世代数を確認してください。');
        await checkDevice(item.manifest.runs.length ? (await readJSON(join(item.dir, item.manifest.runs[0].config))).device : 'auto');
        if (job || closing) throw new HttpError(409, '別の処理を実行中です。');
        if (existsSync(join(item.dir, 'RUNNING'))) throw new HttpError(409, 'この比較実験は既に実行中です。');
        await unlink(join(item.dir, 'STOP')).catch(error => { if (error.code !== 'ENOENT') throw error; });
        const args=['-m','training.experiments','run','--directory',item.dir,'--stage',input.stage,'--generations',String(generations)];
        if (input.rule && input.rule !== 'all') {
          if (!item.children.some(child=>child.rule===input.rule)) throw new HttpError(400,'学習するルールを選んでください。');
          args.push('--rules',input.rule,'--parallel','1');
        }
        json(res, 202, startJob('experiment', python(),args, { dir: item.dir })); return;
      }
      if (path === '/api/settings') {
        const source = String(input.source_dir ?? settings.source_dir).trim();
        if (source && (!isAbsolute(source) || !(await stat(source).catch(() => null))?.isDirectory())) throw new HttpError(400, '存在する同期フォルダーの絶対パスを指定してください。');
        const nextTraining = input.training === undefined ? settings.training : trainingConfig(input.training);
        settings = { source_dir: source ? await realpath(source) : '', training: nextTraining };
        await mkdir(dirname(configFile), { recursive: true });
        await writeFile(`${configFile}.tmp`, JSON.stringify(settings)); await rename(`${configFile}.tmp`, configFile);
        json(res, 200, settings); return;
      }
      if (path === '/api/start') {
        if (job) throw new HttpError(409, '別の処理を実行中です。');
        if (input.mode === 'smoke') {
          const dir = join(runRoot, `local-test-${Date.now()}`);
          json(res, 202, startJob('training', python(), ['-m', 'training.train', '--run-dir', dir, '--smoke'], { dir })); return;
        }
        if (input.mode !== 'local') throw new HttpError(400, '学習モードを確認してください。');
        const config = trainingConfig(input.training ?? {});
        await checkDevice(config.device);
        checkExternal(config);
        if (job || closing) throw new HttpError(409, '別の処理を実行中、または終了処理中です。');
        const dir = join(runRoot, `local-${config.device}-${Date.now()}`), path = join(cache, `train-${randomUUID()}.json`);
        await writeFile(path, JSON.stringify(config));
        json(res, 202, startJob('training', python(), ['-m', 'training.train', '--run-dir', dir, '--config', path], { dir }));
        job.device = config.device; return;
      }
      if (path === '/api/continue') {
        if (job) throw new HttpError(409,'別の処理を実行中です。');
        const run=await select(input.run),device=input.device ?? settings.training.device;
        if (run.manifest.schema !== 'simultaneous-shogi/net-v2-62x24') throw new HttpError(409,'この旧形式は「ルール比較」から重みを引き継いでください。');
        if (!['cpu','cuda','auto'].includes(device)) throw new HttpError(400,'実行デバイスを確認してください。');
        await checkDevice(device);
        if (job || closing) throw new HttpError(409,'別の処理を実行中です。');
        const dir=join(runRoot,`continued-${Date.now()}`),config=join(cache,`continue-${randomUUID()}.json`);
        await writeFile(config,JSON.stringify(continuationConfig(run, device)));
        json(res,202,startJob('training',python(),['-m','training.train','--run-dir',dir,'--config',config,'--continue-from',run.dir,'--prepare-only'],{dir}));
        job.device=device;return;
      }
      if (path === '/api/stop') {
        if (!job) throw new HttpError(409, 'ローカル処理は実行されていません。');
        if (['training', 'experiment', 'distillation'].includes(job.kind)) { await mkdir(job.run.dir, { recursive: true }); await writeFile(join(job.run.dir, 'STOP'), 'requested from local dashboard'); }
        else job.child.kill();
        json(res, 200, { stopping: true }); return;
      }
      if (path === '/api/benchmark') {
        if (!existsSync(binary)) throw new HttpError(409, 'npm run ai:build を先に実行してください。');
        json(res, 202, startJob('benchmark', binary, ['bench-actions', '1000'], null, async output => {
          const value = JSON.parse(output.split('\n').find(line => line.startsWith('{')));
          value.source_fingerprint = await currentFingerprint(); value.cpu = cpus()[0]?.model; value.timestamp = Date.now() / 1000;
          await writeFile(join(runRoot, 'action-benchmark.json'), JSON.stringify(value, null, 2));
        })); return;
      }
      if (path === '/api/external/setup') {
        if (job) throw new HttpError(409, '学習・評価を停止してから既存AIを準備してください。');
        if (process.platform !== 'win32') throw new HttpError(400, '自動準備はWindows向けです。実行環境に対応したUSIエンジンを設定してください。');
        json(res, 202, startJob('external_setup', 'powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
          '-File', join(root, 'scripts/setup-external-shogi.ps1')])); return;
      }
      if (path === '/api/distill') {
        if (job) throw new HttpError(409, '学習・評価を停止してから蒸留を実行してください。');
        const source = await select(input.run);
        await teacherDatasets(true);
        const dataset = datasetMap.get(input.dataset);
        if (!dataset) throw new HttpError(400, '完了した対局の教師データを選択してください。');
        if (dataset.rules_hash !== source.manifest.rules_hash) throw new HttpError(409, '教師データと引き継ぐモデルのルールが異なります。');
        const updates = input.updates ?? 32, device = input.device ?? 'cpu';
        const checkpoint = input.checkpoint ?? 'latest';
        if (!Number.isInteger(updates) || updates < 1 || updates > 4096 || !['cpu', 'cuda'].includes(device) ||
            checkpoint !== 'latest' && (!Number.isInteger(checkpoint) || checkpoint < 0 || checkpoint > source.manifest.generation)) throw new HttpError(400, '更新回数・実行先・世代を確認してください。');
        await checkDevice(device);
        if (job || closing) throw new HttpError(409, '別の処理を実行中です。');
        const directory = join(runRoot, `distilled-${Date.now()}`), configPath = join(cache, `distill-${randomUUID()}.json`);
        await writeFile(configPath, JSON.stringify(continuationConfig(source, device)));
        json(res, 202, startJob('distillation', python(), ['-m', 'training.distill', '--data', dataset.path,
          '--init-from', source.dir, '--checkpoint', String(checkpoint), '--updates', String(updates),
          '--device', device, '--config', configPath, '--output', directory], { dir: directory }));
        job.device = device; return;
      }
      if (['/api/evaluate', '/api/probe', '/api/resume'].includes(path)) {
        if (job) throw new HttpError(409, '別のローカル処理を実行中です。');
        const run = await select(input.run);
        if (path !== '/api/resume' && !run.compatible) throw new HttpError(409, '学習時とソースが異なります。同じソース一式を使用してください。');
        if (path === '/api/evaluate') {
          if (!['adapted_self','recent_checkpoint','external_usi','hunter', 'defense', 'upgrade', 'random', 'champion'].includes(input.opponent) || !Number.isInteger(input.pairs) || input.pairs < 1 || input.pairs > 512) throw new HttpError(400, '対戦相手・評価ペア数を確認してください。');
          const args = ['-m', 'training.evaluate', '--run-dir', run.dir, '--opponent', input.opponent, '--pairs', String(input.pairs), '--device', 'cpu'];
          if (input.opponent === 'external_usi') {
            const nodes = input.nodes ?? settings.training.external_ai_nodes;
            if (!Number.isInteger(nodes) || nodes < 1 || nodes > 100000000) throw new HttpError(400, '既存AIのノード数を確認してください。');
            checkExternal({ ...run.manifest.config, external_ai_enabled: true });
            args.push('--nodes', String(nodes));
          }
          json(res, 202, startJob('evaluation', python(), args, run)); return;
        }
        if (path === '/api/probe') {
          const file = await artifact(run, String(input.file || ''));
          if (!Number.isInteger(input.round) || input.round < 1 || input.round > 100000) throw new HttpError(400, 'ラウンドを確認してください。');
          json(res, 202, startJob('probe', python(), ['-m', 'training.probe', '--run-dir', run.dir, '--replay', file, '--round', String(input.round), '--candidates', '16'], run)); return;
        }
        if (!run.resumable) throw new HttpError(409,'再開に必要なチェックポイント・リプレイ・保存ソースを確認してください。');
        const device = input.device ?? settings.training.device;
        if (!['cpu', 'cuda', 'auto'].includes(device)) throw new HttpError(400, '実行デバイスを確認してください。');
        await checkDevice(device);
        if (job || closing) throw new HttpError(409, '別の処理を実行中、または終了処理中です。');
        const target=input.until_generation ?? 0;
        if (!Number.isInteger(target) || target<0 || target>100000 || target>0 && target<=run.manifest.generation) throw new HttpError(400,'停止する世代は現在の世代より大きい値か0を指定してください。');
        const nextConfig = continuationConfig(run, device);
        checkExternal(nextConfig);
        if (nextConfig.generations && nextConfig.generations <= run.manifest.generation) throw new HttpError(400, '設定の世代数を現在の世代より大きい値か0（無制限）に変更してください。');
        if (target && nextConfig.generations && target > nextConfig.generations) throw new HttpError(400, '停止世代が設定の世代数を超えています。学習設定を確認してください。');
        const config = join(cache, `resume-${randomUUID()}.json`);
        await writeFile(config, JSON.stringify(nextConfig));
        const finished=run.manifest.config.generations>0 && run.manifest.generation>=run.manifest.config.generations;
        const changed = [...Object.keys(editable), 'device', 'amp', 'external_ai_enabled', 'external_ai_fraction', 'external_ai_save_teacher']
          .some(key => nextConfig[key] !== (run.manifest.config[key] ?? defaults[key]));
        let args,activeRun=run;
        if (finished || !run.compatible && changed) {
          if (run.manifest.schema !== 'simultaneous-shogi/net-v2-62x24') throw new HttpError(409, 'この旧形式は「ルール比較」から重みを引き継いでください。');
          const dir=join(runRoot,`continued-${Date.now()}`);
          args=['-m','training.train','--run-dir',dir,'--config',config,'--continue-from',run.dir];activeRun={dir};
        } else args=['-m','training.launch','--run-dir',run.dir,'--config',config,'--resume'];
        if (target) args.push('--until-generation',String(target));
        json(res, 202, startJob('training', python(),args,activeRun)); job.device = device; return;
      }
      throw new HttpError(404, '操作が見つかりません。');
    } catch (error) { if (res.headersSent) res.destroy(error); else json(res, error.status || 500, { error: error.message }); }
  });
  server.requestTimeout = 120000; server.headersTimeout = 15000;
  return { server, close() {
    if (closePromise) return closePromise;
    closePromise = (async () => {
    closing = true;
    if (job) {
      const child = job.child;
      if (['training', 'experiment', 'distillation'].includes(job.kind)) { await mkdir(job.run.dir, { recursive: true }); await writeFile(join(job.run.dir, 'STOP'), 'dashboard closed'); }
      else child.kill();
      // The trainer owns persistent native workers: wait for its cleanup before exiting.
      if (child.exitCode === null) await new Promise(done => child.once('close', done));
    }
    server.closeIdleConnections();
    await new Promise(resolveClose => server.close(resolveClose));
    })();
    return closePromise;
  } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createDashboard();
  const port = Number(process.env.DASHBOARD_PORT || 5180);
  app.server.listen(port, '127.0.0.1', () => console.log(`同時着手将棋 AI学習 → http://localhost:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void app.close().then(() => { process.exitCode = 0; }); });
}
