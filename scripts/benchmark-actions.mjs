import { execFileSync } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cpus } from 'node:os';
import { root, codeFiles, sourceFingerprint } from '../dashboard/server.mjs';

const binary = join(root, 'target/release', process.platform === 'win32' ? 'shogi.exe' : 'shogi');
const built = await stat(binary).catch(() => null);
const sources = (await codeFiles()).filter(p => p.endsWith('.rs') || p.endsWith('Cargo.toml') || p.endsWith('Cargo.lock'));
if (!built || (await Promise.all(sources.map(p => stat(p)))).some(s => s.mtimeMs > built.mtimeMs)) throw new Error('先に npm run ai:build を実行してください。');
const fingerprint = await sourceFingerprint();
const result = JSON.parse(execFileSync(binary, ['bench-actions', '1000'], { cwd: root, encoding: 'utf8', timeout: 60000 }));
if (fingerprint !== await sourceFingerprint()) throw new Error('計測中にソースが変更されました。再計測してください。');
Object.assign(result, { source_fingerprint: fingerprint, cpu: cpus()[0]?.model, logical_cpus: cpus().length,
  timestamp: Date.now() / 1000, platform: process.platform, arch: process.arch,
  rust: execFileSync('rustc', ['--version'], { encoding: 'utf8' }).trim(), node: process.version,
  output_contract: { reference: 'ActionOption including paths/condition descriptions', fast: 'Complete ordered Action set only' } });
await mkdir(join(root, 'dashboard/runs'), { recursive: true });
await writeFile(join(root, 'dashboard/runs/action-benchmark.json'), JSON.stringify(result, null, 2) + '\n');
const median = values => { const sorted = values.sort((a,b) => a-b); return (sorted[2] + sorted[3]) / 2; };
const reference = median(result.measurements.filter(r => !r.fast).map(r => r.seconds));
const fast = median(result.measurements.filter(r => r.fast).map(r => r.seconds));
console.log(JSON.stringify({ reference_seconds: reference, fast_seconds: fast, speedup: reference / fast, cpu: result.cpu, rules: result.rules, source: fingerprint, measurements: result.measurements }, null, 2));
