// Browser Web Worker adapter used only by the Node DOM integration test.
// The production worker and its WASM module run unchanged in an actual thread.
import { parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url,...args) => new URL(url).protocol === 'file:' ? new Response(await readFile(new URL(url))) : originalFetch(url,...args);
globalThis.self = {postMessage:data=>parentPort.postMessage(data)};
await import(workerData.module);
parentPort.on('message',data=>globalThis.self.onmessage({data}));

