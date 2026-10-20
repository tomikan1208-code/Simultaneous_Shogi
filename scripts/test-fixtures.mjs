import { readFileSync } from 'node:fs';
import { WasmEngine } from '../web/dist/engine.js';
import { PLAY_RULES } from '../web/dist/rules.js';
const bytes = readFileSync(new URL('../web/dist/engine.wasm', import.meta.url));
const p = (id, side, kind, at, changes = {}) => ({ id, side, kind, at, ...changes });
const move = (side, piece, to) => ({ side, type: 'move', piece, to, choice: 'none' });
async function replay(pieces, actions = [], hands = { A: {}, B: {} }) {
  const engine = await WasmEngine.fromBytes(bytes);
  const call = request => { const response = engine.call(request); if (!response.ok) throw new Error(response.error); return response.value; };
  call({ cmd: 'new', rules:PLAY_RULES,position: { pieces, hands } });
  for (const action of actions) call({ cmd: 'submit', side: action.side, action });
  return call({ cmd: 'export' });
}
export async function createFixtures() {
  const aPath = [[1,7],[2,7],[3,7],[3,8],[3,9],[2,9],[1,9],[1,8]];
  const bPath = [[6,1],[7,1],[8,1],[9,1],[9,2],[9,3],[8,3],[7,3],[6,3],[6,2]];
  const allKinds = {R:1,B:1,G:1,S:1,N:1,L:1,P:9};
  return {
    longRecord: await replay([p('AK','A','K',aPath[0]),p('BK','B','K',bPath[0])],
      Array.from({length:30},(_,i) => [move('A','AK',aPath[(i+1)%aPath.length]),move('B','BK',bPath[(i+1)%bPath.length])]).flat(),
      {A:{...allKinds},B:{...allKinds}}),
    forcedPromotion: await replay([
      p('AK', 'A', 'K', [9, 9]), p('BK', 'B', 'K', [9, 1]), p('AP', 'A', 'P', [5, 2], { upgraded: true }), p('BP', 'B', 'P', [1, 3]),
    ]),
    promotion: await replay([
      p('AK', 'A', 'K', [9, 9]), p('BK', 'B', 'K', [9, 1]), p('AR', 'A', 'R', [5, 4]),
      p('AB', 'A', 'B', [7, 5], { upgraded: true }), p('BS', 'B', 'S', [4, 7], { promoted: true }), p('BP', 'B', 'P', [1, 3]),
    ], [], { A: { P: 1 }, B: {} }),
    victory: await replay([
      p('AK', 'A', 'K', [9, 9]), p('BK', 'B', 'K', [5, 1]), p('AR', 'A', 'R', [5, 2]), p('BP', 'B', 'P', [1, 3]),
    ], [move('A', 'AR', [5, 1]), move('B', 'BP', [1, 4])]),
    draw: await replay([
      p('AK', 'A', 'K', [9, 9]), p('BK', 'B', 'K', [1, 1]), p('AR', 'A', 'R', [1, 2]), p('BR', 'B', 'R', [9, 8]),
    ], [move('A', 'AR', [1, 1]), move('B', 'BR', [9, 9])]),
    collision: await replay([
      p('AK', 'A', 'K', [9, 9]), p('BK', 'B', 'K', [9, 1]), p('AR', 'A', 'R', [5, 7]), p('BP', 'B', 'P', [5, 5]),
    ]),
  };
}
