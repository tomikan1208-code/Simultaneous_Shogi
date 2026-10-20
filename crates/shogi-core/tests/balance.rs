use serde_json::json;
use shogi_core::replay::position_hash;
use shogi_core::resolution::resolve_round_with_rules;
use shogi_core::*;

fn rules(movement: MovementRule, bonus: u8) -> RuleSet {
    RuleSet {
        profile: "balance-v1".into(),
        balance: Some(BalanceRules {
            movement,
            defense_bonus: bonus,
            rank_offset: u8::from(movement == MovementRule::Progressive),
            ..BalanceRules::default()
        }),
        ..RuleSet::default()
    }
}
fn position(extra: serde_json::Value) -> Position {
    let mut pieces = vec![
        json!({"id":"AK","side":"A","kind":"K","at":[9,9]}),
        json!({"id":"BK","side":"B","kind":"K","at":[9,1]}),
    ];
    pieces.extend(extra.as_array().unwrap().clone());
    serde_json::from_value(json!({"pieces":pieces})).unwrap()
}
fn mv(side: Side, id: &str, to: Square) -> Action {
    Action::Move {
        side,
        piece: id.into(),
        to,
        choice: Change::None,
    }
}
fn play(game: &mut Match, id: &str, to: Square, choice: Change) {
    let other = if game.position.piece("BK").unwrap().at == [9, 1] {
        [8, 1]
    } else {
        [9, 1]
    };
    game.play_round(&[
        Action::Move {
            side: Side::A,
            piece: id.into(),
            to,
            choice,
        },
        mv(Side::B, "BK", other),
    ])
    .unwrap();
}

#[test]
fn b_counts_upgrading_round_and_recovers_without_losing_upgrade() {
    let pos = position(json!([{"id":"AR","side":"A","kind":"R","at":[5,4]}]));
    let mut game = Match::new(pos, rules(MovementRule::UpgradeOnly, 0)).unwrap();
    for (to, choice, streak, rank) in [
        ([5, 3], Change::Upgrade, 1, 7),
        ([5, 4], Change::None, 2, 7),
        ([5, 5], Change::None, 3, 6),
    ] {
        play(&mut game, "AR", to, choice);
        let activity = game.position.activity.get("AR").unwrap();
        assert_eq!(activity.streak, streak);
        assert_eq!(
            game.rules.balance.as_ref().unwrap().movement_rank(
                game.position.piece("AR").unwrap(),
                activity,
                false
            ),
            rank
        );
    }
    play(&mut game, "AK", [8, 9], Change::None);
    assert!(!game.position.activity.contains_key("AR"));
    assert!(game.position.piece("AR").unwrap().upgraded);
    play(&mut game, "AR", [5, 6], Change::None);
    assert_eq!(game.position.activity["AR"].streak, 1);
    game.replay.verify().unwrap();
}

#[test]
fn b_prospective_fatigue_changes_the_third_collision_and_blocking_counts_as_rest() {
    let mut pos = position(json!([
        {"id":"AR","side":"A","kind":"R","at":[5,6],"upgraded":true},
        {"id":"BR","side":"B","kind":"R","at":[5,4]}
    ]));
    let actions = [mv(Side::A, "AR", [5, 5]), mv(Side::B, "BR", [5, 5])];
    assert_eq!(resolve_round(&pos, &actions).unwrap().captures.len(), 1);
    pos.activity.insert(
        "AR".into(),
        PieceActivity {
            streak: 2,
            fatigue: 0,
        },
    );
    let result =
        resolve_round_with_rules(&pos, &actions, &rules(MovementRule::UpgradeOnly, 0), false)
            .unwrap();
    assert_eq!(result.captures.len(), 2);
    assert_eq!(result.contacts[0]["ranks"], json!([6, 6]));
    assert!(resolve_round(&pos, &actions).is_err());
    let mut blocked = position(json!([
        {"id":"AR","side":"A","kind":"R","at":[5,6],"upgraded":true},
        {"id":"AG","side":"A","kind":"G","at":[5,5]}
    ]));
    blocked.activity.insert(
        "AR".into(),
        PieceActivity {
            streak: 3,
            fatigue: 0,
        },
    );
    let result = resolve_round_with_rules(
        &blocked,
        &[mv(Side::A, "AR", [5, 3]), mv(Side::B, "BK", [8, 1])],
        &rules(MovementRule::UpgradeOnly, 0),
        false,
    )
    .unwrap();
    assert_eq!(result.position.piece("AR").unwrap().at, [5, 6]);
    assert!(!result.position.activity.contains_key("AR"));
}

#[test]
fn bp_all_kinds_shift_floor_and_recover_only_one_per_rest() {
    let balance = rules(MovementRule::Progressive, 0).balance.unwrap();
    for kind in Kind::ALL {
        let piece: Piece =
            serde_json::from_value(json!({"id":"p","side":"A","kind":kind,"at":[5,5]})).unwrap();
        assert_eq!(balance.nominal_rank(&piece), kind.rank() + 1);
        assert_eq!(
            balance.movement_rank(
                &piece,
                &PieceActivity {
                    streak: 3,
                    fatigue: 8
                },
                true
            ),
            0
        );
    }
    let mut pos = position(json!([{"id":"AP","side":"A","kind":"P","at":[5,6]}]));
    pos.activity.insert(
        "AP".into(),
        PieceActivity {
            streak: 2,
            fatigue: 0,
        },
    );
    let mut game = Match::new(pos, rules(MovementRule::Progressive, 0)).unwrap();
    play(&mut game, "AP", [5, 5], Change::None);
    assert_eq!(game.position.activity["AP"].fatigue, 1);
    play(&mut game, "AP", [5, 4], Change::None);
    assert_eq!(game.position.activity["AP"].fatigue, 2);
    play(&mut game, "AK", [8, 9], Change::None);
    assert_eq!(game.position.activity["AP"].fatigue, 1);
    play(&mut game, "AK", [9, 9], Change::None);
    assert!(!game.position.activity.contains_key("AP"));
}

#[test]
fn all_pieces_lose_one_rank_on_second_move_without_cumulative_loss() {
    let mut selected = rules(MovementRule::AllPieces, 1);
    selected.balance.as_mut().unwrap().consecutive_threshold = 2;
    let balance = selected.balance.as_ref().unwrap();
    for kind in Kind::ALL {
        for upgraded in [false, true] {
            let piece: Piece = serde_json::from_value(
                json!({"id":"p","side":"A","kind":kind,"at":[5,5],"upgraded":upgraded}),
            )
            .unwrap();
            assert_eq!(
                balance.movement_rank(&piece, &PieceActivity::default(), true),
                piece.rank()
            );
            let previous = PieceActivity {
                streak: 1,
                fatigue: 0,
            };
            assert_eq!(
                balance.movement_rank(&piece, &previous, true),
                piece.rank().saturating_sub(1)
            );
            let consecutive = PieceActivity {
                streak: 2,
                fatigue: 0,
            };
            assert_eq!(
                balance.movement_rank(&piece, &consecutive, true),
                piece.rank().saturating_sub(1)
            );
        }
    }
    let mut game = Match::new(
        position(json!([{"id":"AG","side":"A","kind":"G","at":[5,7]}])),
        selected,
    )
    .unwrap();
    play(&mut game, "AG", [5, 6], Change::None);
    assert_eq!(game.position.activity["AG"].streak, 1);
    play(&mut game, "AG", [5, 5], Change::None);
    assert_eq!(game.position.activity["AG"].streak, 2);
    assert_eq!(game.position.activity["AG"].fatigue, 0);
    play(&mut game, "AG", [5, 4], Change::None);
    assert_eq!(game.position.activity["AG"].fatigue, 0);
    play(&mut game, "AK", [8, 9], Change::None);
    assert!(!game.position.activity.contains_key("AG"));
    game.replay.verify().unwrap();
}

#[test]
fn all_piece_fatigue_changes_gold_collision_and_does_not_protect_stopped_pieces() {
    let mut selected = rules(MovementRule::AllPieces, 0);
    selected.balance.as_mut().unwrap().consecutive_threshold = 2;
    let mut pos = position(json!([
        {"id":"AG","side":"A","kind":"G","at":[5,6]},
        {"id":"BS","side":"B","kind":"S","at":[5,4]}
    ]));
    pos.activity.insert(
        "AG".into(),
        PieceActivity {
            streak: 1,
            fatigue: 0,
        },
    );
    let result = resolve_round_with_rules(
        &pos,
        &[mv(Side::A, "AG", [5, 5]), mv(Side::B, "BS", [5, 5])],
        &selected,
        false,
    )
    .unwrap();
    assert_eq!(result.contacts[0]["ranks"], json!([4, 4]));
    assert_eq!(result.captures.len(), 2);
    let mut resting = pos.clone();
    resting.pieces.iter_mut().find(|p| p.id == "AG").unwrap().at = [5, 5];
    let stopped = resolve_round_with_rules(
        &resting,
        &[mv(Side::A, "AK", [8, 9]), mv(Side::B, "BS", [5, 5])],
        &selected,
        false,
    )
    .unwrap();
    assert!(stopped.position.piece("AG").is_none());
    assert!(stopped
        .captures
        .iter()
        .any(|c| c.victim == "AG" && c.captor == "BS"));
}

#[test]
fn defense_changes_only_moving_contacts_and_cap_and_position_are_configurable() {
    let pos = position(json!([
        {"id":"AR","side":"A","kind":"R","at":[5,8]},
        {"id":"BR","side":"B","kind":"R","at":[5,6],"upgraded":true}
    ]));
    let actions = [mv(Side::A, "AR", [5, 7]), mv(Side::B, "BR", [5, 7])];
    let result =
        resolve_round_with_rules(&pos, &actions, &rules(MovementRule::None, 1), true).unwrap();
    assert_eq!(result.contacts[0]["ranks"], json!([7, 7]));
    assert_eq!(result.captures.len(), 2);
    let mut upgraded = pos.clone();
    upgraded
        .pieces
        .iter_mut()
        .find(|p| p.id == "AR")
        .unwrap()
        .upgraded = true;
    let result =
        resolve_round_with_rules(&upgraded, &actions, &rules(MovementRule::None, 1), false)
            .unwrap();
    assert_eq!(result.contacts[0]["ranks"], json!([8, 7]));
    let mut capped = rules(MovementRule::None, 1);
    capped.balance.as_mut().unwrap().defense_cap = Some(7);
    assert_eq!(
        resolve_round_with_rules(&upgraded, &actions, &capped, false)
            .unwrap()
            .captures
            .len(),
        2
    );
    let p = pos.piece("AR").unwrap();
    let activity = PieceActivity::default();
    let mut b = BalanceRules {
        defense_bonus: 2,
        ..BalanceRules::default()
    };
    assert_eq!(b.collision_rank(p, &activity, [5, 8], [5, 7], [5, 6]), 6);
    b.defense_position = DefensePosition::StageFrom;
    assert_eq!(b.collision_rank(p, &activity, [5, 8], [5, 7], [5, 6]), 8);
    b.defense_position = DefensePosition::RoundStart;
    assert_eq!(b.collision_rank(p, &activity, [5, 8], [5, 6], [5, 5]), 8);
    b.home_rows = 1;
    assert_eq!(b.collision_rank(p, &activity, [5, 8], [5, 6], [5, 5]), 6);

    let static_pos = position(json!([
        {"id":"AR","side":"A","kind":"R","at":[5,9],"upgraded":true},
        {"id":"BP","side":"B","kind":"P","at":[5,8]}
    ]));
    let static_actions = [mv(Side::A, "AK", [8, 9]), mv(Side::B, "BP", [5, 9])];
    let result = resolve_round_with_rules(
        &static_pos,
        &static_actions,
        &rules(MovementRule::None, 2),
        false,
    )
    .unwrap();
    assert_eq!(result.captures[0].victim, "AR");
    assert_eq!(result.captures[0].reason, "static");
    let stopped_pos = position(json!([
        {"id":"AR","side":"A","kind":"R","at":[5,9],"upgraded":true},
        {"id":"BP","side":"B","kind":"R","at":[5,6]}
    ]));
    let result = resolve_round_with_rules(
        &stopped_pos,
        &[mv(Side::A, "AR", [5, 8]), mv(Side::B, "BP", [5, 8])],
        &rules(MovementRule::None, 2),
        false,
    )
    .unwrap();
    assert_eq!(result.captures[0].reason, "stopped");
    assert_eq!(result.captures[0].victim, "AR");
}

#[test]
fn activity_is_identity_independent_but_part_of_repetition_and_replay() {
    let mut pos = position(json!([{"id":"AR","side":"A","kind":"R","at":[5,5],"upgraded":true}]));
    let original = position_hash(&pos);
    pos.activity.insert(
        "AR".into(),
        PieceActivity {
            streak: 3,
            fatigue: 1,
        },
    );
    assert_ne!(original, position_hash(&pos));
    let mut renamed = pos.clone();
    renamed.pieces.iter_mut().find(|p| p.id == "AR").unwrap().id = "renamed".into();
    let value = renamed.activity.remove("AR").unwrap();
    renamed.activity.insert("renamed".into(), value);
    assert_eq!(position_hash(&pos), position_hash(&renamed));
    for movement in [
        MovementRule::None,
        MovementRule::UpgradeOnly,
        MovementRule::Progressive,
    ] {
        for bonus in [0, 1, 2] {
            let initial =
                position(json!([{"id":"AR","side":"A","kind":"R","at":[5,5],"upgraded":true}]));
            let r = rules(movement, bonus);
            let mut quiet = Match::with_diagnostics(initial.clone(), r.clone(), false).unwrap();
            let mut detailed = Match::new(initial, r).unwrap();
            for i in 0..30 {
                if quiet.outcome.is_some() {
                    break;
                }
                let actions = [
                    mv(Side::A, "AR", if i % 2 == 0 { [5, 6] } else { [5, 5] }),
                    mv(Side::B, "BK", if i % 2 == 0 { [8, 1] } else { [9, 1] }),
                ];
                quiet.play_round(&actions).unwrap();
                detailed.play_round(&actions).unwrap();
                assert_eq!(quiet.position, detailed.position);
                assert_eq!(quiet.replay, detailed.replay);
            }
            assert_eq!(quiet.outcome.as_ref().unwrap().reason, "repetition");
            quiet.replay.verify().unwrap();
        }
    }
}
