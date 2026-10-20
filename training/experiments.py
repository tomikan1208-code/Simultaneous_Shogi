"""Frozen-model comparisons and fairly scheduled independent rule adaptation."""
from __future__ import annotations
import argparse
from collections import deque
import csv
import io
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import time
import zipfile
import torch
from .common import ROOT, FORMAT, atomic_json, read_json, load_config, fingerprint, hardware
from .compatibility import file_hash
from .rules import variants
from .train import Trainer, StopRequested
from .evaluate import load_model, paired_match
from .engine import EnginePool
from .model import device_for
from .storage import replace_file
from .artifacts import committed

EXPERIMENT_FORMAT = "simultaneous-shogi/balance-experiment-v1"


def initialize(directory, source_run, checkpoint="latest", plan=None):
    directory, source_run = Path(directory).resolve(), Path(source_run).resolve()
    plan = plan or {}
    unknown = set(plan) - {"training", "rules", "grid", "rule_overrides", "seeds", "max_parallel", "short_pairs", "long_pairs", "short_seed", "long_seed", "chunk_generations"}
    if unknown:
        raise ValueError(f"Unknown experiment settings: {sorted(unknown)}")
    if (directory / "experiment.json").exists():
        raise ValueError("Experiment already exists; use run/report")
    source_manifest = read_json(source_run / "manifest.json")
    if not source_manifest or source_manifest.get("format") != FORMAT:
        raise ValueError("A saved training run is required")
    selected = source_manifest["latest_checkpoint"] if checkpoint == "latest" else f"checkpoints/g{int(checkpoint):04d}.pt"
    source_checkpoint = source_run / selected
    source_config = load_config(overrides=dict(source_manifest["config"], device="cpu"))
    unknown = set(plan.get("training", {})) - set(source_config)
    if unknown:
        raise ValueError(f"Unknown training settings: {sorted(unknown)}")
    model, original = load_model(source_checkpoint, source_config, torch.device("cpu"))
    if plan.get("training", {}).get("channels", model.channels) != model.channels:
        raise ValueError("Warm starts must preserve the source architecture")
    config = load_config(overrides={**source_config, "generations":0, "bootstrap_weight":0., "balance_logging":True,
                                   **{k:v for k,v in plan.get("training", {}).items() if k not in ["channels", "balance", "balance_logging", "bootstrap_weight"]}})
    if config["channels"] != model.channels:
        raise ValueError("Source architecture must be preserved")
    rows = variants(plan.get("rules"), plan.get("grid"), plan.get("rule_overrides"))
    seeds = plan.get("seeds", [config["seed"]])
    if not seeds or len(seeds) > 16 or len(set(seeds)) != len(seeds) or any(type(s) is not int or not 0 <= s < 2**32 for s in seeds):
        raise ValueError("Supply 1..16 distinct integer training seeds")
    parallel = plan.get("max_parallel", 1)
    if type(parallel) is not int or not 1 <= parallel <= 32:
        raise ValueError("max_parallel must be 1..32")
    if any(type(plan.get(k, default)) is not int or not lo <= plan.get(k, default) <= hi
           for k, default, lo, hi in [("short_pairs", 512, 1, 4096), ("long_pairs", 512, 1, 4096), ("chunk_generations", 5, 1, 1000)]):
        raise ValueError("Invalid comparison pairs or scheduling chunk")
    directory.mkdir(parents=True, exist_ok=True)
    seed_run = directory / "seed-run"
    seed_run.mkdir(exist_ok=True)
    # The manifest and checkpoint are read once. Later source generations cannot
    # silently change the parent of queued variants.
    for name in [selected, "source.zip"]:
        target = seed_run / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_run / name, target)
    atomic_json(seed_run / "manifest.json", source_manifest)
    frozen = seed_run / selected
    sha = file_hash(frozen)
    if sha != file_hash(source_checkpoint):
        raise ValueError("Source checkpoint changed while freezing it")
    experiment = dict(format=EXPERIMENT_FORMAT, created=time.time(), source_fingerprint=fingerprint(),
                      initialized=False,
                      parent=dict(source_run=str(source_run), checkpoint=selected, generation=original["generation"], sha256=sha),
                      plan=plan, variants=rows, seeds=seeds, max_parallel=parallel,
                      short_pairs=plan.get("short_pairs", 512), long_pairs=plan.get("long_pairs", 512),
                      short_seed=plan.get("short_seed", 30_719_005), long_seed=plan.get("long_seed", 90_719_005),
                      chunk_generations=plan.get("chunk_generations", 5), runs=[],
                      comparison_note="Short and adapted results are separate; no automatic best-rule decision")
    if experiment["short_seed"] == experiment["long_seed"]:
        raise ValueError("Short and long comparisons must use different seeds")
    if any(type(experiment[key]) is not int or not 0 <= experiment[key] < 2**32 for key in ["short_seed", "long_seed"]):
        raise ValueError("Evaluation seeds must be nonnegative 32-bit integers")
    atomic_json(directory / "experiment.json", experiment)
    for replica, seed in enumerate(seeds):
        for row in rows:
            name = re.sub(r"[^A-Za-z0-9_-]", "P", row["id"]) + f"-s{seed}"
            relative = f"runs/{name}"
            child_config = dict(config, seed=seed, balance=row["balance"])
            run = directory / relative
            trainer = Trainer(run, child_config, initial_checkpoint=frozen, initial_config=source_config)
            trainer.manifest.update(experiment=dict(id=directory.name, rule=row["id"], replica=replica, seed=seed),
                                    name=f"{directory.name} / {row['id']} / seed {seed}")
            atomic_json(run / "manifest.json", trainer.manifest)
            atomic_json(directory / "configs" / f"{name}.json", child_config)
            experiment["runs"].append(dict(rule=row["id"], replica=replica, seed=seed, directory=relative, config=f"configs/{name}.json"))
            atomic_json(directory / "experiment.json", experiment)
    if fingerprint() != experiment["source_fingerprint"]:
        raise ValueError("Sources changed while initializing branches; create a fresh experiment")
    experiment["initialized"] = True
    atomic_json(directory / "experiment.json", experiment)
    atomic_json(directory / "status.json", dict(phase="ready", updated=time.time()))
    return experiment


def evaluate_run(directory, row, stage, pairs=None):
    directory = Path(directory)
    experiment = read_json(directory / "experiment.json")
    if experiment["source_fingerprint"] != fingerprint():
        raise ValueError("Sources changed; evaluate with the saved source snapshot")
    run = directory / row["directory"]
    manifest = read_json(run / "manifest.json")
    config = load_config(overrides=manifest["config"])
    device = device_for(config)
    torch.set_num_threads(max(1, min(4, config["workers"])))
    target = "checkpoints/g0000.pt" if stage == "short" else manifest["latest_checkpoint"]
    model, checkpoint = load_model(run / target, config, device, experiment["source_fingerprint"])
    seed = experiment[f"{stage}_seed"] + row["replica"]*1_000_003
    pairs = pairs or experiment[f"{stage}_pairs"]
    out = run / "comparisons" / stage / f"g{checkpoint['generation']:04d}"
    metadata = dict(stage=stage, rule=row["rule"], replica=row["replica"], generation=checkpoint["generation"],
                    parent=experiment["parent"], model_sha256=file_hash(run / target),
                    seed=seed, pairs=pairs, config=config, hardware=hardware(device), source_fingerprint=fingerprint())
    def progress(*_):
        if (directory/"STOP").exists():
            raise StopRequested()
    progress()
    with EnginePool(config["workers"]) as pool:
        self_result = paired_match(pool, model, model, config, device, checkpoint["generation"], "self", pairs, seed, out, progress=progress)
        result = dict(metadata=metadata, self_play=self_result)
    if experiment["source_fingerprint"] != fingerprint():
        raise ValueError("Sources changed during evaluation; this comparison is not committed")
    atomic_json(out / "comparison.json", result)
    return result


def schedule(directory, stage, generations=0, parallel=None, pairs=None, rules=None):
    directory = Path(directory).resolve()
    experiment = read_json(directory / "experiment.json")
    if not experiment or experiment.get("format") != EXPERIMENT_FORMAT:
        raise ValueError("Not a balance experiment")
    if not experiment.get("initialized", True):
        raise ValueError("Experiment initialization was interrupted; create a new experiment")
    if stage != 'train' and experiment["source_fingerprint"] != fingerprint():
        raise ValueError("Sources differ; use this experiment's saved source snapshots")
    if rules is not None and (not rules or set(rules)-{r['rule'] for r in experiment['runs']}):
        raise ValueError('Select existing rule IDs')
    maximum = experiment["max_parallel"] if parallel is None else parallel
    if not 1 <= maximum <= 32 or generations < 0 or pairs is not None and not 1 <= pairs <= 4096:
        raise ValueError("Invalid parallelism or generation target")
    lock = directory / "RUNNING"
    fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    os.write(fd, str(os.getpid()).encode())
    os.close(fd)
    queue, active = deque(r for r in experiment['runs'] if rules is None or r['rule'] in rules), []
    stopping = False
    previous_handlers = {}
    def stop(*_):
        nonlocal stopping
        stopping = True
    for signum in [signal.SIGINT, signal.SIGTERM]:
        previous_handlers[signum] = signal.signal(signum, stop)
    directory.joinpath("logs").mkdir(exist_ok=True)
    def status(phase):
        atomic_json(directory / "status.json", dict(phase=phase, stage=stage, updated=time.time(),
                    target_generations=generations, queued=len(queue), active=[dict(rule=r["rule"], replica=r["replica"], pid=p.pid) for r,p,_ in active]))
    try:
        while queue or active:
            stopping = stopping or (directory / "STOP").exists()
            if stopping:
                if not (directory/"STOP").exists():
                    (directory/"STOP").write_text("Experiment stopped",encoding="utf-8")
                queue.clear()
                for row, child, _ in active:
                    if stage == "train":
                        (directory / row["directory"] / "STOP").write_text("Experiment stopped", encoding="utf-8")
            while queue and len(active) < maximum and not stopping:
                row = queue.popleft()
                run = directory / row["directory"]
                manifest = read_json(run / "manifest.json")
                if stage == "train":
                    current = manifest["generation"]
                    configured = read_json(directory/row["config"])["generations"]
                    target = min(x for x in [generations or 100001, configured or 100001])
                    if current >= target:
                        continue
                    end = current + experiment["chunk_generations"]
                    end = min(end, target)
                    row = dict(row, _started_generation=current, _target_generation=target)
                    if (run / "RUNNING").exists():
                        raise ValueError(f"Child run is already active: {run}")
                    (run / "STOP").unlink(missing_ok=True)
                    command = [sys.executable, "-u", "-m", "training.launch", "--run-dir", str(run), "--config", str(directory/row["config"]), "--resume", "--until-generation", str(end)]
                else:
                    current = 0 if stage == "short" else manifest["generation"]
                    result = run / "comparisons" / stage / f"g{current:04d}/comparison.json"
                    existing = read_json(result)
                    if existing and existing["metadata"]["pairs"] == (pairs or experiment[f"{stage}_pairs"]):
                        continue
                    command = [sys.executable, "-u", "-m", "training.experiments", "worker", "--directory", str(directory), "--stage", stage, "--run", row["directory"]]
                    if pairs:
                        command += ["--pairs", str(pairs)]
                log = (directory/"logs"/(Path(row["directory"]).name+f"-{stage}.log")).open("a", encoding="utf-8")
                child = subprocess.Popen(command, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT,
                                         env=dict(os.environ, PYTHONUNBUFFERED="1", PYTHONIOENCODING="utf-8"))
                active.append((row, child, log))
            status("stopping" if stopping else "running")
            for row, child, log in active[:]:
                code = child.poll()
                if code is None:
                    continue
                log.close()
                active.remove((row, child, log))
                if code and not stopping:
                    raise RuntimeError(f"{row['rule']} exited with {code}; see logs/{Path(row['directory']).name}-{stage}.log")
                if stage == "train" and not stopping:
                    manifest = read_json(directory / row["directory"] / "manifest.json")
                    if manifest["generation"] <= row["_started_generation"]:
                        raise RuntimeError(f"{row['rule']} stopped without committing a generation")
                    if manifest["generation"] < row["_target_generation"]:
                        queue.append(row)
            if active:
                time.sleep(.5)
        status("stopped" if stopping else "complete")
        report(directory)
    except Exception as error:
        (directory/"STOP").write_text("Experiment worker failed",encoding="utf-8")
        for row, child, _ in active:
            if stage == "train":
                (directory / row["directory"] / "STOP").write_text("Sibling failed", encoding="utf-8")
        atomic_json(directory / "status.json", dict(phase="failed", stage=stage, error=str(error), updated=time.time()))
        raise
    finally:
        for _, child, log in active:
            child.wait()
            log.close()
        lock.unlink(missing_ok=True)
        for signum, handler in previous_handlers.items():
            signal.signal(signum, handler)


def report(directory):
    directory = Path(directory)
    experiment = read_json(directory / "experiment.json")
    rows = []
    for run in experiment["runs"]:
        manifest = read_json(directory / run["directory"] / "manifest.json")
        for path in sorted((directory / run["directory"] / "comparisons").glob("*/g*/comparison.json")):
            data = read_json(path)
            if data["metadata"]["generation"] > manifest["generation"]:
                continue
            stats = data["self_play"]["balance"]
            rows.append(dict(rule=run["rule"], replica=run["replica"], stage=data["metadata"]["stage"], generation=data["metadata"]["generation"],
                             pairs=data["metadata"]["pairs"], model_checkpoint_sha256=data["metadata"]["model_sha256"],
                             mean_survival_observed=stats["elite_survival"]["mean_observed_rounds"],
                             mean_survival_completed=stats["elite_survival"]["mean_completed_rounds"],
                             survival_censored=stats["elite_survival"]["censored"],
                             elite_only_owner_win_rate=stats["elite_ownership"]["only_one_win_rate"],
                             elite_only_owner_games=stats["elite_ownership"].get("only_one_games",0),
                             score_vs_initial=data.get("against_initial",{}).get("score"), **stats))
    value = dict(format=EXPERIMENT_FORMAT, parent=experiment["parent"], generated=time.time(), results=rows,
                 note="Short frozen weights and long adapted policies are separate. No single automatic balance score. See full per-game evidence.")
    atomic_json(directory / "report.json", value)
    columns = ["rule", "replica", "stage", "generation", "games", "pairs", "mean_rounds", "elite_upgrades_per_game", "elite_collision_wins", "elite_stationary_captures",
               "mean_survival_observed", "mean_survival_completed", "survival_censored", "elite_only_owner_win_rate", "elite_only_owner_games", "score_vs_initial",
               "draw_rate", "repetition_rate", "elite_idle_when_mobile_rate", "elite_consecutive_move_rate", "unique_openings", "action_entropy"]
    stream = io.StringIO(newline="")
    writer = csv.DictWriter(stream, columns, extrasaction="ignore")
    writer.writeheader()
    writer.writerows(rows)
    path = directory / "report.csv"
    temp = path.with_suffix(".csv.tmp")
    temp.write_text(stream.getvalue(), encoding="utf-8-sig")
    replace_file(temp, path)
    return value


def export_experiment(directory, output, full_state=False):
    directory, output = Path(directory).resolve(), Path(output).resolve()
    if (directory/"RUNNING").exists() or any((directory/"runs").glob("*/RUNNING")):
        raise ValueError("Stop the experiment before exporting its committed logs")
    report(directory)
    manifests = {p.parent.name:read_json(p) for p in (directory/"runs").glob("*/manifest.json")}
    retained = {}
    for name, manifest in manifests.items():
        generations = {0,manifest["generation"],manifest["champion_generation"]}
        for comparison in (directory/"runs"/name/"comparisons").glob("*/g*/comparison.json"):
            generations.add(read_json(comparison)["metadata"]["generation"])
        retained[name] = {f"g{g:04d}.pt" for g in generations}
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED, compresslevel=1) as archive:
        archive.writestr("export.json",json.dumps(dict(kind="full_state" if full_state else "analysis_logs", created=time.time(),
                         note="Full evidence and selected checkpoints; numerical training replay and intermediate checkpoints omitted" if not full_state else "Complete committed experiment")))
        for path in sorted(directory.rglob("*")):
            name = path.relative_to(directory).as_posix()
            parts = Path(name).parts
            durable = len(parts) < 3 or parts[0] != "runs" or committed("/".join(parts[2:]), manifests[parts[1]]["generation"])
            included = full_state or len(parts) < 3 or parts[0] != "runs" or (parts[2] != "replay" and (parts[2] != "checkpoints" or path.name in retained[parts[1]]))
            if durable and included and path.is_file() and not path.is_symlink() and path != output and path.name not in ["RUNNING", "STOP"] and not path.name.endswith(".tmp"):
                archive.write(path, name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["init", "run", "worker", "report", "export"])
    parser.add_argument("--directory", required=True)
    parser.add_argument("--source-run")
    parser.add_argument("--checkpoint", default="latest")
    parser.add_argument("--plan")
    parser.add_argument("--stage", choices=["short", "train", "long"], default="short")
    parser.add_argument("--run")
    parser.add_argument("--generations", type=int, default=0)
    parser.add_argument("--parallel", type=int)
    parser.add_argument("--pairs", type=int)
    parser.add_argument("--output")
    parser.add_argument("--full-state", action="store_true", help="Include all checkpoints and numerical training replay in the export")
    parser.add_argument('--rules',nargs='+',help='Train only these rule IDs; omitted means all branches')
    args = parser.parse_args()
    if args.action == "init":
        if not args.source_run:
            parser.error("--source-run is required")
        initialize(args.directory, args.source_run, args.checkpoint, read_json(args.plan) if args.plan else None)
    elif args.action == "run":
        schedule(args.directory, args.stage, args.generations, args.parallel, args.pairs,args.rules)
    elif args.action == "worker":
        experiment = read_json(Path(args.directory)/"experiment.json")
        row = next(row for row in experiment["runs"] if row["directory"] == args.run)
        try:
            evaluate_run(args.directory, row, args.stage, args.pairs)
        except StopRequested:
            print(json.dumps(dict(action="worker",stage=args.stage,stopped=True)),flush=True)
            return
    elif args.action == "report":
        report(args.directory)
    elif args.action == "export":
        if not args.output:
            parser.error("--output is required")
        export_experiment(args.directory, args.output, args.full_state)
    print(json.dumps(dict(action=args.action, directory=args.directory, done=True)), flush=True)


if __name__ == "__main__":
    main()
