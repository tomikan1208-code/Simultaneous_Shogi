"""Paired, seeded, fixed-budget evaluation. Pair is the statistical unit."""
from __future__ import annotations
import argparse
import math
from pathlib import Path
import time
import numpy as np
import torch
from .common import ROOT, SCHEMA, FORMAT, atomic_json, read_json, fingerprint, rules_for, rules_hash, load_config, hardware
from .engine import EnginePool, key
from .model import Net, device_for
from .search import Searcher


def interval(pair_scores, alpha=.05):
    """Distribution-free Hoeffding bound for independent bounded pair scores.

    Conservative, fixed-sample, not an anytime/SPRT test. Alpha may be reduced
    across the predeclared total generation gates to control repeated selection.
    """
    score = float(np.mean(pair_scores))
    radius = math.sqrt(math.log(2 / alpha) / (2 * len(pair_scores)))
    return [max(0., score - radius), min(1., score + radius)]


def load_model(path, config, device, source=None):
    checkpoint = torch.load(path, map_location="cpu", weights_only=True)
    if checkpoint.get("schema") != SCHEMA or checkpoint.get("format") != FORMAT:
        raise ValueError("Unsupported checkpoint schema")
    if source is not None and checkpoint["source_fingerprint"] != source:
        raise ValueError("Source fingerprint differs; use the source bundle that created this run")
    if checkpoint["rules_hash"] != rules_hash(rules_for(config)):
        raise ValueError("Rule fingerprint differs; evaluations cannot mix rules/limits")
    model = Net(checkpoint["channels"]).to(device)
    model.load_state_dict(checkpoint["model"])
    model.eval()
    return model, checkpoint


def paired_match(pool, model, opponent, config, device, generation, label, pairs, seed, out_dir=None, alpha=.05, progress=None):
    started = time.perf_counter()
    all_games, events, captures, representative = [], {}, {}, []
    searcher = Searcher(pool, model, config, device, generation)
    other_searcher = Searcher(pool, opponent, config, device, generation) if isinstance(opponent, Net) else None
    # Never split a pair between waves. Streams follow policy roles on a color swap.
    pairs_per_wave = max(1, config["environments"] // 2)
    for first in range(0, pairs, pairs_per_wave):
        batch_pairs = min(pairs_per_wave, pairs - first)
        pool.reset(batch_pairs * 2, rules_for(config))
        rows = pool.call("observe")
        identities, rngs, opponent_rngs, baseline_rngs = {}, {}, {}, {}
        for i, row in enumerate(rows):
            pair, swapped = first + i // 2, bool(i % 2)
            model_side = int(swapped)
            identities[key(row)] = (pair, swapped, model_side)
            streams = [np.random.default_rng(np.random.SeedSequence([seed, pair, role])) for role in range(2)]
            rngs[key(row)] = [streams[s ^ model_side] for s in range(2)]
            opponent_rngs[key(row)] = [np.random.default_rng(np.random.SeedSequence([seed, pair, 20 + (s ^ model_side)])) for s in range(2)]
            baseline_rngs[key(row)] = np.random.default_rng(np.random.SeedSequence([seed, pair, 99]))
        while rows:
            choices = {key(r): r for r in searcher.search(rows, rngs)}
            if other_searcher:
                other = {key(r): r for r in other_searcher.search(rows, opponent_rngs)}
            else:
                other = {key(r): r for r in pool.call("baseline", [
                    {"_engine": row["_engine"], "env": row["env"], "side": ["B", "A"][identities[key(row)][2]],
                     "policy": opponent, "seed": int(baseline_rngs[key(row)].integers(0, 2**63))} for row in rows])}
            items = []
            for row in rows:
                identity = key(row)
                pair, swapped, side = identities[identity]
                selected = choices[identity]["actions"].copy()
                selected[1 - side] = other[identity]["actions"][1 - side] if other_searcher else other[identity]["action"]
                items.append({"_engine": identity[0], "env": identity[1], "actions": selected, "replay": pair == 0})
            for result in pool.call("step", items):
                for name, count in result["metrics"].items():
                    events[name] = events.get(name, 0) + count
                for capture in result["captures"]:
                    name = capture["reason"] + ":" + capture["kind"]
                    captures[name] = captures.get(name, 0) + 1
                if result["outcome"]:
                    pair, swapped, side = identities[key(result)]
                    winner = result["outcome"]["winner"]
                    score = .5 if winner == "draw" else float(winner == ["A", "B"][side])
                    all_games.append({"pair": pair, "swapped": swapped, "score": score, "rounds": result["round"], "outcome": result["outcome"]})
                    if result.get("replay"):
                        representative.append({"label": f"{label} / pair {pair} / {'B' if side else 'A'}", "replay": result["replay"]})
            if progress:
                progress(len(all_games), pairs * 2, label)
            rows = pool.call("observe")
    pair_scores = [sum(g["score"] for g in all_games if g["pair"] == pair) / 2 for pair in range(pairs)]
    score = float(np.mean(pair_scores))
    ci = interval(pair_scores, alpha)
    results = {"opponent": label, "pairs": pairs, "games": pairs * 2, "seed": seed,
               "wins": sum(g["score"] == 1 for g in all_games), "draws": sum(g["score"] == .5 for g in all_games),
               "losses": sum(g["score"] == 0 for g in all_games), "score": score, "interval": ci,
               "confidence": 1 - alpha, "interval_method": "Hoeffding on independent color-swapped pairs",
               "elo_difference": None if score in (0, 1) else 400 * math.log10(score / (1 - score)),
               "decision": "better" if ci[0] > .5 else "worse" if ci[1] < .5 else "inconclusive",
               "seconds": time.perf_counter() - started, "results": all_games, "events": events,
               "captures": captures, "search": searcher.timing,
               "budget": {k: config[k] for k in ["candidates", "regret_iterations", "round_limit", "bootstrap_weight", "bootstrap_generations"]}}
    if out_dir:
        out_dir = Path(out_dir)
        atomic_json(out_dir / f"{label}.json", results)
        for i, replay in enumerate(representative):
            atomic_json(out_dir / f"{label}-replay-{i}.json", replay)
    return results


def main():
    parser = argparse.ArgumentParser(description="Paired local evaluation of a Colab checkpoint")
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--checkpoint", default="latest")
    parser.add_argument("--opponent", default="hunter", choices=["hunter", "defense", "upgrade", "random", "champion"])
    parser.add_argument("--pairs", type=int, default=32)
    parser.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda"])
    args = parser.parse_args()
    if not 1 <= args.pairs <= 4096:
        parser.error("pairs must be 1..4096")
    run = Path(args.run_dir).resolve()
    manifest = read_json(run / "manifest.json")
    config = load_config(overrides=dict(manifest["config"], device=args.device))
    torch.set_num_threads(max(1, min(4, config["workers"])))
    device = device_for(config)
    filename = manifest["latest_checkpoint"] if args.checkpoint == "latest" else f"checkpoints/g{int(args.checkpoint):04d}.pt"
    model, ckpt = load_model(run / filename, config, device, fingerprint())
    opponent = args.opponent
    if opponent == "champion":
        opponent, _ = load_model(run / manifest["champion_checkpoint"], config, device, fingerprint())
    stamp = str(int(time.time()))
    with EnginePool(config["workers"]) as pool:
        results = paired_match(pool, model, opponent, config, device, ckpt["generation"], args.opponent,
                               args.pairs, config["eval_seed"], run / "local-evaluations" / stamp)
    atomic_json(run / "local-evaluations" / stamp / "environment.json", hardware(device))
    print(f"Score {results['score']:.3f}, interval {results['interval']}, {results['decision']}")


if __name__ == "__main__":
    main()
