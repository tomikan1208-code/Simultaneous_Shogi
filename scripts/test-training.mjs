import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const local = join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const python = process.env.SHOGI_PYTHON || (existsSync(local) ? local : process.platform === 'win32' ? 'python' : 'python3');
const result = spawnSync(python, ['-m', 'unittest', 'tests.test_training', 'tests.test_balance', 'tests.test_sessions', 'tests.test_storage', 'tests.test_candidates', '-q'],
  { cwd: root, windowsHide: true, stdio: 'inherit' });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
