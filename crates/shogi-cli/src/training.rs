//! Persistent batched JSONL transport. Python owns GPU tensors; Rust owns rules.
use serde_json::{json, Value};
use shogi_core::{
    policy::{choose, Policy, Rng},
    training::{fast_actions, material_value, regret_match, sparse_observation},
    *,
};
use std::{
    collections::HashMap,
    io::{self, BufRead, Write},
    time::Instant,
};

fn number(v: &Value, key: &str) -> Result<usize, String> {
    v[key]
        .as_u64()
        .and_then(|n| usize::try_from(n).ok())
        .ok_or_else(|| format!("Missing integer {key}"))
}
fn parse<T: serde::de::DeserializeOwned>(v: &Value) -> Result<T, String> {
    serde_json::from_value(v.clone()).map_err(|e| e.to_string())
}
fn state(game: &Match) -> Value {
    json!({"position":game.position,"round":game.round,"repetition":game.repetition_count(),"outcome":game.outcome,"rules":game.rules})
}
pub fn run() -> Result<(), String> {
    let mut games: Vec<Match> = Vec::new();
    let stdin = io::stdin();
    let mut out = io::BufWriter::new(io::stdout().lock());
    for line in stdin.lock().lines() {
        let line = line.map_err(|e| e.to_string())?;
        if line.len() > 64 * 1024 * 1024 {
            return Err("Training request too large".into());
        }
        let response: Result<Value, String> = (|| {
            let v: Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
            match v["cmd"].as_str().ok_or("Missing command")? {
                "hello" => Ok(json!({"protocol":"shogi-training-v1","rules":RuleSet::default()})),
                "restore" => {
                    let replay: shogi_core::replay::Replay = parse(&v["replay"])?;
                    games = vec![replay.verify()?];
                    Ok(json!({"count":1}))
                }
                "reset" => {
                    let count = number(&v, "count")?;
                    if count == 0 || count > 256 { return Err("Environment count must be 1..256".into()); }
                    let rules: RuleSet = if v["rules"].is_object() { parse(&v["rules"])? } else { RuleSet::default() };
                    let pos: Position = if v["position"].is_object() { parse(&v["position"])? } else { Position::initial() };
                    games = (0..count).map(|_| Match::with_diagnostics(pos.clone(), rules.clone(), false)).collect::<Result<_, _>>()?;
                    Ok(json!({"count":count}))
                }
                "observe" => {
                    games.iter().enumerate().filter(|(_,g)| g.outcome.is_none()).map(|(env,g)| {
                        let mut s = state(g);
                        s["env"] = json!(env);
                        s["actions"] = json!([fast_actions(&g.position,Side::A)?,fast_actions(&g.position,Side::B)?]);
                        Ok(s)
                    }).collect::<Result<Vec<_>, String>>().map(|rows| json!(rows))
                }
                "preview" => {
                    let mut rows = Vec::new();
                    for item in v["items"].as_array().ok_or("Missing items")? {
                        let env = number(item,"env")?;
                        let game = games.get(env).ok_or("Invalid environment")?;
                        let options: [Vec<Action>;2] = parse(&item["candidates"])?;
                        if options.iter().any(|a| a.is_empty() || a.len() > 32) { return Err("Candidate count must be 1..32".into()); }
                        let mut states = Vec::new();
                        let mut cells = Vec::new();
                        let mut cache = HashMap::new();
                        for a in &options[0] {
                            for b in &options[1] {
                                let r = game.preview_round(&[a.clone(),b.clone()])?;
                                let key = r.after_hash.clone();
                                let index = *cache.entry((key,json!(r.outcome).to_string())).or_insert_with(|| {
                                    let index = states.len();
                                    let repetition = game.next_repetition_count_from_hash(&r.after_hash);
                                    states.push(if item["compact"].as_bool() == Some(true) {
                                        json!({"outcome":r.outcome,"features":sparse_observation(&r.position,&game.rules,game.round+1,repetition),"heuristic":material_value(&r.position)})
                                    } else {
                                        json!({"position":r.position,"outcome":r.outcome,"round":game.round+1,"rules":game.rules,"repetition":repetition})
                                    });
                                    index
                                });
                                cells.push(index);
                            }
                        }
                        rows.push(json!({"env":env,"states":states,"cells":cells}));
                    }
                    Ok(json!(rows))
                }
                "solve" => {
                    v["items"].as_array().ok_or("Missing items")?.iter().map(|item| {
                        let matrix: Vec<Vec<f64>> = parse(&item["matrix"])?;
                        let strategy = regret_match(&matrix,number(item,"iterations")?)?;
                        Ok(json!({"env":item["env"],"p":strategy.p,"q":strategy.q,"gap":strategy.gap}))
                    }).collect::<Result<Vec<_>,String>>().map(|rows| json!(rows))
                }
                "step" => {
                    let mut rows = Vec::new();
                    for item in v["items"].as_array().ok_or("Missing items")? {
                        let env = number(item,"env")?;
                        let game = games.get_mut(env).ok_or("Invalid environment")?;
                        let actions: Vec<Action> = parse(&item["actions"])?;
                        let result = game.play_round(&actions)?;
                        let metrics = json!(result.metrics);
                        let captures = json!(result.captures);
                        let contacts = json!(result.contacts);
                        let movements = json!(result.movements);
                        let mut s = state(game);
                        s["env"] = json!(env); s["metrics"] = metrics; s["captures"] = captures;
                        s["contacts"] = contacts;
                        s["movements"] = movements;
                        if game.outcome.is_some() && item["replay"].as_bool() == Some(true) { s["replay"] = json!(game.replay); }
                        rows.push(s);
                    }
                    Ok(json!(rows))
                }
                "baseline" => {
                    v["items"].as_array().ok_or("Missing items")?.iter().map(|item| {
                        let game = games.get(number(item,"env")?).ok_or("Invalid environment")?;
                        let side: Side = parse(&item["side"])?;
                        let policy: Policy = parse(&item["policy"])?;
                        let seed = item["seed"].as_u64().ok_or("Missing seed")?;
                        Ok(json!({"env":item["env"],"action":choose(&game.position,side,policy,&mut Rng(seed))?}))
                    }).collect::<Result<Vec<_>,String>>().map(|rows| json!(rows))
                }
                _ => Err("Unknown training command".into()),
            }
        })();
        let value = match response {
            Ok(value) => json!({"ok":true,"value":value}),
            Err(error) => json!({"ok":false,"error":error}),
        };
        writeln!(out, "{value}").map_err(|e| e.to_string())?;
        out.flush().map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn benchmark(iterations: usize) -> Result<Value, String> {
    if !(1..=100_000).contains(&iterations) {
        return Err("Iterations must be 1..100000".into());
    }
    let mut positions = vec![Position::initial()];
    let mut game = Match::with_diagnostics(Position::initial(), RuleSet::default(), false)?;
    let mut rng = Rng(42);
    for _ in 0..64 {
        if game.outcome.is_some() {
            game = Match::with_diagnostics(Position::initial(), RuleSet::default(), false)?;
        }
        let actions = Side::ALL
            .map(|s| choose(&game.position, s, Policy::Random, &mut rng))
            .into_iter()
            .collect::<Result<Vec<_>, _>>()?;
        game.play_round(&actions)?;
        positions.push(game.position.clone());
    }
    // Warm tables; compare every action in exactly the reference order.
    for pos in &positions {
        for side in Side::ALL {
            let expected: Vec<_> = generate_actions(pos, side)?
                .into_iter()
                .map(|o| o.action)
                .collect();
            if fast_actions(pos, side)? != expected {
                return Err("Action equivalence failed".into());
            }
        }
    }
    let mut measurements = Vec::new();
    for trial in 0..6 {
        for fast in if trial % 2 == 0 {
            [false, true]
        } else {
            [true, false]
        } {
            let start = Instant::now();
            let mut total = 0;
            for i in 0..iterations {
                let pos = &positions[i % positions.len()];
                for side in Side::ALL {
                    total += if fast {
                        std::hint::black_box(fast_actions(pos, side)?).len()
                    } else {
                        std::hint::black_box(generate_actions(pos, side)?).len()
                    };
                }
            }
            measurements.push(json!({"trial":trial,"fast":fast,"seconds":start.elapsed().as_secs_f64(),"actions":total}));
        }
    }
    Ok(
        json!({"format":"shogi-action-benchmark-v1","rules":RuleSet::default(),"seed":42,"corpusPositions":positions.len(),"iterations":iterations,"equivalent":true,"measurements":measurements}),
    )
}
