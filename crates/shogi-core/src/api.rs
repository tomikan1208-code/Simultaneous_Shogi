use crate::{
    action::generate_actions,
    game::Match,
    policy::{choose, Policy, Rng},
    replay::{position_hash, Replay},
    resolution::resolve_round_with_rules,
    types::*,
};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Debug, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    New {
        position: Option<Position>,
        rules: Option<RuleSet>,
    },
    View,
    Actions {
        side: Side,
    },
    Submit {
        side: Side,
        action: Action,
    },
    SubmitAi {
        side: Side,
        policy: Policy,
        seed: u64,
    },
    Export,
    ReplayRound {
        round: u32,
    },
    Import {
        replay: Replay,
    },
    Resolve {
        position: Position,
        actions: Vec<Action>,
        rules: Option<RuleSet>,
    },
    Hash {
        position: Position,
    },
}
#[derive(Default)]
pub struct Api {
    game: Option<Match>,
}
impl Api {
    pub fn execute(&mut self, request: Request) -> EngineResult<Value> {
        let value = match request {
            Request::New { position, rules } => {
                let game = Match::new(
                    position.unwrap_or_else(Position::initial),
                    rules.unwrap_or_default(),
                )?;
                let view = json!(game.view());
                self.game = Some(game);
                view
            }
            Request::Resolve {
                position,
                actions,
                rules,
            } => json!(resolve_round_with_rules(
                &position,
                &actions,
                &rules.unwrap_or_default(),
                true
            )?),
            Request::Hash { position } => {
                position.validate()?;
                json!(position_hash(&position))
            }
            Request::Import { replay } => {
                let game = replay.verify()?;
                let view = json!(game.view());
                self.game = Some(game);
                view
            }
            request => {
                let game = self.game.as_mut().ok_or("No active match")?;
                match request {
                    Request::View => json!(game.view()),
                    Request::Actions { side } => {
                        if game.outcome.is_some() {
                            json!([])
                        } else {
                            json!(generate_actions(&game.position, side)?)
                        }
                    }
                    Request::Submit { side, action } => json!(game.submit(side, action)?),
                    Request::SubmitAi { side, policy, seed } => {
                        let action = choose(&game.position, side, policy, &mut Rng(seed))?;
                        json!(game.submit(side, action)?)
                    }
                    Request::Export => json!(game.replay),
                    Request::ReplayRound { round } => json!(game.replay.resolution_at(round)?),
                    _ => unreachable!("handled stateless requests"),
                }
            }
        };
        Ok(value)
    }
    pub fn json(&mut self, input: &[u8]) -> Vec<u8> {
        let result = if input.len() > 16 * 1024 * 1024 {
            Err("Request too large".into())
        } else {
            serde_json::from_slice::<Request>(input)
                .map_err(|e| format!("Invalid request: {e}"))
                .and_then(|r| self.execute(r))
        };
        serde_json::to_vec(&match result {
            Ok(value) => json!({"ok":true,"value":value}),
            Err(error) => json!({"ok":false,"error":error}),
        })
        .expect("JSON response")
    }
}
