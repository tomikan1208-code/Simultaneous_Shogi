import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
if (!existsSync(new URL('../web/dist/engine.wasm', import.meta.url)) || !existsSync(new URL('../web/dist/main.js', import.meta.url))) {
  execFileSync(process.execPath, ['scripts/build-wasm.mjs'], { stdio: 'inherit' });
  execFileSync(process.execPath, ['scripts/build-web.mjs'], { stdio: 'inherit' });
}
const { createApplication } = await import('../server/app.mjs');
const app = await createApplication();
const port = Number(process.env.PORT ?? 5173);
const host = process.env.HOST ?? '0.0.0.0';
app.server.listen(port, host, () => console.log(`同時着手将棋 → http://localhost:${port} (listen: ${host})`));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void app.close().then(() => process.exit(0)); });
