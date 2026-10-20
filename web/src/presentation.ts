import type { Action, ActionOption, Event, Kind, Piece, Resolution, Side, Square } from './types.js';

export const symbols:Record<Kind,string> = { K:'王', P:'歩', L:'香', N:'桂', S:'銀', G:'金', R:'飛', B:'角' };
const promoted:Partial<Record<Kind,string>> = { P:'と', L:'杏', N:'圭', S:'全', R:'龍', B:'馬' };
export const baseRank:Record<Kind,number> = { K:0, P:1, L:2, N:3, S:4, G:5, R:6, B:6 };
export const rank = (piece:Piece):number => baseRank[piece.kind] + Number(piece.upgraded && !piece.promoted);
export const symbol = (piece:Piece):string => piece.kind === 'K' ? piece.side === 'A' ? '王' : '玉' : piece.promoted ? promoted[piece.kind] ?? symbols[piece.kind] : symbols[piece.kind];
export const square = (at:Square):string => `${at[0]}${'一二三四五六七八九'[at[1]-1]}`;
export const same = (a:Square,b:Square):boolean => a[0] === b[0] && a[1] === b[1];
export const escape = (value:string):string => value.replace(/[&<>"']/g,c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]!));
export const other = (side:Side):Side => side === 'A' ? 'B' : 'A';
export const sideIndex = (side:Side):number => side === 'A' ? 0 : 1;
export function pieceMarkup(piece:Piece, enemy = false):string {
  return `<span class="piece${enemy ? ' enemy' : ''}${piece.promoted ? ' promoted' : piece.upgraded ? ' upgraded' : ''}" data-piece="${escape(piece.id)}"><span class="piece-symbol">${symbol(piece)}</span><span class="rank-badge" aria-hidden="true">${rank(piece)}</span></span>`;
}
export function findPiece(resolution:Resolution,id?:string):Piece|undefined {
  return resolution.frames.flatMap(frame => frame.pieces).find(piece => piece.id === id) ?? resolution.pieces.find(piece => piece.id === id);
}
export function actionLabel(action:Action,pieces:Piece[]):string {
  const p = action.type === 'move' ? pieces.find(piece => piece.id === action.piece) : undefined;
  return `${square(action.to)}${action.type === 'drop' ? `${symbols[action.kind]}打` : p ? symbol(p) : '駒'}${action.type === 'move' ? action.choice === 'promote' ? '成希望' : action.choice === 'upgrade' ? '昇格希望' : '' : ''}`;
}
const zone = (side:Side,at:Square):boolean => side === 'A' ? at[1] <= 3 : at[1] >= 7;
/** A partial move can end anywhere along the engine's advertised path. */
export function offersChange(piece:Piece,option:ActionOption):boolean {
  return !piece.promoted && !piece.upgraded && !['K','G'].includes(piece.kind) && (zone(piece.side,piece.at) || option.path.some(at => zone(piece.side,at)));
}
export const reasons:Record<string,string> = {
  king_captured:'王を捕獲', king_captor_lost:'王を取った駒が同じラウンドで取り返されました', both_kings:'双方の王を捕獲・捕獲時の格で判定',
  repetition:'同一局面の4回反復', round_limit:'200ラウンドに到達', resigned:'投了', opponent_left:'対戦相手が退出しました', disconnected:'再接続の猶予時間が終了しました',
};
export function conditionText(conditions:string[]):string {
  const names:Record<string,string> = { friendly_removal:'味方が取られた場合に進入', enemy_departure_or_capture:'敵が残れば捕獲して停止', enemy_departure:'敵が移動した場合に打つ', nifu_removal:'二歩が解消した場合に打つ' };
  return [...new Set(conditions.map(c => { const [key,at] = c.split(':'); return `${at ? `${square(at.split(',').map(Number) as Square)}：` : ''}${names[key] ?? key}`; }))].join(' / ');
}
export function eventText(event:Event,resolution:Resolution):string {
  const name = (id?:string):string => { const p = findPiece(resolution,id); return p ? `${p.side} ${symbol(p)}` : '駒'; };
  switch (event.type) {
    case 'move': return `${name(event.actor)} → ${square(event.to!)}`;
    case 'blocked': return `${name(event.actor)}は味方の駒を待機`;
    case 'contact': return `${event.mode === 'swap' ? 'すれ違いで衝突' : '衝突'}${event.reason === 'rank' ? `・格 ${event.ranks?.join(' 対 ')}` : event.reason === 'chain' ? '・連戦' : '・停止駒の捕獲'} → ${event.winner ? `${name(event.winner)}の勝ち` : '相討ち'}`;
    case 'capture': return `${name(event.captor)}が${name(event.victim)}を捕獲${event.reason === 'chain' ? '（連戦）' : event.reason === 'drop' ? '（盤上駒を優先）' : ''}`;
    case 'drop': return `${name(event.actor)}を${square(event.to!)}に打つ`;
    case 'drop_wait': return `${event.side} ${symbols[event.kind!]}：${event.reason === 'nifu' ? '二歩の解消' : '空きマス'}を待機`;
    case 'drop_failure': return `${event.side} ${symbols[event.kind!]}：打ち不成立・持ち駒を保持`;
    case 'drop_duel': return `同時打ち → ${name(event.winner ?? undefined)}の勝ち`;
    case 'equal_drop_failure': return '同格の同時打ち：双方の持ち駒を保持・次のラウンドの再打ちを禁止';
    case 'forced_promotion': return `${name(event.actor)}が強制成り`;
    case 'promotion': return `${name(event.actor)}が成り`;
    case 'upgrade': return `${name(event.actor)}が昇格・格 +1`;
    default: return event.type;
  }
}
const paths:Record<string,string> = {
  record:'M4 4h16v16H4zM9 4v16m4-11h4m-4 4h4m-4 4h4',
  back:'m15 18-6-6 6-6', chevron:'m9 5 7 7-7 7', close:'m6 6 12 12M6 18 18 6',
  settings:'m12 8 3 2v4l-3 2-3-2v-4zM12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2',
  help:'M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2-3 4m.1 3h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  cpu:'M7 7h10v10H7zM9 10h6m-6 3h3M9 2v3m6-3v3M9 19v3m6-3v3M2 9h3m-3 6h3m14-6h3m-3 6h3',
  globe:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18',
  people:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M16 4a4 4 0 0 1 0 8m6 9v-2a4 4 0 0 0-3-3M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  replay:'M3 11a9 9 0 1 1 2.5 7M3 4v7h7M12 7v5l3 2',
  sound:'m3 9 4 0 5-4v14l-5-4H3zM16 8a5 5 0 0 1 0 8m3-11a9 9 0 0 1 0 14',
  muted:'m3 9 4 0 5-4v14l-5-4H3zM17 9l5 6m-5 0 5-6',
  menu:'M4 6h16M4 12h16M4 18h16', check:'m5 12 4 4L19 6', copy:'M8 8h12v13H8zM16 8V3H3v13h5',
  home:'m3 11 9-8 9 8v10h-6v-7H9v7H3z', flag:'M4 22V3m0 1c5-4 10 4 16 0v11c-6 4-11-4-16 0',
  download:'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5', upload:'M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5',
};
export const icon = (name:string):string => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name] ?? paths.chevron}"/></svg>`;
