use crate::{game::Match, types::*};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

pub const REPLAY_FORMAT: &str = "simultaneous-shogi/replay-v1";
pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn hash_value(value: &impl Serialize) -> String {
    digest(&serde_json::to_vec(value).expect("serializable engine state"))
}

/// Identity-independent repetition key. IDs and the allocation counter are not
/// game state, but promotion and ALL next-round restrictions are.
pub fn position_hash(pos: &Position) -> String {
    let mut board: Vec<_> = pos
        .pieces
        .iter()
        .map(|p| (p.at, p.side, p.kind, p.promoted, p.upgraded))
        .collect();
    board.sort();
    let mut drops: Vec<_> = pos
        .drop_bans
        .iter()
        .map(|b| (b.side, b.kind, b.to, b.remaining))
        .collect();
    drops.sort();
    let mut moves: Vec<_> = pos
        .move_bans
        .iter()
        .map(|b| (b.side, b.from, b.to, b.remaining))
        .collect();
    moves.sort();
    let mut hands = pos.hands.clone();
    hands.normalize();
    let mut value = json!({"board":board,"hands":hands,"dropBans":drops,"moveBans":moves});
    if !pos.activity.is_empty() {
        let mut activity: Vec<_> = pos
            .activity
            .iter()
            .filter_map(|(id, a)| pos.piece(id).map(|p| (p.at, p.side, p.kind, a)))
            .collect();
        activity.sort();
        value["activity"] = json!(activity);
    }
    hash_value(&value)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoundRecord {
    pub round: u32,
    pub actions: Vec<Action>,
    pub before_hash: String,
    pub after_hash: String,
    pub resolution_hash: String,
    pub outcome: Option<Outcome>,
    pub chain_hash: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Replay {
    pub format: String,
    pub rules: RuleSet,
    pub initial: Position,
    pub rounds: Vec<RoundRecord>,
}
impl Replay {
    pub fn resolution_at(&self, round: u32) -> EngineResult<crate::resolution::RoundResolution> {
        if round == 0 || round as usize > self.rounds.len() {
            return Err("Replay round out of range".into());
        }
        let mut prefix = self.clone();
        prefix.rounds.truncate(round as usize);
        prefix
            .verify()?
            .last_resolution
            .ok_or_else(|| "Replay has no resolved round".into())
    }
    pub fn header_hash(&self) -> String {
        hash_value(&(&self.format, &self.rules, &self.initial))
    }
    pub fn verify(&self) -> EngineResult<Match> {
        if self.format != REPLAY_FORMAT {
            return Err("Unsupported replay format".into());
        }
        self.rules.validate()?;
        if self.rounds.len() > self.rules.round_limit as usize {
            return Err("Replay exceeds round limit".into());
        }
        let mut game = Match::new(self.initial.clone(), self.rules.clone())?;
        for record in &self.rounds {
            game.play_round(&record.actions)
                .map_err(|e| format!("Replay round {}: {e}", record.round))?;
            if game.replay.rounds.last() != Some(record) {
                return Err(format!(
                    "Replay hash/result mismatch at round {}",
                    record.round
                ));
            }
        }
        Ok(game)
    }
}
