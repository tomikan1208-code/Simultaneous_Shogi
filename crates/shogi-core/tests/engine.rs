use serde_json::{json, Value};
use shogi_core::{
    api::Api,
    policy::{choose, Policy, Rng},
    replay::{position_hash, Replay},
    *,
};

fn fixtures() -> Vec<Value> {
    serde_json::from_str::<Value>(include_str!("../../../review/stage_cases.json")).unwrap()
        ["cases"]
        .as_array()
        .unwrap()
        .clone()
}
fn input(value: &Value) -> (Position, Vec<Action>) {
    let mut p = value.clone();
    let actions = p.as_object_mut().unwrap().remove("actions").unwrap();
    (
        serde_json::from_value(p).unwrap(),
        serde_json::from_value(actions).unwrap(),
    )
}
fn canonical_pieces(pieces: &[Piece], initial: &Position) -> Vec<Value> {
    let mut rows: Vec<_> = pieces.iter().map(|p| {
        let id = if initial.piece(&p.id).is_some() { p.id.clone() } else { format!("drop:{:?}",p.side) };
        json!({"id":id,"side":p.side,"kind":p.kind,"at":p.at,"promoted":p.promoted,"upgraded":p.upgraded})
    }).collect();
    rows.sort_by_key(Value::to_string);
    rows
}
#[test]
fn all_46_hand_calculated_fixtures() {
    for case in fixtures() {
        let (position, actions) = input(&case["input"]);
        let result = resolve_round(&position, &actions);
        if let Some(error) = case["expectedError"].as_str() {
            assert!(result.unwrap_err().contains(error), "{}", case["id"]);
            continue;
        }
        let result = result.unwrap_or_else(|e| panic!("{}: {e}", case["id"]));
        let expected = &case["expect"];
        let expected_pieces: Vec<Piece> =
            serde_json::from_value(expected["pieces"].clone()).unwrap();
        assert_eq!(
            canonical_pieces(&result.position.pieces, &position),
            canonical_pieces(&expected_pieces, &position),
            "{} board",
            case["id"]
        );
        assert_eq!(
            result.position.hands,
            serde_json::from_value::<Hands>(expected["hands"].clone()).unwrap(),
            "{} hands",
            case["id"]
        );
        assert_eq!(
            json!(result.outcome),
            expected["outcome"],
            "{} outcome",
            case["id"]
        );
        assert_eq!(
            json!(result.position.drop_bans),
            expected["dropBans"],
            "{} bans",
            case["id"]
        );
        if let Some(contacts) = expected["contacts"].as_array() {
            let actual: Vec<_> = result
                .events
                .iter()
                .filter(|e| e["type"] == "contact")
                .collect();
            assert_eq!(actual.len(), contacts.len());
            for (a, e) in actual.iter().zip(contacts) {
                for (key, value) in e.as_object().unwrap() {
                    assert_eq!(&a[key], value, "{} contact {key}", case["id"]);
                }
            }
        }
        if let Some(stages) = expected.get("captureStages") {
            assert_eq!(
                json!(result.captures.iter().map(|c| c.stage).collect::<Vec<_>>()),
                *stages
            );
        }
        if let Some(stages) = expected.get("dropStages") {
            assert_eq!(
                json!(result
                    .events
                    .iter()
                    .filter(|e| e["type"] == "drop")
                    .map(|e| e["stage"].clone())
                    .collect::<Vec<_>>()),
                *stages
            );
        }
        let mut reordered = position.clone();
        reordered.pieces.reverse();
        let mut reordered_actions = actions.clone();
        reordered_actions.reverse();
        assert_eq!(
            result,
            resolve_round(&reordered, &reordered_actions).unwrap(),
            "{} order",
            case["id"]
        );
    }
}

fn kings() -> Position {
    serde_json::from_value(json!({"pieces":[{"id":"AK","side":"A","kind":"K","at":[5,9]}, {"id":"BK","side":"B","kind":"K","at":[5,1]}]})).unwrap()
}
fn mv(side: Side, piece: &str, to: Square) -> Action {
    Action::Move {
        side,
        piece: piece.into(),
        to,
        choice: Change::None,
    }
}

#[test]
fn secrets_validation_and_atomic_submission() {
    let mut game = Match::new(kings(), RuleSet::default()).unwrap();
    let before = game.state_hash();
    let first = game.submit(Side::A, mv(Side::A, "AK", [4, 9])).unwrap();
    assert_eq!(first.committed, [true, false]);
    assert_eq!(before, first.state_hash);
    assert!(first.last_resolution.is_none());
    assert!(game.replay.rounds.is_empty());
    assert!(game.submit(Side::A, mv(Side::A, "AK", [6, 9])).is_err());
    assert!(game.submit(Side::B, mv(Side::B, "BK", [3, 1])).is_err());
    assert_eq!(before, game.state_hash());
    assert_eq!(game.view().committed, [true, false]);
    game.submit(Side::B, mv(Side::B, "BK", [4, 1])).unwrap();
    assert_eq!(game.round, 1);
    assert_eq!(game.view().committed, [false, false]);
    assert_eq!(game.replay.rounds.len(), 1);
    let mut reversed = Match::new(kings(), RuleSet::default()).unwrap();
    reversed.submit(Side::B, mv(Side::B, "BK", [4, 1])).unwrap();
    reversed.submit(Side::A, mv(Side::A, "AK", [4, 9])).unwrap();
    assert_eq!(game.replay, reversed.replay);
}

#[test]
fn repetition_and_limits_and_terminal_rejection() {
    let mut game = Match::new(kings(), RuleSet::default()).unwrap();
    for round in 0..6 {
        let x = if round % 2 == 0 { 4 } else { 5 };
        game.play_round(&[mv(Side::A, "AK", [x, 9]), mv(Side::B, "BK", [x, 1])])
            .unwrap();
        assert_eq!(game.outcome.is_some(), round == 5);
    }
    assert_eq!(game.outcome.as_ref().unwrap().reason, "repetition");
    assert!(game
        .play_round(&[mv(Side::A, "AK", [4, 9]), mv(Side::B, "BK", [4, 1])])
        .is_err());
    let mut limited = Match::new(
        kings(),
        RuleSet {
            round_limit: 1,
            ..RuleSet::default()
        },
    )
    .unwrap();
    limited
        .play_round(&[mv(Side::A, "AK", [4, 9]), mv(Side::B, "BK", [4, 1])])
        .unwrap();
    assert_eq!(limited.outcome.unwrap().reason, "round_limit");
    let case = fixtures().into_iter().find(|c| c["id"] == "E09").unwrap();
    let (p, a) = input(&case["input"]);
    let mut game = Match::new(
        p,
        RuleSet {
            round_limit: 1,
            ..RuleSet::default()
        },
    )
    .unwrap();
    game.play_round(&a).unwrap();
    assert_eq!(json!(game.outcome), case["expect"]["outcome"]);
}

#[test]
fn repetition_hash_ignores_identity_but_includes_every_restriction() {
    let mut pos = kings();
    let key = position_hash(&pos);
    pos.pieces.reverse();
    pos.pieces[0].id = "renamed".into();
    pos.next_piece_id = 900;
    assert_eq!(key, position_hash(&pos));
    pos.drop_bans.push(DropBan {
        side: Side::A,
        kind: Kind::R,
        to: [5, 5],
        remaining: 1,
    });
    assert_ne!(key, position_hash(&pos));
    pos.drop_bans.clear();
    pos.move_bans.push(MoveBan {
        side: Side::A,
        piece: "AK".into(),
        from: [5, 9],
        to: [4, 9],
        remaining: 1,
    });
    assert_ne!(key, position_hash(&pos));
}

#[test]
fn cooldown_consumed_even_on_blocked_round_and_unique_drop_ids() {
    let fs = fixtures();
    let (p, a) = input(&fs.iter().find(|c| c["id"] == "N19").unwrap()["input"]);
    let equal = resolve_round(&p, &a).unwrap();
    let mut forbidden = p.clone();
    forbidden.drop_bans = equal.position.drop_bans.clone();
    assert!(resolve_round(&forbidden, &a).is_err());
    let (mut blocked, b) = input(&fs.iter().find(|c| c["id"] == "N15").unwrap()["input"]);
    blocked.hands = equal.position.hands;
    blocked.drop_bans = equal.position.drop_bans;
    assert!(resolve_round(&blocked, &b)
        .unwrap()
        .position
        .drop_bans
        .is_empty());
    let mut pos = kings();
    pos.hands.a.insert(Kind::P, 2);
    let r = resolve_round(
        &pos,
        &[
            Action::Drop {
                side: Side::A,
                kind: Kind::P,
                to: [4, 5],
            },
            mv(Side::B, "BK", [4, 1]),
        ],
    )
    .unwrap();
    let id = r.position.occupant([4, 5]).unwrap().id.clone();
    let r = resolve_round(
        &r.position,
        &[
            Action::Drop {
                side: Side::A,
                kind: Kind::P,
                to: [6, 5],
            },
            mv(Side::B, "BK", [3, 1]),
        ],
    )
    .unwrap();
    assert_ne!(id, r.position.occupant([6, 5]).unwrap().id);
    assert_eq!(
        r.position
            .pieces
            .iter()
            .filter(|p| p.kind == Kind::P)
            .count(),
        2
    );
}

#[test]
fn replay_reexecutes_and_rejects_tampering_and_old_versions() {
    let mut game = Match::standard();
    let mut a = Rng(12);
    let mut b = Rng(34);
    for _ in 0..15 {
        if game.outcome.is_some() {
            break;
        }
        let actions = [
            choose(&game.position, Side::A, Policy::Hunter, &mut a).unwrap(),
            choose(&game.position, Side::B, Policy::Defense, &mut b).unwrap(),
        ];
        game.play_round(&actions).unwrap();
    }
    let encoded = serde_json::to_string(&game.replay).unwrap();
    let replay: Replay = serde_json::from_str(&encoded).unwrap();
    assert_eq!(game.state_hash(), replay.verify().unwrap().state_hash());
    let mut corrupted = replay.clone();
    corrupted.rounds[0].after_hash = "bad".into();
    assert!(corrupted.verify().is_err());
    let mut corrupted = replay.clone();
    corrupted.rounds[0].actions.reverse();
    assert!(corrupted.verify().is_err());
    let mut old = replay;
    old.rules.version = "0.4".into();
    assert!(old.verify().is_err());
}

#[test]
fn action_generation_preserves_conditional_targets_and_knight_jump() {
    let p = Position::initial();
    let options = generate_actions(&p, Side::A).unwrap();
    assert!(options.iter().any(
        |o| matches!(&o.action,Action::Move {piece,to,..} if piece == "A:R" && *to == [2,1])
            && !o.conditions.is_empty()
    ));
    let mut knight = p.piece("A:N:2").unwrap().clone();
    knight.at = [5, 5];
    assert_eq!(planned_path(&knight, [4, 3]).unwrap(), vec![[4, 3]]);
    for option in &options {
        validate_action(&p, &option.action).unwrap();
    }
    let mut pos = kings();
    pos.hands.a.insert(Kind::P, 1);
    pos.pieces.push(Piece {
        id: "AP".into(),
        side: Side::A,
        kind: Kind::P,
        at: [5, 5],
        promoted: false,
        upgraded: false,
    });
    let options = generate_actions(&pos, Side::A).unwrap();
    assert!(options
        .iter()
        .any(|o| matches!(&o.action,Action::Drop {to,..} if *to == [5,4])
            && o.conditions.contains(&"nifu_removal".into())));
}

#[test]
fn api_never_exports_pending_action_and_invalid_import_is_atomic() {
    let mut api = Api::default();
    let call = |api: &mut Api, v: Value| {
        serde_json::from_slice::<Value>(&api.json(&serde_json::to_vec(&v).unwrap())).unwrap()
    };
    call(&mut api, json!({"cmd":"new"}));
    let response = call(
        &mut api,
        json!({"cmd":"submit","side":"A","action":{"side":"A","type":"move","piece":"A:P:7","to":[7,6]}}),
    );
    assert_eq!(response["value"]["committed"], json!([true, false]));
    assert_eq!(
        call(&mut api, json!({"cmd":"export"}))["value"]["rounds"],
        json!([])
    );
    assert_eq!(
        call(&mut api, json!({"cmd":"import","replay":{"format":"bad"}}))["ok"],
        false
    );
    assert_eq!(
        call(&mut api, json!({"cmd":"view"}))["value"]["committed"],
        json!([true, false])
    );
}

#[test]
fn malformed_states_and_intents_fail_without_in_game_cycle_penalties() {
    let mut pos = kings();
    pos.pieces[0].promoted = true;
    assert!(pos.validate().is_err());
    assert!(serde_json::from_value::<Action>(json!({"type":"pass","side":"A"})).is_err());
    let pos = kings();
    assert!(resolve_round(
        &pos,
        &[mv(Side::A, "AK", [4, 9]), mv(Side::A, "AK", [6, 9])]
    )
    .is_err());
}

#[test]
fn diagnostics_can_be_disabled_without_changing_results_or_replays() {
    for case in fixtures()
        .iter()
        .filter(|c| c.get("expectedError").is_none())
    {
        let (position, actions) = input(&case["input"]);
        let full = resolve_round(&position, &actions).unwrap();
        let light =
            shogi_core::resolution::resolve_round_with_diagnostics(&position, &actions, false)
                .unwrap();
        assert_eq!(
            full.semantic_hash(),
            light.semantic_hash(),
            "{}",
            case["id"]
        );
        assert!(light.frames.is_empty());
        assert!(light.events.is_empty());
    }
    let mut game = Match::with_diagnostics(kings(), RuleSet::default(), false).unwrap();
    game.play_round(&[mv(Side::A, "AK", [4, 9]), mv(Side::B, "BK", [4, 1])])
        .unwrap();
    assert_eq!(
        game.state_hash(),
        game.replay.verify().unwrap().state_hash()
    );
}

#[test]
fn exhaustive_rook_line_pairs_match_independent_position_formula() {
    let at = |from: i16, to: i16, k: i16| from + (to - from).signum() * k.min((to - from).abs());
    let mut count = 0;
    for a in 1i16..=9 {
        for b in 1i16..=9 {
            if a == b {
                continue;
            }
            for ta in 1i16..=9 {
                for tb in 1i16..=9 {
                    if ta == a || tb == b {
                        continue;
                    }
                    let mut meeting = None;
                    for k in 1..=8 {
                        let (ax, bx) = (at(a, ta, k), at(b, tb, k));
                        if ax == bx || ax == at(b, tb, k - 1) && bx == at(a, ta, k - 1) {
                            meeting = Some((
                                k as u8,
                                if ax != at(a, ta, k - 1) { "AR" } else { "BR" },
                                ax as u8,
                            ));
                            break;
                        }
                    }
                    let mut position = kings();
                    position.pieces.push(Piece {
                        id: "AR".into(),
                        side: Side::A,
                        kind: Kind::R,
                        at: [a as u8, 5],
                        promoted: false,
                        upgraded: true,
                    });
                    position.pieces.push(Piece {
                        id: "BR".into(),
                        side: Side::B,
                        kind: Kind::R,
                        at: [b as u8, 5],
                        promoted: false,
                        upgraded: false,
                    });
                    let result = resolve_round(
                        &position,
                        &[
                            mv(Side::A, "AR", [ta as u8, 5]),
                            mv(Side::B, "BR", [tb as u8, 5]),
                        ],
                    )
                    .unwrap();
                    let contact = result.events.iter().find(|e| e["type"] == "contact");
                    if let Some((stage, id, x)) = meeting {
                        let c = contact.unwrap();
                        assert_eq!(c["stage"], stage);
                        assert_eq!(c["winner"], id);
                        assert_eq!(result.position.piece(id).unwrap().at, [x, 5]);
                    } else {
                        assert!(contact.is_none());
                        assert_eq!(result.position.piece("AR").unwrap().at, [ta as u8, 5]);
                        assert_eq!(result.position.piece("BR").unwrap().at, [tb as u8, 5]);
                    }
                    count += 1;
                }
            }
        }
    }
    assert_eq!(count, 4608);
}
