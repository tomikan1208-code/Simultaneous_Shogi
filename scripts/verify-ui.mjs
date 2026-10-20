import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Worker as NodeWorker } from 'node:worker_threads';
import { Window } from 'happy-dom';
import { createFixtures } from './test-fixtures.mjs';
import { describeClash } from '../web/dist/effects.js';
const window = new Window({url:'http://127.0.0.1:5173',settings:{enableFileSystemHttpRequests:false,disableCSSFileLoading:true,disableJavaScriptFileLoading:true}});
const workers = [], intervals = [];
for (const name of ['window','document','location','navigator','localStorage','sessionStorage']) globalThis[name] = name === 'window' ? window : window[name];
globalThis.matchMedia = window.matchMedia.bind(window);
const interval = globalThis.setInterval;
globalThis.setInterval = (...args) => { const id = interval(...args); intervals.push(id); return id; };
window.localStorage.setItem('shogi-settings',JSON.stringify({reduced:true}));
globalThis.Worker = class {
  constructor(url) {
    this.worker = new NodeWorker(new URL('./ui-worker.mjs',import.meta.url),{workerData:{module:url.href}});
    workers.push(this.worker);
    this.worker.on('message',data=>this.onmessage?.({data}));
    this.worker.on('error',error=>{console.error(error);this.onerror?.(error);});
  }
  postMessage(data) {this.worker.postMessage(data);}
};
window.document.write(readFileSync(new URL('../web/public/index.html',import.meta.url),'utf8'));
const $ = id => window.document.getElementById(id);
const cell = (x,y) => window.document.querySelector('#board [data-x="'+x+'"][data-y="'+y+'"]');
const click = element => {assert.ok(element,'Expected clickable element');assert.notEqual(element.disabled,true,'Disabled: '+(element.id || element.getAttribute('aria-label')));assert.equal(element.closest('[hidden]'),null,'Hidden: '+element.id);element.click();};
async function until(check,label) {
  const limit = Date.now()+15000;
  while(!check()) {if(Date.now()>limit)throw new Error('Timed out: '+label+'. Error: '+$('error-text').textContent);await new Promise(resolve=>setTimeout(resolve,10));}
}
const ready = () => !$('start-game').disabled;
const round = number => until(()=>$('round-number').textContent===String(number).padStart(2,'0')&&ready(),'round '+number);
const changeFile = async replay => {
  const file = new window.File([JSON.stringify(replay)],'test.json',{type:'application/json'});
  Object.defineProperty($('replay-file'),'files',{value:[file],configurable:true});
  $('replay-file').dispatchEvent(new window.Event('change'));
  await until(ready,'import complete');
};
try {
  await import('../web/dist/main.js');
  assert.equal($('home-screen').hidden,false); assert.equal($('game-screen').hidden,true);
  assert.equal($('commit'),null,'No confirm-move button exists');
  click($('mode-cpu'));assert.equal($('setup-screen').hidden,false);click($('start-game'));
  await until(()=>$('game-screen').hidden===false&&ready(),'AI setup/start');
  assert.equal(window.document.querySelectorAll('#board .piece').length,40);
  click(cell(7,7));assert.ok(cell(7,6).classList.contains('available'));
  click(cell(7,6));await round(2);
  assert.equal(window.document.querySelectorAll('.history-row').length,1);assert.equal($('error').hidden,true);
  assert.equal($('tab-replay').hidden,true);assert.equal($('tab-replay').disabled,true);
  assert.equal(window.document.querySelector('.history-row').disabled,true,'live history is read-only');
  $('tab-replay').click();assert.equal($('replay-panel').hidden,true,'live stage review is guarded');
  assert.equal($('input-hint').textContent,'');
  click($('history-toggle'));assert.equal($('game-sidebar').hidden,true);
  click($('history-toggle'));assert.equal($('game-sidebar').hidden,false);
  click(cell(2,8));
  assert.ok(cell(2,7).title.includes('味方が取られた場合'));click($('clear-selection'));

  click($('game-home'));click($('confirm-accept'));await until(()=>$('home-screen').hidden===false&&ready(),'home');
  click($('mode-local'));click($('start-game'));await until(()=>$('game-screen').hidden===false&&ready(),'local setup');
  click(cell(7,7));click(cell(7,6));await until(()=>$('handoff').hidden===false&&ready(),'private handoff');
  assert.ok($('handoff-title').textContent.includes('プレイヤー2'));
  assert.ok(cell(7,7).querySelector('.piece'));assert.equal(cell(7,6).querySelector('.piece'),null,'sealed action does not move the public board');
  assert.equal(window.document.querySelectorAll('.history-row').length,0);
  click($('handoff-ready'));click(cell(3,3));click(cell(3,4));await round(2);
  assert.equal($('handoff').hidden,false);click($('handoff-ready'));
  assert.equal($('tab-replay').hidden,true);
  assert.ok($('history').textContent.includes('7六歩'));assert.ok($('history').textContent.includes('3四歩'));
  click(cell(7,6));click(cell(7,5));await until(()=>!$('handoff').hidden&&ready(),'second handoff');
  click($('handoff-ready'));click(cell(3,4));click(cell(3,5));await round(3);click($('handoff-ready'));
  click($('resign'));click($('confirm-accept'));await until(()=>!$('result-overlay').hidden&&ready(),'local game ends before review');
  click($('result-final'));assert.equal($('tab-replay').hidden,false);
  click($('tab-replay'));await until(()=>!$('replay-panel').hidden&&ready(),'post-game replay round two');
  $('replay-round').value='1';$('replay-round').dispatchEvent(new window.Event('change'));
  await until(()=>$('replay-round').value==='1'&&ready(),'historical round');
  assert.ok(cell(7,7).querySelector('.piece'));assert.equal($('stage-label').textContent,'開始局面');
  click($('stage-next'));assert.equal($('stage-label').textContent,'段階 1');assert.ok($('events').textContent.includes('A 歩'));
  click($('stage-next'));assert.equal($('stage-label').textContent,'確定局面');
  click($('return-live'));assert.ok(cell(7,5).querySelector('.piece'));

  const priorRound = $('round-number').textContent;
  await changeFile({format:'old'});
  assert.equal($('error').hidden,false);assert.equal($('round-number').textContent,priorRound,'invalid import is atomic');
  const fixtures = await createFixtures();
  await changeFile(fixtures.promotion);click($('continue-game'));await until(ready,'resume imported board');
  assert.ok(cell(7,5).querySelector('.piece.upgraded'));assert.ok(cell(4,7).querySelector('.piece.promoted'));
  click(cell(5,4));click(cell(5,3));
  assert.equal($('choice-popover').hidden,false);assert.equal(window.document.querySelectorAll('[data-choice]').length,2);
  assert.equal(window.document.querySelector('[data-choice="none"]'),null);
  assert.equal(window.document.querySelectorAll('.history-row').length,0,'choice is not committed early');
  click(window.document.querySelector('[data-choice="upgrade"]'));await round(2);
  assert.ok(cell(5,3).querySelector('.piece.upgraded'));assert.equal($('choice-popover').hidden,true);
  click(cell(5,3));click(cell(5,2));assert.equal($('choice-popover').hidden,true);await round(3);
  assert.equal(cell(5,2).querySelector('.piece-symbol').textContent,'飛');assert.ok(cell(5,2).querySelector('.piece.upgraded'));
  click(window.document.querySelector('#hand-bottom [data-kind="P"]'));click(cell(4,5));await round(4);
  assert.ok(cell(4,5).querySelector('.piece'));assert.equal(window.document.querySelector('#hand-bottom [data-kind="P"]'),null);
  click($('resign'));click($('confirm-accept'));await until(()=>!$('result-overlay').hidden&&ready(),'defeat result');
  assert.equal($('result-title').textContent,'敗北');click($('result-final'));assert.equal($('result-overlay').hidden,true);
  click($('show-result'));click($('result-review'));await until(()=>!$('replay-panel').hidden&&ready(),'rewind from result');
  assert.equal($('replay-round').value,'1');assert.equal($('stage-label').textContent,'開始局面');
  await changeFile(fixtures.forcedPromotion);click($('continue-game'));await until(ready,'upgraded pawn fixture');
  click(cell(5,2));click(cell(5,1));assert.equal($('choice-popover').hidden,true);await round(2);
  assert.ok(cell(5,1).querySelector('.piece.promoted'));assert.equal(cell(5,1).querySelector('.piece.upgraded'),null);
  assert.equal(cell(5,1).querySelector('.piece-symbol').textContent,'と');
  click($('resign'));click($('confirm-accept'));await until(()=>!$('result-overlay').hidden&&ready(),'forced-promotion game ends');
  click($('result-final'));
  click($('show-result'));click($('result-rematch'));await until(()=>!$('game-screen').hidden&&ready(),'AI rematch');
  assert.equal(window.document.querySelectorAll('#board .piece').length,40);assert.equal($('round-number').textContent,'01');

  await changeFile(fixtures.victory);click($('show-result'));assert.equal($('result-title').textContent,'勝利');click($('result-final'));
  await changeFile(fixtures.draw);click($('show-result'));assert.equal($('result-title').textContent,'引き分け');click($('result-final'));
  const resolution = await (await import('../web/dist/engine.js')).WasmEngine.fromBytes(readFileSync(new URL('../web/dist/engine.wasm',import.meta.url)));
  const call = request => { const result = resolution.call(request);assert.equal(result.ok,true);return result.value; };
  call({cmd:'import',replay:fixtures.collision});
  call({cmd:'submit',side:'A',action:{type:'move',side:'A',piece:'AR',to:[5,5],choice:'none'}});
  const clashView = call({cmd:'submit',side:'B',action:{type:'move',side:'B',piece:'BP',to:[5,6],choice:'none'}});
  const event = clashView.lastResolution.events.find(event=>event.type==='contact');
  const visual = describeClash(event,clashView.lastResolution);
  assert.equal(visual.winner,'A');assert.deepEqual(visual.ranks,[6,1]);
  assert.deepEqual(visual.pieces.map(p=>p.kind),['R','P']);
  const kings = [{id:'AK',side:'A',kind:'K',at:[9,9]},{id:'BK',side:'B',kind:'K',at:[9,1]}];
  const equal = call({cmd:'resolve',position:{pieces:[...kings,{id:'AR',side:'A',kind:'R',at:[5,7]},{id:'BR',side:'B',kind:'R',at:[5,3]}],hands:{A:{},B:{}}},actions:[{type:'move',side:'A',piece:'AR',to:[5,5],choice:'none'},{type:'move',side:'B',piece:'BR',to:[5,5],choice:'none'}]});
  const tie = describeClash(equal.events.find(event=>event.type==='contact'),equal);
  assert.equal(tie.title,'相討ち');assert.equal(tie.winner,null);assert.equal(tie.retained,false);
  for (const kind of ['R','P']) {
    const drops = call({cmd:'resolve',position:{pieces:kings,hands:{A:{[kind]:1},B:{P:1}}},actions:[{type:'drop',side:'A',kind,to:[5,5]},{type:'drop',side:'B',kind:'P',to:[5,5]}]});
    const drop = describeClash(drops.events.find(event=>['drop_duel','equal_drop_failure'].includes(event.type)),drops);
    assert.equal(drop.winner,kind==='R'?'A':null);assert.equal(drop.retained,kind==='P','equal drops retain both pieces, rather than displaying mutual capture');
  }
  console.log('DOM integration passed: home/setup, real Worker/WASM, immediate moves/drops, conditional targets, private handoff, historical stage replay, atomic imports, promotion/upgrade choices and glyph states, victory/defeat/draw, result review, AI rematch, and engine-driven collision descriptions.');
} finally {
  intervals.forEach(clearInterval);
  await Promise.all(workers.map(worker=>worker.terminate()));
  await window.happyDOM.close();
}
