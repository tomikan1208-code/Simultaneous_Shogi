import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { HttpError } from './rooms.mjs';
import { sameRules } from '../web/dist/rules.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const FORMAT = 'simultaneous-shogi/training-v1', SCHEMA = 'simultaneous-shogi/net-v1-54x24';
const schemas = new Set([SCHEMA, 'simultaneous-shogi/net-v2-62x24']);
const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 24);
const readJSON = async file => {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
};

function pythonPath() {
  return [process.env.SHOGI_PYTHON, join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')]
    .find(file => file && existsSync(file)) || (process.platform === 'win32' ? 'python' : 'python3');
}

class InferenceWorker {
  constructor({ python = pythonPath(), timeoutMs = 120_000 } = {}) {
    this.python = python; this.timeoutMs = timeoutMs;
    this.queue = Promise.resolve(); this.queued = 0; this.next = 0; this.closed = false;
  }

  start() {
    if (this.child) return this.child;
    const child = spawn(this.python, ['-u', '-m', 'server.model_worker'], {
      cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    this.child = child;
    let stderr = '';
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-6000); });
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      const task = this.pending;
      if (!task || this.child !== child) return;
      try {
        const response = JSON.parse(line);
        if (response.id !== task.id) throw new Error('Unexpected model response');
        this.pending = null; clearTimeout(task.timer);
        if (response.ok) task.resolve(response.value);
        else task.reject(new HttpError(422, response.error));
      } catch {
        this.fail(child, new HttpError(503, '学習モデルからの応答を読めませんでした。もう一度お試しください。'));
        child.kill();
      }
    });
    child.stdin.on('error', () => {});
    child.once('error', () => this.fail(child, new HttpError(503, '学習モデル用のPythonを起動できません。dashboard/setup-gpu.bat で環境を準備してください。')));
    child.once('close', () => {
      lines.close();
      this.fail(child, new HttpError(503, /ModuleNotFoundError|No module named/.test(stderr)
        ? '学習モデルにはPyTorchとNumPyが必要です。dashboard/setup-gpu.bat で環境を準備してください。'
        : '学習モデルの推論が停止しました。モデルとPython環境を確認して、もう一度お試しください。'));
    });
    return child;
  }

  fail(child, error) {
    if (this.child !== child) return;
    this.child = null;
    const task = this.pending; this.pending = null;
    if (task) { clearTimeout(task.timer); task.reject(error); }
  }

  request(input) {
    if (this.closed) return Promise.reject(new HttpError(503, 'サーバーを終了しています。'));
    if (this.queued >= 4) return Promise.reject(new HttpError(429, '学習モデルが使用中です。少し待ってから再試行してください。'));
    this.queued++;
    const result = this.queue.then(() => {
      if (this.closed) throw new HttpError(503, 'サーバーを終了しています。');
      const child = this.start(), id = ++this.next;
      return new Promise((resolveResult, reject) => {
        const timer = setTimeout(() => {
          this.fail(child, new HttpError(504, '学習モデルの処理がタイムアウトしました。もう一度お試しください。'));
          child.kill();
        }, this.timeoutMs);
        this.pending = { id, resolve: resolveResult, reject, timer };
        child.stdin.write(JSON.stringify({ ...input, id }) + '\n', error => {
          if (error) this.fail(child, new HttpError(503, '学習モデルとの接続が切れました。もう一度お試しください。'));
        });
      });
    });
    this.queue = result.catch(() => {});
    return result.finally(() => { this.queued--; });
  }

  async close() {
    this.closed = true;
    const child = this.child;
    if (!child) return;
    this.fail(child, new HttpError(503, 'サーバーを終了しています。'));
    await new Promise(done => {
      const timer = setTimeout(() => { child.kill(); }, 5000);
      child.once('close', () => { clearTimeout(timer); done(); });
      child.stdin.end();
    });
  }
}

export class ModelService {
  constructor({ rules, runsDir = join(root, 'dashboard/runs'), configFile = join(root, 'dashboard/local.json'), ...workerOptions }) {
    this.rules = rules; this.runsDir = runsDir; this.configFile = configFile;
    this.models = new Map(); this.worker = new InferenceWorker(workerOptions);
  }

  async catalogue() {
    const settings = await readJSON(this.configFile);
    const sources = [{ dir: resolve(this.runsDir), name: 'ローカル' }];
    if (settings?.source_dir && resolve(settings.source_dir) !== sources[0].dir) sources.push({ dir: resolve(settings.source_dir), name: 'Drive / 同期' });
    const runs = [], models = new Map(), visited = new Set();
    for (const source of sources) {
      let entries;
      try { entries = await readdir(source.dir, { withFileTypes: true }); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      const folders = [source.dir, ...entries.filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.')).slice(0, 200).map(entry => join(source.dir, entry.name))];
      for (const folder of folders) {
        const manifest = await readJSON(join(folder, 'manifest.json'));
        if (!manifest || manifest.format !== FORMAT) continue;
        const canonical = await realpath(folder);
        if (visited.has(canonical)) continue;
        visited.add(canonical);
        const compatible = schemas.has(manifest.schema) && sameRules(manifest.rules, this.rules);
        const checkpoints = [];
        let files = [], checkpointRoot;
        try { checkpointRoot = await realpath(join(canonical, 'checkpoints')); files = await readdir(checkpointRoot, { withFileTypes: true }); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        for (const file of files.slice(0, 10000)) {
          const match = /^g(\d{4,})\.pt$/.exec(file.name);
          if (!file.isFile() || file.isSymbolicLink() || !match) continue;
          const path = await realpath(join(checkpointRoot, file.name));
          if (!path.startsWith(checkpointRoot + sep)) continue;
          const info = await stat(path), id = digest(`${path}\0${info.size}\0${info.mtimeMs}`);
          const generation = Number(match[1]), relative = `checkpoints/${file.name}`;
          checkpoints.push({ id, generation, latest: manifest.latest_checkpoint === relative, champion: manifest.champion_checkpoint === relative });
          if (compatible) models.set(id, { id, path, generation, size: info.size, modified: info.mtimeMs, config: manifest.config, rules: manifest.rules });
        }
        checkpoints.sort((a, b) => b.generation - a.generation);
        runs.push({ id: digest(canonical), name: String(manifest.name || folder.split(sep).at(-1)), source: source.name,
          compatible: compatible && checkpoints.length > 0,
          reason: !schemas.has(manifest.schema) ? 'モデルの形式が異なります' : !sameRules(manifest.rules, this.rules) ? '現在のゲームとルール・ラウンド制限が異なります' : !checkpoints.length ? '保存済みモデルがありません' : '', checkpoints });
      }
    }
    this.models = models;
    runs.sort((a, b) => Number(b.compatible) - Number(a.compatible) || (b.checkpoints[0]?.generation ?? 0) - (a.checkpoints[0]?.generation ?? 0) || a.name.localeCompare(b.name, 'ja'));
    return { runs };
  }

  async selected(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{24}$/.test(id)) throw new HttpError(400, '学習モデルを選択してください。');
    if (!this.models.has(id)) await this.catalogue();
    const model = this.models.get(id);
    if (!model) throw new HttpError(404, 'モデルが見つからないか、このゲームに対応していません。一覧を更新してください。');
    let info;
    try { info = await stat(model.path); } catch { throw new HttpError(404, 'モデルが見つかりません。一覧を更新してください。'); }
    if (info.size !== model.size || info.mtimeMs !== model.modified) throw new HttpError(409, 'モデルが更新されています。一覧を更新して選び直してください。');
    return { id: model.id, path: model.path, generation: model.generation, config: model.config, rules: model.rules };
  }

  async load(id) {
    const model = await this.selected(id);
    return { model: id, rules: model.rules, ...await this.worker.request({ cmd: 'load', model }) };
  }

  async choose(input) {
    if (!['A', 'B'].includes(input.side) || !Number.isSafeInteger(input.seed) || input.seed < 0) throw new HttpError(400, 'AIの陣営と乱数種を確認してください。');
    if (!input.replay || !Array.isArray(input.replay.rounds) || input.replay.rounds.length > this.rules.roundLimit) throw new HttpError(400, '公開済みの棋譜を送信してください。');
    const model = await this.selected(input.model);
    if (!sameRules(input.replay.rules, this.rules)) throw new HttpError(422, '棋譜とモデルのルールが異なります。');
    // Only completed, public rounds cross this boundary. Never forward the human's pending move.
    return { model: model.id, ...await this.worker.request({ cmd: 'choose', model, replay: input.replay, side: input.side, seed: input.seed }) };
  }

  close() { return this.worker.close(); }
}
