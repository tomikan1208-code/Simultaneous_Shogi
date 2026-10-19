import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Worker as NodeWorker } from 'node:worker_threads';
import { Window } from 'happy-dom';
const window = new Window({url:'http://127.0.0.1:5173',settings:{enableFileSystemHttpRequests:false,disableCSSFileLoading:true,disableJavaScriptFileLoading:true}});
const workers = [];
globalThis.document = window.document;
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
const cell = (x,y) => window.document.querySelector(`[data-x="${x}"][data-y="${y}"]`);
const click = element => {assert.ok(element,'Expected clickable element');assert.notEqual(element.disabled,true,`Disabled: ${element.id || element.getAttribute('aria-label')}`);element.click();};
async function until(check,label) {
  const limit = Date.now()+10000;
  while(!check()) {if(Date.now()>limit)throw new Error(`Timed out: ${label}. Error: ${$('error').textContent}`);await new Promise(resolve=>setTimeout(resolve,10));}
}
try {
  await import('../web/dist/main.js');
  await until(()=>$('engine-status').textContent.includes('準備完了'),'WASM initialization');
  assert.equal(window.document.querySelectorAll('.piece').length,40);
  assert.equal($('commit').disabled,true);
  click(cell(7,7));assert.equal($('selection-title').textContent,'歩の目的地を選択');
  click(cell(7,6));assert.equal($('commit').disabled,false);assert.ok($('intent-card').textContent.includes('7六'));
  click($('commit'));await until(()=>$('round-number').textContent==='02'&&!$('new-game').disabled,'human/AI round');
  assert.equal($('intent-card').hidden,true);assert.equal($('commit').disabled,true);assert.equal($('error').hidden,true);
  click($('tab-replay'));assert.equal($('replay-panel').hidden,false);assert.equal($('stage-label').textContent,'開始局面');
  click($('stage-next'));assert.equal($('stage-label').textContent,'段階 1');assert.ok($('events').textContent.includes('A歩'));
  click($('stage-next'));assert.equal($('stage-label').textContent,'確定局面');
  click($('return-input'));assert.equal($('input-panel').hidden,false);

  // Friendly-occupied destinations remain selectable and display the condition.
  click(cell(2,8));click(cell(2,7));assert.ok($('conditions').textContent.includes('味方の駒が取られた場合'));
  click($('clear-selection'));assert.equal($('selection-title').textContent,'駒を選んでください');

  click($('mode-local'));await until(()=>$('round-number').textContent==='01'&&!$('new-game').disabled,'new local game');
  click(cell(7,7));click(cell(7,6));click($('commit'));
  await until(()=>$('handoff').hidden===false&&!$('new-game').disabled,'private handoff');
  assert.equal($('intent-card').hidden,true);assert.ok($('handoff-title').textContent.includes('B陣営'));
  assert.equal(window.document.querySelector('#player-a .commit-state').textContent,'確定済み ✓');
  assert.equal($('round-number').textContent,'01');
  click($('handoff-ready'));click(cell(3,3));click(cell(3,4));click($('commit'));
  await until(()=>$('round-number').textContent==='02'&&!$('new-game').disabled,'both local actions resolve');
  assert.ok($('handoff-title').textContent.includes('A陣営'));click($('handoff-ready'));
  click($('tab-replay'));assert.ok($('revealed-actions').textContent.includes('A：歩'));assert.ok($('revealed-actions').textContent.includes('B：歩'));

  click($('return-input'));click(cell(7,6));click(cell(7,5));click($('commit'));
  await until(()=>$('handoff').hidden===false&&!$('new-game').disabled,'second round handoff');
  click($('handoff-ready'));click(cell(3,4));click(cell(3,5));click($('commit'));
  await until(()=>$('round-number').textContent==='03'&&!$('new-game').disabled,'second local round');
  click($('handoff-ready'));click($('tab-replay'));
  assert.equal($('replay-round').value,'2');$('replay-round').value='1';$('replay-round').dispatchEvent(new window.Event('change'));
  await until(()=>$('replay-title').textContent.includes('ラウンド 1')&&!$('new-game').disabled,'previous round replay');
  assert.ok(cell(7,7).querySelector('.piece'),'Prior round starts from its own position');
  click($('return-input'));assert.ok(cell(7,5).querySelector('.piece'),'Live match is unchanged by historical replay');

  // Import uses the real file input event and verifies hashes before replacement.
  const invalidFile = new window.File([JSON.stringify({format:'old'})],'bad.json',{type:'application/json'});
  Object.defineProperty($('replay-file'),'files',{value:[invalidFile],configurable:true});
  $('replay-file').dispatchEvent(new window.Event('change'));
  await until(()=>$('error').hidden===false&&!$('new-game').disabled,'invalid replay error');
  assert.equal($('round-number').textContent,'03');
  console.log('DOM integration passed: 40-piece setup, real Worker/WASM, human/AI round, conditional target, private handoff, simultaneous reveal, historical stage replay, and atomic invalid import. Visual layout is not tested by this DOM harness.');
} finally {
  await Promise.all(workers.map(w=>w.terminate()));
  await window.happyDOM.close();
}

