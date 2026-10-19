import type { Request, Response } from './types.js';
export class EngineClient {
  private worker = new Worker(new URL('./worker.js',import.meta.url), {type:'module'});
  private next = 0;
  private pending = new Map<number,{resolve:(value:unknown)=>void;reject:(error:Error)=>void}>();
  constructor() {
    this.worker.onmessage = ({data}:{data:{id:number;response:Response<unknown>}}) => {
      const task = this.pending.get(data.id); if (!task) return; this.pending.delete(data.id);
      if (data.response.ok) task.resolve(data.response.value); else task.reject(new Error(data.response.error));
    };
    this.worker.onerror = () => {
      for (const task of this.pending.values()) task.reject(new Error('エンジンとの接続が切れました。ページを再読み込みしてください。'));
      this.pending.clear();
    };
  }
  request<T>(request:Request):Promise<T> {
    return new Promise((resolve,reject) => {
      const id = ++this.next;
      this.pending.set(id,{resolve:value=>resolve(value as T),reject});
      this.worker.postMessage({id,request});
    });
  }
}
