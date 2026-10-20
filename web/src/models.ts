import type { Action, Replay, RuleSet, Side } from './types.js';

export interface SavedModel { id:string; generation:number; latest:boolean; champion:boolean }
export interface SavedRun { id:string; name:string; source:string; compatible:boolean; reason:string; checkpoints:SavedModel[] }
export interface LoadedModel { model:string; generation:number; device:string; rules:RuleSet }
export interface ModelMove { model:string; generation:number; action:Action; round:number; device:string }

async function request<T>(path:string, input?:unknown):Promise<T> {
  let response:Response;
  try {
    response = await fetch('/api/ai/'+path, {
      method:input === undefined ? 'GET' : 'POST', cache:'no-store', signal:AbortSignal.timeout(input === undefined ? 15_000 : 125_000),
      ...(input === undefined ? {} : { headers:{'Content-Type':'application/json'}, body:JSON.stringify(input) }),
    });
  } catch {
    throw new Error('学習モデルのサーバーに接続できないか、処理がタイムアウトしました。ゲーム用BATの起動状態を確認して再試行してください。');
  }
  const value = await response.json() as T & { error?:string };
  if (!response.ok) throw new Error(value.error || '学習モデルを利用できませんでした。');
  return value;
}

export const savedModels = {
  list:():Promise<{runs:SavedRun[]}> => request('models'),
  load:(model:string):Promise<LoadedModel> => request('load',{model}),
  choose:(model:string, replay:Replay, side:Side, seed:number):Promise<ModelMove> => request('move',{model,replay,side,seed}),
};
