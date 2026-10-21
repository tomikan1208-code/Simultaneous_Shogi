import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { InferenceWorker } from './models.mjs';
import { HttpError } from './rooms.mjs';
import { sameRules } from '../web/dist/rules.js';

async function readConfig(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return {};
    if (error instanceof SyntaxError) throw new HttpError(422, '既存AIの設定ファイルを読めません。学習パネルで設定を確認してください。');
    throw error;
  }
}

export class ExternalService {
  constructor({ rules, configFile = fileURLToPath(new URL('../dashboard/local.json', import.meta.url)), ...workerOptions }) {
    this.rules = rules; this.configFile = configFile; this.engines = new Map();
    this.worker = new InferenceWorker({ ...workerOptions, module: 'server.external_worker', label: '既存AI', dependencies: 'NumPy' });
  }

  async config() {
    const [defaults, local] = await Promise.all([
      readConfig(new URL('../training/config.json', import.meta.url)), readConfig(this.configFile),
    ]);
    return Object.fromEntries(Object.entries({ ...defaults, ...local.training }).filter(([key]) => key.startsWith('external_ai_')));
  }

  async status() {
    return this.worker.request({ cmd: 'status', config: await this.config() });
  }

  async load() {
    const config = await this.config();
    const loaded = await this.worker.request({ cmd: 'load', config, rules: this.rules });
    this.engines.set(loaded.engine, config);
    if (this.engines.size > 8) this.engines.delete(this.engines.keys().next().value);
    return loaded;
  }

  async choose(input) {
    if (!['A', 'B'].includes(input.side) || !Number.isSafeInteger(input.seed) || input.seed < 0) throw new HttpError(400, 'AIの陣営と乱数種を確認してください。');
    if (!input.replay || !Array.isArray(input.replay.rounds) || input.replay.rounds.length > this.rules.roundLimit) throw new HttpError(400, '公開済みの棋譜を送信してください。');
    if (!sameRules(input.replay.rules, this.rules)) throw new HttpError(422, '棋譜と既存AIの対局ルールが異なります。');
    if (typeof input.engine !== 'string' || !/^[a-f0-9]{24}$/.test(input.engine)) throw new HttpError(400, '対局に使う既存AIを選択してください。');
    const config = this.engines.get(input.engine);
    if (!config) throw new HttpError(404, '既存AIの接続情報がありません。AI対戦の設定から接続し直してください。');
    // Forward verified public history only; never pass a human's pending action.
    return this.worker.request({ cmd: 'choose', config, engine: input.engine, rules: this.rules,
      replay: input.replay, side: input.side, seed: input.seed });
  }

  close() { return this.worker.close(); }
}
