import { execFileSync } from 'node:child_process';
import { mkdirSync, copyFileSync, cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc'], { cwd: root, stdio: 'inherit' });
mkdirSync(new URL('../web/dist/', import.meta.url), { recursive: true });
for (const file of ['index.html', 'style.css', 'match.css', 'icon.svg', 'engine.wasm']) {
  copyFileSync(new URL(`../web/public/${file}`, import.meta.url), new URL(`../web/dist/${file}`, import.meta.url));
}
cpSync(new URL('../web/public/fonts/', import.meta.url), new URL('../web/dist/fonts/', import.meta.url), { recursive: true });
cpSync(new URL('../web/public/audio/', import.meta.url), new URL('../web/dist/audio/', import.meta.url), { recursive: true });

