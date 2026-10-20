//! Deterministic v0.7 rules with exact v0.6 replay support. No clocks or I/O here.
pub mod action;
pub mod api;
pub mod game;
pub mod policy;
pub mod replay;
pub mod resolution;
pub mod training;
pub mod types;

#[cfg(target_arch = "wasm32")]
mod wasm;

pub use action::{generate_actions, planned_path, validate_action};
pub use game::Match;
pub use resolution::resolve_round;
pub use types::*;
