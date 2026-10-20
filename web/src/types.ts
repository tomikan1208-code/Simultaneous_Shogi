export type Side = 'A' | 'B';
export type Kind = 'K' | 'P' | 'L' | 'N' | 'S' | 'G' | 'R' | 'B';
export type Square = [number, number];
export type Choice = 'none' | 'promote' | 'upgrade';
export interface Piece { id:string; side:Side; kind:Kind; at:Square; promoted:boolean; upgraded:boolean }
export interface DropBan { side:Side; kind:Kind; to:Square; remaining:number }
export interface MoveBan { side:Side; piece:string; from:Square; to:Square; remaining:number }
export interface Position { pieces:Piece[]; hands:Record<Side,Partial<Record<Kind,number>>>; dropBans:DropBan[]; moveBans:MoveBan[]; nextPieceId:number }
export type Action = { type:'move'; side:Side; piece:string; to:Square; choice:Choice } | { type:'drop'; side:Side; kind:Kind; to:Square };
export interface ActionOption { action:Action; path:Square[]; conditions:string[] }
export interface Outcome { winner:Side|'draw'; reason:string }
export interface RuleSet { version:string; profile:string; repetitionLimit:number; roundLimit:number }
export interface StagePlan { actor:string; from:Square; proposed:Square; next:Square; advance:boolean; blocker:string|null; finished:boolean }
export interface Frame { stage:number; pieces:Piece[]; plans:StagePlan[] }
export interface Event { stage:number; type:string; actor?:string; actors?:string[]; captor?:string; victim?:string; kind?:Kind; reason?:string; mode?:string; winner?:string|null; to?:Square; at?:Square|Square[]; blocker?:string; side?:Side; kinds?:Kind[]; ranks?:number[] }
export interface Capture { stage:number;captor:string;captorSide:Side;victim:string;victimSide:Side;kind:Kind;at:Square;captorRank:number;reason:string }
export interface Resolution extends Position { version:string; frames:Frame[]; events:Event[]; captures:Capture[]; outcome:Outcome|null; actions:Action[]; beforeHash:string; afterHash:string }
export interface MatchView { position:Position; rules:RuleSet; round:number; outcome:Outcome|null; committed:[boolean,boolean]; stateHash:string; lastResolution:Resolution|null }
export type Policy = 'random'|'hunter'|'defense'|'interference'|'upgrade';
export interface RoundRecord { round:number; actions:Action[]; beforeHash:string; afterHash:string; resolutionHash:string; outcome:Outcome|null; chainHash:string }
export interface Replay { format:string; rules:RuleSet; initial:Position; rounds:RoundRecord[] }
export type Request = {cmd:'new';position?:Position;rules?:RuleSet} | {cmd:'view'} | {cmd:'actions';side:Side} |
  {cmd:'submit';side:Side;action:Action} | {cmd:'submit_ai';side:Side;policy:Policy;seed:number} | {cmd:'export'} | {cmd:'import';replay:Replay} | {cmd:'replay_round';round:number};
export type Response<T> = {ok:true;value:T} | {ok:false;error:string};
export interface RoomPlayer { side:Side; name:string; ready:boolean; inLobby:boolean; connected:boolean; reconnectUntil:number|null }
export interface RoomView { code:string; phase:'lobby'|'playing'|'finished'; gameId:string; result:Outcome|null; players:(RoomPlayer|null)[] }
export interface HistoryEntry { round:number; labels:string[] }
export interface OnlineState { version:number; serverTime:number; you:Side; room:RoomView; view:MatchView; options:ActionOption[]; history:HistoryEntry[] }
export interface OnlineEntry extends OnlineState { token:string }

