use crate::{
    action::{planned_path, validate_action},
    types::*,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capture {
    pub stage: u8,
    pub captor: String,
    pub captor_side: Side,
    pub victim: String,
    pub victim_side: Side,
    pub kind: Kind,
    pub at: Square,
    pub captor_rank: u8,
    pub reason: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StagePlan {
    pub actor: String,
    pub from: Square,
    pub proposed: Square,
    pub next: Square,
    pub advance: bool,
    pub blocker: Option<String>,
    pub finished: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Frame {
    pub stage: u8,
    pub pieces: Vec<Piece>,
    pub plans: Vec<StagePlan>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundResolution {
    pub version: String,
    #[serde(flatten)]
    pub position: Position,
    pub actions: Vec<Action>,
    pub captures: Vec<Capture>,
    pub outcome: Option<Outcome>,
    pub frames: Vec<Frame>,
    pub events: Vec<Value>,
    pub before_hash: String,
    pub after_hash: String,
    pub metrics: BTreeMap<String, u64>,
}
impl RoundResolution {
    /// Replay identity is independent of whether detailed diagnostics were kept.
    pub fn semantic_hash(&self) -> String {
        crate::replay::hash_value(&(
            &self.version,
            &self.position,
            &self.actions,
            &self.captures,
            &self.outcome,
            &self.before_hash,
            &self.after_hash,
            &self.metrics,
        ))
    }
}

struct Actor {
    id: String,
    side: Side,
    from: Square,
    path: Vec<Square>,
    index: usize,
    moved: bool,
    finished: bool,
    choice: Change,
}
struct Drop {
    side: Side,
    kind: Kind,
    to: Square,
    id: String,
    original: Option<String>,
    resolved: bool,
}
#[derive(Clone)]
struct Plan {
    actor: usize,
    piece: Piece,
    from: Square,
    next: Square,
    advance: bool,
}
struct Working {
    pieces: BTreeMap<String, Piece>,
    hands: Hands,
    captures: Vec<Capture>,
    events: Vec<Value>,
    stage: u8,
    round_drops: BTreeSet<String>,
    diagnostics: bool,
    metrics: BTreeMap<String, u64>,
}
impl Working {
    fn occupant(&self, at: Square) -> Option<&Piece> {
        self.pieces.values().find(|p| p.at == at)
    }
    fn emit(&mut self, event: Value) {
        *self
            .metrics
            .entry(event["type"].as_str().expect("event type").into())
            .or_default() += 1;
        if !self.diagnostics {
            return;
        }
        let mut e = event.as_object().expect("event object").clone();
        e.insert("stage".into(), self.stage.into());
        self.events.push(Value::Object(e));
    }
    fn take(&mut self, captor: &Piece, victim: &Piece, reason: &str) -> EngineResult<()> {
        if self.pieces.remove(&victim.id).is_none() {
            return Err("Invariant: duplicate capture".into());
        }
        self.hands.add(captor.side, victim.kind);
        let c = Capture {
            stage: self.stage,
            captor: captor.id.clone(),
            captor_side: captor.side,
            victim: victim.id.clone(),
            victim_side: victim.side,
            kind: victim.kind,
            at: victim.at,
            captor_rank: captor.rank(),
            reason: reason.into(),
        };
        let mut e = serde_json::to_value(&c).map_err(|e| e.to_string())?;
        e["type"] = "capture".into();
        self.emit(e);
        self.captures.push(c);
        Ok(())
    }
    fn validate_board(&self) -> EngineResult<()> {
        let mut seen = [false; 81];
        for p in self.pieces.values() {
            if seen[square_index(p.at)] {
                return Err("Invariant: frame overlap".into());
            }
            seen[square_index(p.at)] = true;
        }
        Ok(())
    }
    fn frame(&self, plans: Vec<StagePlan>) -> EngineResult<Frame> {
        self.validate_board()?;
        Ok(Frame {
            stage: self.stage,
            pieces: self.pieces.values().cloned().collect(),
            plans,
        })
    }
}

/// Both actions are validated against the SAME initial position. A stage proposes
/// both displacements before committing captures, then evaluates all pending drops.
pub fn resolve_round(initial: &Position, actions: &[Action]) -> EngineResult<RoundResolution> {
    resolve_round_with_diagnostics(initial, actions, true)
}

pub fn resolve_round_with_diagnostics(
    initial: &Position,
    actions: &[Action],
    diagnostics: bool,
) -> EngineResult<RoundResolution> {
    initial.validate()?;
    if actions.len() != 2 {
        return Err("InvalidIntent: two actions required".into());
    }
    let mut ordered = Vec::new();
    for side in Side::ALL {
        let own: Vec<_> = actions.iter().filter(|a| a.side() == side).collect();
        if own.len() != 1 {
            return Err("InvalidIntent: one action per side".into());
        }
        validate_action(initial, own[0])?;
        ordered.push(own[0].clone());
    }
    let mut w = Working {
        pieces: initial
            .pieces
            .iter()
            .map(|p| (p.id.clone(), p.clone()))
            .collect(),
        hands: initial.hands.clone(),
        captures: vec![],
        events: vec![],
        stage: 0,
        round_drops: BTreeSet::new(),
        diagnostics,
        metrics: BTreeMap::new(),
    };
    let mut actors = Vec::new();
    let mut drops = Vec::new();
    let mut next_id = initial.next_piece_id;
    for action in &ordered {
        match action {
            Action::Move {
                side,
                piece,
                to,
                choice,
            } => {
                let p = initial.piece(piece).expect("validated piece");
                actors.push(Actor {
                    id: piece.clone(),
                    side: *side,
                    from: p.at,
                    path: planned_path(p, *to)?,
                    index: 0,
                    moved: false,
                    finished: false,
                    choice: *choice,
                });
            }
            Action::Drop { side, kind, to } => {
                let id = loop {
                    let candidate = format!("drop:{next_id}:{side:?}");
                    next_id = next_id
                        .checked_add(1)
                        .ok_or("InvalidPosition: ID counter exhausted")?;
                    if !w.pieces.contains_key(&candidate) {
                        break candidate;
                    }
                };
                drops.push(Drop {
                    side: *side,
                    kind: *kind,
                    to: *to,
                    id,
                    original: initial.occupant(*to).map(|p| p.id.clone()),
                    resolved: false,
                });
            }
        }
    }
    let mut frames = if diagnostics {
        vec![w.frame(vec![])?]
    } else {
        vec![]
    };
    let mut bans = Vec::new();
    while actors
        .iter()
        .any(|a| !a.finished && w.pieces.contains_key(&a.id))
        || drops.iter().any(|d| !d.resolved)
    {
        w.stage += 1;
        // A defect guard, never adjudicated as the game's reserve cycle-cancellation rule.
        if w.stage > 32 {
            return Err("Invariant: monotone stage bound exceeded".into());
        }
        let mut progress = false;
        let mut plans = Vec::new();
        let mut trace = Vec::new();
        for (i, a) in actors.iter().enumerate() {
            let Some(p) = w.pieces.get(&a.id).cloned() else {
                continue;
            };
            let proposed = if a.finished { p.at } else { a.path[a.index] };
            let blocker = if !a.finished {
                w.occupant(proposed)
                    .filter(|p| p.side == a.side)
                    .map(|p| p.id.clone())
            } else {
                None
            };
            if let Some(blocker) = &blocker {
                w.emit(json!({"type":"blocked", "actor":a.id, "at":proposed, "blocker":blocker}));
            }
            let advance = !a.finished && blocker.is_none();
            let next = if advance { proposed } else { p.at };
            if diagnostics {
                trace.push(StagePlan {
                    actor: a.id.clone(),
                    from: p.at,
                    proposed,
                    next,
                    advance,
                    blocker,
                    finished: a.finished,
                });
            }
            plans.push(Plan {
                actor: i,
                from: p.at,
                piece: p,
                next,
                advance,
            });
        }
        let contact = plans.len() == 2
            && (plans[0].next == plans[1].next
                || plans.iter().all(|p| p.advance)
                    && plans[0].next == plans[1].from
                    && plans[1].next == plans[0].from);
        if contact {
            let x = &plans[0];
            let y = &plans[1];
            let swap = x.next != y.next;
            let chain = |u: &Plan, v: &Plan| {
                !swap
                    && u.advance
                    && w.captures.iter().any(|c| {
                        c.captor == v.piece.id
                            && c.victim_side == u.piece.side
                            && c.at == u.next
                            && actors[u.actor].path.contains(&c.at)
                            && c.stage < w.stage
                    })
            };
            let (winner, reason) = if chain(x, y) {
                (Some(0), "chain")
            } else if chain(y, x) {
                (Some(1), "chain")
            } else if !x.advance {
                (
                    Some(1),
                    if actors[x.actor].moved {
                        "stopped"
                    } else {
                        "unmoved"
                    },
                )
            } else if !y.advance {
                (
                    Some(0),
                    if actors[y.actor].moved {
                        "stopped"
                    } else {
                        "unmoved"
                    },
                )
            } else {
                (
                    match x.piece.rank().cmp(&y.piece.rank()) {
                        std::cmp::Ordering::Greater => Some(0),
                        std::cmp::Ordering::Less => Some(1),
                        _ => None,
                    },
                    "rank",
                )
            };
            w.emit(json!({"type":"contact", "mode":if swap {"swap"} else {"same_square"}, "actors":[x.piece.id,y.piece.id], "reason":reason,
                "at":if swap {json!([x.next,y.next])} else {json!(x.next)}, "winner":winner.map(|i| &plans[i].piece.id), "ranks":[x.piece.rank(),y.piece.rank()]}));
            for p in &plans {
                let a = &mut actors[p.actor];
                a.moved |= p.advance;
                if p.advance {
                    a.index += 1;
                }
                a.finished = true;
            }
            if let Some(i) = winner {
                let win = &plans[i];
                let lose = &plans[1 - i];
                let mut victim = lose.piece.clone();
                victim.at = lose.next;
                w.take(&win.piece, &victim, reason)?;
                w.pieces.get_mut(&win.piece.id).expect("winner exists").at = win.next;
            } else {
                let mut xp = x.piece.clone();
                xp.at = x.next;
                let mut yp = y.piece.clone();
                yp.at = y.next;
                w.take(&xp, &yp, "mutual")?;
                w.take(&yp, &xp, "mutual")?;
            }
            progress = true;
        } else {
            for p in plans.iter().filter(|p| p.advance) {
                w.pieces.get_mut(&p.piece.id).expect("moving piece").at = p.next;
                let a = &mut actors[p.actor];
                a.index += 1;
                a.moved = true;
                a.finished = a.index == a.path.len();
                w.emit(json!({"type":"move", "actor":p.piece.id, "from":p.from, "to":p.next}));
                progress = true;
            }
            for p in plans.iter().filter(|p| p.advance) {
                let Some(captor) = w.pieces.get(&p.piece.id).cloned() else {
                    continue;
                };
                let victim = w
                    .pieces
                    .values()
                    .find(|q| q.id != captor.id && q.at == captor.at)
                    .cloned();
                if let Some(victim) = victim {
                    if victim.side == captor.side || actors.iter().any(|a| a.id == victim.id) {
                        return Err("Invariant: unclassified contact".into());
                    }
                    let reason = if w.round_drops.contains(&victim.id) {
                        "drop"
                    } else {
                        "static"
                    };
                    w.take(&captor, &victim, reason)?;
                    actors[p.actor].finished = true;
                }
            }
        }

        // Readiness is computed ONCE from the post-movement snapshot for BOTH sides.
        let ready: Vec<usize> = drops
            .iter()
            .enumerate()
            .filter(|(_, d)| !d.resolved)
            .filter(|(_, d)| {
                if d.original
                    .as_ref()
                    .is_some_and(|id| w.occupant(d.to).is_some_and(|p| &p.id == id))
                {
                    return false;
                }
                d.kind != Kind::P
                    || !w.pieces.values().any(|p| {
                        p.side == d.side && p.kind == Kind::P && !p.promoted && p.at[0] == d.to[0]
                    })
            })
            .map(|(i, _)| i)
            .collect();
        for d in drops.iter().filter(|d| !d.resolved) {
            if !ready.iter().any(|i| drops[*i].id == d.id) {
                w.emit(json!({"type":"drop_wait", "side":d.side, "kind":d.kind, "to":d.to,
                    "reason":if d.original.as_ref().is_some_and(|id| w.occupant(d.to).is_some_and(|p| &p.id == id)) {"occupied"} else {"nifu"}}));
            }
        }
        if ready.len() == 2 && drops[ready[0]].to == drops[ready[1]].to {
            let a = ready[0];
            let b = ready[1];
            drops[a].resolved = true;
            drops[b].resolved = true;
            if drops[a].kind.rank() == drops[b].kind.rank() {
                for &i in &ready {
                    let d = &drops[i];
                    bans.push(DropBan {
                        side: d.side,
                        kind: d.kind,
                        to: d.to,
                        remaining: 1,
                    });
                }
                w.emit(json!({"type":"equal_drop_failure", "to":drops[a].to, "kinds":[drops[a].kind,drops[b].kind]}));
            } else {
                let (win, lose) = if drops[a].kind.rank() > drops[b].kind.rank() {
                    (&drops[a], &drops[b])
                } else {
                    (&drops[b], &drops[a])
                };
                w.hands.remove(win.side, win.kind);
                w.hands.remove(lose.side, lose.kind);
                w.hands.add(win.side, lose.kind);
                w.pieces.insert(
                    win.id.clone(),
                    Piece {
                        id: win.id.clone(),
                        side: win.side,
                        kind: win.kind,
                        at: win.to,
                        promoted: false,
                        upgraded: false,
                    },
                );
                w.round_drops.insert(win.id.clone());
                w.emit(json!({"type":"drop_duel", "winner":win.id, "to":win.to}));
            }
            progress = true;
        } else {
            for i in ready {
                let d = &mut drops[i];
                let at = w.occupant(d.to).cloned();
                w.hands.remove(d.side, d.kind);
                d.resolved = true;
                let dropped = Piece {
                    id: d.id.clone(),
                    side: d.side,
                    kind: d.kind,
                    at: d.to,
                    promoted: false,
                    upgraded: false,
                };
                w.pieces.insert(d.id.clone(), dropped.clone());
                w.round_drops.insert(d.id.clone());
                if let Some(captor) = at {
                    if captor.side == d.side {
                        return Err("Invariant: friendly arrival during drop".into());
                    }
                    w.take(&captor, &dropped, "drop")?;
                    if let Some(a) = actors.iter_mut().find(|a| a.id == captor.id) {
                        a.finished = true;
                    }
                } else {
                    w.emit(json!({"type":"drop", "actor":d.id, "to":d.to}));
                }
                progress = true;
            }
        }
        if diagnostics {
            frames.push(w.frame(trace)?);
        } else {
            w.validate_board()?;
        }
        if !progress {
            break;
        }
    }
    for d in drops.iter().filter(|d| !d.resolved) {
        w.emit(json!({"type":"drop_failure", "side":d.side, "kind":d.kind, "to":d.to}));
    }
    let outcome = adjudicate_kings(&w.captures)?;
    for a in &actors {
        let status = match w.pieces.get(&a.id) {
            None => "move_captured",
            Some(_) if !a.moved => "move_zero",
            Some(p) if Some(&p.at) == a.path.last() => "move_reached",
            Some(_) => "move_partial",
        };
        *w.metrics.entry(status.into()).or_default() += 1;
    }
    for a in &actors {
        let Some(p) = w.pieces.get_mut(&a.id) else {
            continue;
        };
        if !a.moved || !p.kind.changeable() || p.promoted {
            continue;
        }
        let event = if dead_end(p.side, p.kind, p.at) {
            p.promoted = true;
            p.upgraded = false;
            Some("forced_promotion")
        } else if !p.upgraded && (in_zone(p.side, a.from) || in_zone(p.side, p.at)) {
            match a.choice {
                Change::Promote => {
                    p.promoted = true;
                    p.upgraded = false;
                    Some("promotion")
                }
                Change::Upgrade if !p.upgraded => {
                    p.upgraded = true;
                    Some("upgrade")
                }
                _ => None,
            }
        } else {
            None
        };
        if let Some(kind) = event {
            w.emit(json!({"type":kind, "actor":a.id}));
        }
    }
    let mut position = Position {
        pieces: w.pieces.into_values().collect(),
        hands: w.hands,
        drop_bans: bans,
        move_bans: vec![],
        next_piece_id: next_id,
    };
    position.normalize();
    position.validate()?;
    Ok(RoundResolution {
        version: RULE_VERSION.into(),
        before_hash: crate::replay::position_hash(initial),
        after_hash: crate::replay::position_hash(&position),
        position,
        actions: ordered,
        captures: w.captures,
        outcome,
        frames,
        events: w.events,
        metrics: w.metrics,
    })
}

fn adjudicate_kings(captures: &[Capture]) -> EngineResult<Option<Outcome>> {
    let kings: Vec<_> = captures.iter().filter(|c| c.kind == Kind::K).collect();
    let later: Vec<_> = kings
        .iter()
        .filter(|k| {
            captures
                .iter()
                .any(|c| c.victim == k.captor && c.stage > k.stage)
        })
        .collect();
    if later.len() > 1 {
        return Err("Invariant: conflicting king-captor losses".into());
    }
    let outcome = if let Some(k) = later.first() {
        Some(Outcome {
            winner: k.victim_side.into(),
            reason: "king_captor_lost".into(),
        })
    } else if kings.len() == 2 {
        let winner = match kings[0].captor_rank.cmp(&kings[1].captor_rank) {
            std::cmp::Ordering::Equal => Winner::Draw,
            std::cmp::Ordering::Greater => kings[0].captor_side.into(),
            std::cmp::Ordering::Less => kings[1].captor_side.into(),
        };
        Some(Outcome {
            winner,
            reason: "both_kings".into(),
        })
    } else {
        kings.first().map(|k| Outcome {
            winner: k.captor_side.into(),
            reason: "king_captured".into(),
        })
    };
    Ok(outcome)
}
