use crate::types::*;
use serde::{Deserialize, Serialize};

/// Geometry only: obstacles do not truncate the list of specifiable destinations.
pub fn planned_path(p: &Piece, to: Square) -> EngineResult<Vec<Square>> {
    if !inside(to) || to == p.at {
        return Err("InvalidIntent: destination".into());
    }
    let dx = to[0] as i8 - p.at[0] as i8;
    let dy = to[1] as i8 - p.at[1] as i8;
    let ax = dx.abs();
    let ay = dy.abs();
    let forward = dy * if p.side == Side::A { -1 } else { 1 };
    let gold = forward == 1 && ax <= 1 || forward == 0 && ax == 1 || forward == -1 && dx == 0;
    let valid = if p.promoted && matches!(p.kind, Kind::P | Kind::L | Kind::N | Kind::S) {
        gold
    } else {
        match p.kind {
            Kind::K => ax.max(ay) == 1,
            Kind::R => dx == 0 || dy == 0 || p.promoted && ax == 1 && ay == 1,
            Kind::B => ax == ay || p.promoted && ax + ay == 1,
            Kind::G => gold,
            Kind::S => forward == 1 && ax <= 1 || forward == -1 && ax == 1,
            Kind::N => ax == 1 && forward == 2,
            Kind::L => dx == 0 && forward > 0,
            Kind::P => dx == 0 && forward == 1,
        }
    };
    if !valid {
        return Err("InvalidIntent: movement shape".into());
    }
    if p.kind == Kind::N && !p.promoted {
        return Ok(vec![to]);
    }
    Ok((1..=ax.max(ay))
        .map(|n| {
            [
                (p.at[0] as i8 + dx.signum() * n) as u8,
                (p.at[1] as i8 + dy.signum() * n) as u8,
            ]
        })
        .collect())
}

pub fn validate_action(pos: &Position, action: &Action) -> EngineResult<()> {
    match action {
        Action::Move {
            side, piece, to, ..
        } => {
            let p = pos
                .piece(piece)
                .filter(|p| p.side == *side)
                .ok_or("InvalidIntent: piece owner")?;
            if pos
                .move_bans
                .iter()
                .any(|b| b.side == *side && b.piece == *piece && b.from == p.at && b.to == *to)
            {
                return Err("InvalidIntent: repeated cyclic move".into());
            }
            planned_path(p, *to)?;
        }
        Action::Drop { side, kind, to } => {
            if !inside(*to) || *kind == Kind::K || pos.hands.count(*side, *kind) == 0 {
                return Err("InvalidIntent: drop".into());
            }
            if dead_end(*side, *kind, *to) {
                return Err("InvalidIntent: dead-end drop".into());
            }
            if pos.occupant(*to).is_some_and(|p| p.side == *side) {
                return Err("InvalidIntent: friendly occupied drop".into());
            }
            if pos
                .drop_bans
                .iter()
                .any(|b| b.side == *side && b.kind == *kind && b.to == *to)
            {
                return Err("InvalidIntent: repeated equal-rank drop".into());
            }
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionOption {
    pub action: Action,
    pub path: Vec<Square>,
    pub conditions: Vec<String>,
}

/// Every permissible precommitment; conditional occupancy/nifu is explained, not filtered.
pub fn generate_actions(pos: &Position, side: Side) -> EngineResult<Vec<ActionOption>> {
    pos.validate()?;
    let mut result = Vec::new();
    let mut pieces: Vec<_> = pos.pieces.iter().filter(|p| p.side == side).collect();
    pieces.sort_by_key(|p| (p.at, p.kind));
    for p in pieces {
        for y in 1..=9 {
            for x in 1..=9 {
                let to = [x, y];
                let Ok(path) = planned_path(p, to) else {
                    continue;
                };
                let mut conditions = Vec::new();
                for q in &path {
                    if let Some(b) = pos.occupant(*q) {
                        conditions.push(if b.side == side {
                            format!("friendly_removal:{},{}", q[0], q[1])
                        } else {
                            format!("enemy_departure_or_capture:{},{}", q[0], q[1])
                        });
                    }
                }
                // All three conditional precommitments are valid inputs, even
                // when the chosen change will be inapplicable. Do not silently
                // omit valid inputs from the advertised complete action set.
                let choices = &[Change::None, Change::Promote, Change::Upgrade];
                for &choice in choices {
                    let action = Action::Move {
                        side,
                        piece: p.id.clone(),
                        to,
                        choice,
                    };
                    if validate_action(pos, &action).is_ok() {
                        result.push(ActionOption {
                            action,
                            path: path.clone(),
                            conditions: conditions.clone(),
                        });
                    }
                }
            }
        }
    }
    for kind in Kind::ALL {
        if pos.hands.count(side, kind) == 0 {
            continue;
        }
        for y in 1..=9 {
            for x in 1..=9 {
                let to = [x, y];
                let action = Action::Drop { side, kind, to };
                if validate_action(pos, &action).is_err() {
                    continue;
                }
                let mut conditions = Vec::new();
                if pos.occupant(to).is_some() {
                    conditions.push("enemy_departure".into());
                }
                if kind == Kind::P
                    && pos
                        .pieces
                        .iter()
                        .any(|p| p.side == side && p.kind == Kind::P && !p.promoted && p.at[0] == x)
                {
                    conditions.push("nifu_removal".into());
                }
                result.push(ActionOption {
                    action,
                    path: vec![to],
                    conditions,
                });
            }
        }
    }
    Ok(result)
}
