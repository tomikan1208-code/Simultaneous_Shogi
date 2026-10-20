import type { OnlineEntry, OnlineState, Replay, Resolution } from './types.js';

export type Connection = 'connecting'|'connected'|'reconnecting'|'replaced'|'expired';
export class NetworkError extends Error {
  constructor(message:string,readonly status = 0) { super(message); }
}
export class OnlineClient {
  private token = '';
  private generation = 0;
  private controller:AbortController|null = null;
  private stopped = true;
  constructor(private update:(state:OnlineState)=>void,private status:(value:Connection)=>void) {}
  static async enter(path:'rooms'|'join',input:unknown):Promise<OnlineEntry> {
    return OnlineClient.fetchJSON<OnlineEntry>(`/api/${path}`,'',input);
  }
  private static async fetchJSON<T>(path:string,token:string,input?:unknown):Promise<T> {
    let response:Response;
    try {
      response = await fetch(path,{ method:input === undefined ? 'GET' : 'POST', headers:{ ...(token ? {Authorization:`Bearer ${token}`} : {}), ...(input === undefined ? {} : {'Content-Type':'application/json'}) }, body:input === undefined ? undefined : JSON.stringify(input), signal:AbortSignal.timeout(15_000), cache:'no-store' });
    } catch { throw new NetworkError('通信を確認してください。接続が戻ると自動で復帰します。'); }
    const data = await response.json() as T & {error?:string};
    if (!response.ok) throw new NetworkError(data.error ?? '通信に失敗しました。',response.status);
    return data;
  }
  request<T = OnlineState>(path:string,input?:unknown):Promise<T> { return OnlineClient.fetchJSON<T>(`/api/${path}`,this.token,input); }
  replay(round?:number):Promise<Resolution|Replay> { return this.request(`replay${round ? `?round=${round}` : ''}`); }
  connect(token:string):void {
    this.stop(); this.token = token; this.stopped = false;
    this.status('connecting'); void this.stream(++this.generation);
  }
  stop():void { this.stopped = true; this.generation++; this.controller?.abort(); this.controller = null; }
  private async stream(generation:number):Promise<void> {
    let attempt = 0;
    while (!this.stopped && generation === this.generation) {
      const controller = new AbortController(); this.controller = controller;
      let lastMessage = Date.now();
      let pinging = false;
      const heartbeat = setInterval(async () => {
        if (pinging || this.stopped || generation !== this.generation) return;
        pinging = true;
        try { await this.request('ping',{}); }
        catch (error) { if (error instanceof NetworkError && error.status === 401) { this.stopped = true; this.status('expired'); controller.abort(); } }
        finally { pinging = false; }
      },8000);
      const watchdog = setInterval(() => { if (Date.now()-lastMessage > 35_000) controller.abort(); },5000);
      try {
        const response = await fetch('/api/events',{headers:{Authorization:`Bearer ${this.token}`},signal:controller.signal,cache:'no-store'});
        if (response.status === 401) { this.stopped = true; this.status('expired'); break; }
        if (!response.ok || !response.body) throw new Error('No event stream');
        const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
        while (!this.stopped && generation === this.generation) {
          const chunk = await reader.read(); if (chunk.done) break;
          buffer += decoder.decode(chunk.value,{stream:true}).replace(/\r/g,'');
          let boundary:number;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const message = buffer.slice(0,boundary); buffer = buffer.slice(boundary+2); lastMessage = Date.now();
            const event = message.match(/^event: (.+)$/m)?.[1];
            const data = message.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n');
            if (event === 'replaced') { this.stopped = true; this.status('replaced'); controller.abort(); break; }
            if (event === 'state') { attempt = 0; this.status('connected'); this.update(JSON.parse(data) as OnlineState); }
          }
          if (buffer.length > 4*1024*1024) throw new Error('Event stream too large');
        }
      } catch { /* The next full snapshot reconciles lost acknowledgements. */ }
      finally { clearInterval(watchdog); clearInterval(heartbeat); controller.abort(); }
      if (this.stopped || generation !== this.generation) break;
      this.status('reconnecting');
      await new Promise(resolve => setTimeout(resolve,Math.min(8000,600*2**Math.min(attempt++,4))));
    }
  }
}
