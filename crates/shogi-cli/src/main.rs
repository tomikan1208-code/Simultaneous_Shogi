use serde_json::{json, Value};
use shogi_core::{
    api::Api,
    policy::{choose, Policy, Rng},
    replay::Replay,
    *,
};
use std::{
    collections::BTreeMap,
    io::{self, BufRead, Read},
    time::Instant,
};

fn read_json() -> Result<Value, String> {
    let mut input = String::new();
    io::stdin()
        .take(16 * 1024 * 1024 + 1)
        .read_to_string(&mut input)
        .map_err(|e| e.to_string())?;
    if input.len() > 16 * 1024 * 1024 {
        return Err("Input too large".into());
    }
    serde_json::from_str(&input).map_err(|e| e.to_string())
}
fn parse<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, String> {
    serde_json::from_value(value).map_err(|e| e.to_string())
}
fn stream(command: &str) -> Result<(), String> {
    let mut api = Api::default();
    for line in io::stdin().lock().lines() {
        let line = line.map_err(|e| e.to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        let response = if command == "api" {
            parse::<Value>(
                serde_json::from_slice(&api.json(line.as_bytes())).map_err(|e| e.to_string())?,
            )?
        } else {
            let result = (|| {
                let mut input: Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
                let actions = parse::<Vec<Action>>(
                    input
                        .as_object_mut()
                        .ok_or("Expected round input")?
                        .remove("actions")
                        .ok_or("Missing actions")?,
                )?;
                let position = parse::<Position>(input)?;
                resolve_round(&position, &actions)
            })();
            match result {
                Ok(value) => json!({"ok":true,"value":value}),
                Err(error) => json!({"ok":false,"error":error}),
            }
        };
        println!("{response}");
    }
    Ok(())
}
fn policy(name: &str) -> Result<Policy, String> {
    parse(json!(name))
}
fn arena(args: &[String]) -> Result<Value, String> {
    let pairs = args
        .first()
        .map(|v| v.parse::<u32>())
        .transpose()
        .map_err(|e| e.to_string())?
        .unwrap_or(10);
    if pairs == 0 || pairs > 10_000 {
        return Err("Arena pairs must be 1..10000".into());
    }
    let seed = args
        .get(1)
        .map(|v| v.parse::<u64>())
        .transpose()
        .map_err(|e| e.to_string())?
        .unwrap_or(1);
    let names = [
        args.get(2).map(String::as_str).unwrap_or("hunter"),
        args.get(3).map(String::as_str).unwrap_or("random"),
    ];
    let policies = [policy(names[0])?, policy(names[1])?];
    let diagnostics = match args.get(4).map(String::as_str).unwrap_or("off") {
        "on" => true,
        "off" => false,
        _ => return Err("Diagnostics must be on/off".into()),
    };
    let start = Instant::now();
    let mut policy_time = std::time::Duration::ZERO;
    let mut resolution_time = std::time::Duration::ZERO;
    let mut wins = [0u32; 2];
    let mut draws = 0;
    let mut rounds = 0u64;
    let mut events = BTreeMap::<String, u64>::new();
    let mut captures = BTreeMap::<Kind, u64>::new();
    let mut survivors = BTreeMap::<Kind, u64>::new();
    let mut games = Vec::new();
    let mut capture_reasons = BTreeMap::<String, u64>::new();
    let mut rank7_piece_rounds = 0u64;
    for pair in 0..pairs {
        for swapped in [false, true] {
            let mut game =
                Match::with_diagnostics(Position::initial(), RuleSet::default(), diagnostics)?;
            // Independent streams follow the policy when colors are exchanged.
            let mut rngs = [
                Rng(seed.wrapping_add(pair as u64 * 2)),
                Rng(seed.wrapping_add(pair as u64 * 2 + 1)),
            ];
            while game.outcome.is_none() {
                rank7_piece_rounds += game
                    .position
                    .pieces
                    .iter()
                    .filter(|p| p.rank() == 7)
                    .count() as u64;
                let mut actions = Vec::new();
                let t = Instant::now();
                for side in Side::ALL {
                    let i = side.index() ^ usize::from(swapped);
                    actions.push(choose(&game.position, side, policies[i], &mut rngs[i])?);
                }
                policy_time += t.elapsed();
                let t = Instant::now();
                let r = game.play_round(&actions)?;
                resolution_time += t.elapsed();
                rounds += 1;
                for (kind, count) in &r.metrics {
                    *events.entry(kind.clone()).or_default() += count;
                }
                for c in &r.captures {
                    *captures.entry(c.kind).or_default() += 1;
                    *capture_reasons.entry(c.reason.clone()).or_default() += 1;
                }
            }
            let outcome = game.outcome.as_ref().expect("finished");
            match outcome.winner {
                Winner::Draw => draws += 1,
                Winner::A => wins[usize::from(swapped)] += 1,
                Winner::B => wins[1 ^ usize::from(swapped)] += 1,
            }
            for p in &game.position.pieces {
                *survivors.entry(p.kind).or_default() += 1;
            }
            games.push(json!({"pair":pair,"swapped":swapped,"rounds":game.round,"outcome":outcome,"hash":game.state_hash()}));
        }
    }
    let seconds = start.elapsed().as_secs_f64();
    Ok(
        json!({"rules":RuleSet::default(),"seed":seed,"policies":names,"pairs":pairs,"games":pairs*2,"wins":wins,"draws":draws,
        "rounds":rounds,"averageRounds":rounds as f64 / (pairs*2) as f64,"events":events,"capturesByKind":captures,"survivorsByKind":survivors,"captureReasons":capture_reasons,"rank7PieceRounds":rank7_piece_rounds,
        "seconds":seconds,"policySeconds":policy_time.as_secs_f64(),"matchResolutionSeconds":resolution_time.as_secs_f64(),
        "roundsPerSecond":rounds as f64 / seconds,"gamesPerSecond":(pairs*2) as f64 / seconds,"diagnostics":diagnostics,"results":games}),
    )
}
fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str).unwrap_or("help") {
        "resolve" | "api" => stream(&args[0])?,
        "initial" => println!("{}",json!(Match::standard().view())),
        "actions" => {
            let side = parse::<Side>(json!(args.get(1).map(String::as_str).unwrap_or("A")))?;
            let pos: Position = parse(read_json()?)?; println!("{}",json!(generate_actions(&pos,side)?));
        }
        "verify" => {
            let replay: Replay = parse(read_json()?)?; let game = replay.verify()?;
            println!("{}",json!({"verified":true,"rounds":game.round,"hash":game.state_hash(),"outcome":game.outcome}));
        }
        "arena" => println!("{}",arena(&args[1..])?),
        _ => println!("Simultaneous Shogi v0.5\n  shogi initial\n  shogi resolve    JSONL round fixtures on stdin\n  shogi api        JSONL session requests on stdin\n  shogi actions A  Position JSON on stdin\n  shogi verify     Replay JSON on stdin\n  shogi arena [pairs=10] [seed=1] [hunter] [random] [diagnostics=off]\nPolicies: random, hunter, defense, interference, upgrade"),
    }
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
