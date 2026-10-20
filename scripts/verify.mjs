import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { plannedPath, resolveStageRound } from '../review/stage_reference.mjs';

const root = fileURLToPath(new URL('../',import.meta.url));
const run = (program,args) => execFileSync(program,args,{cwd:root,stdio:'inherit'});
run('cargo',['test','--workspace','--locked']);
run('cargo',['build','--workspace','--locked']);
run(process.execPath,['review/verify_examples.mjs']);
run(process.execPath,['scripts/build-wasm.mjs']);
run(process.execPath,['scripts/build-web.mjs']);

const { WasmEngine } = await import('../web/dist/engine.js');
const wasm = await WasmEngine.fromBytes(readFileSync(new URL('../web/dist/engine.wasm',import.meta.url)));
const fixtures = JSON.parse(readFileSync(new URL('../review/stage_cases.json',import.meta.url),'utf8')).cases;
let rng = 12345;
const random = n => { rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5; return (rng >>> 0) % n; };
const generated = [];
for (let i=0;i<1000;i++) {
  const occupied = new Set();
  const cell = () => {let q; do q = [random(9)+1,random(9)+1];while(occupied.has(q.join(',')));occupied.add(q.join(','));return q;};
  const pieces = ['A','B'].map(side=>({id:`${side}K`,side,kind:'K',at:cell()}));
  const kinds = ['P','L','N','S','G','R','B'];
  for(let j=0;j<2+random(10);j++) {
    const kind = kinds[random(kinds.length)], change = kind !== 'G' ? random(4) : 0;
    pieces.push({id:`p${j}`,side:random(2)?'A':'B',kind,at:cell(),promoted:change===1,upgraded:change===2});
  }
  const hands = {A:{P:1,R:1},B:{P:1,B:1}};
  const actions = ['A','B'].map(side=>{
    const candidates = [];
    for(const p of pieces.filter(p=>p.side===side))for(let y=1;y<=9;y++)for(let x=1;x<=9;x++) {
      try {plannedPath(p,[x,y]);candidates.push({type:'move',side,piece:p.id,to:[x,y],choice:['none','promote','upgrade'][random(3)]});}catch{}
    }
    for(const kind of Object.keys(hands[side]))for(let y=1;y<=9;y++)for(let x=1;x<=9;x++) {
      if(kind==='P' && y===(side==='A'?1:9))continue;
      if(pieces.some(p=>p.side===side && p.at[0]===x && p.at[1]===y))continue;
      candidates.push({type:'drop',side,kind,to:[x,y]});
    }
    return candidates[random(candidates.length)];
  });
  generated.push({id:`generated-${i}`,input:{pieces,hands,actions}});
}

const tests = [...fixtures,...generated];
const native = fileURLToPath(new URL(`../target/debug/shogi${process.platform==='win32'?'.exe':''}`,import.meta.url));
const nativeResults = spawnSync(native,['resolve'],{input:tests.map(t=>JSON.stringify(t.input)).join('\n')+'\n',encoding:'utf8',maxBuffer:128*1024*1024,timeout:120000});
assert.equal(nativeResults.status,0,nativeResults.stderr);
const results = nativeResults.stdout.trim().split(/\r?\n/).map(line=>JSON.parse(line));
assert.equal(results.length,tests.length);
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,stable(v)])) : value;
const sort = xs => xs.sort((a,b)=>JSON.stringify(stable(a)).localeCompare(JSON.stringify(stable(b))));
function canonical(result,input) {
  const ids = new Set(input.pieces.map(p=>p.id));
  const renamed = new Map(result.pieces.filter(p=>!ids.has(p.id)).map(p=>[p.id,`drop:${p.side}`]));
  // A dropped piece can be captured before the final board.
  for(const f of result.frames)for(const p of f.pieces)if(!ids.has(p.id))renamed.set(p.id,`drop:${p.side}`);
  for(const c of result.captures)if(!ids.has(c.victim)&&c.reason==='drop')renamed.set(c.victim,`drop:${c.victimSide}`);
  for(const side of ['A','B'])for(const e of result.events)if(e.type==='drop_duel'&&e.winner?.endsWith(`:${side}`))renamed.set(e.winner,`drop:${side}`);
  const remap = value => typeof value==='string' ? renamed.get(value)??value : Array.isArray(value) ? value.map(remap) : value && typeof value==='object' ? Object.fromEntries(Object.entries(value).map(([k,v])=>[k,remap(v)])) : value;
  const x = remap(result);
  const board = ps => sort(ps.map(p=>({id:p.id,side:p.side,kind:p.kind,at:p.at,promoted:!!p.promoted,upgraded:!!p.upgraded})));
  const hs = Object.fromEntries(['A','B'].map(s=>[s,Object.fromEntries(Object.entries(x.hands[s]).filter(([,n])=>n>0).sort())]));
  const captures = x.captures.map(({captorSide,...c})=>c);
  const events = x.events.filter(e=>e.type!=='drop_wait').map(({captorSide,ranks,...e})=>e);
  return {pieces:board(x.pieces),hands:hs,outcome:x.outcome,dropBans:sort(x.dropBans),captures,events,frames:x.frames.map(f=>({stage:f.stage,pieces:board(f.pieces)}))};
}
const flipSide = s => s==='A'?'B':s==='B'?'A':s;
const rotate = q => q.map(n=>10-n);
const physical = r => ({pieces:sort(r.pieces.map(({id,...p})=>p)),hands:r.hands,outcome:r.outcome,dropBans:sort(r.dropBans),frames:r.frames.map(f=>({stage:f.stage,pieces:sort(f.pieces.map(({id,...p})=>p))}))});
function flipped(input) {
  return {...input,pieces:input.pieces.map(p=>({...p,side:flipSide(p.side),at:rotate(p.at)})),hands:{A:input.hands.B,B:input.hands.A},actions:input.actions.map(a=>({...a,side:flipSide(a.side),to:rotate(a.to)}))};
}
let comparisons = 0;
for (const [i,test] of tests.entries()) {
  const response = results[i];
  const {actions,...position} = test.input;
  const wasmResponse = wasm.call({cmd:'resolve',position,actions});
  assert.deepEqual(wasmResponse,response,`${test.id}: native/WASM byte semantics`);
  if(test.expectedError) {assert.equal(response.ok,false,test.id);continue;}
  assert.equal(response.ok,true,`${test.id}: ${response.error}`);
  const expected = resolveStageRound(test.input), actual = response.value;
  assert.deepEqual(canonical(actual,test.input),canonical(expected,test.input),`${test.id}: JS reference/native`);
  const reversed = structuredClone(test.input);reversed.pieces.reverse();reversed.actions.reverse();
  const {actions:reversedActions,...reversedPos} = reversed;
  assert.deepEqual(wasm.call({cmd:'resolve',position:reversedPos,actions:reversedActions}).value,actual,`${test.id}: input order`);
  const flip = flipped(test.input);const {actions:flipActions,...flipPos} = flip;
  const flipResult = wasm.call({cmd:'resolve',position:flipPos,actions:flipActions});assert.equal(flipResult.ok,true,test.id);
  const mapped = structuredClone(actual);mapped.pieces = mapped.pieces.map(p=>({...p,side:flipSide(p.side),at:rotate(p.at)}));mapped.hands = {A:actual.hands.B,B:actual.hands.A};if(mapped.outcome)mapped.outcome.winner=flipSide(mapped.outcome.winner);
  mapped.dropBans = mapped.dropBans.map(b=>({...b,side:flipSide(b.side),to:rotate(b.to)}));mapped.frames = mapped.frames.map(f=>({...f,pieces:f.pieces.map(p=>({...p,side:flipSide(p.side),at:rotate(p.at)}))}));
  assert.deepEqual(physical(canonical(flipResult.value,flip)),physical(canonical(mapped,test.input)),`${test.id}: rotation/side symmetry`);
  const renamed = structuredClone(test.input);const names = new Map(renamed.pieces.map((p,j)=>[p.id,`renamed:${j}`]));
  renamed.pieces.forEach(p=>p.id=names.get(p.id));renamed.actions.forEach(a=>{if(a.type==='move')a.piece=names.get(a.piece);});
  const {actions:renamedActions,...renamedPos} = renamed;
  const renamedResult = wasm.call({cmd:'resolve',position:renamedPos,actions:renamedActions});assert.equal(renamedResult.ok,true);
  assert.deepEqual(physical(canonical(renamedResult.value,renamed)),physical(canonical(actual,test.input)),`${test.id}: ID neutrality`);
  const totals = (ps,hs) => {const m={};for(const p of ps)m[p.kind]=(m[p.kind]??0)+1;for(const h of Object.values(hs))for(const [k,n]of Object.entries(h))m[k]=(m[k]??0)+n;return Object.fromEntries(Object.entries(m).filter(([,n])=>n>0).sort());};
  const after = totals(actual.pieces,actual.hands);after.K = (after.K??0)+actual.captures.filter(c=>c.kind==='K').length;
  assert.deepEqual(after,totals(test.input.pieces,test.input.hands),`${test.id}: material conservation`);
  comparisons++;
}

// Run a complete public-session protocol in WASM, then verify the exact replay
// with native Rust. Exporting after a first commitment never reveals that input.
assert.equal(wasm.call({cmd:'new'}).ok,true);
for(let r=0;r<12;r++) {
  const before = wasm.call({cmd:'view'}).value;if(before.outcome)break;
  const first = wasm.call({cmd:'submit_ai',side:'A',policy:'hunter',seed:r*2+1});assert.equal(first.ok,true);
  assert.deepEqual(first.value.committed,[true,false]);assert.equal(first.value.stateHash,before.stateHash);
  assert.equal(wasm.call({cmd:'export'}).value.rounds.length,r);
  assert.equal(wasm.call({cmd:'submit_ai',side:'B',policy:'defense',seed:r*2+2}).ok,true);
}
const replay = wasm.call({cmd:'export'}).value;
const finalHash = wasm.call({cmd:'view'}).value.stateHash;
const checked = JSON.parse(execFileSync(native,['verify'],{input:JSON.stringify(replay),encoding:'utf8'}));assert.equal(checked.hash,finalHash);
assert.equal(wasm.call({cmd:'import',replay}).value.stateHash,finalHash);
assert.equal(wasm.call({cmd:'replay_round',round:1}).ok,true);
assert.equal(wasm.call({cmd:'view'}).value.stateHash,finalHash);

// RNG arithmetic must agree on 32-bit WASM and 64-bit native hosts, including
// policy tie-breaking. The pending first input is never part of an observation.
const protocol = [{cmd:'new'}];
for(let round=0;round<8;round++) for(const [side,policy] of [['A','random'],['B','hunter']]) protocol.push({cmd:'submit_ai',side,policy,seed:round*2+(side==='A'?1:2)});
const expectedProtocol = protocol.map(request=>wasm.call(request));
const nativeProtocol = execFileSync(native,['api'],{input:protocol.map(p=>JSON.stringify(p)).join('\n')+'\n',encoding:'utf8',maxBuffer:16*1024*1024}).trim().split(/\r?\n/).map(JSON.parse);
assert.deepEqual(expectedProtocol,nativeProtocol,'Seeded policies and session protocol must match across runtimes');
const arenaOff = JSON.parse(execFileSync(native,['arena','2','42','hunter','random','off'],{encoding:'utf8'}));
const arenaOn = JSON.parse(execFileSync(native,['arena','2','42','hunter','random','on'],{encoding:'utf8'}));
assert.deepEqual(arenaOff.results,arenaOn.results,'Arena diagnostics cannot change any game');
assert.deepEqual(arenaOff.events,arenaOn.events,'Metrics must also be available without traces');
console.log(`${comparisons} resolved fixtures/generated positions matched JS, native Rust, and WASM; 2 invalid fixtures rejected. Order, rotation, conservation, secrets, and cross-runtime replay verified.`);
run(process.execPath,['scripts/verify-ui.mjs']);
run(process.execPath,['scripts/verify-online.mjs']);
