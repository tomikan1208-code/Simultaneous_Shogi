//! Deterministic v0.6 rules. No clocks, I/O, drawing, or policy randomness here.
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
