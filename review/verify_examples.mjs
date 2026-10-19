// Current v0.5 executable-spec checks. v0.4 cumulative expectations are historical only.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveStageRound } from './stage_reference.mjs';

const { cases } = JSON.parse(readFileSync(new URL('./stage_cases.json', import.meta.url), 'utf8'));
const clone = x => JSON.parse(JSON.stringify(x));
const sortJson = xs => xs.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const board = (ps, ids = true) => sortJson(ps.map(p => ({ ...(ids ? { id: p.id } : {}), side: p.side,
  kind: p.kind, at: p.at, promoted: !!p.promoted, upgraded: !!p.upgraded })));
const hands = hs => Object.fromEntries(['A', 'B'].map(s => [s, Object.fromEntries(Object.entries(hs[s]).filter(([, n]) => n > 0).sort())]));
const physical = r => ({ pieces: board(r.pieces, false), hands: hands(r.hands), outcome: r.outcome,
  dropBans: sortJson(clone(r.dropBans)), frames: r.frames.map(f => ({ stage: f.stage, pieces: board(f.pieces, false) })) });
const flipSide = s => s === 'A' ? 'B' : s === 'B' ? 'A' : s;
const rotate = q => q.map(v => 10 - v);
function flipInput(src) {
  const x = clone(src);
  x.pieces = x.pieces.map(p => ({ ...p, side: flipSide(p.side), at: rotate(p.at) }));
  x.hands = { A: x.hands.B, B: x.hands.A };
  x.actions = x.actions.map(a => ({ ...a, side: flipSide(a.side), to: rotate(a.to) }));
  return x;
}
function flipResult(src) {
  const x = clone(src);
  x.pieces = x.pieces.map(p => ({ ...p, side: flipSide(p.side), at: rotate(p.at) }));
  x.hands = { A: x.hands.B, B: x.hands.A };
  if (x.outcome) x.outcome.winner = flipSide(x.outcome.winner);
  x.dropBans = x.dropBans.map(b => ({ ...b, side: flipSide(b.side), to: rotate(b.to) }));
  x.frames = x.frames.map(f => ({ ...f, pieces: f.pieces.map(p => ({ ...p, side: flipSide(p.side), at: rotate(p.at) })) }));
  return x;
}
function totals(ps, hs) {
  const n = {};
  for (const p of ps) n[p.kind] = (n[p.kind] ?? 0) + 1;
  for (const h of Object.values(hs)) for (const [k, v] of Object.entries(h)) n[k] = (n[k] ?? 0) + v;
  return n;
}

let valid = 0, invalid = 0;
for (const c of cases) {
  const label = `${c.id}: ${c.title}`, before = clone(c.input);
  if (c.expectedError) {
    assert.throws(() => resolveStageRound(c.input), new RegExp(c.expectedError), label);
    invalid++;
    continue;
  }
  const result = resolveStageRound(c.input), exp = c.expect;
  assert.deepEqual(c.input, before, `${label}: input mutation`);
  assert.deepEqual(board(result.pieces), board(exp.pieces), `${label}: board`);
  assert.deepEqual(hands(result.hands), hands(exp.hands), `${label}: hands`);
  assert.deepEqual(result.outcome, exp.outcome, `${label}: outcome`);
  assert.deepEqual(sortJson(clone(result.dropBans)), sortJson(clone(exp.dropBans)), `${label}: drop bans`);
  if (exp.contacts) {
    const contacts = result.events.filter(e => e.type === 'contact');
    assert.equal(contacts.length, exp.contacts.length, `${label}: contact count`);
    exp.contacts.forEach((e, i) => { for (const [k, v] of Object.entries(e)) assert.deepEqual(contacts[i][k], v, `${label}: contact ${k}`); });
  }
  if (exp.captureStages) assert.deepEqual(result.captures.map(c => c.stage), exp.captureStages, `${label}: capture stages`);
  if (exp.dropStages) assert.deepEqual(result.events.filter(e => e.type === 'drop').map(e => e.stage), exp.dropStages, `${label}: drop stages`);
  const initialTotals = totals(c.input.pieces, c.input.hands), finalTotals = totals(result.pieces, result.hands);
  finalTotals.K = (finalTotals.K ?? 0) + result.captures.filter(c => c.kind === 'K').length;
  assert.deepEqual(finalTotals, initialTotals, `${label}: piece conservation`);
  for (const f of result.frames) assert.equal(new Set(f.pieces.map(p => p.at.join(','))).size, f.pieces.length, `${label}: frame overlap`);
  const reordered = clone(c.input);
  reordered.actions.reverse(); reordered.pieces.reverse();
  assert.deepEqual(resolveStageRound(reordered), result, `${label}: enumeration/input order`);
  assert.deepEqual(physical(resolveStageRound(flipInput(c.input))), physical(flipResult(result)), `${label}: player exchange and rotation`);
  const renamed = clone(c.input), names = new Map(renamed.pieces.map((p, i) => [p.id, `renamed:${i}`]));
  renamed.pieces.forEach(p => { p.id = names.get(p.id); });
  renamed.actions.forEach(a => { if (a.type === 'move') a.piece = names.get(a.piece); });
  assert.deepEqual(physical(resolveStageRound(renamed)), physical(result), `${label}: piece ID neutrality`);
  valid++;
}

// Cooldowns expire after the intervening round, even when both moves are blocked.
const equal = resolveStageRound(cases.find(c => c.id === 'N19').input);
const blocked = clone(cases.find(c => c.id === 'N15').input);
blocked.hands = equal.hands; blocked.dropBans = equal.dropBans;
assert.deepEqual(resolveStageRound(blocked).dropBans, []);
const forbidden = clone(cases.find(c => c.id === 'N19').input);
forbidden.dropBans = equal.dropBans;
assert.throws(() => resolveStageRound(forbidden), /repeated equal-rank drop/);

// Independent closed-form positions on an empty row, including arrived pieces and swaps.
let linePairs = 0;
for (let a = 1; a <= 9; a++) for (let b = 1; b <= 9; b++) {
  if (a === b) continue;
  for (let ta = 1; ta <= 9; ta++) for (let tb = 1; tb <= 9; tb++) {
    if (ta === a || tb === b) continue;
    const pos = (s, t, k) => s + Math.sign(t - s) * Math.min(k, Math.abs(t - s));
    let meeting = null;
    for (let k = 1; k <= 8; k++) {
      const ax = pos(a, ta, k), bx = pos(b, tb, k);
      if (ax === bx || (ax === pos(b, tb, k - 1) && bx === pos(a, ta, k - 1))) {
        const aMoving = ax !== pos(a, ta, k - 1);
        meeting = { stage: k, x: ax, winner: aMoving ? 'AR' : 'BR' };
        break;
      }
    }
    const input = { pieces: [{ id: 'AK', side: 'A', kind: 'K', at: [9, 9] }, { id: 'BK', side: 'B', kind: 'K', at: [9, 1] },
      { id: 'AR', side: 'A', kind: 'R', at: [a, 5], upgraded: true }, { id: 'BR', side: 'B', kind: 'R', at: [b, 5] }],
      hands: { A: {}, B: {} }, actions: [{ side: 'A', type: 'move', piece: 'AR', to: [ta, 5] }, { side: 'B', type: 'move', piece: 'BR', to: [tb, 5] }] };
    const r = resolveStageRound(input), contact = r.events.find(e => e.type === 'contact');
    assert.equal(contact?.stage ?? null, meeting?.stage ?? null);
    if (meeting) {
      assert.equal(contact.winner, meeting.winner);
      assert.deepEqual(r.pieces.find(p => p.id === meeting.winner).at, [meeting.x, 5]);
      assert.equal(r.pieces.some(p => p.id === (meeting.winner === 'AR' ? 'BR' : 'AR')), false);
    } else {
      assert.deepEqual(r.pieces.find(p => p.id === 'AR').at, [ta, 5]);
      assert.deepEqual(r.pieces.find(p => p.id === 'BR').at, [tb, 5]);
    }
    linePairs++;
  }
}
console.log(`${cases.length} fixtures passed (${valid} resolved, ${invalid} invalid inputs), with conservation, snapshots, order/ID neutrality and player-rotation symmetry.`);
console.log(`${linePairs} unobstructed rook action pairs matched independent stage-position calculations; cooldown checks passed.`);
console.log('Scope: one-round executable specification, not a complete match engine or AI balance evaluation.');
