use shogi_core::{
    policy::{choose, Policy, Rng},
    training::fast_actions,
    *,
};

fn equivalent(pos: &Position) {
    for side in Side::ALL {
        let reference: Vec<_> = generate_actions(pos, side)
            .unwrap()
            .into_iter()
            .map(|o| o.action)
            .collect();
        assert_eq!(fast_actions(pos, side).unwrap(), reference);
    }
}

#[test]
fn complete_actions_match_reference_on_fixtures_bans_and_played_positions() {
    let fixtures: serde_json::Value =
        serde_json::from_str(include_str!("../../../review/stage_cases.json")).unwrap();
    for case in fixtures["cases"].as_array().unwrap() {
        let mut raw = case["input"].clone();
        raw.as_object_mut().unwrap().remove("actions");
        if let Ok(pos) = serde_json::from_value::<Position>(raw) {
            if pos.validate().is_ok() {
                equivalent(&pos);
            }
        }
    }
    let mut game = Match::standard();
    let mut rng = Rng(271828);
    for _ in 0..300 {
        if game.outcome.is_some() {
            game = Match::standard();
        }
        equivalent(&game.position);
        let actions =
            Side::ALL.map(|s| choose(&game.position, s, Policy::Random, &mut rng).unwrap());
        let preview = game.preview_round(&actions).unwrap();
        game.play_round(&actions).unwrap();
        assert_eq!(preview.position, game.position);
        assert_eq!(preview.outcome, game.outcome);
    }
    let mut pos = Position::initial();
    pos.hands.add(Side::A, Kind::P);
    pos.drop_bans.push(DropBan {
        side: Side::A,
        kind: Kind::P,
        to: [5, 5],
        remaining: 1,
    });
    let p = pos
        .pieces
        .iter()
        .find(|p| p.side == Side::A && p.kind == Kind::P)
        .unwrap();
    pos.move_bans.push(MoveBan {
        side: Side::A,
        piece: p.id.clone(),
        from: p.at,
        to: [p.at[0], 6],
        remaining: 1,
    });
    equivalent(&pos);
}

#[test]
fn preview_includes_round_cap_and_repetition_and_does_not_mutate_match() {
    let mut game = Match::new(
        Position::initial(),
        RuleSet {
            round_limit: 1,
            ..RuleSet::default()
        },
    )
    .unwrap();
    let actions = [
        Action::Move {
            side: Side::A,
            piece: "A:L:1".into(),
            to: [1, 8],
            choice: Change::None,
        },
        Action::Move {
            side: Side::B,
            piece: "B:L:1".into(),
            to: [1, 2],
            choice: Change::None,
        },
    ];
    let before = game.state_hash();
    let result = game.preview_round(&actions).unwrap();
    assert_eq!(game.state_hash(), before);
    assert_eq!(result.outcome.as_ref().unwrap().reason, "round_limit");
    game.play_round(&actions).unwrap();
    assert_eq!(result.outcome, game.outcome);
    let mut game = Match::standard();
    // Both lances are immediately blocked by their own pawns: a permitted noop.
    let blocked = [
        Action::Move {
            side: Side::A,
            piece: "A:R".into(),
            to: [2, 1],
            choice: Change::None,
        },
        Action::Move {
            side: Side::B,
            piece: "B:R".into(),
            to: [8, 9],
            choice: Change::None,
        },
    ];
    for _ in 0..2 {
        game.play_round(&blocked).unwrap();
    }
    assert_eq!(
        game.preview_round(&blocked)
            .unwrap()
            .outcome
            .as_ref()
            .unwrap()
            .reason,
        "repetition"
    );
    game.play_round(&blocked).unwrap();
    assert_eq!(game.outcome.as_ref().unwrap().reason, "repetition");
}
