import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WasmEngine } from '../web/dist/engine.js';
import { actionLabel } from '../web/dist/presentation.js';
import { PLAY_RULES } from '../web/dist/rules.js';

const engine=await WasmEngine.fromBytes(readFileSync(new URL('../web/dist/engine.wasm',import.meta.url)));
const p=(id,side,kind,at,extra={})=>({id,side,kind,at,promoted:false,upgraded:false,...extra});
const move=(side,piece,to,choice='none')=>({type:'move',side,piece,to,choice});
function label(extra,action,enemy=move('B','bk',[8,1])) {
  const pieces=[p('ak','A','K',[9,9]),p('bk','B','K',[9,1]),...extra];
  const response=engine.call({cmd:'resolve',rules:PLAY_RULES,position:{pieces,hands:{A:{},B:{}}},actions:[action,enemy]});
  assert.equal(response.ok,true,response.error);
  return {raw:actionLabel(action,pieces),resolved:actionLabel(action,pieces,response.value)};
}
assert.deepEqual(label([p('ap','A','P',[7,7])],move('A','ap',[7,6],'promote')),{raw:'7六歩',resolved:'7六歩'});
assert.deepEqual(label([p('ag','A','G',[5,8])],move('A','ag',[4,8],'upgrade')),{raw:'4八金',resolved:'4八金'});
assert.deepEqual(label([],move('A','ak',[8,9],'upgrade')),{raw:'8九王',resolved:'8九王'});
assert.deepEqual(label([p('ar','A','R',[5,8]),p('ap','A','P',[5,7])],move('A','ar',[5,2],'upgrade')),
  {raw:'5二飛昇格希望',resolved:'5八飛（不動・指定5二）'});
assert.deepEqual(label([p('ar','A','R',[5,6]),p('ap','A','P',[5,4])],move('A','ar',[5,2],'upgrade')),
  {raw:'5二飛昇格希望',resolved:'5五飛（指定5二）'});
assert.deepEqual(label([p('ar','A','R',[5,4])],move('A','ar',[5,3],'upgrade')),
  {raw:'5三飛昇格希望',resolved:'5三飛昇格'});
assert.equal(label([p('ar','A','R',[5,6]),p('br','B','R',[5,4],{upgraded:true})],move('A','ar',[5,1]),move('B','br',[5,9])).resolved,
  '5五飛（被捕獲・指定5一）');
assert.equal(label([p('ar','A','R',[5,6],{upgraded:true}),p('br','B','R',[5,4])],move('A','ar',[5,1]),move('B','br',[5,9])).resolved,
  '5五飛（指定5一）','Winning a moving collision counts as an actual move');
console.log('History labels verified against actual WASM movement, promotion, blocking, partial arrival and capture.');
