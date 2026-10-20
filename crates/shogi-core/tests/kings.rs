use serde_json::Value;
use shogi_core::{
    replay::Replay, resolution::resolve_round_with_rules, Action, BalanceRules, Match, Position,
    RuleSet, Winner,
};

fn fixture(id: &str) -> (Position, Vec<Action>) {
    let cases: Value =
        serde_json::from_str(include_str!("../../../review/stage_cases.json")).unwrap();
    let mut input = cases["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["id"] == id)
        .unwrap()["input"]
        .clone();
    let actions = input.as_object_mut().unwrap().remove("actions").unwrap();
    (
        serde_json::from_value(input).unwrap(),
        serde_json::from_value(actions).unwrap(),
    )
}

#[test]
fn king_capture_victory_survives_recapture_in_play_search_and_replay() {
    for id in ["E08", "E10"] {
        for balance in [None, Some(BalanceRules::default())] {
            let rules = RuleSet {
                profile: if balance.is_some() {
                    "balance-v1"
                } else {
                    "official-v0.7"
                }
                .into(),
                balance,
                ..RuleSet::default()
            };
            let (position, actions) = fixture(id);
            let mut game = Match::new(position, rules.clone()).unwrap();
            let preview = game.preview_round(&actions).unwrap();
            let result = game.play_round(&actions).unwrap();
            assert_eq!(preview.semantic_hash(), result.semantic_hash(), "{id}");
            assert_eq!(result.version, "0.7");
            let outcome = result.outcome.as_ref().unwrap();
            assert_eq!(outcome.winner, Winner::A, "{id}");
            assert_eq!(outcome.reason, "king_capture_retained");
            let king = result
                .captures
                .iter()
                .find(|c| c.kind == shogi_core::Kind::K)
                .unwrap();
            assert!(result
                .captures
                .iter()
                .any(|c| c.victim == king.captor && c.stage > king.stage));
            assert!(result.position.piece(&king.captor).is_none());
            assert_eq!(
                game.replay.verify().unwrap().state_hash(),
                game.state_hash()
            );

            // The same moves must keep their historical winner under v0.6.
            let legacy = RuleSet {
                version: "0.6".into(),
                profile: if rules.balance.is_some() {
                    "balance-v1"
                } else {
                    "official-v0.6"
                }
                .into(),
                ..rules
            };
            let old =
                resolve_round_with_rules(&game.replay.initial, &actions, &legacy, true).unwrap();
            assert_eq!(old.version, "0.6");
            assert_eq!(old.outcome.as_ref().unwrap().winner, Winner::B);
            assert_eq!(old.outcome.as_ref().unwrap().reason, "king_captor_lost");
            assert_eq!(old.position, game.position);
        }
    }
}

#[test]
fn original_v06_replay_retains_every_recorded_hash() {
    let replay: Replay = serde_json::from_str(include_str!(
        "../../../tests/fixtures/official-v06-replay.json"
    ))
    .unwrap();
    let verified = replay.verify().unwrap();
    assert_eq!(verified.replay, replay);
    assert_eq!(verified.last_resolution.unwrap().version, "0.6");
}

#[test]
fn rule_versions_cannot_be_mixed_with_other_official_profiles() {
    for (version, profile) in [
        ("0.6", "official-v0.7"),
        ("0.7", "official-v0.6"),
        ("0.8", "official-v0.7"),
        ("0.5", "official-v0.5"),
    ] {
        assert!(RuleSet {
            version: version.into(),
            profile: profile.into(),
            ..RuleSet::default()
        }
        .validate()
        .is_err());
    }
}
