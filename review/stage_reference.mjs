// v0.6 executable specification for one round; no UI, search, repetition or match runner.
// Every stage plans from one snapshot. There is no cumulative-path collision test.
const baseRank = { K: 0, P: 1, L: 2, N: 3, S: 4, G: 5, R: 6, B: 6 };
const eq = (a, b) => a[0] === b[0] && a[1] === b[1];
const cellKey = q => q.join(',');
const inside = q => Array.isArray(q) && q.length === 2 && q.every(v => Number.isInteger(v) && v >= 1 && v <= 9);
const rank = p => baseRank[p.kind] + (p.upgraded && !p.promoted ? 1 : 0);
const copy = x => JSON.parse(JSON.stringify(x));

export function plannedPath(p, to) {
  if (!inside(to) || eq(p.at, to)) throw new Error('InvalidIntent: destination');
  const dx = to[0] - p.at[0], dy = to[1] - p.at[1];
  const ax = Math.abs(dx), ay = Math.abs(dy), f = dy * (p.side === 'A' ? -1 : 1);
  const gold = (f === 1 && ax <= 1) || (f === 0 && ax === 1) || (f === -1 && dx === 0);
  let valid = false, jump = false;
  if (p.promoted && ['P', 'L', 'N', 'S'].includes(p.kind)) valid = gold;
  else switch (p.kind) {
    case 'K': valid = Math.max(ax, ay) === 1; break;
    case 'R': valid = dx === 0 || dy === 0 || (p.promoted && ax === 1 && ay === 1); break;
    case 'B': valid = ax === ay || (p.promoted && ax + ay === 1); break;
    case 'G': valid = gold; break;
    case 'S': valid = (f === 1 && ax <= 1) || (f === -1 && ax === 1); break;
    case 'N': valid = ax === 1 && f === 2; jump = true; break;
    case 'L': valid = dx === 0 && f > 0; break;
    case 'P': valid = dx === 0 && f === 1; break;
  }
  if (!valid) throw new Error('InvalidIntent: movement shape');
  if (jump) return [to];
  return Array.from({ length: Math.max(ax, ay) }, (_, i) =>
    [p.at[0] + Math.sign(dx) * (i + 1), p.at[1] + Math.sign(dy) * (i + 1)]);
}

function deadEnd(side, kind, at) {
  const distance = side === 'A' ? at[1] - 1 : 9 - at[1];
  return (['P', 'L'].includes(kind) && distance === 0) || (kind === 'N' && distance < 2);
}

export function resolveStageRound(input) {
  const initial = copy(input), pieces = new Map(initial.pieces.map(p => [p.id, p]));
  const hands = { A: { ...(initial.hands?.A ?? {}) }, B: { ...(initial.hands?.B ?? {}) } };
  const events = [], frames = [], captures = [], newDropBans = [], actors = [], drops = [];
  let stage = 0;
  const occupant = q => [...pieces.values()].find(p => eq(p.at, q));
  const emit = (type, fields = {}) => events.push({ stage, type, ...fields });
  const frame = () => frames.push({ stage, pieces: [...pieces.values()].map(copy).sort((a, b) => a.id.localeCompare(b.id)) });
  const take = (captor, victim, reason) => {
    if (!pieces.has(victim.id)) throw new Error('Invariant: duplicate capture');
    pieces.delete(victim.id);
    if (victim.kind !== 'K') hands[captor.side][victim.kind] = (hands[captor.side][victim.kind] ?? 0) + 1;
    const record = { stage, captor: captor.id, victim: victim.id, victimSide: victim.side,
      kind: victim.kind, at: [...victim.at], captorRank: rank(captor), reason };
    captures.push(record);
    emit('capture', record);
  };
  const pending = () => drops.filter(d => !d.resolved);

  if (pieces.size !== initial.pieces.length || new Set(initial.pieces.map(p => cellKey(p.at))).size !== pieces.size)
    throw new Error('InvalidPosition: duplicate ID or square');
  if (initial.pieces.some(p => !inside(p.at) || !(p.kind in baseRank) || !['A', 'B'].includes(p.side)))
    throw new Error('InvalidPosition: piece');
  if (initial.actions.length !== 2) throw new Error('InvalidIntent: two actions required');

  for (const side of ['A', 'B']) {
    const own = initial.actions.filter(a => a.side === side);
    if (own.length !== 1) throw new Error('InvalidIntent: one action per side');
    const a = own[0];
    if (a.type === 'move') {
      const p = pieces.get(a.piece);
      if (!p || p.side !== side) throw new Error('InvalidIntent: piece owner');
      if ((initial.moveBans ?? []).some(b => b.side === side && b.piece === p.id && eq(b.from, p.at) && eq(b.to, a.to)))
        throw new Error('InvalidIntent: repeated cyclic move');
      if (!['none', 'promote', 'upgrade'].includes(a.choice ?? 'none')) throw new Error('InvalidIntent: change choice');
      actors.push({ id: p.id, side, from: [...p.at], path: plannedPath(p, a.to), index: 0,
        moved: false, finished: false, choice: a.choice ?? 'none' });
    } else if (a.type === 'drop') {
      if (!inside(a.to) || a.kind === 'K' || !(a.kind in baseRank) || !(hands[side][a.kind] > 0))
        throw new Error('InvalidIntent: drop');
      if (deadEnd(side, a.kind, a.to)) throw new Error('InvalidIntent: dead-end drop');
      const old = occupant(a.to);
      if (old?.side === side) throw new Error('InvalidIntent: friendly occupied drop');
      if ((initial.dropBans ?? []).some(b => b.side === side && b.kind === a.kind && eq(b.to, a.to)))
        throw new Error('InvalidIntent: repeated equal-rank drop');
      const id = `drop:${side}`;
      if (pieces.has(id)) throw new Error('InvalidPosition: reserved drop ID');
      drops.push({ ...a, id, originalOccupant: old?.id, resolved: false });
    } else throw new Error('InvalidIntent: explicit pass is disabled');
  }
  frame();

  while (actors.some(a => pieces.has(a.id) && !a.finished) || pending().length) {
    stage++;
    // A guard for implementation defects, not an in-game cyclic-failure adjudication.
    if (stage > 32) throw new Error('Invariant: monotone stage bound exceeded');
    let progress = false;
    const live = actors.filter(a => pieces.has(a.id));
    const plans = live.map(a => {
      const p = pieces.get(a.id), next = a.finished ? p.at : a.path[a.index];
      const block = !a.finished && occupant(next)?.side === a.side;
      if (block) emit('blocked', { actor: a.id, at: [...next], blocker: occupant(next).id });
      return { a, p, from: [...p.at], next: [...(block ? p.at : next)], advance: !a.finished && !block };
    });
    const contact = plans.length === 2 &&
      (eq(plans[0].next, plans[1].next) ||
       (plans.every(p => p.advance) && eq(plans[0].next, plans[1].from) && eq(plans[1].next, plans[0].from)));

    if (contact) {
      const [x, y] = plans;
      const swap = !eq(x.next, y.next);
      const chain = (u, v) => !swap && u.advance && captures.some(c =>
        c.captor === v.p.id && c.victimSide === u.a.side && eq(c.at, u.next) &&
        u.a.path.some(q => eq(q, c.at)) && c.stage < stage);
      let winner, reason;
      if (chain(x, y)) { winner = x; reason = 'chain'; }
      else if (chain(y, x)) { winner = y; reason = 'chain'; }
      else if (!x.advance) { winner = y; reason = x.a.moved ? 'stopped' : 'unmoved'; }
      else if (!y.advance) { winner = x; reason = y.a.moved ? 'stopped' : 'unmoved'; }
      else { winner = rank(x.p) === rank(y.p) ? null : rank(x.p) > rank(y.p) ? x : y; reason = 'rank'; }
      emit('contact', { mode: swap ? 'swap' : 'same_square', actors: [x.p.id, y.p.id], reason,
        at: swap ? [x.next, y.next] : x.next, winner: winner?.p.id ?? null });
      if (winner) {
        const loser = winner === x ? y : x;
        loser.p.at = [...loser.next];
        take(winner.p, loser.p, reason);
        winner.p.at = [...winner.next];
        winner.a.moved ||= winner.advance;
        if (winner.advance) winner.a.index++;
        winner.a.finished = true;
      } else {
        // Capture records use the opponent's square at contact, including swaps.
        x.p.at = [...x.next]; y.p.at = [...y.next];
        take(x.p, y.p, 'mutual'); take(y.p, x.p, 'mutual');
      }
      progress = true;
    } else {
      // Commit both displacements before examining remaining static occupants.
      for (const p of plans) if (p.advance) {
        p.p.at = [...p.next]; p.a.index++; p.a.moved = true;
        p.a.finished = p.a.index === p.a.path.length;
        emit('move', { actor: p.p.id, from: p.from, to: p.next });
        progress = true;
      }
      for (const p of plans) if (p.advance && pieces.has(p.p.id)) {
        const victim = [...pieces.values()].find(q => q.id !== p.p.id && eq(q.at, p.p.at));
        if (victim) {
          if (victim.side === p.p.side || actors.some(a => a.id === victim.id))
            throw new Error('Invariant: unclassified contact');
          take(p.p, victim, victim.roundDrop ? 'drop' : 'static');
          p.a.finished = true;
        }
      }
    }

    // Placement readiness uses the same board after BOTH movements/captures.
    // An unmet vacancy/nifu condition waits; it never creates a phantom blocker.
    const ready = pending().filter(d => {
      const at = occupant(d.to);
      if (d.originalOccupant !== undefined && at?.id === d.originalOccupant) return false;
      return d.kind !== 'P' || ![...pieces.values()].some(p =>
        p.side === d.side && p.kind === 'P' && !p.promoted && p.at[0] === d.to[0]);
    });
    if (ready.length === 2 && eq(ready[0].to, ready[1].to)) {
      const [a, b] = ready, ra = baseRank[a.kind], rb = baseRank[b.kind];
      a.resolved = b.resolved = true;
      if (ra === rb) {
        for (const d of ready) newDropBans.push({ side: d.side, kind: d.kind, to: [...d.to], remaining: 1 });
        emit('equal_drop_failure', { to: a.to, kinds: [a.kind, b.kind] });
      } else {
        const win = ra > rb ? a : b, lose = win === a ? b : a;
        hands[a.side][a.kind]--; hands[b.side][b.kind]--;
        hands[win.side][lose.kind] = (hands[win.side][lose.kind] ?? 0) + 1;
        pieces.set(win.id, { id: win.id, side: win.side, kind: win.kind, at: [...win.to], roundDrop: true });
        emit('drop_duel', { winner: win.id, to: win.to });
      }
      progress = true;
    } else for (const d of ready) {
      const at = occupant(d.to);
      hands[d.side][d.kind]--;
      d.resolved = true;
      const dropped = { id: d.id, side: d.side, kind: d.kind, at: [...d.to], roundDrop: true };
      pieces.set(d.id, dropped);
      if (at) {
        if (at.side === d.side) throw new Error('Invariant: friendly arrival during drop');
        take(at, dropped, 'drop');
        const actor = actors.find(a => a.id === at.id);
        if (actor) actor.finished = true;
      } else emit('drop', { actor: d.id, to: d.to });
      progress = true;
    }
    frame();
    if (!progress) break; // No future occupancy can change without a displacement or placement.
  }
  for (const d of pending()) emit('drop_failure', { side: d.side, kind: d.kind, to: d.to });

  // All movement/capture comparisons use the pre-upgrade ranks stored in capture events.
  const kings = captures.filter(c => c.kind === 'K');
  const laterLost = kings.filter(k => captures.some(c => c.victim === k.captor && c.stage > k.stage));
  let outcome = null;
  if (laterLost.length > 1) throw new Error('Invariant: conflicting king-captor losses');
  if (laterLost.length === 1) outcome = { winner: laterLost[0].victimSide, reason: 'king_captor_lost' };
  else if (kings.length === 2) {
    outcome = kings[0].captorRank === kings[1].captorRank ? { winner: 'draw', reason: 'both_kings' } :
      { winner: kings[0].captorRank > kings[1].captorRank ? kings[1].victimSide : kings[0].victimSide, reason: 'both_kings' };
  } else if (kings.length === 1) outcome = { winner: kings[0].victimSide === 'A' ? 'B' : 'A', reason: 'king_captured' };

  for (const a of actors) {
    const p = pieces.get(a.id);
    if (!p || !a.moved || ['K', 'G'].includes(p.kind) || p.promoted) continue;
    const zone = at => p.side === 'A' ? at[1] <= 3 : at[1] >= 7;
    if (deadEnd(p.side, p.kind, p.at)) { p.promoted = true; p.upgraded = false; emit('forced_promotion', { actor: p.id }); }
    else if (!p.upgraded && (zone(a.from) || zone(p.at))) {
      if (a.choice === 'promote') { p.promoted = true; p.upgraded = false; emit('promotion', { actor: p.id }); }
      else if (a.choice === 'upgrade' && !p.upgraded) { p.upgraded = true; emit('upgrade', { actor: p.id }); }
    }
  }
  const finalPieces = [...pieces.values()].map(p => {
    const result = copy(p); delete result.roundDrop; return result;
  }).sort((a, b) => a.id.localeCompare(b.id));
  for (const side of ['A', 'B']) hands[side] = Object.fromEntries(Object.entries(hands[side]).filter(([, n]) => n > 0).sort());
  if (new Set(finalPieces.map(p => cellKey(p.at))).size !== finalPieces.length) throw new Error('Invariant: final overlap');
  return { version: '0.6', pieces: finalPieces, hands, captures, outcome, dropBans: newDropBans, moveBans: [], frames, events };
}
