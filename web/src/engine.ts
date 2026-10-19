import type { Response } from './types.js';
interface WasmExports extends WebAssembly.Exports {
  memory:WebAssembly.Memory;
  shogi_alloc:(len:number)=>number;
  shogi_call:(ptr:number,len:number)=>bigint;
  shogi_free:(ptr:number,len:number)=>void;
}
/** The browser and native CLI use the same Rust JSON API and resolver. */
export class WasmEngine {
  private constructor(private wasm:WasmExports) {}
  static async fromBytes(bytes:BufferSource):Promise<WasmEngine> {
    const { instance } = await WebAssembly.instantiate(bytes, {});
    return new WasmEngine(instance.exports as WasmExports);
  }
  call<T>(request:unknown):Response<T> {
    const input = new TextEncoder().encode(JSON.stringify(request));
    const pointer = this.wasm.shogi_alloc(input.length);
    new Uint8Array(this.wasm.memory.buffer,pointer,input.length).set(input);
    const output = this.wasm.shogi_call(pointer,input.length);
    const ptr = Number(output >> 32n), length = Number(output & 0xffffffffn);
    try {
      return JSON.parse(new TextDecoder().decode(new Uint8Array(this.wasm.memory.buffer,ptr,length))) as Response<T>;
    } finally { this.wasm.shogi_free(ptr,length); }
  }
}

