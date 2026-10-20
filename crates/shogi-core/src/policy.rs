//! Policies observe only the public position. They cannot access Match.pending.
use crate::{
    action::{generate_actions, planned_path},
    types::*,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Policy {
    Random,
    Hunter,
    Defense,
    Interference,
    Upgrade,
}
pub struct Rng(pub u64);
impl Rng {
    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e3779b97f4a7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d049bb133111eb);
        z ^ (z >> 31)
    }
}
fn distance(a: Square, b: Square) -> i32 {
    (a[0] as i32 - b[0] as i32).abs() + (a[1] as i32 - b[1] as i32).abs()
}

pub fn choose(pos: &Position, side: Side, policy: Policy, rng: &mut Rng) -> EngineResult<Action> {
    let options = generate_actions(pos, side)?;
    if options.is_empty() {
        return Err(format!(
            "No specifiable action for {side:?}; no pass/stalemate rule is adopted"
        ));
    }
    if matches!(policy, Policy::Random) {
        return Ok(options[(rng.next_u64() % options.len() as u64) as usize]
            .action
            .clone());
    }
    let enemy_king = pos
        .pieces
        .iter()
        .find(|p| p.side != side && p.kind == Kind::K)
        .map(|p| p.at);
    let king = pos
        .pieces
        .iter()
        .find(|p| p.side == side && p.kind == Kind::K);
    let mut best = i32::MIN;
    let mut selected = Vec::new();
    for option in &options {
        let mut score = 0;
        let to = option.action.to();
        let mut effective = to;
        for q in &option.path {
            if let Some(p) = pos.occupant(*q) {
                effective = *q;
                if p.side == side {
                    score -= 250;
                } else {
                    score += if p.kind == Kind::K {
                        100_000
                    } else {
                        p.kind.rank() as i32 * 100 + 50
                    };
                }
                break;
            }
        }
        if let Some(k) = enemy_king {
            score -= distance(effective, k) * 5;
        }
        match &option.action {
            Action::Move { piece, choice, .. } => {
                let p = pos.piece(piece).expect("generated piece");
                if *choice != Change::None
                    && p.kind.changeable()
                    && !p.promoted
                    && !p.upgraded
                    && (in_zone(side, p.at) || in_zone(side, effective))
                {
                    score += if matches!(policy, Policy::Upgrade) {
                        130
                    } else {
                        18
                    };
                    if *choice == Change::Promote {
                        score += 1;
                    }
                }
                if p.kind == Kind::K {
                    score -= 20;
                }
                if matches!(policy, Policy::Defense) && p.kind == Kind::K {
                    score += pos
                        .pieces
                        .iter()
                        .filter(|p| p.side != side)
                        .map(|p| distance(effective, p.at).min(5))
                        .sum::<i32>()
                        * 12;
                }
            }
            Action::Drop { .. } => {
                if !option.conditions.is_empty() {
                    score -= 100;
                }
                if matches!(policy, Policy::Interference) {
                    score += 40;
                }
            }
        }
        if matches!(policy, Policy::Defense) {
            if let Some(king) = king {
                for enemy in pos.pieces.iter().filter(|p| p.side != side) {
                    if planned_path(enemy, king.at).is_ok_and(|path| path.contains(&effective)) {
                        score += 80;
                    }
                }
            }
        }
        if score > best {
            best = score;
            selected.clear();
        }
        if score == best {
            selected.push(option.action.clone());
        }
    }
    Ok(selected[(rng.next_u64() % selected.len() as u64) as usize].clone())
}
