import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { WasmEngine } from '../web/dist/engine.js';
import { PLAY_RULES, sameRules } from '../web/dist/rules.js';
import { rankAppearance, pieceMarkup } from '../web/dist/presentation.js';
import { ModelService } from '../server/models.mjs';

const engine=await WasmEngine.fromBytes(await readFile('web/dist/engine.wasm'));
const call=request=>{const result=engine.call(request);assert.equal(result.ok,true,result.error);return result.value;};
const kings=[{id:'AK',side:'A',kind:'K',at:[9,9]},{id:'BK',side:'B',kind:'K',at:[9,1]}];
const piece=(id,side,kind,at,changes={})=>({id,side,kind,at,promoted:false,upgraded:false,...changes});
const move=(side,id,to,choice='none')=>({type:'move',side,piece:id,to,choice});
const begin=(extra,activity={})=>call({cmd:'new',rules:PLAY_RULES,position:{pieces:[...kings,...extra],activity}});
const play=(a,b)=>{call({cmd:'submit',side:'A',action:a});return call({cmd:'submit',side:'B',action:b});};
const display=(view,id)=>rankAppearance(view.position.pieces.find(p=>p.id===id),{rules:view.rules,activity:view.position.activity?.[id]});

const python=resolve('.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
const trained=JSON.parse(execFileSync(python,['-c',"import json; from training.rules import balance_for; print(json.dumps(balance_for('D+ALL2-C1')))"],{encoding:'utf8',windowsHide:true}));
assert.deepEqual(PLAY_RULES.balance,trained,'Gameplay must use exactly the trained main profile');
assert.equal(sameRules(PLAY_RULES,{...PLAY_RULES,balance:Object.fromEntries(Object.entries(trained).reverse())}),true);
assert.equal(sameRules(PLAY_RULES,{...PLAY_RULES,balance:{...trained,consecutiveThreshold:3}}),false);
assert.equal(sameRules(PLAY_RULES,{...PLAY_RULES,version:'0.6'}),false,'Old models must not silently adopt the changed king rule');

const fixtures=JSON.parse(await readFile('review/stage_cases.json','utf8')).cases;
for(const id of ['E08','E10']) {
  const {actions,...position}=fixtures.find(fixture=>fixture.id===id).input;
  call({cmd:'new',rules:PLAY_RULES,position});
  const finished=play(...actions);
  assert.deepEqual(finished.outcome,{winner:'A',reason:'king_capture_retained'},`${id}: recapture must not reverse the victory`);
  assert.equal(finished.lastResolution.version,'0.7');
  const recorded=call({cmd:'export'});
  assert.equal(call({cmd:'import',replay:recorded}).stateHash,finished.stateHash);
  call({cmd:'new',rules:{...PLAY_RULES,version:'0.6'},position});
  assert.deepEqual(play(...actions).outcome,{winner:'B',reason:'king_captor_lost'},`${id}: old replays keep the old adjudication`);
}

begin([piece('AR','A','R',[5,4])]);
let state=play(move('A','AR',[5,3],'upgrade'),move('B','BK',[8,1]));
assert.equal(display(state,'AR').effective,7);assert.equal(display(state,'AR').aura,'');
state=play(move('A','AR',[5,4]),move('B','BK',[9,1]));
assert.equal(display(state,'AR').effective,6);assert.equal(display(state,'AR').aura,'reduced');
assert.match(pieceMarkup(state.position.pieces.find(p=>p.id==='AR'),false,{rules:state.rules,activity:state.position.activity.AR}),/rank-reduced/);
state=play(move('A','AK',[8,9]),move('B','BK',[8,1]));
assert.equal(display(state,'AR').effective,7);assert.equal(display(state,'AR').aura,'');
assert.equal(state.position.pieces.find(p=>p.id==='AR').upgraded,true,'Rest does not undo the upgrade');
state=play(move('A','AR',[5,7]),move('B','BK',[9,1]));
assert.equal(display(state,'AR').effective,8);assert.equal(display(state,'AR').aura,'boosted','Blue requires the actual home defense bonus');

begin([piece('AG','A','G',[5,7])]);
state=play(move('A','AG',[5,6]),move('B','BK',[8,1]));
assert.equal(display(state,'AG').effective,5);assert.equal(display(state,'AG').aura,'');
state=play(move('A','AG',[5,5]),move('B','BK',[9,1]));
assert.equal(display(state,'AG').effective,4);assert.equal(display(state,'AG').aura,'reduced');
state=play(move('A','AG',[5,4]),move('B','BK',[8,1]));
assert.equal(display(state,'AG').effective,4,'Fixed fatigue never accumulates past minus one');
state=play(move('A','AK',[8,9]),move('B','BK',[9,1]));
assert.equal(display(state,'AG').effective,5);assert.equal(display(state,'AG').aura,'');

begin([piece('AR','A','R',[5,6],{upgraded:true}),piece('BR','B','R',[5,4])],{AR:{streak:1,fatigue:0}});
state=play(move('A','AR',[5,5]),move('B','BR',[5,5]));
assert.deepEqual(state.lastResolution.events.find(e=>e.type==='contact').ranks,[6,6]);
assert.equal(state.lastResolution.captures.length,2,'Second consecutive move changes the actual collision');
begin([piece('AR','A','R',[5,8]),piece('BR','B','R',[5,6],{upgraded:true})]);
state=play(move('A','AR',[5,7]),move('B','BR',[5,7]));
assert.deepEqual(state.lastResolution.events.find(e=>e.type==='contact').ranks,[7,7]);
assert.equal(state.lastResolution.captures.length,2,'Home defense affects moving collisions');
begin([piece('AR','A','R',[5,7],{upgraded:true}),piece('BP','B','P',[5,6])]);
state=play(move('A','AK',[8,9]),move('B','BP',[5,7]));
assert.ok(state.lastResolution.captures.some(c=>c.victim==='AR'&&c.captor==='BP'),'A stopped upgraded defender is still captured unconditionally');

const tired=piece('T','A','R',[5,5],{upgraded:true});
const progressive={...PLAY_RULES,balance:{...trained,movement:'progressive',rankOffset:1}};
const light=rankAppearance(tired,{rules:progressive,activity:{streak:2,fatigue:1}});
const dark=rankAppearance(tired,{rules:progressive,activity:{streak:2,fatigue:4}});
assert.equal(light.aura,'reduced');assert.equal(dark.aura,'reduced');assert.ok(dark.intensity>light.intensity);
assert.equal(rankAppearance(tired,{rules:PLAY_RULES,activity:{streak:2,fatigue:0}}).aura,'reduced');
assert.equal(rankAppearance(piece('P','A','P',[5,7]),{rules:PLAY_RULES}).aura,'boosted');
assert.equal(rankAppearance(piece('P','A','P',[5,6]),{rules:PLAY_RULES}).aura,'');
assert.equal(rankAppearance(tired,{rules:PLAY_RULES}).aura,'','An upgraded piece outside home has no blue aura');
for(const kind of ['K','P','L','N','S','G','R','B']) {
  const p=piece('p','A',kind,[5,5]);
  const resting=rankAppearance(p,{rules:PLAY_RULES});
  const moving=rankAppearance(p,{rules:PLAY_RULES,activity:{streak:1,fatigue:0},moving:true});
  assert.equal(moving.effective,Math.max(0,resting.effective-1),kind);
}
assert.equal(rankAppearance(tired).effective,7,'Old replay rendering keeps its original rank');

if(process.argv.includes('--main-model')) {
  const service=new ModelService({rules:PLAY_RULES});
  try {
    const catalogue=await service.catalogue();
    const run=catalogue.runs.find(r=>r.compatible&&r.name.includes('2回目から格低下'));
    assert.ok(run,'The real main run must be available for gameplay');
    const selected=run.checkpoints.find(c=>c.latest),loaded=await service.load(selected.id);
    assert.equal(sameRules(loaded.rules,PLAY_RULES),true);
    call({cmd:'new',rules:PLAY_RULES});
    const chosen=await service.choose({model:selected.id,replay:call({cmd:'export'}),side:'B',seed:42});
    assert.equal(chosen.action.side,'B');assert.equal(chosen.generation,selected.generation);
    console.log(`Real main model G${selected.generation}: compatible, loaded and selected a legal move under D+ALL2-C1.`);
  } finally {await service.close();}
}
console.log('Gameplay rules passed: v0.7 king victory, v0.6 replay compatibility, all-piece second-move fatigue, rest recovery, home-only blue aura, defense-only collisions and unconditional static capture.');
