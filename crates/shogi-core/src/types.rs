use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

pub type Square = [u8; 2];
pub type EngineResult<T> = Result<T, String>;
pub const RULE_VERSION: &str = "0.7";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum Side {
    A,
    B,
}
impl Side {
    pub const ALL: [Self; 2] = [Self::A, Self::B];
    pub fn index(self) -> usize {
        if self == Self::A {
            0
        } else {
            1
        }
    }
    pub fn other(self) -> Self {
        if self == Self::A {
            Self::B
        } else {
            Self::A
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum Kind {
    K,
    P,
    L,
    N,
    S,
    G,
    R,
    B,
}
impl Kind {
    pub const ALL: [Self; 8] = [
        Self::K,
        Self::P,
        Self::L,
        Self::N,
        Self::S,
        Self::G,
        Self::R,
        Self::B,
    ];
    pub fn rank(self) -> u8 {
        match self {
            Self::K => 0,
            Self::P => 1,
            Self::L => 2,
            Self::N => 3,
            Self::S => 4,
            Self::G => 5,
            Self::R | Self::B => 6,
        }
    }
    pub fn changeable(self) -> bool {
        !matches!(self, Self::K | Self::G)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Piece {
    pub id: String,
    pub side: Side,
    pub kind: Kind,
    pub at: Square,
    #[serde(default)]
    pub promoted: bool,
    #[serde(default)]
    pub upgraded: bool,
}
impl Piece {
    pub fn rank(&self) -> u8 {
        self.kind.rank() + u8::from(self.upgraded && !self.promoted)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hands {
    #[serde(rename = "A", default)]
    pub a: BTreeMap<Kind, u16>,
    #[serde(rename = "B", default)]
    pub b: BTreeMap<Kind, u16>,
}
impl Hands {
    pub fn get(&self, side: Side) -> &BTreeMap<Kind, u16> {
        if side == Side::A {
            &self.a
        } else {
            &self.b
        }
    }
    pub fn get_mut(&mut self, side: Side) -> &mut BTreeMap<Kind, u16> {
        if side == Side::A {
            &mut self.a
        } else {
            &mut self.b
        }
    }
    pub fn count(&self, side: Side, kind: Kind) -> u16 {
        *self.get(side).get(&kind).unwrap_or(&0)
    }
    pub fn add(&mut self, side: Side, kind: Kind) {
        if kind != Kind::K {
            *self.get_mut(side).entry(kind).or_default() += 1;
        }
    }
    pub fn remove(&mut self, side: Side, kind: Kind) {
        let hand = self.get_mut(side);
        let count = hand.get_mut(&kind).expect("validated hand");
        *count -= 1;
        if *count == 0 {
            hand.remove(&kind);
        }
    }
    pub fn normalize(&mut self) {
        self.a.retain(|_, n| *n > 0);
        self.b.retain(|_, n| *n > 0);
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DropBan {
    pub side: Side,
    pub kind: Kind,
    pub to: Square,
    pub remaining: u8,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MoveBan {
    pub side: Side,
    pub piece: String,
    pub from: Square,
    pub to: Square,
    pub remaining: u8,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Position {
    pub pieces: Vec<Piece>,
    #[serde(default)]
    pub hands: Hands,
    #[serde(default)]
    pub drop_bans: Vec<DropBan>,
    #[serde(default)]
    pub move_bans: Vec<MoveBan>,
    #[serde(default)]
    pub next_piece_id: u64,
    /// Experimental public state. Omitted for official v0.6 replay identity.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub activity: BTreeMap<String, PieceActivity>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PieceActivity {
    pub streak: u8,
    pub fatigue: u8,
}
pub fn inside(q: Square) -> bool {
    q.iter().all(|n| (1..=9).contains(n))
}
pub fn square_index(q: Square) -> usize {
    (q[1] as usize - 1) * 9 + q[0] as usize - 1
}
pub fn in_zone(side: Side, q: Square) -> bool {
    if side == Side::A {
        q[1] <= 3
    } else {
        q[1] >= 7
    }
}
pub fn dead_end(side: Side, kind: Kind, q: Square) -> bool {
    let distance = if side == Side::A { q[1] - 1 } else { 9 - q[1] };
    matches!(kind, Kind::P | Kind::L) && distance == 0 || kind == Kind::N && distance < 2
}
impl Position {
    pub fn piece(&self, id: &str) -> Option<&Piece> {
        self.pieces.iter().find(|p| p.id == id)
    }
    pub fn occupant(&self, at: Square) -> Option<&Piece> {
        self.pieces.iter().find(|p| p.at == at)
    }
    pub fn validate(&self) -> EngineResult<()> {
        if self.pieces.len() > 81 {
            return Err("InvalidPosition: board capacity".into());
        }
        let mut ids = BTreeSet::new();
        let mut board = [false; 81];
        let mut kings = [0; 2];
        for p in &self.pieces {
            if !inside(p.at) || p.id.is_empty() || p.id.len() > 128 {
                return Err("InvalidPosition: piece".into());
            }
            if !ids.insert(&p.id) || board[square_index(p.at)] {
                return Err("InvalidPosition: duplicate ID or square".into());
            }
            board[square_index(p.at)] = true;
            if p.kind == Kind::K {
                kings[p.side.index()] += 1;
            }
            if p.promoted && p.upgraded || !p.kind.changeable() && (p.promoted || p.upgraded) {
                return Err("InvalidPosition: invalid promotion state".into());
            }
        }
        if kings.iter().any(|n| *n > 1) {
            return Err("InvalidPosition: duplicate king".into());
        }
        for s in Side::ALL {
            if self.hands.count(s, Kind::K) > 0 || self.hands.get(s).values().any(|n| *n > 40) {
                return Err("InvalidPosition: hand".into());
            }
        }
        for b in &self.drop_bans {
            if !inside(b.to) || b.kind == Kind::K || b.remaining != 1 {
                return Err("InvalidPosition: drop ban".into());
            }
        }
        for b in &self.move_bans {
            if !inside(b.from)
                || !inside(b.to)
                || b.remaining != 1
                || self
                    .piece(&b.piece)
                    .is_none_or(|p| p.side != b.side || p.at != b.from)
            {
                return Err("InvalidPosition: move ban".into());
            }
        }
        if self.next_piece_id > u64::MAX - 2 {
            return Err("InvalidPosition: ID counter exhausted".into());
        }
        if self
            .activity
            .iter()
            .any(|(id, a)| self.piece(id).is_none() || a.streak > 32 || a.fatigue > 16)
        {
            return Err("InvalidPosition: activity".into());
        }
        Ok(())
    }
    pub fn normalize(&mut self) {
        self.pieces.sort_by(|a, b| a.id.cmp(&b.id));
        self.hands.normalize();
        self.activity.retain(|_, a| *a != PieceActivity::default());
        self.drop_bans.sort_by_key(|b| (b.side, b.kind, b.to));
        self.move_bans.sort_by(|a, b| {
            (&a.side, &a.piece, a.from, a.to).cmp(&(&b.side, &b.piece, b.from, b.to))
        });
    }
    pub fn initial() -> Self {
        let mut p = Self::default();
        let back = [
            Kind::L,
            Kind::N,
            Kind::S,
            Kind::G,
            Kind::K,
            Kind::G,
            Kind::S,
            Kind::N,
            Kind::L,
        ];
        for side in Side::ALL {
            for x in 1..=9 {
                let y = if side == Side::A { 9 } else { 1 };
                for (kind, at) in [
                    (back[x as usize - 1], [x, y]),
                    (Kind::P, [x, if side == Side::A { 7 } else { 3 }]),
                ] {
                    p.pieces.push(Piece {
                        id: format!("{side:?}:{kind:?}:{x}"),
                        side,
                        kind,
                        at,
                        promoted: false,
                        upgraded: false,
                    });
                }
            }
            for (kind, at) in if side == Side::A {
                [(Kind::R, [2, 8]), (Kind::B, [8, 8])]
            } else {
                [(Kind::R, [8, 2]), (Kind::B, [2, 2])]
            } {
                p.pieces.push(Piece {
                    id: format!("{side:?}:{kind:?}"),
                    side,
                    kind,
                    at,
                    promoted: false,
                    upgraded: false,
                });
            }
        }
        p.normalize();
        p
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Change {
    #[default]
    None,
    Promote,
    Upgrade,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
pub enum Action {
    Move {
        side: Side,
        piece: String,
        to: Square,
        #[serde(default)]
        choice: Change,
    },
    Drop {
        side: Side,
        kind: Kind,
        to: Square,
    },
}
impl Action {
    pub fn side(&self) -> Side {
        match self {
            Self::Move { side, .. } | Self::Drop { side, .. } => *side,
        }
    }
    pub fn to(&self) -> Square {
        match self {
            Self::Move { to, .. } | Self::Drop { to, .. } => *to,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuleSet {
    pub version: String,
    pub profile: String,
    pub repetition_limit: u32,
    pub round_limit: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub balance: Option<BalanceRules>,
}
impl Default for RuleSet {
    fn default() -> Self {
        Self {
            version: RULE_VERSION.into(),
            profile: "official-v0.7".into(),
            repetition_limit: 4,
            round_limit: 200,
            balance: None,
        }
    }
}
impl RuleSet {
    pub fn validate(&self) -> EngineResult<()> {
        if !matches!(
            (self.version.as_str(), self.profile.as_str(), &self.balance),
            ("0.7", "official-v0.7", None)
                | ("0.6", "official-v0.6", None)
                | ("0.6" | "0.7", "balance-v1", Some(_))
        ) {
            return Err("Unsupported rule version/profile; old games are not reinterpreted".into());
        }
        if let Some(balance) = &self.balance {
            balance.validate()?;
        }
        if self.repetition_limit < 2 || self.round_limit == 0 || self.round_limit > 100_000 {
            return Err("Invalid match limits".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MovementRule {
    #[default]
    None,
    UpgradeOnly,
    AllPieces,
    Progressive,
}
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DefensePosition {
    RoundStart,
    StageFrom,
    #[default]
    Destination,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BalanceRules {
    pub movement: MovementRule,
    pub consecutive_threshold: u8,
    pub rank_offset: u8,
    pub minimum_rank: u8,
    pub rest_recovery: u8,
    pub home_rows: u8,
    pub defense_bonus: u8,
    pub defense_position: DefensePosition,
    /// None permits ranks above seven (eight on the shifted B+ scale).
    pub defense_cap: Option<u8>,
}
impl Default for BalanceRules {
    fn default() -> Self {
        Self {
            movement: MovementRule::None,
            consecutive_threshold: 3,
            rank_offset: 0,
            minimum_rank: 0,
            rest_recovery: 1,
            home_rows: 3,
            defense_bonus: 0,
            defense_position: DefensePosition::Destination,
            defense_cap: None,
        }
    }
}
impl BalanceRules {
    pub fn validate(&self) -> EngineResult<()> {
        if !(2..=32).contains(&self.consecutive_threshold)
            || self.rank_offset != u8::from(self.movement == MovementRule::Progressive)
            || self.minimum_rank != 0
            || !(1..=16).contains(&self.rest_recovery)
            || !(1..=9).contains(&self.home_rows)
            || self.defense_bonus > 8
            || self
                .defense_cap
                .is_some_and(|cap| cap < 7 + self.rank_offset || cap > 16)
        {
            return Err("Invalid balance rules".into());
        }
        Ok(())
    }
    pub fn home(&self, side: Side, at: Square) -> bool {
        if side == Side::A {
            at[1] > 9 - self.home_rows
        } else {
            at[1] <= self.home_rows
        }
    }
    pub fn nominal_rank(&self, piece: &Piece) -> u8 {
        piece.rank() + self.rank_offset
    }
    /// Prospective movement is applied before comparing two advancing pieces.
    pub fn movement_rank(&self, piece: &Piece, activity: &PieceActivity, moving: bool) -> u8 {
        let streak = activity.streak.saturating_add(u8::from(moving));
        let loss = match self.movement {
            MovementRule::UpgradeOnly => {
                u8::from(piece.rank() == 7 && streak >= self.consecutive_threshold)
            }
            MovementRule::AllPieces => u8::from(streak >= self.consecutive_threshold),
            MovementRule::Progressive => activity
                .fatigue
                .saturating_add(u8::from(moving && streak >= self.consecutive_threshold)),
            MovementRule::None => 0,
        };
        self.nominal_rank(piece)
            .saturating_sub(loss)
            .max(self.minimum_rank)
    }
    pub fn collision_rank(
        &self,
        piece: &Piece,
        activity: &PieceActivity,
        round_start: Square,
        from: Square,
        destination: Square,
    ) -> u8 {
        let base = self.movement_rank(piece, activity, true);
        let at = match self.defense_position {
            DefensePosition::RoundStart => round_start,
            DefensePosition::StageFrom => from,
            DefensePosition::Destination => destination,
        };
        let boosted = base
            + if self.home(piece.side, at) {
                self.defense_bonus
            } else {
                0
            };
        self.defense_cap.map_or(boosted, |cap| boosted.min(cap))
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Winner {
    A,
    B,
    #[serde(rename = "draw")]
    Draw,
}
impl From<Side> for Winner {
    fn from(s: Side) -> Self {
        if s == Side::A {
            Self::A
        } else {
            Self::B
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Outcome {
    pub winner: Winner,
    pub reason: String,
}
