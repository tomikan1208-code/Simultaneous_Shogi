import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, sep } from 'node:path';

const jsonCache = new Map(), hashCache = new Map();
const inside = (base, path) => path === base || path.startsWith(base + sep);
export const runId = directory => createHash('sha256').update(directory).digest('hex').slice(0, 20);
export const artifactGeneration = name => { const match = /(?:^|\/)g(\d+)(?:[-./]|$)/.exec(name); return match ? Number(match[1]) : null; };

async function cached(path, cache, convert) {
  const info = await stat(path), key = `${info.size}:${info.mtimeMs}`;
  const previous = cache.get(path);
  if (previous?.key === key) return previous.value;
  const value = convert(await readFile(path));
  if (cache.size > 10000) cache.clear();
  cache.set(path, { key, value });
  return value;
}
const readJSON = path => cached(path, jsonCache, bytes => JSON.parse(bytes.toString('utf8')));

export async function readLineage(run, roots) {
  const allowed = (await Promise.all(roots.filter(Boolean).map(path => realpath(path).catch(() => null)))).filter(Boolean);
  const lineage = [{ dir: run.dir, id: run.id || runId(run.dir), manifest: run.manifest, ceiling: run.manifest.generation, inherited: false }];
  const warnings = [], seen = new Set([run.dir]);
  for (let depth = 0; depth < 32; depth++) {
    const child = lineage.at(-1), parent = child.manifest.parent;
    // A weights-only warm start is a new experiment and has its own generation numbering.
    if (parent?.kind !== 'state_continuation') break;
    try {
      if (typeof parent.run !== 'string' || !Number.isInteger(parent.generation) || parent.generation < 0 || parent.generation > child.ceiling) throw new Error('継続元の世代情報が不正です');
      const directory = await realpath(resolve(parent.run));
      if (!allowed.some(base => inside(base, directory)) || seen.has(directory)) throw new Error('継続元の参照範囲を確認してください');
      if (!/^checkpoints\/g\d+\.pt$/.test(parent.checkpoint || '') || artifactGeneration(parent.checkpoint) !== parent.generation) throw new Error('継続元のチェックポイントが不正です');
      const checkpoint = await realpath(join(directory, parent.checkpoint));
      if (!inside(directory, checkpoint)) throw new Error('継続元の保存先が不正です');
      const manifest = await readJSON(join(directory, 'manifest.json'));
      if (manifest.format !== run.manifest.format || manifest.schema !== run.manifest.schema || manifest.rules_hash !== run.manifest.rules_hash || manifest.source_fingerprint !== parent.source_fingerprint || manifest.generation < parent.generation) throw new Error('継続元のルール・保存情報が一致しません');
      const digest = await cached(checkpoint, hashCache, bytes => createHash('sha256').update(bytes).digest('hex'));
      if (digest !== parent.sha256) throw new Error('継続元の重みが保存時と一致しません');
      seen.add(directory);
      lineage.push({ dir: directory, id: runId(directory), manifest, ceiling: parent.generation, inherited: true });
      if (depth === 31) warnings.push('継続元の参照が32段を超えたため、それ以前の記録を省略しました。');
    } catch (error) {
      warnings.push(`G${parent.generation}以前の継続元を読み込めません。元フォルダーを確認してください（${error.code === 'ENOENT' ? '保存先が見つかりません' : error.message}）。`);
      break;
    }
  }
  return { lineage, warnings };
}

export function generationConfig(manifest, generation) {
  return manifest.config_history?.filter(row => row.from_generation <= generation).at(-1)?.config || manifest.config;
}

export async function readGenerationHistory(lineage) {
  const history = new Map();
  for (const source of lineage.slice().reverse()) {
    const names = await readdir(join(source.dir, 'generations')).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    const rows = await Promise.all(names.filter(name => /^g\d+\.json$/.test(name) && Number(name.slice(1, -5)) <= source.ceiling)
      .map(async name => {
        const row = await readJSON(join(source.dir, 'generations', name));
        if (row.generation !== Number(name.slice(1, -5))) throw new Error('世代番号と保存名が一致しません');
        return { ...row, config: row.config || generationConfig(source.manifest, row.generation),
          origin_run: row.origin_run || source.id, origin_name: row.origin_name || source.manifest.name, inherited: source.inherited || !!row.inherited };
      }));
    for (const row of rows) history.set(row.generation, row);
  }
  return [...history.values()].sort((a, b) => a.generation - b.generation);
}

export function lineageArtifact(source, name) {
  if (!source.inherited) return name;
  const slash = name.indexOf('/');
  return `${name.slice(0, slash)}/ancestor-${source.id}/${name.slice(slash + 1)}`;
}
