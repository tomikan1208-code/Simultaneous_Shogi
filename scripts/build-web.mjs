import { execFileSync } from 'node:child_process';
import { mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc'], { cwd: root, stdio: 'inherit' });
mkdirSync(new URL('../web/dist/', import.meta.url), { recursive: true });
for (const file of ['index.html', 'style.css', 'engine.wasm']) {
  copyFileSync(new URL(`../web/public/${file}`, import.meta.url), new URL(`../web/dist/${file}`, import.meta.url));
}

