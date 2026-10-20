import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const virtualenv = join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const python = process.env.SHOGI_PYTHON || (existsSync(virtualenv) ? virtualenv : process.platform === 'win32' ? 'python' : 'python3');
const result = spawnSync(python, [join(root, 'scripts/benchmark-training.py'), ...process.argv.slice(2)],
  { cwd: root, stdio: 'inherit', windowsHide: true });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
