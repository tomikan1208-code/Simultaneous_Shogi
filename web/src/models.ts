import type { Action, Replay, RuleSet, Side } from './types.js';

export interface SavedModel { id:string; generation:number; latest:boolean; champion:boolean }
export interface SavedRun { id:string; name:string; source:string; compatible:boolean; reason:string; checkpoints:SavedModel[] }
export interface LoadedModel { model:string; generation:number; device:string; rules:RuleSet }
export interface ModelMove { model:string; generation:number; action:Action; round:number; device:string }
export interface ExternalStatus { available:boolean; label:string; nodes:number; reason:string }
export interface LoadedExternal { engine:string; name:string; label:string; nodes:number; rules:RuleSet }
export interface ExternalMove { engine:string; nodes:number; action:Action; round:number; source:'usi'|'hunter'; reason:string|null }

async function request<T>(path:string, input?:unknown):Promise<T> {
  let response:Response;
  try {
    response = await fetch('/api/ai/'+path, {
      method:input === undefined ? 'GET' : 'POST', cache:'no-store', signal:AbortSignal.timeout(input === undefined ? 15_000 : 125_000),
      ...(input === undefined ? {} : { headers:{'Content-Type':'application/json'}, body:JSON.stringify(input) }),
    });
  } catch {
    throw new Error('AIのサーバーに接続できないか、処理がタイムアウトしました。ゲーム用BATの起動状態を確認して再試行してください。');
  }
  const value = await response.json() as T & { error?:string };
  if (!response.ok) throw new Error(value.error || '対戦AIを利用できませんでした。');
  return value;
}

export const savedModels = {
  list:():Promise<{runs:SavedRun[]}> => request('models'),
  load:(model:string):Promise<LoadedModel> => request('load',{model}),
  choose:(model:string, replay:Replay, side:Side, seed:number):Promise<ModelMove> => request('move',{model,replay,side,seed}),
};

export const externalAI = {
  status:():Promise<ExternalStatus> => request('external'),
  load:():Promise<LoadedExternal> => request('external/load',{}),
  choose:(engine:string, replay:Replay, side:Side, seed:number):Promise<ExternalMove> => request('external/move',{engine,replay,side,seed}),
};
