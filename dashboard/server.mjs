import { createServer } from 'node:http';
import { readFile, writeFile, readdir, stat, mkdir, rename, unlink, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cpus } from 'node:os';
import { resolve, dirname, relative, sep, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipFiles } from './zip.mjs';

export const root = fileURLToPath(new URL('../', import.meta.url));
const web = join(root, 'dashboard/web'), localRuns = join(root, 'dashboard/runs'), cache = join(root, '.cache/dashboard');
const FORMAT = 'simultaneous-shogi/training-v1', SCHEMA = 'simultaneous-shogi/net-v1-54x24';
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
const readJSON = async (path, fallback = null) => { try { return JSON.parse(await readFile(path, 'utf8')); } catch (e) { if (e.code === 'ENOENT' || e instanceof SyntaxError) return fallback; throw e; } };
const within = (base, file) => file === base || file.startsWith(base.endsWith(sep) ? base : base + sep);
const safeFile = name => !name.includes('..') && !name.includes('\\') && /^(games|probes|evaluations|local-evaluations)\/[\w./-]+\.json$/.test(name);

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
  let settings = await readJSON(configFile, { source_dir: '' });
  let job = null, logs = [], lastJob = null, knownRuns = new Map(), closing = false;
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
      for (const dir of dirs) {
        const manifest = await readJSON(join(dir, 'manifest.json'));
        if (manifest?.format !== FORMAT || manifest.schema !== SCHEMA) continue;
        const canonical = await realpath(dir);
        const id = createHash('sha256').update(canonical).digest('hex').slice(0, 20);
        const status = await readJSON(join(canonical, 'status.json'), {});
        found.set(id, { id, dir: canonical, manifest, status, source: source.label, compatible: manifest.source_fingerprint === fingerprint });
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
  async function artifacts(run) {
    return (await filesUnder(run.dir, 4)).map(p => relative(run.dir, p).split(sep).join('/')).filter(safeFile).sort().reverse();
  }
  async function artifact(run, file) {
    if (!safeFile(file) || !(await artifacts(run)).includes(file)) throw new HttpError(404, '記録が見つかりません。');
    const path = await realpath(join(run.dir, file));
    if (!within(run.dir, path)) throw new HttpError(400, '記録のパスが不正です。');
    return path;
  }
  async function details(run) {
    const records = (await filesUnder(join(run.dir, 'generations'), 0)).filter(p => /g\d+\.json$/.test(p)).sort();
    const history = (await Promise.all(records.map(p => readJSON(p)))).filter(r => r && r.generation <= run.manifest.generation);
    return { id: run.id, manifest: run.manifest, status: run.status, source: run.source, compatible: run.compatible,
      history, artifacts: await artifacts(run), source_snapshot: existsSync(join(run.dir, 'source.zip')), local_evaluations: await Promise.all((await artifacts(run)).filter(n => /^local-evaluations\/[^/]+\/[^/]+\.json$/.test(n) && !n.includes('replay') && !n.endsWith('environment.json')).slice(0, 20).map(n => readJSON(join(run.dir, n)))) };
  }
  function startJob(kind, command, args, run = null, onSuccess = null) {
    if (job) throw new HttpError(409, '別の処理を実行中です。完了か停止を待ってください。');
    logs = [];
    const child = spawn(command, args, { cwd: root, windowsHide: true, env: { ...process.env, PYTHONUNBUFFERED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
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
  const binary = join(root, 'target/release', process.platform === 'win32' ? 'shogi.exe' : 'shogi');
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
        if (path === '/api/state') {
          const { runs, warnings } = await scan();
          const selected = runs.find(r => r.id === url.searchParams.get('run')) || runs[0];
          json(res, 200, { runs: runs.map(r => ({ id: r.id, name: r.manifest.name, source: r.source, generation: r.manifest.generation, rules_hash: r.manifest.rules_hash, compatible: r.compatible, phase: r.status.phase, round_limit: r.manifest.rules.roundLimit })),
            selected: selected ? await details(selected) : null, settings, warnings,
            source_fingerprint: await currentFingerprint(), job: job ? { kind: job.kind, started: job.started, run: job.run?.id } : null,
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
          const files = (await filesUnder(run.dir)).filter(p => /(?:^|[\\/])(?:manifest|status)\.json$|\.(?:pt|npz|json)$|[\\/]source\.zip$/.test(p) && !p.endsWith('.tmp'));
          const zip = await zipFiles(files.map(p => ({ name: relative(run.dir, p).split(sep).join('/'), path: p })));
          res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="shogi-results.zip"', 'Content-Length': zip.length }); res.end(zip); return;
        }
        if (path === '/colab.ipynb') {
          const data = await readFile(join(root, 'training/colab.ipynb'));
          res.writeHead(200, { 'Content-Type': 'application/x-ipynb+json', 'Content-Disposition': 'attachment; filename="Simultaneous_Shogi_Colab.ipynb"' }); res.end(data); return;
        }
        if (path === '/api/research') { json(res, 200, await readJSON(join(root, 'training/research.json'), [])); return; }
        const allowed = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css', '/icon.svg': 'icon.svg' };
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
      if (path === '/api/settings') {
        const source = String(input.source_dir ?? '').trim();
        if (source && (!isAbsolute(source) || !(await stat(source).catch(() => null))?.isDirectory())) throw new HttpError(400, '存在する同期フォルダーの絶対パスを指定してください。');
        settings = { source_dir: source ? await realpath(source) : '' };
        await mkdir(dirname(configFile), { recursive: true });
        await writeFile(`${configFile}.tmp`, JSON.stringify(settings)); await rename(`${configFile}.tmp`, configFile);
        json(res, 200, settings); return;
      }
      if (path === '/api/start') {
        if (input.mode !== 'smoke') throw new HttpError(400, 'ローカル起動はCPU動作確認モードを選択してください。');
        const dir = join(runRoot, `local-test-${Date.now()}`);
        json(res, 202, startJob('training', python(), ['-m', 'training.train', '--run-dir', dir, '--smoke'], { dir })); return;
      }
      if (path === '/api/stop') {
        if (!job) throw new HttpError(409, 'ローカル処理は実行されていません。');
        if (job.kind === 'training') { await mkdir(job.run.dir, { recursive: true }); await writeFile(join(job.run.dir, 'STOP'), 'requested from local dashboard'); }
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
      if (['/api/evaluate', '/api/probe', '/api/resume'].includes(path)) {
        if (job) throw new HttpError(409, '別のローカル処理を実行中です。');
        const run = await select(input.run);
        if (!run.compatible) throw new HttpError(409, '学習時とソースが異なります。同じソース一式を使用してください。');
        if (path === '/api/evaluate') {
          if (!['hunter', 'defense', 'upgrade', 'random', 'champion'].includes(input.opponent) || !Number.isInteger(input.pairs) || input.pairs < 1 || input.pairs > 512) throw new HttpError(400, '対戦相手・評価ペア数を確認してください。');
          json(res, 202, startJob('evaluation', python(), ['-m', 'training.evaluate', '--run-dir', run.dir, '--opponent', input.opponent, '--pairs', String(input.pairs), '--device', 'cpu'], run)); return;
        }
        if (path === '/api/probe') {
          const file = await artifact(run, String(input.file || ''));
          if (!Number.isInteger(input.round) || input.round < 1 || input.round > 100000) throw new HttpError(400, 'ラウンドを確認してください。');
          json(res, 202, startJob('probe', python(), ['-m', 'training.probe', '--run-dir', run.dir, '--replay', file, '--round', String(input.round), '--candidates', '16'], run)); return;
        }
        if (existsSync(join(run.dir, 'RUNNING'))) throw new HttpError(409, 'RUNNINGが存在します。既存の学習が停止していることを確認してください。');
        const config = join(cache, `resume-${randomUUID()}.json`);
        await writeFile(config, JSON.stringify({ ...run.manifest.config, device: 'cpu', workers: 1 }));
        await unlink(join(run.dir, 'STOP')).catch(error => { if (error.code !== 'ENOENT') throw error; });
        json(res, 202, startJob('training', python(), ['-m', 'training.train', '--run-dir', run.dir, '--config', config, '--resume'], run)); return;
      }
      throw new HttpError(404, '操作が見つかりません。');
    } catch (error) { json(res, error.status || 500, { error: error.message }); }
  });
  server.requestTimeout = 120000; server.headersTimeout = 15000;
  return { server, async close() {
    closing = true;
    if (job) {
      if (job.kind === 'training') { await mkdir(job.run.dir, { recursive: true }); await writeFile(join(job.run.dir, 'STOP'), 'dashboard closed'); }
      else job.child.kill();
    }
    server.closeIdleConnections();
    await new Promise(resolveClose => server.close(resolveClose));
  } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createDashboard();
  const port = Number(process.env.DASHBOARD_PORT || 5180);
  app.server.listen(port, '127.0.0.1', () => console.log(`同時着手将棋 AI学習 → http://localhost:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void app.close().then(() => { process.exitCode = 0; }); });
}
