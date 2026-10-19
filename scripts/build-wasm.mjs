import { execFileSync } from 'node:child_process';
import { mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
execFileSync('cargo', ['build', '-p', 'shogi-core', '--target', 'wasm32-unknown-unknown', '--release', '--locked'], { cwd: root, stdio: 'inherit' });
mkdirSync(new URL('../web/public/', import.meta.url), { recursive: true });
copyFileSync(new URL('../target/wasm32-unknown-unknown/release/shogi_core.wasm', import.meta.url), new URL('../web/public/engine.wasm', import.meta.url));

