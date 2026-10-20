use serde_json::json;
use shogi_core::resolution::RoundResolution;
use shogi_core::*;

fn resolve_change(
    side: Side,
    kind: Kind,
    from: Square,
    to: Square,
    choice: Change,
) -> RoundResolution {
    let flip = |at: Square| {
        if side == Side::B {
            [10 - at[0], 10 - at[1]]
        } else {
            at
        }
    };
    let (position, actions) = (
        serde_json::from_value(json!({
            "pieces":[
                {"id":"AK","side":"A","kind":"K","at":[9,9]},
                {"id":"BK","side":"B","kind":"K","at":[9,1]},
                {"id":"X","side":side,"kind":kind,"at":flip(from),"upgraded":true}
            ],
            "hands":{"A":{},"B":{}}
        }))
        .unwrap(),
        vec![
            Action::Move {
                side,
                piece: "X".into(),
                to: flip(to),
                choice,
            },
            Action::Move {
                side: side.other(),
                piece: if side == Side::A { "BK" } else { "AK" }.into(),
                to: if side == Side::A { [8, 1] } else { [8, 9] },
                choice: Change::None,
            },
        ],
    );
    resolve_round(&position, &actions).unwrap()
}

#[test]
fn upgraded_pieces_ignore_optional_change_requests_for_both_sides() {
    for side in [Side::A, Side::B] {
        for kind in [Kind::P, Kind::L, Kind::N, Kind::S, Kind::R, Kind::B] {
            let (from, to) = match kind {
                Kind::N => ([5, 5], [4, 3]),
                Kind::B => ([5, 3], [4, 2]),
                _ => ([5, 3], [5, 2]),
            };
            for choice in [Change::None, Change::Promote, Change::Upgrade] {
                let result = resolve_change(side, kind, from, to, choice);
                let piece = result.position.piece("X").unwrap();
                assert!(!piece.promoted);
                assert!(piece.upgraded);
                assert_eq!(piece.rank(), kind.rank() + 1);
                assert!(!result
                    .events
                    .iter()
                    .any(|e| e["type"] == "promotion" || e["type"] == "upgrade"));
            }
        }
    }
}

#[test]
fn upgraded_pieces_become_promoted_only_at_actual_dead_ends() {
    for side in [Side::A, Side::B] {
        for kind in [Kind::P, Kind::L, Kind::N] {
            let (from, to) = if kind == Kind::N {
                ([5, 4], [4, 2])
            } else {
                ([5, 2], [5, 1])
            };
            for choice in [Change::None, Change::Promote, Change::Upgrade] {
                let result = resolve_change(side, kind, from, to, choice);
                let piece = result.position.piece("X").unwrap();
                assert!(piece.promoted);
                assert!(!piece.upgraded);
                assert_eq!(piece.rank(), kind.rank());
                assert!(result
                    .events
                    .iter()
                    .any(|e| e["type"] == "forced_promotion" && e["actor"] == "X"));
            }
        }
    }
}

#[test]
fn previous_rule_version_is_not_silently_reinterpreted() {
    let previous = RuleSet {
        version: "0.5".into(),
        profile: "official-v0.5".into(),
        ..RuleSet::default()
    };
    assert!(previous.validate().is_err());
    assert!(RuleSet::default().validate().is_ok());
}
