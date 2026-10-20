// Deterministic transport fixture for UI tests. Real inference has its own suite.
import { readFileSync } from 'node:fs';
import { WasmEngine } from '../web/dist/engine.js';
import { PLAY_RULES } from '../web/dist/rules.js';

export async function modelFixture() {
  const engine = await WasmEngine.fromBytes(readFileSync(new URL('../web/dist/engine.wasm', import.meta.url)));
  const call = input => {
    const response = engine.call(input);
    if (!response.ok) throw new Error(response.error);
    return response.value;
  };
  const id = 'f'.repeat(24), rules = call({cmd:'new',rules:PLAY_RULES}).rules;
  return (path, input) => {
    if (path.endsWith('/models')) return {runs:[{id:'fixture',name:'画面検証用モデル',source:'テスト',compatible:true,reason:'',checkpoints:[{id,generation:145,latest:true,champion:true}]}]};
    if (path.endsWith('/load')) return {model:id,generation:145,device:'cpu',rules};
    call({cmd:'import',replay:input.replay});
    return {model:id,generation:145,device:'cpu',round:input.replay.rounds.length,action:call({cmd:'actions',side:input.side})[0].action};
  };
}
