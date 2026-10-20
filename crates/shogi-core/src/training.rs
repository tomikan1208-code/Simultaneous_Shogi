//! Training-only complete action enumeration. The reference/UI generator stays
//! independent so equivalence and throughput can be measured on the same corpus.
use crate::{action::planned_path, types::*};
use serde::Serialize;
use std::sync::OnceLock;

type Geometry = Vec<Vec<Square>>;
static GEOMETRY: OnceLock<Vec<Geometry>> = OnceLock::new();
pub const BOARD_SIZE: usize = 9;
pub const BOARD_CELLS: usize = BOARD_SIZE * BOARD_SIZE;
pub const OBSERVATION_PLANES: usize = 62;

#[derive(Serialize)]
pub struct SparseObservation {
    indices: Vec<usize>,
    values: Vec<f32>,
    planes: Vec<(usize, f32)>,
}

impl SparseObservation {
    fn cell(&mut self, plane: usize, at: Square, value: f32) {
        if value != 0.0 {
            self.indices.push(plane * BOARD_CELLS + square_index(at));
            self.values.push(value);
        }
    }
    fn plane(&mut self, plane: usize, value: f32) {
        if value != 0.0 {
            self.planes.push((plane, value));
        }
    }
}

fn ratio(n: u32, d: u32) -> f32 {
    (f64::from(n) / f64::from(d)) as f32
}

fn kind_index(kind: Kind) -> usize {
    Kind::ALL.iter().position(|k| *k == kind).unwrap()
}

/// Exact net-v2 observation from A's perspective. B is a rotation plus plane swap.
/// Sparse transport avoids serializing piece IDs, rules and full positions per leaf.
pub fn sparse_observation(
    position: &Position,
    rules: &RuleSet,
    round: u32,
    repetition: u32,
) -> SparseObservation {
    let mut result = SparseObservation {
        indices: Vec::with_capacity(256),
        values: Vec::with_capacity(256),
        planes: Vec::with_capacity(16),
    };
    for p in &position.pieces {
        let side = p.side.index();
        result.cell(side * 8 + kind_index(p.kind), p.at, 1.0);
        result.cell(16 + side, p.at, f32::from(p.promoted));
        result.cell(18 + side, p.at, f32::from(p.upgraded));
        if let Some(balance) = &rules.balance {
            let activity = position.activity.get(&p.id).cloned().unwrap_or_default();
            result.cell(
                54 + side,
                p.at,
                ratio(
                    u32::from(activity.streak),
                    u32::from(balance.consecutive_threshold),
                ),
            );
            result.cell(56 + side, p.at, ratio(u32::from(activity.fatigue), 8));
            result.cell(
                58 + side,
                p.at,
                ratio(u32::from(balance.movement_rank(p, &activity, true)), 16),
            );
        }
    }
    for side in Side::ALL {
        for kind in Kind::ALL.into_iter().skip(1) {
            result.plane(
                20 + side.index() * 7 + kind_index(kind) - 1,
                ratio(
                    u32::from(position.hands.count(side, kind)),
                    if kind == Kind::P { 18 } else { 4 },
                ),
            );
        }
    }
    for ban in &position.drop_bans {
        result.cell(
            34 + ban.side.index() * 7 + kind_index(ban.kind) - 1,
            ban.to,
            f32::from(ban.remaining),
        );
    }
    for ban in &position.move_bans {
        let plane = 48 + ban.side.index() * 2;
        result.cell(plane, ban.from, f32::from(ban.remaining));
        result.cell(plane + 1, ban.to, f32::from(ban.remaining));
    }
    result.plane(
        52,
        (1.0 - f64::from(round) / f64::from(rules.round_limit)).max(0.0) as f32,
    );
    result.plane(53, ratio(repetition, rules.repetition_limit));
    if let Some(balance) = &rules.balance {
        for side in Side::ALL {
            for y in 1..=BOARD_SIZE as u8 {
                for x in 1..=BOARD_SIZE as u8 {
                    if balance.home(side, [x, y]) {
                        result.cell(
                            60 + side.index(),
                            [x, y],
                            ratio(u32::from(balance.defense_bonus), 8),
                        );
                    }
                }
            }
        }
    }
    result
}

pub fn material_value(position: &Position) -> f64 {
    let values = [0i32, 1, 3, 3, 5, 6, 10, 9];
    let mut total = 0i32;
    for p in &position.pieces {
        let value = values[kind_index(p.kind)] + 2 * i32::from(p.promoted) + i32::from(p.upgraded);
        total += if p.side == Side::A { value } else { -value };
    }
    for side in Side::ALL {
        for (kind, count) in position.hands.get(side) {
            let value = values[kind_index(*kind)] * i32::from(*count);
            total += if side == Side::A { value } else { -value };
        }
    }
    (f64::from(total) / 25.0).tanh()
}

#[derive(Debug, Serialize)]
pub struct MixedStrategy {
    pub p: Vec<f64>,
    pub q: Vec<f64>,
    pub gap: f64,
}

/// Same simultaneous, linearly weighted regret matching as the NumPy reference.
pub fn regret_match(matrix: &[Vec<f64>], iterations: usize) -> EngineResult<MixedStrategy> {
    let rows = matrix.len();
    let cols = matrix.first().map_or(0, Vec::len);
    if rows == 0
        || cols == 0
        || rows > 32
        || cols > 32
        || !(1..=8192).contains(&iterations)
        || matrix
            .iter()
            .any(|row| row.len() != cols || row.iter().any(|v| !v.is_finite()))
    {
        return Err("Invalid finite payoff matrix / iteration count".into());
    }
    let (mut ra, mut rb) = (vec![0.0f64; rows], vec![0.0f64; cols]);
    let (mut sa, mut sb) = (ra.clone(), rb.clone());
    let (mut p, mut q) = (ra.clone(), rb.clone());
    let (mut row_values, mut col_values) = (ra.clone(), rb.clone());
    for t in 1..=iterations {
        let a: f64 = ra.iter().sum();
        let b: f64 = rb.iter().sum();
        for i in 0..rows {
            p[i] = if a > 1e-12 {
                ra[i] / a
            } else {
                1.0 / rows as f64
            };
        }
        for j in 0..cols {
            q[j] = if b > 1e-12 {
                rb[j] / b
            } else {
                1.0 / cols as f64
            };
        }
        col_values.fill(0.0);
        for i in 0..rows {
            row_values[i] = 0.0;
            for j in 0..cols {
                row_values[i] += matrix[i][j] * q[j];
                col_values[j] -= p[i] * matrix[i][j];
            }
        }
        let expected_a: f64 = p.iter().zip(&row_values).map(|(p, v)| p * v).sum();
        let expected_b: f64 = q.iter().zip(&col_values).map(|(q, v)| q * v).sum();
        for i in 0..rows {
            ra[i] = (ra[i] + row_values[i] - expected_a).max(0.0);
            sa[i] += t as f64 * p[i];
        }
        for j in 0..cols {
            rb[j] = (rb[j] + col_values[j] - expected_b).max(0.0);
            sb[j] += t as f64 * q[j];
        }
    }
    let a: f64 = sa.iter().sum();
    let b: f64 = sb.iter().sum();
    for i in 0..rows {
        p[i] = sa[i] / a;
    }
    for j in 0..cols {
        q[j] = sb[j] / b;
    }
    let best_a = matrix
        .iter()
        .map(|row| row.iter().zip(&q).map(|(v, q)| v * q).sum::<f64>())
        .fold(f64::NEG_INFINITY, f64::max);
    let best_b = (0..cols)
        .map(|j| (0..rows).map(|i| p[i] * matrix[i][j]).sum::<f64>())
        .fold(f64::INFINITY, f64::min);
    Ok(MixedStrategy {
        p,
        q,
        gap: (best_a - best_b).max(0.0),
    })
}

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
