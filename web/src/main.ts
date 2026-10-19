import { EngineClient } from './client.js';
import type { Action, ActionOption, Choice, Event, Kind, MatchView, Piece, Policy, Replay, Resolution, Side, Square } from './types.js';

const $ = <T extends HTMLElement = HTMLElement>(id:string):T => {
  const element = document.getElementById(id); if (!element) throw new Error(`Missing element: ${id}`); return element as T;
};
const symbols:Record<Kind,string> = {K:'王',P:'歩',L:'香',N:'桂',S:'銀',G:'金',R:'飛',B:'角'};
const promoted:Partial<Record<Kind,string>> = {P:'と',L:'杏',N:'圭',S:'全',R:'龍',B:'馬'};
const baseRank:Record<Kind,number> = {K:0,P:1,L:2,N:3,S:4,G:5,R:6,B:6};
const rank = (p:Piece) => baseRank[p.kind] + Number(p.upgraded && !p.promoted);
const symbol = (p:Piece) => p.promoted ? promoted[p.kind] ?? symbols[p.kind] : symbols[p.kind];
const square = (q:Square) => `${q[0]}${'一二三四五六七八九'[q[1]-1]}`;
const same = (a:Square,b:Square) => a[0] === b[0] && a[1] === b[1];
const escape = (s:string) => s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const engine = new EngineClient();
let view:MatchView;
let mode:'cpu'|'local' = 'cpu';
let active:Side = 'A';
let options:ActionOption[] = [];
let selection:{piece:string}|{kind:Kind}|null = null;
let destination:Square|null = null;
let choice:Choice = 'none';
let busy = false;
let handoff = false;
let stageIndex:number|null = null;
let tab:'input'|'replay' = 'input';
let timer:ReturnType<typeof setInterval>|undefined;
let aiSeed = 1;
let replayResolution:Resolution|null = null;
let replayRound = 0;
const displayedResolution = () => tab === 'replay' && replayResolution ? replayResolution : view.lastResolution;

function selectedOptions():ActionOption[] {
  return options.filter(o=>selection && ('piece' in selection ? o.action.type === 'move' && o.action.piece === selection.piece : o.action.type === 'drop' && o.action.kind === selection.kind));
}
function intent():ActionOption|undefined {
  return selectedOptions().find(o=>destination && same(o.action.to,destination) && (o.action.type === 'drop' || o.action.choice === choice));
}
function pieceFor(id?:string):Piece|undefined {
  const r = displayedResolution();
  return r?.pieces.find(p=>p.id === id) ?? r?.frames.flatMap(f=>f.pieces).find(p=>p.id === id) ?? view.position.pieces.find(p=>p.id === id);
}
function actorName(id?:string):string { const p = pieceFor(id); return p ? `${p.side}${symbol(p)}` : '駒'; }
function actionName(a:Action):string {
  return `${a.side}：${a.type === 'drop' ? `${symbols[a.kind]}打ち` : actorName(a.piece).slice(1)} → ${square(a.to)}${a.type === 'move' && a.choice !== 'none' ? a.choice === 'promote' ? '（成り希望）' : '（昇格希望）' : ''}`;
}
function canInput():boolean { return !!view && !busy && !view.outcome && !handoff && stageIndex === null; }
function clearSelection():void { selection = null; destination = null; choice = 'none'; }
function stopPlayback():void { if (timer) clearInterval(timer); timer = undefined; $('play').textContent = '▶ 再生'; }
function setTab(next:'input'|'replay'):void {
  tab = next;
  if (tab === 'input') { stageIndex = null; replayResolution = null; stopPlayback(); }
  else if (view.lastResolution && stageIndex === null) { stageIndex = 0; replayRound = view.round; }
  render();
}
function showError(error:unknown):void { $('error').textContent = error instanceof Error ? error.message : String(error); $('error').hidden = false; }
async function run(work:()=>Promise<void>):Promise<void> {
  if (busy) return; busy = true; $('error').hidden = true; if (view) render();
  try { await work(); } catch (error) { showError(error); }
  finally { busy = false; if (view) render(); }
}
async function loadOptions():Promise<void> { options = await engine.request<ActionOption[]>({cmd:'actions',side:active}); }
async function startGame():Promise<void> {
  stopPlayback(); clearSelection(); active = 'A'; handoff = false; stageIndex = null; tab = 'input'; aiSeed = 1; replayResolution = null; replayRound = 0;
  view = await engine.request<MatchView>({cmd:'new'}); await loadOptions();
  $('engine-status').textContent = 'Rust / WebAssembly · 準備完了';
}

function renderBoard():void {
  const resolution = displayedResolution();
  const frame = stageIndex !== null && resolution ? resolution.frames[stageIndex] : undefined;
  const displayedPosition = stageIndex !== null && resolution ? resolution : view.position;
  const pieces = frame?.pieces ?? displayedPosition.pieces;
  const flipped = mode === 'local' && active === 'B';
  const files = Array.from({length:9},(_,i)=>flipped ? i+1 : 9-i);
  const ranks = Array.from({length:9},(_,i)=>flipped ? 9-i : i+1);
  $('files').innerHTML = files.map(n=>`<span>${n}</span>`).join('');
  $('ranks').innerHTML = ranks.map(n=>`<span>${'一二三四五六七八九'[n-1]}</span>`).join('');
  const candidates = canInput() ? selectedOptions() : [];
  const current = intent();
  const latest = view.lastResolution?.actions ?? [];
  const actualEnds = latest.flatMap(a=>a.type === 'move' ? view.position.pieces.filter(p=>p.id === a.piece).map(p=>p.at) : []);
  $('board').innerHTML = ranks.flatMap(y=>files.map(x=>{
    const q:Square = [x,y]; const p = pieces.find(p=>same(p.at,q));
    const classes = ['cell'];
    if (candidates.some(o=>same(o.action.to,q))) classes.push('available');
    if (stageIndex === null && current?.path.some(at=>same(at,q))) classes.push('path');
    if (stageIndex === null && destination && same(destination,q)) classes.push('destination');
    if (stageIndex === null && selection && 'piece' in selection && p?.id === selection.piece) classes.push('selected');
    if (stageIndex === null && !selection && actualEnds.some(at=>same(at,q))) classes.push('last');
    const name = `${square(q)}${p ? ` ${p.side} ${symbol(p)} 格${rank(p)}` : ' 空きマス'}`;
    return `<button class="${classes.join(' ')}" data-x="${x}" data-y="${y}" aria-label="${name}" ${canInput() ? '' : 'disabled'}>${p ? `<span class="piece ${p.side === (flipped?'B':'A') ? '' : 'enemy'} ${p.promoted?'promoted':''} ${p.upgraded?'upgraded':''}"><span class="piece-symbol">${symbol(p)}</span><span class="rank-badge">${rank(p)}</span></span>` : ''}</button>`;
  })).join('');
  for (const side of ['A','B'] as Side[]) {
    const atTop = side === (flipped?'A':'B');
    const el = $(atTop ? 'hand-b' : 'hand-a');
    const kinds = (Object.entries(displayedPosition.hands[side]) as [Kind,number][]).filter(([,n])=>n>0);
    el.innerHTML = `<span class="hand-label">${side} 持ち駒</span>` + (stageIndex !== null && resolution && stageIndex < resolution.frames.length ? '<span>再生中は盤面を表示</span>' : kinds.length ? kinds.map(([kind,n])=>`<button class="hand-piece ${selection && 'kind' in selection && selection.kind === kind && side === active ? 'selected':''}" data-side="${side}" data-kind="${kind}" aria-label="${side} 持ち駒 ${symbols[kind]} ${n}枚" ${canInput() && side === active ? '' : 'disabled'}>${symbols[kind]}<small>${n}</small></button>`).join('') : '<span>なし</span>');
  }
}
function outcomeText():string {
  if (!view.outcome) return '';
  const reasons:Record<string,string> = {king_captured:'王を捕獲',king_captor_lost:'王の捕獲者を取り返し',both_kings:'双方の王を捕獲',repetition:'同一局面が4回',round_limit:'ラウンド上限'};
  return `${view.outcome.winner === 'draw' ? '引き分け' : `${view.outcome.winner}陣営の勝利`} · ${reasons[view.outcome.reason] ?? view.outcome.reason}`;
}
function renderInput():void {
  const current = intent();
  const selectedId = selection && 'piece' in selection ? selection.piece : undefined;
  const selected = view.position.pieces.find(p=>p.id === selectedId);
  $('selection-title').textContent = view.outcome ? outcomeText().split(' · ')[0] : selection ? `${selected ? symbol(selected) : symbols[(selection as {kind:Kind}).kind]}の${destination ? '着手を確認' : '目的地を選択'}` : '駒を選んでください';
  $('selection-description').textContent = view.outcome ? outcomeText().split(' · ')[1] : selection ? '点のあるマスを指定できます。味方のいるマスや、障害の先も条件付きで指定できます。' : '盤上の自分の駒、または持ち駒を選んで、目的地を指定します。';
  $('intent-card').hidden = !current;
  $('intent-card').innerHTML = current ? `${escape(actionName(current.action))}<small>予定経路 ${current.path.map(square).join(' → ')}</small>` : '';
  let clear = document.getElementById('clear-selection');
  if (!clear) {
    clear = document.createElement('button'); clear.id = 'clear-selection'; clear.className = 'text-button'; clear.textContent = '選択を解除';
    clear.addEventListener('click',()=>{clearSelection();render();}); $('intent-card').after(clear);
  }
  clear.hidden = !selection;
  const change = $<HTMLSelectElement>('choice');
  change.value = choice; change.disabled = !canInput() || !selected || selected.promoted || ['K','G'].includes(selected.kind);
  change.options[2].disabled = !!selected?.upgraded;
  const conditionNames:Record<string,string> = {friendly_removal:'味方の駒が取られた場合に進入',enemy_departure_or_capture:'敵が残れば捕獲してその場で停止',enemy_departure:'開始時の敵が退いた場合に配置',nifu_removal:'同筋の未成歩が取られ、二歩が解消すれば配置'};
  const conditions = current?.conditions ?? [];
  $('conditions').innerHTML = conditions.map(c=>{const [key,at] = c.split(':'); return `<p>◇ ${conditionNames[key] ?? escape(key)}${at ? `（${square(at.split(',').map(Number) as Square)}）` : ''}</p>`;}).join('') + (current?.action.type === 'move' && choice !== 'none' ? '<p>◇ 実際の到達位置に資格がある場合に変更。強制成りは優先されます。</p>' : '');
  const commit = $<HTMLButtonElement>('commit');
  commit.disabled = busy || handoff || !view.outcome && !current;
  commit.innerHTML = view.outcome ? '新しい対局 <span>↗</span>' : busy ? '同時解決中…' : '着手を確定 <span>→</span>';
}
function eventText(e:Event):string {
  switch (e.type) {
    case 'move': return `${actorName(e.actor)} → ${square(e.to!)}`;
    case 'blocked': return `${actorName(e.actor)}は味方障害のため待機`;
    case 'contact': return `${e.mode === 'swap' ? '位置を交換して接触' : '同じマスで接触'}。${e.reason === 'rank' ? `開始時の格 ${e.ranks?.join(' 対 ')} を比較` : e.reason === 'chain' ? '味方除去による連戦' : '停止駒への通常捕獲'}${e.winner ? `、${actorName(e.winner)}が勝利` : '、同格相討ち'}`;
    case 'capture': return `${actorName(e.captor)}が${actorName(e.victim)}を捕獲${e.reason === 'drop' ? '（盤上駒を優先）' : e.reason === 'chain' ? '（連戦）' : ''}`;
    case 'drop': return `${actorName(e.actor)}を${square(e.to!)}に配置`;
    case 'drop_wait': return `${e.side}${symbols[e.kind!]}の打ちは${e.reason === 'nifu' ? '二歩の解消' : '空き'}を待機`;
    case 'drop_failure': return `${e.side}${symbols[e.kind!]}の打ちは不成立。持ち駒を保持`;
    case 'drop_duel': return `同時打ちは${actorName(e.winner ?? undefined)}が勝利`;
    case 'equal_drop_failure': return '同格の同時打ちは双方保持。次ラウンドの再打ちを禁止';
    case 'forced_promotion': return `${actorName(e.actor)}が強制成り`;
    case 'promotion': return `${actorName(e.actor)}が成り`;
    case 'upgrade': return `${actorName(e.actor)}が昇格、格 +1`;
    default: return e.type;
  }
}
function renderReplay():void {
  const r = displayedResolution();
  $('replay-dot').hidden = !r;
  $('replay-controls').hidden = !r;
  $('replay-title').textContent = r ? `ラウンド ${tab === 'replay' ? replayRound : view.round} の記録` : 'まだ着手はありません';
  if (!r) return;
  const roundSelect = $<HTMLSelectElement>('replay-round');
  roundSelect.innerHTML = Array.from({length:view.round},(_,i)=>`<option value="${i+1}">ラウンド ${i+1}</option>`).join('');
  roundSelect.value = String(tab === 'replay' ? replayRound : view.round); roundSelect.disabled = busy;
  $('revealed-actions').textContent = '予定：' + r.actions.map(actionName).join(' ／ ');
  const index = stageIndex ?? r.frames.length;
  const slider = $<HTMLInputElement>('stage'); slider.max = String(r.frames.length); slider.value = String(index);
  $('stage-label').textContent = index === 0 ? '開始局面' : index === r.frames.length ? '確定局面' : `段階 ${r.frames[index].stage}`;
  $<HTMLButtonElement>('stage-prev').disabled = index === 0;
  $<HTMLButtonElement>('stage-next').disabled = index === r.frames.length;
  const plans = index < r.frames.length ? r.frames[index].plans : [];
  $('plan-details').innerHTML = index === r.frames.length ? r.actions.map(a=>{
    const originalIds = new Set(r.frames[0].pieces.map(p=>p.id));
    const p = a.type === 'move' ? r.pieces.find(p=>p.id === a.piece) : r.pieces.find(p=>p.side === a.side && p.kind === a.kind && !originalIds.has(p.id));
    const failedDrop = a.type === 'drop' && r.events.some(e=>e.side === a.side && (e.type === 'drop_failure' || e.type === 'equal_drop_failure'));
    const equalDrop = a.type === 'drop' && r.events.some(e=>e.type === 'equal_drop_failure');
    return `<p>${a.side} 実結果：${p ? square(p.at) : failedDrop || equalDrop ? '打ち不成立・持ち駒保持' : '被捕獲'}</p>`;
  }).join('') : plans.map(p=>`<p>${actorName(p.actor)}：${square(p.from)} → ${square(p.proposed)}${p.blocker ? '（味方障害で待機）' : p.finished ? '（停止済み）' : ''}</p>`).join('');
  const events = r.events.filter(e=>index === r.frames.length || e.stage <= r.frames[index].stage);
  $('events').innerHTML = events.length ? events.map(e=>`<div class="event"><span class="event-step">${String(e.stage).padStart(2,'0')}</span><span>${escape(eventText(e))}</span></div>`).join('') : '<p class="muted">スライダーで次の段階へ進めます。</p>';
}
function render():void {
  if (!view) return;
  $('round-number').textContent = String(view.outcome ? view.round : view.round+1).padStart(2,'0');
  $('round-status').textContent = view.outcome ? outcomeText() : busy ? '処理中…' : handoff ? '画面を交代してください' : `${active}陣営が選択中`;
  $('board-title').textContent = stageIndex !== null ? `ラウンド ${replayRound} を再生` : view.outcome ? outcomeText().split(' · ')[0] : `${active}陣営の手を選択`;
  $('board-mode').textContent = stageIndex !== null ? '段階リプレイ' : '対局盤';
  $('board-tag').textContent = view.outcome ? '終局' : stageIndex !== null ? '公開済み' : '秘密入力';
  for (const side of ['A','B'] as Side[]) {
    const el = $(`player-${side.toLowerCase()}`); const committed = view.committed[side === 'A'?0:1];
    el.querySelector('strong')!.textContent = side === 'A' ? mode === 'cpu' ? 'あなた' : 'A陣営' : mode === 'cpu' ? '対戦AI' : 'B陣営';
    const status = el.querySelector('.commit-state')!; status.textContent = view.outcome ? '終了' : committed ? '確定済み ✓' : side === active ? '選択中' : '待機'; status.classList.toggle('ready',committed);
  }
  for (const kind of ['cpu','local'] as const) { $(`mode-${kind}`).classList.toggle('active',mode === kind); $<HTMLButtonElement>(`mode-${kind}`).disabled = busy; }
  $<HTMLSelectElement>('policy').disabled = busy || mode === 'local';
  $<HTMLButtonElement>('new-game').disabled = busy;
  $<HTMLButtonElement>('export').disabled = busy;
  $<HTMLButtonElement>('import').disabled = busy;
  $('handoff').hidden = !handoff;
  $('handoff-title').textContent = `${active}陣営へ交代してください`;
  $('handoff-ready').textContent = `${active}陣営の入力を始める →`;
  $('tab-input').classList.toggle('active',tab === 'input'); $('tab-replay').classList.toggle('active',tab === 'replay');
  $<HTMLButtonElement>('tab-input').disabled = busy; $<HTMLButtonElement>('tab-replay').disabled = busy;
  $('input-panel').hidden = tab !== 'input'; $('replay-panel').hidden = tab !== 'replay';
  renderInput(); renderBoard(); renderReplay();
}

$('board').addEventListener('click',event=>{
  if (!canInput()) return;
  const cell = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-x]'); if (!cell) return;
  const q:Square = [Number(cell.dataset.x),Number(cell.dataset.y)];
  if (selection && selectedOptions().some(o=>same(o.action.to,q))) destination = q;
  else {
    const p = view.position.pieces.find(p=>p.side === active && same(p.at,q)); if (!p) return;
    if (selection && 'piece' in selection && selection.piece === p.id) clearSelection();
    else {selection = {piece:p.id}; destination = null; choice = 'none';}
  }
  render();
});
for (const id of ['hand-a','hand-b']) $(id).addEventListener('click',event=>{
  if (!canInput()) return;
  const target = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-kind]');
  if (!target || target.dataset.side !== active) return;
  selection = {kind:target.dataset.kind as Kind}; destination = null; choice = 'none'; render();
});
$('choice').addEventListener('change',()=>{choice = $<HTMLSelectElement>('choice').value as Choice;render();});
$('commit').addEventListener('click',()=>void run(async()=>{
  if (view.outcome) {await startGame();return;}
  const chosen = intent(); if (!chosen) return;
  const action = chosen.action; clearSelection(); stopPlayback(); stageIndex = null; replayResolution = null;
  view = await engine.request<MatchView>({cmd:'submit',side:active,action});
  if (mode === 'cpu') {
    view = await engine.request<MatchView>({cmd:'submit_ai',side:'B',policy:$<HTMLSelectElement>('policy').value as Policy,seed:aiSeed++});
    active = 'A';
  } else { active = active === 'A' ? 'B' : 'A'; handoff = !view.outcome; }
  await loadOptions();
}));
$('handoff-ready').addEventListener('click',()=>{handoff = false;render();});
$('new-game').addEventListener('click',()=>void run(startGame));
for (const kind of ['cpu','local'] as const) $(`mode-${kind}`).addEventListener('click',()=>void run(async()=>{mode = kind;await startGame();}));
$('tab-input').addEventListener('click',()=>setTab('input'));
$('tab-replay').addEventListener('click',()=>setTab('replay'));
$('return-input').addEventListener('click',()=>setTab('input'));
$('stage').addEventListener('input',()=>{stopPlayback();stageIndex = Number($<HTMLInputElement>('stage').value);render();});
function step(amount:number):void {const r = displayedResolution();if (!r)return;stageIndex = Math.max(0,Math.min(r.frames.length,(stageIndex ?? r.frames.length)+amount));render();}
$('stage-prev').addEventListener('click',()=>{stopPlayback();step(-1);});
$('stage-next').addEventListener('click',()=>{stopPlayback();step(1);});
$('play').addEventListener('click',()=>{
  if (timer) {stopPlayback();return;} const r = displayedResolution();if (!r)return;
  if (stageIndex === null || stageIndex >= r.frames.length) stageIndex = 0;
  $('play').textContent = 'Ⅱ 一時停止'; render();
  timer = setInterval(()=>{step(1);if (stageIndex === r.frames.length)stopPlayback();},800);
});
$('export').addEventListener('click',()=>void run(async()=>{
  const replay = await engine.request<Replay>({cmd:'export'});
  const url = URL.createObjectURL(new Blob([JSON.stringify(replay,null,2)],{type:'application/json'}));
  const a = document.createElement('a');a.href = url;a.download = `simultaneous-shogi-r${view.round}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}));
$('import').addEventListener('click',()=>$<HTMLInputElement>('replay-file').click());
$('replay-file').addEventListener('change',()=>void run(async()=>{
  const input = $<HTMLInputElement>('replay-file');const file = input.files?.[0];if (!file)return;
  input.value = '';if(file.size > 10*1024*1024)throw new Error('棋譜は10MB以内で読み込んでください。');
  const replay = JSON.parse(await file.text()) as Replay;
  const imported = await engine.request<MatchView>({cmd:'import',replay});
  view = imported; stopPlayback(); clearSelection();mode = 'cpu';active = 'A';handoff = false;stageIndex = null;tab = 'input';aiSeed = view.round+1;replayResolution = null;replayRound = 0;await loadOptions();
}));
$('replay-round').addEventListener('change',()=>{
  const round = Number($<HTMLSelectElement>('replay-round').value);
  void run(async()=>{
  stopPlayback();
  const result = await engine.request<Resolution>({cmd:'replay_round',round});
  replayResolution = result;replayRound = round;stageIndex = 0;
  });
});
$('rules-open').addEventListener('click',()=>$<HTMLDialogElement>('rules-dialog').showModal());
$('rules-close').addEventListener('click',()=>$<HTMLDialogElement>('rules-dialog').close());
void run(startGame);
