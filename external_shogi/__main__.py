from __future__ import annotations

import argparse
import json
from pathlib import Path
import torch

from training.common import ROOT, load_config, read_json
from training.compatibility import file_hash
from training.evaluate import load_model
from .experiment import match
from .usi import USIEngine


def main():
    parser = argparse.ArgumentParser(description="External shogi opponents, demonstration data and distillation")
    commands = parser.add_subparsers(dest="command", required=True)
    play = commands.add_parser("match", help="Play a checkpoint or native baseline against a USI engine")
    play.add_argument("--run-dir", help="Read a committed model; omit to test the native baseline")
    play.add_argument("--checkpoint", default="latest")
    play.add_argument("--config", help="Rule/training config for baseline-only matches")
    play.add_argument("--baseline", default="hunter", choices=["hunter", "defense", "upgrade", "random"])
    play.add_argument("--engine", help="USI executable; default is the locally cached YaneuraOu V9.00")
    play.add_argument("--eval-dir", help="Engine evaluation directory")
    play.add_argument("--weights", help="Weights file to hash; default is EvalDir/nn.bin")
    play.add_argument("--option", action="append", default=[], metavar="NAME=VALUE")
    play.add_argument("--nodes", type=int, default=2000)
    play.add_argument("--pairs", type=int, default=2)
    play.add_argument("--seed", type=int, default=719005)
    play.add_argument("--output", required=True, help="New result directory; never overwrites an experiment")
    play.add_argument("--device", default="cpu", choices=["cpu", "cuda"])
    play.add_argument("--timeout", type=float, default=30.)
    distill = commands.add_parser("distill", help="Warm-start a separate run from completed USI demonstrations")
    distill.add_argument("--data", required=True, help="teacher.jsonl from a match")
    distill.add_argument("--init-from", required=True, help="Existing run; its weights are read only")
    distill.add_argument("--checkpoint", default="latest", help="Source generation; default is latest committed")
    distill.add_argument("--output", required=True, help="New training run directory")
    distill.add_argument("--updates", type=int, default=32)
    distill.add_argument("--device", default="cpu", choices=["cpu", "cuda"])
    args = parser.parse_args()
    if args.command == "distill":
        from .distill import distill_run
        if not 1 <= args.updates <= 4096:
            parser.error("updates must be 1..4096")
        distill_run(args.data, args.init_from, args.output, args.updates, args.device, args.checkpoint)
        return
    if not 1 <= args.pairs <= 4096 or not 1 <= args.nodes <= 100000000 or not 0 <= args.seed < 2**32 or not 0 < args.timeout <= 300:
        parser.error("Invalid pairs/nodes/seed/timeout")
    if args.config and args.run_dir:
        parser.error("--config is only for baseline matches; model matches use the saved rules")
    if Path(args.output).exists():
        parser.error("--output already exists; choose a new experiment directory")
    torch.set_num_threads(2)
    model, generation, identity = None, 0, None
    if args.run_dir:
        run = Path(args.run_dir).resolve()
        manifest = read_json(run / "manifest.json")
        config = load_config(overrides=dict(manifest["config"], device=args.device, workers=1))
        filename = manifest["latest_checkpoint"] if args.checkpoint == "latest" else f"checkpoints/g{int(args.checkpoint):04d}.pt"
        checkpoint_path = (run / filename).resolve()
        if not checkpoint_path.is_relative_to(run):
            parser.error("Checkpoint must stay inside its run")
        origin = manifest.get("checkpoint_origins", {}).get(filename)
        if origin and file_hash(checkpoint_path) != origin["sha256"]:
            parser.error("Inherited checkpoint has changed")
        source = origin["source_fingerprint"] if origin else manifest["source_fingerprint"]
        model, checkpoint = load_model(checkpoint_path, config, torch.device(args.device), source)
        generation = checkpoint["generation"]
        identity = dict(run=str(run), checkpoint=filename, generation=generation, sha256=file_hash(checkpoint_path), source_fingerprint=source)
    else:
        config = load_config(args.config, dict(device=args.device, workers=1))
    options = {}
    if args.engine:
        executable = Path(args.engine).resolve()
        eval_dir = Path(args.eval_dir).resolve() if args.eval_dir else None
    else:
        executable = ROOT / ".cache/external-shogi/yaneuraou/NNUE_halfkp_256x2_32_32/YaneuraOu_NNUE_halfkp_256x2_32_32-V900Git_AVX2.exe"
        eval_dir = Path(args.eval_dir).resolve() if args.eval_dir else ROOT / ".cache/external-shogi/tanuki/eval"
        options.update(Threads=1, USI_Hash=64, MultiPV=4, USI_OwnBook=False, BookFile="no_book",
                       EnteringKingRule="NoEnteringKing", FV_SCALE=20)
    if eval_dir:
        options["EvalDir"] = str(eval_dir)
    for entry in args.option:
        name, sep, value = entry.partition("=")
        if not sep or not name:
            parser.error("--option must be NAME=VALUE")
        options[name] = value
    weights = Path(args.weights).resolve() if args.weights else eval_dir / "nn.bin" if eval_dir else None
    if not executable.is_file() or weights is not None and not weights.is_file():
        parser.error("Engine/weights not found; see EXTERNAL_SHOGI.md for installation")
    with USIEngine([executable], options, args.timeout) as engine:
        result = match(engine, config, args.output, args.pairs, args.seed, args.nodes,
                       model, generation, identity, args.baseline, weights)
    print(json.dumps({k: result[k] for k in ("wins", "draws", "losses", "score", "interval", "decision", "adapter")}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
