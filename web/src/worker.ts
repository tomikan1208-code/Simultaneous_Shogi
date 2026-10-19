import { WasmEngine } from './engine.js';
import type { Request } from './types.js';
const engine = fetch(new URL('./engine.wasm',import.meta.url)).then(async response => {
  if (!response.ok) throw new Error('エンジンを読み込めません。npm run build を実行してください。');
  return WasmEngine.fromBytes(await response.arrayBuffer());
});
self.onmessage = async ({data}:{data:{id:number;request:Request}}) => {
  try { self.postMessage({id:data.id,response:(await engine).call(data.request)}); }
  catch (error) { self.postMessage({id:data.id,response:{ok:false,error:error instanceof Error ? error.message : String(error)}}); }
};

