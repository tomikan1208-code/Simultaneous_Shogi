import { EngineClient } from './client.js';
import { Effects } from './effects.js';
import { NetworkError, OnlineClient } from './online.js';
import { savedModels } from './models.js';
import type { SavedRun } from './models.js';
import type { Connection } from './online.js';
import { actionLabel, conditionText, escape, eventText, icon, offersChange, other, pieceMarkup, rankAppearance, reasons, same, sideIndex, square, symbol, symbols } from './presentation.js';
import { PLAY_RULES, sameRules } from './rules.js';
import type { Action, ActionOption, Choice, HistoryEntry, Kind, MatchView, OnlineEntry, OnlineState, Outcome, Piece, Position, Replay, Resolution, RuleSet, Side, Square } from './types.js';

const $ = <T extends HTMLElement = HTMLElement>(id:string):T => {
  const element = document.getElementById(id); if (!element) throw new Error('Missing element: '+id); return element as T;
};
const engine = new EngineClient();
let historyEngine:EngineClient|null = null;
type Screen = 'home'|'setup'|'online'|'room'|'game';
type Mode = 'cpu'|'local'|'online'|'replay';
let screen:Screen = 'home', mode:Mode = 'cpu', setupMode:'cpu'|'local' = 'cpu';
let view:MatchView|null = null, options:ActionOption[] = [];
let active:Side = 'A', human:Side = 'A';
let names:Record<Side,string> = {A:'あなた',B:'対戦AI'};
let selection:{piece:string}|{kind:Kind}|null = null;
let pendingChoice:{piece:Piece;to:Square;options:ActionOption[]}|null = null;
let busy = false, animating = false, handoff = false;
let aiSeed = 1, gameSerial = 0;
type Opponent = {type:'model';id:string;generation:number;label:string};
let opponent:Opponent = {type:'model',id:'',generation:0,label:'学習済みAI'};
let modelRuns:SavedRun[] = [], modelsLoading = false, modelsListed = false, modelMessage = '';
let localOutcome:Outcome|null = null;
let history:HistoryEntry[] = [];
let replayResolution:Resolution|null = null, replayRound = 0, stageIndex:number|null = null;
let animationResolution:Resolution|null = null, animationStage = 0;
let tab:'game'|'replay' = 'game';
let playback:ReturnType<typeof setInterval>|undefined;
const replayCache = new Map<number,Resolution>();
const roundStarts = new Map<number,Position>();
let onlineState:OnlineState|null = null, onlineToken = '', onlineCode = '';
let connection:Connection = 'connecting', onlineQueue = Promise.resolve(), onlineOffset = 0;
let joinMode = false, resultShown = '', confirmAction:(()=>void)|null = null;
const storage = {
  get(key:string,session = false):string|null { try { return (session ? sessionStorage : localStorage).getItem(key); } catch { return null; } },
  set(key:string,value:string|null,session = false):void { try { const target = session ? sessionStorage : localStorage; if (value === null) target.removeItem(key); else target.setItem(key,value); } catch { /* Private mode can disable storage. */ } },
};
const savedSettings = (() => { try { return JSON.parse(storage.get('shogi-settings') ?? '{}') as Record<string,unknown>; } catch { return {}; } })();
const systemReduced = matchMedia('(prefers-reduced-motion: reduce)');
const settings = { sound:savedSettings.sound !== false, ranks:savedSettings.ranks !== false, reduced:savedSettings.reduced === true || systemReduced.matches, history:savedSettings.history !== false };
const effects = new Effects(() => settings.reduced,() => settings.sound);
const net = new OnlineClient(state => { void enqueueOnline(state); },state => {
  connection = state;
  if (state === 'expired') { storage.set('shogi-room',null,true); showError('部屋の接続情報が失効しました。ホームから部屋に入り直してください。'); }
  if (state === 'replaced') showError('別のタブでこのルームが開かれました。この画面からの操作は停止しています。');
  render();
});
const outcome = ():Outcome|null => mode === 'online' ? onlineState?.room.result ?? view?.outcome ?? null : localOutcome ?? view?.outcome ?? null;
const perspective = ():Side => mode === 'local' ? active : human;
const currentResolution = ():Resolution|null => replayResolution ?? view?.lastResolution ?? null;
const canReview = ():boolean => !!view && (mode === 'replay' || !!outcome());
function showError(error:unknown):void { $('error-text').textContent = error instanceof Error ? error.message : String(error); $('error').hidden = false; }
function hideError():void { $('error').hidden = true; }
function setScreen(next:Screen):void {
  screen = next;
  document.body.classList.toggle('is-playing',next === 'game');
  for (const name of ['home','setup','online','room','game'] as Screen[]) $(name+'-screen').hidden = name !== next;
  $('context-label').textContent = next === 'room' ? 'インターネット対戦' : next === 'game' ? mode === 'online' ? 'ルーム '+onlineCode : mode === 'cpu' ? 'AI対戦' : mode === 'local' ? 'ローカル対戦' : '棋譜の検討' : '';
  document.title = next === 'game' ? '対局 · 同時着手将棋' : '同時着手将棋';
  window.scrollTo({top:0,behavior:'instant'});
  render();
}
function selectedOptions():ActionOption[] {
  return options.filter(option => selection && ('piece' in selection ? option.action.type === 'move' && option.action.piece === selection.piece : option.action.type === 'drop' && option.action.kind === selection.kind));
}
function canAct():boolean {
  return !!view && screen === 'game' && mode !== 'replay' && !outcome() && !busy && !animating && !handoff && stageIndex === null && !view.committed[sideIndex(active)] && (mode !== 'online' || connection === 'connected' && onlineState?.room.phase === 'playing' && onlineState.room.players.every(player => player?.connected));
}
function canInput():boolean { return canAct() && !pendingChoice; }
function clearSelection():void { selection = null; pendingChoice = null; }
function stopPlayback():void { if (playback) clearInterval(playback); playback = undefined; $('play').textContent = '▶ 再生'; }
function hideResult():void {
  document.body.classList.remove('result-open');
  $('result-overlay').hidden = true; $('app').inert = false;
  document.querySelector<HTMLElement>('.app-header')!.inert = false;
}
function resetGameUI():void {
  gameSerial++; effects.skip(); stopPlayback(); hideResult(); clearSelection();
  handoff = false; animating = false; animationResolution = null; replayResolution = null;
  stageIndex = null; replayRound = 0; tab = 'game'; history = []; replayCache.clear(); roundStarts.clear();
  resultShown = ''; localOutcome = null;
}
async function run(work:()=>Promise<void>):Promise<void> {
  if (busy) return; busy = true; hideError(); render();
  try { await work(); } catch (error) {
    if (mode === 'online' && onlineToken && error instanceof NetworkError && error.status !== 401) {
      try { await enqueueOnline(await net.request<OnlineState>('state')); } catch { /* The stream will retry. */ }
    }
    showError(error);
  } finally { busy = false; render(); }
}
async function loadOptions():Promise<void> {
  options = mode === 'online' ? onlineState?.options ?? [] : mode === 'replay' || outcome() ? [] : await engine.request<ActionOption[]>({cmd:'actions',side:active});
}
function openSetup(next:'cpu'|'local'):void {
  detachHomeConnection();
  setupMode = next; hideError();
  $('setup-title').textContent = next === 'cpu' ? 'AI対戦' : 'ひとつの端末で対戦';
  $('setup-kicker').textContent = next === 'cpu' ? 'PLAY WITH AI' : 'LOCAL TWO PLAYERS';
  $('setup-emblem').innerHTML = next === 'cpu' ? '金' : icon('people');
  $('ai-options').hidden = next !== 'cpu'; $('local-options').hidden = next !== 'local';
  setScreen('setup'); $('start-game').focus({preventScroll:true});
  if (next === 'cpu' && !modelsListed) void refreshModels();
}
function usesModel():boolean { return setupMode === 'cpu'; }
function selectedModel():{run:SavedRun;id:string;generation:number}|null {
  const run = modelRuns.find(item => item.id === $<HTMLSelectElement>('model-run').value);
  const model = run?.checkpoints.find(item => item.id === $<HTMLSelectElement>('model-checkpoint').value);
  return run?.compatible && model ? {run,id:model.id,generation:model.generation} : null;
}
function fillModelCheckpoints(preferred = ''):void {
  const run = modelRuns.find(item => item.id === $<HTMLSelectElement>('model-run').value);
  const select = $<HTMLSelectElement>('model-checkpoint');
  select.innerHTML = run?.compatible ? run.checkpoints.map(model => '<option value="'+model.id+'">第'+model.generation+'世代'+(model.latest ? ' · 最新' : '')+(model.champion ? ' · champion' : '')+'</option>').join('') : '<option value="">利用できる世代がありません</option>';
  select.value = run?.checkpoints.find(item => item.id === preferred)?.id ?? run?.checkpoints.find(item => item.latest)?.id ?? run?.checkpoints.find(item => item.champion)?.id ?? run?.checkpoints[0]?.id ?? '';
}
function renderModelSetup():void {
  const selected = selectedModel();
  $<HTMLSelectElement>('model-run').disabled = busy || modelsLoading || !modelRuns.some(run => run.compatible);
  $<HTMLSelectElement>('model-checkpoint').disabled = busy || modelsLoading || !selected;
  $<HTMLButtonElement>('refresh-models').disabled = busy || modelsLoading;
  $('model-status').textContent = modelMessage || (selected ? '第'+selected.generation+'世代を使用します。対局中にモデルは切り替わりません。' : '保存済みモデルがありません。学習パネルで学習するか、Colabの結果を取り込んでから一覧を更新してください。');
  $('start-game').innerHTML = (usesModel() ? 'モデルを読み込んで対局' : '対局を始める')+icon('chevron');
}
async function refreshModels():Promise<void> {
  if (modelsLoading) return;
  const previousRun = $<HTMLSelectElement>('model-run').value, previousModel = $<HTMLSelectElement>('model-checkpoint').value;
  modelsLoading = true; modelMessage = 'モデル一覧を読み込み中…'; render();
  try {
    modelRuns = (await savedModels.list()).runs; modelsListed = true;
    const select = $<HTMLSelectElement>('model-run');
    select.innerHTML = modelRuns.length ? modelRuns.map(run => '<option value="'+run.id+'"'+(run.compatible ? '' : ' disabled')+'>'+escape(run.name)+' · '+escape(run.source)+(run.compatible ? '' : '（'+escape(run.reason)+'）')+'</option>').join('') : '<option value="">保存済みモデルがありません</option>';
    select.value = modelRuns.find(run => run.id === previousRun && run.compatible)?.id ?? modelRuns.find(run => run.compatible)?.id ?? '';
    fillModelCheckpoints(previousModel); modelMessage = '';
    if (modelRuns.length && !modelRuns.some(run => run.compatible)) modelMessage = '現在のゲームに対応するモデルがありません。ルールとラウンド制限が一致するモデルを用意してください。';
  } catch (error) { modelMessage = error instanceof Error ? error.message : String(error); }
  finally { modelsLoading = false; render(); }
}
async function prepareOpponent(rules:RuleSet = PLAY_RULES):Promise<Opponent> {
  if (!modelsListed) await refreshModels();
  const selected = selectedModel();
  if (!selected) throw new Error('対局に使う学習モデルを選択してください。');
  modelMessage = '第'+selected.generation+'世代のモデルを読み込み中…'; render();
  try {
    const loaded = await savedModels.load(selected.id);
    if (loaded.model !== selected.id || loaded.generation !== selected.generation) throw new Error('選択したモデルと応答が一致しません。一覧を更新してください。');
    if (!sameRules(rules,loaded.rules)) throw new Error('棋譜とモデルのルールが異なるため、この局面からは対局できません。');
    return {type:'model',id:selected.id,generation:selected.generation,label:selected.run.name+' · 第'+selected.generation+'世代'};
  } finally { modelMessage = ''; }
}
async function startGame():Promise<void> {
  const chosen = setupMode === 'cpu' ? await prepareOpponent() : opponent;
  resetGameUI(); mode = setupMode;
  human = document.querySelector<HTMLInputElement>('input[name="side"]:checked')!.value as Side;
  active = mode === 'local' ? 'A' : human;
  opponent = chosen;
  names = mode === 'cpu' ? { [human]:'あなた', [other(human)]:opponent.type === 'model' ? '学習AI · 第'+opponent.generation+'世代' : '対戦AI' } as Record<Side,string> : { A:$<HTMLInputElement>('local-name-a').value.trim() || 'プレイヤー1', B:$<HTMLInputElement>('local-name-b').value.trim() || 'プレイヤー2' };
  aiSeed = Math.floor(Math.random()*0x100000000);
  view = await engine.request<MatchView>({cmd:'new',rules:PLAY_RULES}); await loadOptions();
  setScreen('game'); effects.sound('start');
}
function openOnline(join = false):void {
  detachHomeConnection();
  hideError(); joinMode = join; setScreen('online'); renderOnlineForm();
  $<HTMLInputElement>('player-name').value ||= storage.get('shogi-name') ?? '';
}
function renderOnlineForm():void {
  $('join-fields').hidden = !joinMode; $<HTMLInputElement>('room-code').required = joinMode;
  $('create-tab').classList.toggle('active',!joinMode); $('join-tab').classList.toggle('active',joinMode);
  $('create-tab').setAttribute('aria-selected',String(!joinMode)); $('join-tab').setAttribute('aria-selected',String(joinMode));
  $('online-description').textContent = joinMode ? '相手から教えてもらった6桁の番号を入力。' : '部屋番号を相手に伝えて、対戦できます。';
  $('online-submit').innerHTML = (joinMode ? 'ルームに入る' : 'ルームを作る')+icon('chevron');
}
async function enterOnline(entry:OnlineEntry):Promise<void> {
  onlineToken = entry.token; onlineCode = entry.room.code; onlineState = null;
  storage.set('shogi-room',JSON.stringify({token:entry.token,code:onlineCode}),true);
  mode = 'online'; resetGameUI(); net.connect(entry.token); await enqueueOnline(entry);
}
function enqueueOnline(state:OnlineState):Promise<void> {
  const token = onlineToken;
  onlineQueue = onlineQueue.catch(() => {}).then(async () => {
    if (!token || token !== onlineToken || state.room.code !== onlineCode || onlineState && state.version <= onlineState.version) return;
    const previous = onlineState, fresh = !previous || state.room.gameId !== previous.room.gameId;
    if (fresh) resetGameUI();
    const resolved = !fresh && state.view.round > (view?.round ?? 0);
    if (resolved && view) roundStarts.set(state.view.round,view.position);
    onlineState = state; onlineOffset = state.serverTime-Date.now(); mode = 'online';
    human = state.you; active = human; names = {A:state.room.players[0]?.name ?? '退出した相手',B:state.room.players[1]?.name ?? '退出した相手'};
    view = state.view; options = state.options; history = state.history;
    if (fresh || resolved || view.committed[sideIndex(active)]) clearSelection();
    const player = state.room.players[sideIndex(human)];
    if (state.room.phase === 'playing') {
      if (screen !== 'game') setScreen('game');
      if (resolved && view.lastResolution) await animateRound(view.lastResolution);
    } else if (player?.inLobby) { hideResult(); setScreen('room'); }
    else { setScreen('game'); if (resolved && view.lastResolution) await animateRound(view.lastResolution); }
    render();
    if (outcome() && !player?.inLobby) showResult();
  }).catch(error => showError(error));
  return onlineQueue;
}
let lastBoard = new Map<string,Square>();
function renderBoard():void {
  if (!view) return;
  const resolution = animationResolution ?? currentResolution();
  const index = animationResolution ? animationStage : stageIndex;
  const frame = index !== null && resolution ? resolution.frames[index] : undefined;
  const position = index !== null && resolution ? resolution : view.position;
  const pieces = frame?.pieces ?? position.pieces;
  const round=animationResolution ? view.round : replayRound || view.round;
  const start=frame ? roundStarts.get(round) : undefined;
  const rankContext=(piece:Piece) => ({rules:view!.rules,activity:(start ?? position).activity?.[piece.id],
    moving:!!frame && !!start?.pieces.find(p=>p.id===piece.id && !same(p.at,piece.at))});
  const flipped = perspective() === 'B';
  const files = Array.from({length:9},(_,i) => flipped ? i+1 : 9-i);
  const ranks = Array.from({length:9},(_,i) => flipped ? 9-i : i+1);
  $('files').innerHTML = files.map(n => '<span>'+n+'</span>').join('');
  $('ranks').innerHTML = ranks.map(n => '<span>'+'一二三四五六七八九'[n-1]+'</span>').join('');
  const candidates = canInput() ? selectedOptions() : [];
  const latest = view.lastResolution?.actions ?? [];
  const actualEnds = latest.flatMap(action => action.type === 'move' ? view!.position.pieces.filter(p => p.id === action.piece).map(p => p.at) : view!.position.pieces.filter(p => p.side === action.side && same(p.at,action.to)).map(p => p.at));
  $('board').innerHTML = ranks.flatMap(y => files.map(x => {
    const at:Square = [x,y], p = pieces.find(piece => same(piece.at,at));
    const candidate = candidates.find(option => same(option.action.to,at));
    const classes = ['cell'];
    if (p) classes.push('occupied');
    if (candidate) { classes.push('available'); if (candidate.conditions.length) classes.push('conditional'); }
    if (selection && 'piece' in selection && p?.id === selection.piece && index === null) classes.push('selected');
    if (pendingChoice && same(pendingChoice.to,at)) classes.push('destination');
    if (index === null && !selection && actualEnds.some(q => same(q,at))) classes.push('last');
    const status=p ? rankAppearance(p,rankContext(p)) : null;
    const label = square(at)+(p ? ' '+p.side+' '+symbol(p)+' '+status!.description : ' 空きマス');
    const conditional = candidate ? conditionText(candidate.conditions) : '';
    const title=[status?.description,conditional].filter(Boolean).join(' / ');
    return '<button class="'+classes.join(' ')+'" data-x="'+x+'" data-y="'+y+'" aria-label="'+escape(label)+(conditional ? ' 条件：'+escape(conditional) : '')+'"'+(title ? ' title="'+escape(title)+'"' : '')+(canInput() ? '' : ' disabled')+'>'+ (p ? pieceMarkup(p,p.side !== perspective(),rankContext(p)) : '')+'</button>';
  })).join('');
  if (animating && !settings.reduced && $('board').clientWidth > 0) {
    const size = $('board').clientWidth/9;
    for (const element of $('board').querySelectorAll<HTMLElement>('.piece')) {
      const p = pieces.find(piece => piece.id === element.dataset.piece), before = lastBoard.get(element.dataset.piece!);
      if (p && before && !same(before,p.at) && element.animate) {
        const dx = (before[0]-p.at[0])*(flipped ? 1 : -1)*size, dy = (before[1]-p.at[1])*(flipped ? -1 : 1)*size;
        element.animate([{translate:dx+'px '+dy+'px'},{translate:'0px 0px'}],{duration:210,easing:'cubic-bezier(.2,.7,.3,1)'});
      }
    }
  }
  lastBoard = new Map(pieces.map(piece => [piece.id,piece.at]));
  for (const side of ['A','B'] as Side[]) {
    const top = side !== perspective(), element = $(top ? 'hand-top' : 'hand-bottom');
    const kinds = (['R','B','G','S','N','L','P'] as Kind[]).filter(kind => (position.hands[side][kind] ?? 0) > 0);
    const stageHands = index !== null && resolution && index < resolution.frames.length;
    element.innerHTML = '<span class="hand-label">持ち駒</span>'+(stageHands ? '<span class="hand-empty">段階再生中</span>' : kinds.length ? kinds.map(kind =>
      '<button class="hand-piece'+(selection && 'kind' in selection && selection.kind === kind && side === active ? ' selected' : '')+'" data-side="'+side+'" data-kind="'+kind+'" aria-label="'+side+' 持ち駒 '+symbols[kind]+' '+position.hands[side][kind]+'枚"'+(canInput() && side === active ? '' : ' disabled')+'>'+pieceMarkup({id:'hand:'+side+':'+kind,side,kind,at:[1,1],promoted:false,upgraded:false},top)+'<small aria-hidden="true">'+position.hands[side][kind]+'</small></button>').join('') : '<span class="hand-empty">なし</span>');
  }
  renderChoice();
}
function renderChoice():void {
  const element = $('choice-popover'); element.hidden = !pendingChoice;
  if (!pendingChoice) return;
  const {piece,to} = pendingChoice, flipped = perspective() === 'B';
  const col = flipped ? to[0]-1 : 9-to[0], row = flipped ? 9-to[1] : to[1]-1;
  element.style.setProperty('--choice-x',((col+.5)/9*100)+'%');
  element.style.setProperty('--choice-y',((row+.5)/9*100)+'%');
  element.classList.toggle('above',row >= 4);
  const choices:Choice[] = ['promote','upgrade'];
  element.innerHTML = '<div class="choice-heading"><span>着手後の変更</span><button class="icon-button" data-choice-cancel aria-label="選び直す">×</button></div><div class="choice-options">'+choices.map(choice => {
    const preview = {...piece,promoted:choice === 'promote',upgraded:choice === 'upgrade'};
    return '<button class="choice-option" data-choice="'+choice+'"'+(canAct() ? '' : ' disabled')+'>'+pieceMarkup(preview)+'<span>'+(choice === 'promote' ? '成る' : '昇格 +1')+'</span></button>';
  }).join('')+'</div><p class="choice-note">実際の到達位置に資格がある場合に適用。<br>行き所がなくなる場合は強制成り。</p>';
}
function renderPlayers():void {
  if (!view) return;
  for (const side of ['A','B'] as Side[]) {
    const top = side !== perspective(), element = $(top ? 'player-top' : 'player-bottom');
    const committed = view.committed[sideIndex(side)], player = onlineState?.room.players[sideIndex(side)];
    const status = outcome() ? '終局' : stageIndex !== null ? '公開済み' : animating ? '同時着手' : mode === 'online' && !player?.connected ? '接続待ち' : committed ? '着手済み' : mode === 'cpu' && side !== human ? '思考中' : '手を選択中';
    element.classList.toggle('is-you',!top);
    element.innerHTML = '<span class="player-avatar">'+(side === 'A' ? '王' : '玉')+'</span><strong class="player-name">'+escape(names[side])+'<span class="player-side">'+side+'陣営</span></strong><span class="player-status'+(committed ? ' ready' : '')+'"><i class="live-dot"></i>'+status+'</span>';
  }
}
function renderReplay():void {
  const resolution = currentResolution(); if (!view || !resolution || tab !== 'replay') return;
  $<HTMLSelectElement>('replay-round').innerHTML = Array.from({length:view.round},(_,i) => '<option value="'+(i+1)+'">ラウンド '+(i+1)+'</option>').join('');
  $<HTMLSelectElement>('replay-round').value = String(replayRound || view.round);
  $<HTMLSelectElement>('replay-round').disabled = busy;
  $('revealed-actions').textContent = resolution.actions.map(action => action.side+'：'+actionLabel(action,resolution.frames[0].pieces,resolution)).join(' / ');
  const index = stageIndex ?? resolution.frames.length, frame = resolution.frames[index];
  $('stage-label').textContent = index === 0 ? '開始局面' : frame ? '段階 '+frame.stage : '確定局面';
  const slider = $<HTMLInputElement>('stage-slider'); slider.max = String(resolution.frames.length); slider.value = String(index);
  $<HTMLButtonElement>('stage-prev').disabled = busy || index === 0;
  $<HTMLButtonElement>('stage-next').disabled = busy || index === resolution.frames.length;
  $<HTMLButtonElement>('play').disabled = busy;
  const plans = frame?.plans ?? [];
  $('plan-details').innerHTML = index === resolution.frames.length ? resolution.actions.map(action => {
    const before = resolution.frames[0].pieces;
    const p = action.type === 'move' ? resolution.pieces.find(p => p.id === action.piece) : resolution.pieces.find(p => p.side === action.side && p.kind === action.kind && !before.some(old => old.id === p.id));
    const failed = action.type === 'drop' && resolution.events.some(event => event.type === 'equal_drop_failure' || event.type === 'drop_failure' && event.side === action.side);
    return '<p>'+action.side+' 実結果：'+(p ? square(p.at) : failed ? '打ち不成立・持ち駒を保持' : '被捕獲')+'</p>';
  }).join('') : index === 0 ? '<p>双方の着手を公開した開始局面</p>' : plans.map(plan => {
    const actual = frame.pieces.find(piece => piece.id === plan.actor), p = resolution.frames[0].pieces.find(piece => piece.id === plan.actor);
    return '<p>'+ (p ? p.side+' '+symbol(p) : '駒')+'　予定 '+square(plan.proposed)+' / 実際 '+(actual ? square(actual.at) : '被捕獲')+(plan.blocker ? '（味方の駒を待機）' : plan.finished ? '（停止）' : '')+'</p>';
  }).join('');
  const events = resolution.events.filter(event => !frame || event.stage <= frame.stage && !['forced_promotion','promotion','upgrade','drop_failure'].includes(event.type));
  $('events').innerHTML = events.length ? events.map(event => '<div class="event"><span class="event-step">'+String(event.stage).padStart(2,'0')+'</span><span>'+escape(eventText(event,resolution))+'</span></div>').join('') : '<p class="empty-history">次の段階へ進めると、記録が表示されます。</p>';
}
function renderRoom():void {
  if (!onlineState) return;
  const {room} = onlineState, self = room.players[sideIndex(human)];
  $('room-number').textContent = room.code;
  $('room-connection').innerHTML = '<i class="live-dot"></i>'+(connection === 'connected' ? '接続済み' : connection === 'replaced' ? '別のタブで接続中' : '再接続中');
  $('room-connection').classList.toggle('offline',connection !== 'connected');
  $('room-players').innerHTML = room.players.map((p,i) => {
    const status = !p ? '参加を待っています' : !p.connected ? '接続待ち' : !p.inLobby ? '結果を確認中' : p.ready ? '準備完了' : '準備中';
    return (i ? '<span class="room-vs">vs</span>' : '')+'<div class="room-seat'+(!p ? ' empty' : '')+'"><div class="room-avatar">'+(p ? i ? '玉' : '王' : '…')+'</div><strong>'+escape(p?.name ?? '対戦相手を待つ')+'</strong><p class="seat-side">'+(i ? 'B' : 'A')+'陣営'+(p?.side === human ? ' · あなた' : '')+'</p><span class="seat-status'+(p?.ready ? ' ready' : '')+'">'+(p?.ready ? icon('check') : '')+status+'</span></div>';
  }).join('');
  const opponent = room.players[sideIndex(other(human))];
  $('room-status').textContent = connection !== 'connected' ? '通信に再接続しています…' : !opponent ? '部屋番号を相手に伝えてください' : !opponent.inLobby ? '相手がルームに戻るのを待っています' : self?.ready ? '相手の準備完了を待っています' : '双方が準備完了すると対局が始まります';
  $('room-ready').textContent = self?.ready ? '準備完了を取り消す' : '準備完了';
  $<HTMLButtonElement>('room-ready').disabled = busy || connection !== 'connected' || !self?.connected || !self.inLobby;
  $<HTMLButtonElement>('room-leave').disabled = busy;
}
function renderConnection():void {
  const missing = onlineState?.room.players.find(player => player && !player.connected);
  const visible = mode === 'online' && screen === 'game' && !outcome() && (connection !== 'connected' || !!missing);
  $('connection-notice').hidden = !visible;
  if (!visible) return;
  $('connection-message').textContent = connection === 'replaced' ? '別のタブで接続中です。ホームから退出できます。' : connection === 'expired' ? '接続情報が失効しました。ホームから入り直してください。' : connection !== 'connected' ? '通信に再接続しています。対局は保持されています。' : '相手の再接続を待っています。';
  const until = missing?.reconnectUntil;
  $('reconnect-countdown').textContent = until ? Math.max(0,Math.ceil((until-Date.now()-onlineOffset)/1000))+'秒' : '';
}
function render():void {
  $('resume-online').hidden = !storage.get('shogi-room',true);
  renderModelSetup();
  $<HTMLButtonElement>('start-game').disabled = busy || screen === 'setup' && usesModel() && (modelsLoading || !selectedModel());
  $<HTMLButtonElement>('online-submit').disabled = busy;
  for (const id of ['mode-cpu','mode-local','mode-online','setup-back','online-back','home-nav','game-home','menu-open']) $<HTMLButtonElement>(id).disabled = busy || animating;
  if (screen === 'room') renderRoom();
  if (screen !== 'game' || !view) return;
  $('context-label').textContent = mode === 'online' ? 'ルーム '+onlineCode : mode === 'cpu' ? 'AI対戦' : mode === 'local' ? 'ローカル対戦' : '棋譜の検討';
  $('game-mode').textContent = mode === 'cpu' ? 'AI対戦 · '+opponent.label : mode === 'online' ? 'ルーム '+onlineCode : mode === 'local' ? 'ローカル対戦' : '棋譜の検討';
  $('game-mode').title = $('game-mode').textContent ?? '';
  $('round-number').textContent = String(stageIndex !== null ? replayRound : outcome() ? view.round : view.round+1).padStart(2,'0');
  const reviewable = canReview();
  $('game-sidebar').hidden = !settings.history;
  $('history-toggle').setAttribute('aria-pressed',String(settings.history));
  $('history-toggle').setAttribute('aria-label',settings.history ? '棋譜を隠す' : '棋譜を表示');
  $('history-toggle').title = settings.history ? '棋譜を隠す' : '棋譜を表示';
  $('tab-replay').hidden = !reviewable;
  $('tab-game').classList.toggle('active',tab === 'game'); $('tab-replay').classList.toggle('active',tab === 'replay');
  $('tab-game').setAttribute('aria-pressed',String(tab === 'game')); $('tab-replay').setAttribute('aria-pressed',String(tab === 'replay'));
  $<HTMLButtonElement>('tab-replay').disabled = !reviewable || busy || animating || !view.round || handoff;
  $<HTMLButtonElement>('tab-game').disabled = busy || animating || handoff;
  $('history-panel').hidden = tab !== 'game'; $('replay-panel').hidden = tab !== 'replay';
  $('history').innerHTML = history.length ? history.map(entry => '<button class="history-row'+(entry.round === replayRound && stageIndex !== null ? ' active' : '')+'" data-round="'+entry.round+'" aria-label="ラウンド '+entry.round+(reviewable ? ' を振り返る' : '')+'"'+(!reviewable || busy || animating || handoff ? ' disabled' : '')+'><span>'+String(entry.round).padStart(2,'0')+'</span>'+entry.labels.map(label => '<span>'+escape(label)+'</span>').join('')+'</button>').join('') : '<p class="empty-history">双方の一手が揃うと<br>ここに棋譜が残ります。</p>';
  const meaningful = view.lastResolution?.events.filter(event => !['move','blocked','drop_wait'].includes(event.type)) ?? [];
  $('last-event').hidden = !meaningful.length;
  if (meaningful.length && view.lastResolution) $('last-event').textContent = eventText(meaningful.find(event => event.type === 'contact') ?? meaningful[meaningful.length-1],view.lastResolution);
  const finished = !!outcome();
  $('continue-game').hidden = mode !== 'replay' || finished;
  $('show-result').hidden = !finished;
  $('rematch').hidden = !finished || mode === 'online' || mode === 'replay';
  $('back-room').hidden = !finished || mode !== 'online';
  $('resign').hidden = finished || mode === 'replay';
  $('menu-resign').hidden = finished || mode === 'replay';
  $<HTMLButtonElement>('resign').disabled = busy || animating || handoff;
  $<HTMLButtonElement>('export').disabled = busy || animating;
  $<HTMLButtonElement>('import').disabled = busy || mode === 'online' || animating;
  $('handoff').hidden = !handoff;
  $('handoff-title').textContent = names[active]+'さんに交代';
  $('handoff-ready').innerHTML = active+'陣営の入力を始める'+icon('chevron');
  const committed = view.committed[sideIndex(active)];
  const selectedId = selection && 'piece' in selection ? selection.piece : null;
  const selectedPiece = view.position.pieces.find(p => p.id === selectedId);
  $('input-hint').textContent = finished ? '終局 · '+(outcome()!.winner === 'draw' ? '引き分け' : names[outcome()!.winner as Side]+'の勝利') : handoff ? '端末を交代してください' : stageIndex !== null ? '段階リプレイ · 公開済みの局面' : animating ? '双方の駒が同時に動きます' : committed ? '着手を封じました。相手の一手を待っています' : busy ? '処理中…' : pendingChoice ? '成り・昇格を選択' : selection ? (selectedPiece ? symbol(selectedPiece) : symbols[(selection as {kind:Kind}).kind])+'の移動先を選択' : '';
  $('input-hint').parentElement!.classList.toggle('waiting',committed && !finished);
  $('clear-selection').hidden = !selection || busy || animating;
  renderPlayers(); renderBoard(); renderReplay(); renderConnection();
}
async function animateRound(resolution:Resolution):Promise<void> {
  await ensureRoundStart(view!.round);
  const serial = gameSerial; animating = true; clearSelection(); stopPlayback(); tab = 'game';
  stageIndex = null; replayResolution = null; animationResolution = resolution; animationStage = 0;
  effects.begin(); render(); await effects.wait(settings.reduced ? 30 : 140);
  try {
    for (let i=1;i<resolution.frames.length;i++) {
      if (serial !== gameSerial) return;
      animationStage = i; render();
      await effects.wait(settings.reduced ? 50 : 265);
      for (const event of resolution.events.filter(event => event.stage === resolution.frames[i].stage)) {
        if (serial !== gameSerial) return;
        await effects.clash(event,resolution,names,view!.rules,roundStarts.get(view!.round));
      }
    }
    await effects.wait(settings.reduced ? 20 : 100);
  } finally {
    if (serial === gameSerial) {
      animating = false; animationResolution = null; render();
      if (resolution.events.some(event => event.type === 'move' || event.type === 'drop')) effects.sound('move');
    }
  }
}
function rememberRound(resolution:Resolution,round:number):void {
  replayCache.set(round,resolution);
  const entry = {round,labels:(['A','B'] as Side[]).map(side => actionLabel(resolution.actions.find(action => action.side === side)!,resolution.frames[0].pieces,resolution))};
  history = [...history.filter(item => item.round !== round),entry].sort((a,b) => a.round-b.round);
}
async function ensureRoundStart(round:number):Promise<void> {
  if (roundStarts.has(round)) return;
  const replay=mode==='online' ? await net.replay() as Replay : await engine.request<Replay>({cmd:'export'});
  historyEngine ??= new EngineClient();
  const before=await historyEngine.request<MatchView>({cmd:'import',replay:{...replay,rounds:replay.rounds.slice(0,round-1)}});
  roundStarts.set(round,before.position);
}
async function submitAction(action:Action):Promise<void> {
  if (!view) return;
  const round = view.round, submittingSide = active; clearSelection(); stopPlayback(); stageIndex = null;
  roundStarts.set(round+1,view.position);
  if (mode === 'online') {
    const state = await net.request<OnlineState>('move',{round,gameId:onlineState!.room.gameId,action});
    await enqueueOnline(state); return;
  }
  let modelAction:Action|undefined, publicReplay:Replay|undefined;
  if (mode === 'cpu') {
    const serial = gameSerial, stateHash = view.stateHash;
    publicReplay = await engine.request<Replay>({cmd:'export'});
    const result = await savedModels.choose(opponent.id,publicReplay,other(human),aiSeed);
    if (serial !== gameSerial || view.stateHash !== stateHash || result.round !== round || result.model !== opponent.id || result.generation !== opponent.generation || result.action.side !== other(human)) throw new Error('局面またはモデルが変わりました。もう一度着手してください。');
    modelAction = result.action;
  }
  try {
    view = await engine.request<MatchView>({cmd:'submit',side:submittingSide,action});
    if (mode === 'cpu') {
      if (!modelAction) throw new Error('学習モデルの着手を取得できませんでした。');
      view = await engine.request<MatchView>({cmd:'submit',side:other(human),action:modelAction});
      aiSeed++;
    }
  } catch (error) {
    if (publicReplay) { view = await engine.request<MatchView>({cmd:'import',replay:publicReplay}); await loadOptions(); }
    throw error;
  }
  if (view.round > round && view.lastResolution) {
    rememberRound(view.lastResolution,view.round); await animateRound(view.lastResolution);
  }
  if (mode === 'local') { active = other(submittingSide); handoff = !outcome(); }
  await loadOptions();
  if (outcome()) { handoff = false; showResult(); }
  else if (handoff) { render(); $('handoff-ready').focus({preventScroll:true}); }
}
async function openReplay(round:number,atEnd = false):Promise<void> {
  if (!view || !canReview() || round < 1 || round > view.round) return;
  await ensureRoundStart(round);
  settings.history = true; applySettings();
  stopPlayback(); clearSelection();
  let resolution = replayCache.get(round);
  if (!resolution) {
    resolution = mode === 'online' ? await net.replay(round) as Resolution : await engine.request<Resolution>({cmd:'replay_round',round});
    replayCache.set(round,resolution);
  }
  replayResolution = resolution; replayRound = round; stageIndex = atEnd ? resolution.frames.length : 0; tab = 'replay';
  render();
}
function returnLive():void { stopPlayback(); stageIndex = null; replayResolution = null; tab = 'game'; clearSelection(); render(); }
function stepStage(amount:number):void {
  const resolution = currentResolution(); if (!resolution || stageIndex === null) return;
  stageIndex = Math.max(0,Math.min(resolution.frames.length,stageIndex+amount)); render();
}
function showResult(force = false):void {
  const result = outcome(); if (!result || !view) return;
  const key = gameSerial+':'+view.round+':'+result.winner;
  if (!force && key === resultShown) return;
  for (const dialog of document.querySelectorAll<HTMLDialogElement>('dialog[open]')) dialog.close();
  confirmAction = null;
  resultShown = key; stopPlayback(); clearSelection();
  const draw = result.winner === 'draw', victory = !draw && (mode === 'local' || result.winner === human);
  $('result-card').className = 'result-card '+(draw ? 'draw' : victory ? 'victory' : 'defeat');
  $('result-sigil').textContent = draw ? '和' : victory ? '勝' : '敗';
  $('result-kicker').textContent = draw ? 'DRAW' : victory ? 'VICTORY' : 'DEFEAT';
  $('result-title').textContent = draw ? '引き分け' : mode === 'local' ? result.winner+'陣営の勝利' : victory ? '勝利' : '敗北';
  $('result-detail').textContent = reasons[result.reason] ?? result.reason;
  $('result-players').innerHTML = '<span>'+escape(names.A)+'</span><small>vs</small><span>'+escape(names.B)+'</span>';
  $('result-rounds').textContent = view.round+' ROUNDS · '+(mode === 'online' ? 'ONLINE MATCH' : mode === 'cpu' ? 'AI MATCH' : mode === 'local' ? 'LOCAL MATCH' : 'REPLAY');
  $('result-rematch').textContent = mode === 'online' ? 'ルームへ戻って再戦' : mode === 'replay' ? 'AI対戦を始める' : 'もう一度対戦';
  $<HTMLButtonElement>('result-review').disabled = view.round === 0;
  $('result-overlay').hidden = false; $('app').inert = true; document.querySelector<HTMLElement>('.app-header')!.inert = true;
  document.body.classList.add('result-open');
  effects.sound(draw ? 'draw' : victory ? 'win' : 'lose');
  $('result-rematch').focus({preventScroll:true});
}
function confirm(title:string,description:string,label:string,action:()=>void):void {
  $('confirm-title').textContent = title; $('confirm-description').textContent = description;
  $('confirm-accept').textContent = label; confirmAction = action;
  $<HTMLDialogElement>('confirm-dialog').showModal();
}
async function leaveOnline():Promise<void> {
  if (onlineToken && connection !== 'expired') await net.request('leave',{});
  net.stop(); onlineToken = ''; onlineCode = ''; onlineState = null; storage.set('shogi-room',null,true);
}
async function goHome():Promise<void> {
  hideResult(); stopPlayback(); effects.skip();
  if (mode === 'online' && onlineToken) await leaveOnline();
  resetGameUI(); view = null; options = []; setScreen('home');
}
function requestHome():void {
  if (busy || animating) return;
  $<HTMLDialogElement>('menu-dialog').close();
  if (onlineToken && screen !== 'home') {
    confirm('ルームを退出しますか？',outcome() || screen === 'room' ? '再戦する場合は、このルームに残ってください。' : '対局中に退出すると、あなたの負けになります。','退出する',() => void run(goHome));
  } else if (view && mode !== 'replay' && !outcome() && screen === 'game') {
    confirm('対局を終了しますか？','この対局を終了してホームへ戻ります。','ホームへ戻る',() => void run(goHome));
  } else void run(goHome);
}
function requestResign():void {
  if (busy || animating || handoff || outcome() || !view) return;
  $<HTMLDialogElement>('menu-dialog').close();
  confirm('投了しますか？',names[active]+'さんの投了として、対局を終了します。','投了する',() => void run(async () => {
    if (mode === 'online') await enqueueOnline(await net.request<OnlineState>('resign',{gameId:onlineState!.room.gameId}));
    else { localOutcome = {winner:other(active),reason:'resigned'}; options = []; showResult(); }
  }));
}
async function rematch():Promise<void> {
  hideResult();
  if (mode === 'online') {
    await enqueueOnline(await net.request<OnlineState>('return',{gameId:onlineState!.room.gameId}));
    setScreen('room');
  } else if (mode === 'replay') openSetup('cpu');
  else { setupMode = mode; await startGame(); }
}
async function saveReplay():Promise<void> {
  const replay = mode === 'online' ? await net.replay() as Replay : await engine.request<Replay>({cmd:'export'});
  const url = URL.createObjectURL(new Blob([JSON.stringify(replay,null,2)],{type:'application/json'}));
  const link = document.createElement('a'); link.href = url; link.download = 'simultaneous-shogi-r'+(view?.round ?? 0)+'.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url),1000);
}
async function replayHistory(replay:Replay):Promise<HistoryEntry[]> {
  historyEngine ??= new EngineClient();
  await historyEngine.request<MatchView>({cmd:'import',replay});
  await historyEngine.request<MatchView>({cmd:'new',position:replay.initial,rules:replay.rules});
  const result:HistoryEntry[] = [];
  for (const record of replay.rounds) {
    let state:MatchView|undefined;
    for (const action of record.actions) state = await historyEngine.request<MatchView>({cmd:'submit',side:action.side,action});
    const resolution = state!.lastResolution!;
    result.push({round:record.round,labels:(['A','B'] as Side[]).map(side => actionLabel(resolution.actions.find(action => action.side === side)!,resolution.frames[0].pieces,resolution))});
  }
  return result;
}
async function readReplay():Promise<void> {
  const input = $<HTMLInputElement>('replay-file'), file = input.files?.[0]; if (!file) return;
  input.value = ''; if (file.size > 10*1024*1024) throw new Error('棋譜は10MB以内で読み込んでください。');
  let replay:Replay;
  try { replay = JSON.parse(await file.text()) as Replay; }
  catch { throw new Error('棋譜を読み込めません。JSON形式の棋譜ファイルを選んでください。'); }
  let entries:HistoryEntry[];
  try { entries = await replayHistory(replay); }
  catch { throw new Error('棋譜を検証できませんでした。形式・ルール版・内容を確認してください。'); }
  const imported = await engine.request<MatchView>({cmd:'import',replay});
  resetGameUI(); mode = 'replay'; view = imported; active = 'A'; human = 'A'; names = {A:'A陣営',B:'B陣営'}; options = []; history = entries;
  setScreen('game'); if (view.round) await openReplay(1);
}
function requestImport():void {
  if (mode === 'online' && onlineToken) return;
  $<HTMLDialogElement>('menu-dialog').close();
  const open = ():void => $<HTMLInputElement>('replay-file').click();
  if (view && screen === 'game' && !outcome() && mode !== 'replay') confirm('棋譜を開きますか？','有効な棋譜を読み込むと、現在の対局を置き換えます。','棋譜を選ぶ',open);
  else open();
}
async function resumeOnline():Promise<void> {
  const saved = storage.get('shogi-room',true); if (!saved) return;
  let session:{token:string;code:string};
  try { session = JSON.parse(saved) as typeof session; if (!session.token || !/^\d{6}$/.test(session.code)) throw new Error(); }
  catch { storage.set('shogi-room',null,true); throw new Error('保存されたルーム情報を読み込めません。'); }
  onlineToken = session.token; onlineCode = session.code; mode = 'online'; onlineState = null; net.connect(session.token);
  try { await enqueueOnline(await net.request<OnlineState>('state')); }
  catch (error) {
    if (error instanceof NetworkError && error.status === 401) { net.stop(); onlineToken = ''; storage.set('shogi-room',null,true); }
    throw error;
  }
}
function detachHomeConnection():void {
  if (screen === 'home' && onlineToken) { net.stop(); onlineToken = ''; onlineCode = ''; onlineState = null; }
}
async function copy(value:string,label:string):Promise<void> {
  if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(value); $('room-status').textContent = label+'をコピーしました'; }
  else {
    // HTTP LAN play has no Clipboard API; show selectable text instead.
    const input = document.createElement('input'); input.value = value; input.setAttribute('aria-label',label);
    $('room-code-block-fallback')?.remove();
    input.id = 'room-code-block-fallback'; input.readOnly = true; $('copy-link').after(input); input.focus(); input.select();
    $('room-status').textContent = '表示された'+label+'をコピーしてください';
  }
}
function applySettings():void {
  effects.syncAudio();
  document.body.classList.toggle('hide-ranks',!settings.ranks);
  document.body.classList.toggle('reduced-motion',settings.reduced);
  $<HTMLInputElement>('sound-setting').checked = settings.sound;
  $<HTMLInputElement>('rank-setting').checked = settings.ranks;
  $<HTMLInputElement>('motion-setting').checked = settings.reduced;
  $('sound-toggle').innerHTML = icon(settings.sound ? 'sound' : 'muted');
  $('sound-toggle').setAttribute('aria-label','効果音を'+(settings.sound ? 'オフ' : 'オン')+'にする');
  $('sound-toggle').setAttribute('aria-pressed',String(settings.sound));
  storage.set('shogi-settings',JSON.stringify(settings));
}
for (const element of document.querySelectorAll<HTMLElement>('[data-icon]')) element.innerHTML = icon(element.dataset.icon!);
$('mode-cpu').addEventListener('click',() => openSetup('cpu'));
$('mode-local').addEventListener('click',() => openSetup('local'));
$('mode-online').addEventListener('click',() => openOnline());
$('refresh-models').addEventListener('click',() => void refreshModels());
$('model-run').addEventListener('change',() => { fillModelCheckpoints(); modelMessage = ''; render(); });
$('model-checkpoint').addEventListener('change',() => { modelMessage = ''; render(); });
for (const id of ['setup-back','online-back']) $(id).addEventListener('click',() => setScreen('home'));
for (const id of ['home-nav','game-home','menu-home','result-home','room-leave']) $(id).addEventListener('click',requestHome);
$('setup-form').addEventListener('submit',event => { event.preventDefault(); void run(startGame); });
$('create-tab').addEventListener('click',() => { joinMode = false; renderOnlineForm(); });
$('join-tab').addEventListener('click',() => { joinMode = true; renderOnlineForm(); });
$('online-form').addEventListener('submit',event => {
  event.preventDefault();
  void run(async () => {
    const name = $<HTMLInputElement>('player-name').value.trim();
    if (!name || [...name].length > 20) throw new Error('プレイヤー名は1〜20文字で入力してください。');
    const code = $<HTMLInputElement>('room-code').value;
    const entry = await OnlineClient.enter(joinMode ? 'join' : 'rooms',{name,...(joinMode ? {code} : {})});
    storage.set('shogi-name',name); await enterOnline(entry);
  });
});
$('room-code').addEventListener('input',() => {
  const input = $<HTMLInputElement>('room-code'); input.value = input.value.replace(/[０-９]/g,c => String.fromCharCode(c.charCodeAt(0)-0xfee0)).replace(/\D/g,'').slice(0,6);
});
$('room-ready').addEventListener('click',() => void run(async () => {
  await enqueueOnline(await net.request<OnlineState>('ready',{ready:!onlineState?.room.players[sideIndex(human)]?.ready}));
}));
$('resume-online').addEventListener('click',() => void run(resumeOnline));
$('copy-code').addEventListener('click',() => void run(() => copy(onlineCode,'部屋番号')));
$('copy-link').addEventListener('click',() => void run(() => copy(location.origin+location.pathname+'?room='+onlineCode,'招待リンク')));
$('board').addEventListener('click',event => {
  if (!canInput() || !view) return;
  const cell = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-x]'); if (!cell) return;
  const at:Square = [Number(cell.dataset.x),Number(cell.dataset.y)];
  const candidates = selectedOptions().filter(option => same(option.action.to,at));
  if (selection && candidates.length) {
    const option = candidates.find(option => option.action.type === 'drop' || option.action.choice === 'none')!;
    const selectedId = selection && 'piece' in selection ? selection.piece : null;
    const p = view.position.pieces.find(piece => piece.id === selectedId);
    if (p && offersChange(p,option)) {
      pendingChoice = {piece:p,to:at,options:candidates}; render();
      $('choice-popover').querySelector<HTMLButtonElement>('[data-choice]')?.focus({preventScroll:true});
    } else void run(() => submitAction(option.action));
  } else {
    const p = view.position.pieces.find(piece => piece.side === active && same(piece.at,at));
    if (!p) { clearSelection(); render(); return; }
    if (selection && 'piece' in selection && selection.piece === p.id) clearSelection();
    else selection = {piece:p.id};
    render(); $('board').querySelector<HTMLButtonElement>('[data-x="'+at[0]+'"][data-y="'+at[1]+'"]')?.focus({preventScroll:true});
  }
});
for (const id of ['hand-top','hand-bottom']) $(id).addEventListener('click',event => {
  if (!canInput()) return;
  const target = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-kind]');
  if (!target || target.dataset.side !== active) return;
  const kind = target.dataset.kind as Kind;
  selection = selection && 'kind' in selection && selection.kind === kind ? null : {kind}; pendingChoice = null; render();
});
$('choice-popover').addEventListener('click',event => {
  const target = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
  if (!target || !pendingChoice) return;
  if (target.hasAttribute('data-choice-cancel')) { pendingChoice = null; render(); return; }
  if (!canAct()) return;
  const chosen = pendingChoice.options.find(option => option.action.type === 'move' && option.action.choice === target.dataset.choice);
  if (chosen) void run(() => submitAction(chosen.action));
});
$('clear-selection').addEventListener('click',() => { clearSelection(); render(); });
$('board').addEventListener('pointerover',event => {
  if (!selection || !canInput()) return;
  const cell = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-x]'); if (!cell) return;
  const candidate = selectedOptions().find(option => same(option.action.to,[Number(cell.dataset.x),Number(cell.dataset.y)]));
  if (candidate) $('input-hint').textContent = conditionText(candidate.conditions) || square(candidate.action.to)+'へ移動';
});
$('board').addEventListener('pointerleave',() => {
  if (selection && !pendingChoice && !busy) {
    const p = 'piece' in selection ? view?.position.pieces.find(p => p.id === (selection as {piece:string}).piece) : undefined;
    $('input-hint').textContent = (p ? symbol(p) : '持ち駒')+'の移動先を選択';
  }
});
$('handoff-ready').addEventListener('click',() => {
  handoff = false; render();
  const p = view?.position.pieces.find(piece => piece.side === active);
  if (p) $('board').querySelector<HTMLButtonElement>('[data-x="'+p.at[0]+'"][data-y="'+p.at[1]+'"]')?.focus({preventScroll:true});
});
$('skip-effects').addEventListener('click',() => effects.skip());
$('tab-game').addEventListener('click',returnLive);
$('tab-replay').addEventListener('click',() => void run(() => openReplay(view?.round ?? 0)));
$('return-live').addEventListener('click',returnLive);
$('history').addEventListener('click',event => {
  const row = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-round]');
  if (row && canReview() && !animating && !handoff) void run(() => openReplay(Number(row.dataset.round)));
});
$('replay-round').addEventListener('change',() => {
  const round = Number($<HTMLSelectElement>('replay-round').value);
  void run(() => openReplay(round));
});
$('stage-slider').addEventListener('input',() => { stopPlayback(); stageIndex = Number($<HTMLInputElement>('stage-slider').value); render(); });
$('stage-prev').addEventListener('click',() => { stopPlayback(); stepStage(-1); });
$('stage-next').addEventListener('click',() => { stopPlayback(); stepStage(1); });
$('play').addEventListener('click',() => {
  if (playback) { stopPlayback(); return; }
  const resolution = currentResolution(); if (!resolution) return;
  if (stageIndex === null || stageIndex >= resolution.frames.length) stageIndex = 0;
  $('play').textContent = 'Ⅱ 一時停止'; render();
  playback = setInterval(() => { stepStage(1); if (stageIndex === resolution.frames.length) stopPlayback(); },650);
});
$('resign').addEventListener('click',requestResign); $('menu-resign').addEventListener('click',requestResign);
for (const id of ['rematch','back-room','result-rematch']) $(id).addEventListener('click',() => void run(rematch));
$('show-result').addEventListener('click',() => showResult(true));
$('result-final').addEventListener('click',() => { hideResult(); returnLive(); $('show-result').focus({preventScroll:true}); });
$('result-review').addEventListener('click',() => { hideResult(); void run(() => openReplay(1)); });
$('continue-game').addEventListener('click',() => void run(async () => {
  opponent = await prepareOpponent(view?.rules);
  mode = 'cpu'; human = 'A'; active = human; names = {A:'あなた',B:opponent.type === 'model' ? '学習AI · 第'+opponent.generation+'世代' : '対戦AI'}; aiSeed = Math.floor(Math.random()*0x100000000);
  returnLive(); await loadOptions();
}));
$('export').addEventListener('click',() => { $<HTMLDialogElement>('menu-dialog').close(); void run(saveReplay); });
$('import').addEventListener('click',requestImport); $('import-home').addEventListener('click',requestImport);
$('replay-file').addEventListener('change',() => void run(readReplay));
$('rules-open').innerHTML = icon('help'); $('settings-open').innerHTML = icon('settings');
$('rules-open').addEventListener('click',() => $<HTMLDialogElement>('rules-dialog').showModal());
$('settings-open').addEventListener('click',() => $<HTMLDialogElement>('settings-dialog').showModal());
$('menu-open').addEventListener('click',() => $<HTMLDialogElement>('menu-dialog').showModal());
$('menu-rules').addEventListener('click',() => { $<HTMLDialogElement>('menu-dialog').close(); $<HTMLDialogElement>('rules-dialog').showModal(); });
$('menu-settings').addEventListener('click',() => { $<HTMLDialogElement>('menu-dialog').close(); $<HTMLDialogElement>('settings-dialog').showModal(); });
for (const button of document.querySelectorAll<HTMLElement>('[data-close]')) button.addEventListener('click',() => $<HTMLDialogElement>(button.dataset.close!).close());
for (const dialog of document.querySelectorAll<HTMLDialogElement>('dialog')) dialog.addEventListener('click',event => { if (event.target === dialog) { const box = dialog.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close(); } });
$('confirm-cancel').addEventListener('click',() => { confirmAction = null; $<HTMLDialogElement>('confirm-dialog').close(); });
$('confirm-accept').addEventListener('click',() => { const action = confirmAction; confirmAction = null; $<HTMLDialogElement>('confirm-dialog').close(); action?.(); });
$('error-close').addEventListener('click',hideError);
$('sound-toggle').addEventListener('click',() => { settings.sound = !settings.sound; applySettings(); effects.sound('move'); });
$('history-toggle').innerHTML = icon('record');
$('history-toggle').addEventListener('click',() => { settings.history = !settings.history; applySettings(); render(); });
document.addEventListener('pointerdown',() => effects.unlockAudio(),{passive:true});
document.addEventListener('keydown',() => effects.unlockAudio());
for (const key of ['sound','rank','motion'] as const) $(key+'-setting').addEventListener('change',() => {
  const checked = $<HTMLInputElement>(key+'-setting').checked;
  if (key === 'sound') settings.sound = checked; else if (key === 'rank') settings.ranks = checked; else settings.reduced = checked;
  applySettings(); if (key === 'sound') effects.sound('move');
});
document.addEventListener('keydown',event => {
  if (document.querySelector('dialog[open]')) return;
  const modal = !$('result-overlay').hidden ? $('result-overlay') : !$('clash-overlay').hidden ? $('clash-overlay') : handoff ? $('handoff') : pendingChoice ? $('choice-popover') : null;
  if (event.key === 'Tab' && modal) {
    const buttons = [...modal.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]; if (!buttons.length) return;
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.shiftKey && index <= 0) { event.preventDefault(); buttons[buttons.length-1].focus(); }
    else if (!event.shiftKey && (index < 0 || index === buttons.length-1)) { event.preventDefault(); buttons[0].focus(); }
  }
  if (event.key === 'Escape') {
    if (!$('clash-overlay').hidden) effects.skip();
    else if (!$('result-overlay').hidden) { hideResult(); returnLive(); $('show-result').focus({preventScroll:true}); }
    else if (pendingChoice) { pendingChoice = null; render(); }
    else if (selection) { clearSelection(); render(); }
    else if (stageIndex !== null) returnLive();
  }
  const cell = (event.target as HTMLElement).closest<HTMLButtonElement>('#board [data-x]');
  if (cell && /^Arrow/.test(event.key) && canInput()) {
    event.preventDefault(); const flip = perspective() === 'B' ? 1 : -1;
    const x = Number(cell.dataset.x)+(event.key === 'ArrowRight' ? flip : event.key === 'ArrowLeft' ? -flip : 0);
    const y = Number(cell.dataset.y)+(event.key === 'ArrowDown' ? -flip : event.key === 'ArrowUp' ? flip : 0);
    $('board').querySelector<HTMLButtonElement>('[data-x="'+x+'"][data-y="'+y+'"]')?.focus();
  }
});
document.addEventListener('visibilitychange',() => { if (document.hidden) { stopPlayback(); if (animating) effects.skip(); } });
systemReduced.addEventListener('change',event => { if (event.matches) { settings.reduced = true; applySettings(); } });
setInterval(() => { if (screen === 'game') renderConnection(); },1000);
applySettings(); setScreen('home');
const invite = new URL(location.href).searchParams.get('room');
if (storage.get('shogi-room',true)) void run(resumeOnline);
else if (invite && /^\d{6}$/.test(invite)) { openOnline(true); $<HTMLInputElement>('room-code').value = invite; }
