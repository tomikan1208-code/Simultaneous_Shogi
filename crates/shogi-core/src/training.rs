//! Training-only complete action enumeration. The reference/UI generator stays
//! independent so equivalence and throughput can be measured on the same corpus.
use crate::{action::planned_path, types::*};
use std::sync::OnceLock;

type Geometry = Vec<Vec<Square>>;
static GEOMETRY: OnceLock<Vec<Geometry>> = OnceLock::new();

fn geometry(p: &Piece) -> &Geometry {
    let table = GEOMETRY.get_or_init(|| {
        let mut table = Vec::with_capacity(2 * 8 * 2 * 81);
        for side in Side::ALL {
            for kind in Kind::ALL {
                for promoted in [false, true] {
                    for i in 0..81 {
                        let p = Piece {
                            id: "template".into(),
                            side,
                            kind,
                            promoted,
                            upgraded: false,
                            at: [(i % 9 + 1) as u8, (i / 9 + 1) as u8],
                        };
                        let paths = (1..=9)
                            .flat_map(|y| (1..=9).map(move |x| [x, y]))
                            .filter_map(|to| planned_path(&p, to).ok())
                            .collect();
                        table.push(paths);
                    }
                }
            }
        }
        table
    });
    let kind = Kind::ALL.iter().position(|k| *k == p.kind).unwrap();
    &table[((p.side.index() * 8 + kind) * 2 + usize::from(p.promoted)) * 81 + square_index(p.at)]
}

/// No occupancy truncation, no check filter, no nifu filter, all three choices.
/// The 81-bit mask only filters friendly-occupied DROP destinations.
pub fn fast_actions(pos: &Position, side: Side) -> EngineResult<Vec<Action>> {
    pos.validate()?;
    let friendly = pos
        .pieces
        .iter()
        .filter(|p| p.side == side)
        .fold(0u128, |mask, p| mask | (1u128 << square_index(p.at)));
    let mut pieces: Vec<_> = pos.pieces.iter().filter(|p| p.side == side).collect();
    pieces.sort_by_key(|p| (p.at, p.kind));
    let mut actions = Vec::with_capacity(256);
    for p in pieces {
        for path in geometry(p) {
            let to = *path.last().expect("nonempty geometry");
            if pos
                .move_bans
                .iter()
                .any(|b| b.side == side && b.piece == p.id && b.from == p.at && b.to == to)
            {
                continue;
            }
            for choice in [Change::None, Change::Promote, Change::Upgrade] {
                actions.push(Action::Move {
                    side,
                    piece: p.id.clone(),
                    to,
                    choice,
                });
            }
        }
    }
    for kind in Kind::ALL {
        if kind == Kind::K || pos.hands.count(side, kind) == 0 {
            continue;
        }
        for y in 1..=9 {
            for x in 1..=9 {
                let to = [x, y];
                if dead_end(side, kind, to)
                    || friendly & (1u128 << square_index(to)) != 0
                    || pos
                        .drop_bans
                        .iter()
                        .any(|b| b.side == side && b.kind == kind && b.to == to)
                {
                    continue;
                }
                actions.push(Action::Drop { side, kind, to });
            }
        }
    }
    Ok(actions)
}
