use crate::{
    action::validate_action,
    replay::{hash_value, position_hash, Replay, RoundRecord, REPLAY_FORMAT},
    resolution::{resolve_round_with_diagnostics, RoundResolution},
    types::*,
};
use serde::Serialize;
use std::collections::BTreeMap;

/// Pending secrets deliberately have no Serialize implementation and are never
/// included in a public view, policy observation, or exported replay.
pub struct Match {
    pub position: Position,
    pub rules: RuleSet,
    pub round: u32,
    pub outcome: Option<Outcome>,
    pub replay: Replay,
    pub last_resolution: Option<RoundResolution>,
    repetitions: BTreeMap<String, u32>,
    pending: [Option<Action>; 2],
    diagnostics: bool,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchView {
    pub position: Position,
    pub rules: RuleSet,
    pub round: u32,
    pub outcome: Option<Outcome>,
    pub committed: [bool; 2],
    pub state_hash: String,
    pub last_resolution: Option<RoundResolution>,
}
impl Match {
    pub fn new(position: Position, rules: RuleSet) -> EngineResult<Self> {
        Self::with_diagnostics(position, rules, true)
    }
    pub fn with_diagnostics(
        mut position: Position,
        rules: RuleSet,
        diagnostics: bool,
    ) -> EngineResult<Self> {
        rules.validate()?;
        position.validate()?;
        position.normalize();
        for side in Side::ALL {
            if position
                .pieces
                .iter()
                .filter(|p| p.side == side && p.kind == Kind::K)
                .count()
                != 1
            {
                return Err("InvalidMatch: initial position needs one king per side".into());
            }
        }
        let repetitions = BTreeMap::from([(position_hash(&position), 1)]);
        let replay = Replay {
            format: REPLAY_FORMAT.into(),
            initial: position.clone(),
            rules: rules.clone(),
            rounds: vec![],
        };
        Ok(Self {
            position,
            rules,
            round: 0,
            outcome: None,
            replay,
            last_resolution: None,
            repetitions,
            pending: [None, None],
            diagnostics,
        })
    }
    pub fn standard() -> Self {
        Self::new(Position::initial(), RuleSet::default()).expect("standard match")
    }
    pub fn repetition_count(&self) -> u32 {
        self.repetitions
            .get(&position_hash(&self.position))
            .copied()
            .unwrap_or(0)
    }
    /// Search has exactly the same terminal rules as a played round, including
    /// this match's repetition history. No pending opponent action is exposed.
    pub fn preview_round(&self, actions: &[Action]) -> EngineResult<RoundResolution> {
        if self.outcome.is_some() || self.pending.iter().any(Option::is_some) {
            return Err("Search requires an unfinished public round".into());
        }
        let mut result = resolve_round_with_diagnostics(&self.position, actions, false)?;
        let count = self
            .repetitions
            .get(&position_hash(&result.position))
            .copied()
            .unwrap_or(0)
            + 1;
        if result.outcome.is_none() && count >= self.rules.repetition_limit {
            result.outcome = Some(Outcome {
                winner: Winner::Draw,
                reason: "repetition".into(),
            });
        }
        if result.outcome.is_none() && self.round + 1 >= self.rules.round_limit {
            result.outcome = Some(Outcome {
                winner: Winner::Draw,
                reason: "round_limit".into(),
            });
        }
        Ok(result)
    }
    pub fn next_repetition_count(&self, position: &Position) -> u32 {
        self.repetitions
            .get(&position_hash(position))
            .copied()
            .unwrap_or(0)
            + 1
    }
    pub fn state_hash(&self) -> String {
        hash_value(&(
            &self.position,
            &self.rules,
            self.round,
            &self.outcome,
            &self.repetitions,
        ))
    }
    pub fn view(&self) -> MatchView {
        MatchView {
            position: self.position.clone(),
            rules: self.rules.clone(),
            round: self.round,
            outcome: self.outcome.clone(),
            committed: self.pending.each_ref().map(Option::is_some),
            state_hash: self.state_hash(),
            last_resolution: self.last_resolution.clone(),
        }
    }
    pub fn submit(&mut self, side: Side, action: Action) -> EngineResult<MatchView> {
        if self.outcome.is_some() {
            return Err("Match is finished".into());
        }
        if action.side() != side {
            return Err("InvalidIntent: side mismatch".into());
        }
        if self.pending[side.index()].is_some() {
            return Err("Action already committed".into());
        }
        validate_action(&self.position, &action)?;
        // Resolve before changing pending state so a defect leaves the match intact.
        if let Some(other) = &self.pending[side.other().index()] {
            let actions = vec![action, other.clone()];
            self.advance(&actions)?;
            self.pending = [None, None];
        } else {
            self.pending[side.index()] = Some(action);
        }
        Ok(self.view())
    }
    pub fn play_round(&mut self, actions: &[Action]) -> EngineResult<&RoundResolution> {
        if self.pending.iter().any(Option::is_some) {
            return Err("Round has pending secret inputs".into());
        }
        self.advance(actions)?;
        Ok(self.last_resolution.as_ref().expect("resolved round"))
    }
    fn advance(&mut self, actions: &[Action]) -> EngineResult<()> {
        if self.outcome.is_some() {
            return Err("Match is finished".into());
        }
        let before_hash = self.state_hash();
        let result = resolve_round_with_diagnostics(&self.position, actions, self.diagnostics)?;
        self.position = result.position.clone();
        self.round += 1;
        self.outcome = result.outcome.clone();
        let count = self
            .repetitions
            .entry(position_hash(&self.position))
            .or_default();
        *count += 1;
        if self.outcome.is_none() && *count >= self.rules.repetition_limit {
            self.outcome = Some(Outcome {
                winner: Winner::Draw,
                reason: "repetition".into(),
            });
        }
        if self.outcome.is_none() && self.round >= self.rules.round_limit {
            self.outcome = Some(Outcome {
                winner: Winner::Draw,
                reason: "round_limit".into(),
            });
        }
        let mut record = RoundRecord {
            round: self.round,
            actions: result.actions.clone(),
            before_hash,
            after_hash: self.state_hash(),
            resolution_hash: result.semantic_hash(),
            outcome: self.outcome.clone(),
            chain_hash: String::new(),
        };
        let previous = self
            .replay
            .rounds
            .last()
            .map(|r| r.chain_hash.clone())
            .unwrap_or_else(|| self.replay.header_hash());
        record.chain_hash = hash_value(&(previous, &record));
        self.replay.rounds.push(record);
        self.last_resolution = Some(result);
        Ok(())
    }
}
