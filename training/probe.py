"""Re-search a verified replay prefix with a wider finite candidate matrix."""
import argparse
from pathlib import Path
import time
import numpy as np
import torch
from .common import read_json, atomic_json, fingerprint, load_config
from .engine import EnginePool, key
from .evaluate import load_model
from .model import device_for
from .search import Searcher


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--replay", required=True)
    parser.add_argument("--round", type=int, required=True, help="One-based round to analyze, before its commitments")
    parser.add_argument("--candidates", type=int, default=16)
    args = parser.parse_args()
    if not 2 <= args.candidates <= 32:
        parser.error("candidates must be 2..32")
    run = Path(args.run_dir).resolve()
    manifest = read_json(run / "manifest.json")
    config = load_config(overrides=dict(manifest["config"], device="auto"))
    device = device_for(config)
    torch.set_num_threads(4)
    model, checkpoint = load_model(run / manifest["latest_checkpoint"], config, device, fingerprint())
    raw = read_json(args.replay)
    replay = raw.get("replay", raw)
    if not 1 <= args.round <= len(replay["rounds"]):
        parser.error("round is outside the replay")
    actual = replay["rounds"][args.round - 1]
    replay["rounds"] = replay["rounds"][:args.round - 1]
    if replay["rules"] != manifest["rules"]:
        raise ValueError("Replay and model rules differ")
    config["candidates"] = args.candidates
    config["cheap_candidates"] = min(config["cheap_candidates"], args.candidates)
    with EnginePool(1) as pool:
        pool.restore(replay)
        rows = pool.call("observe")
        if not rows:
            raise ValueError("Cannot analyze a terminal position")
        rngs = {key(rows[0]): [np.random.default_rng(123), np.random.default_rng(124)]}
        choice = Searcher(pool, model, config, device, checkpoint["generation"]).search(
            rows, rngs, forced_actions={key(rows[0]): actual["actions"]})[0]
        state = {k: v for k, v in rows[0].items() if k not in ["actions", "_engine", "env"]}
        result = {"round": args.round, "state": state, "generation": checkpoint["generation"],
                  "candidates": [[rows[0]["actions"][s][j] for j in choice["selected"][s]] for s in range(2)],
                  "matrix": choice["matrix"].tolist(), "strategies": choice["strategies"], "restricted_gap": choice["gap"],
                  "actual_actions": actual["actions"], "replay_file": str(Path(args.replay).name),
                  "source_fingerprint": manifest["source_fingerprint"], "rules_hash": manifest["rules_hash"],
                  "note": "History verified by Rust replay; finite candidate matrix, approximate leaves, not a proof of imbalance"}
        path = run / "probes" / f"local-{int(time.time())}.json"
        atomic_json(path, result)
        print(path)


if __name__ == "__main__":
    main()
