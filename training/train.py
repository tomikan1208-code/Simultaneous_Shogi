from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import time
import zipfile
import numpy as np
import torch
from .common import ROOT, SCHEMA, FORMAT, official_rules, atomic_json, read_json, fingerprint, source_files, rules_for, rules_hash, load_config, hardware
from .engine import EnginePool, key
from .evaluate import load_model, paired_match
from .features import heuristic_prior, mirror_sample
from .model import Net, device_for, pack, autocast, predict
from .replay import ReplayBuffer
from .search import Searcher, softmax


class StopRequested(Exception):
    pass


class Trainer:
    def __init__(self, run, config, resume=False, mirror=None):
        self.run, self.config = Path(run).resolve(), config
        self.mirror = Path(mirror).resolve() if mirror else None
        self.run.mkdir(parents=True, exist_ok=True)
        self.device = device_for(config)
        torch.set_num_threads(max(1, min(4, os.cpu_count() or 1)))
        if self.device.type == "cuda":
            torch.backends.cuda.matmul.allow_tf32 = True
            torch.backends.cudnn.allow_tf32 = True
        torch.manual_seed(config["seed"])
        self.rng = np.random.default_rng(config["seed"])
        self.model = Net(config["channels"]).to(self.device)
        self.optimizer = torch.optim.AdamW(self.model.parameters(), lr=config["learning_rate"], weight_decay=1e-4)
        self.scaler = torch.amp.GradScaler("cuda", enabled=config["amp"] and self.device.type == "cuda")
        self.buffer = ReplayBuffer(config["replay_capacity"])
        self.generation, self.stopping, self.last_progress = 0, False, 0.
        self.source = fingerprint()
        existing = read_json(self.run / "manifest.json")
        if existing and not resume:
            raise ValueError("Run exists. Use --resume or a new run directory.")
        if resume:
            if not existing:
                raise ValueError("No manifest to resume")
            # Training semantics stay fixed; only runtime location/device may change.
            allowed = {"device", "amp", "workers"}
            if any(config[k] != existing["config"][k] for k in config if k not in allowed):
                raise ValueError("Resume configuration differs. Restore the saved config or create a separate run.")
            self.model, checkpoint = load_model(self.run / existing["latest_checkpoint"], config, self.device, self.source)
            self.optimizer = torch.optim.AdamW(self.model.parameters(), lr=config["learning_rate"], weight_decay=1e-4)
            self.optimizer.load_state_dict(checkpoint["optimizer"])
            if self.scaler.is_enabled() and checkpoint["scaler"]:
                self.scaler.load_state_dict(checkpoint["scaler"])
            torch.set_rng_state(checkpoint["torch_rng"])
            if self.device.type == "cuda" and checkpoint.get("cuda_rng"):
                torch.cuda.set_rng_state_all(checkpoint["cuda_rng"])
            self.generation = checkpoint["generation"]
            self.rng.bit_generator.state = read_json(self.run / existing["rng_file"])
            self.buffer.load(self.run / existing["replay_file"])
            self.manifest = existing
        else:
            planned_gates = sum(g == 1 or g == config["generations"] or g % config["eval_every"] == 0 for g in range(1, config["generations"] + 1))
            self.manifest = {"format": FORMAT, "schema": SCHEMA, "name": self.run.name, "created": time.time(),
                             "source_fingerprint": self.source, "rules": rules_for(config), "rules_hash": rules_hash(rules_for(config)),
                             "config": config, "hardware": hardware(self.device), "generation": 0,
                             "champion_checkpoint": "checkpoints/g0000.pt", "champion_generation": 0,
                             "evaluation_note": "Short-run smoke test; not eligible for promotion" if config["round_limit"] != 200 else "Official limits; paired fixed-budget gates",
                             "planned_gates": planned_gates, "gate_alpha": .05 / planned_gates}
            if fingerprint() != self.source:
                raise RuntimeError("Training sources changed during initialization. Restart after edits settle.")
            with zipfile.ZipFile(self.run / "source.zip", "w", zipfile.ZIP_DEFLATED) as snapshot:
                files = source_files() + [ROOT / "training/colab.ipynb", ROOT / "training/README.md"]
                for path in files:
                    if path.is_file():
                        snapshot.write(path, path.relative_to(ROOT).as_posix())
            self.commit_checkpoint()
        self.manifest["last_hardware"] = hardware(self.device)
        atomic_json(self.run / "manifest.json", self.manifest)

    def status(self, phase, **extra):
        value = {"format": FORMAT, "phase": phase, "generation": self.generation,
                 "target_generations": self.config["generations"], "updated": time.time(), "device": str(self.device),
                 "samples": len(self.buffer.rows), **extra}
        atomic_json(self.run / "status.json", value)
        print(json.dumps(value, ensure_ascii=False), flush=True)

    def check_stop(self):
        if self.stopping or (self.run / "STOP").exists():
            raise StopRequested()

    def commit_checkpoint(self):
        if fingerprint() != self.source:
            raise RuntimeError("Training sources changed during this run. The current generation is not committed; use the saved source snapshot to resume.")
        tag = f"g{self.generation:04d}"
        path = self.run / "checkpoints" / f"{tag}.pt"
        path.parent.mkdir(parents=True, exist_ok=True)
        torch.save({"format": FORMAT, "schema": SCHEMA, "channels": self.model.channels, "generation": self.generation,
                    "source_fingerprint": self.source, "rules_hash": self.manifest["rules_hash"], "model": self.model.state_dict(),
                    "optimizer": self.optimizer.state_dict(), "scaler": self.scaler.state_dict(), "torch_rng": torch.get_rng_state(),
                    "cuda_rng": torch.cuda.get_rng_state_all() if self.device.type == "cuda" else []}, path.with_suffix(".tmp"))
        os.replace(path.with_suffix(".tmp"), path)
        replay_file, rng_file = f"replay/{tag}.npz", f"replay/{tag}.rng.json"
        self.buffer.save(self.run / replay_file)
        atomic_json(self.run / rng_file, self.rng.bit_generator.state)
        self.manifest.update(generation=self.generation, latest_checkpoint=f"checkpoints/{tag}.pt", replay_file=replay_file, rng_file=rng_file)
        # Last pointer is committed only after all recoverable state is durable.
        atomic_json(self.run / "manifest.json", self.manifest)
        self.sync_mirror()
        # Keep two replay snapshots; checkpoints and evaluation evidence remain.
        for old in (self.run / "replay").glob("g*.npz"):
            if int(old.stem[1:]) < self.generation - 1:
                old.unlink()
                old.with_suffix(".rng.json").unlink(missing_ok=True)

    def sync_mirror(self):
        if not self.mirror:
            return
        files = [p for p in self.run.rglob("*") if p.is_file() and p.suffix != ".tmp" and p.name not in ["manifest.json", "STOP", "RUNNING"]]
        files.append(self.run / "manifest.json")
        for source in files:
            dest = self.mirror / source.relative_to(self.run)
            if dest.exists() and dest.stat().st_size == source.stat().st_size and dest.stat().st_mtime >= source.stat().st_mtime:
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            temp = dest.with_suffix(dest.suffix + ".tmp")
            shutil.copy2(source, temp)
            os.replace(temp, dest)

    def self_play(self, pool, generation):
        config = self.config
        searcher = Searcher(pool, self.model, config, self.device, generation)
        self.model.eval()
        history = list((self.run / "checkpoints").glob("g*.pt"))
        history = sorted(history)[-config["history_size"]:]
        old, history_checkpoint = None, None
        if history and config["history_fraction"] > 0:
            history_checkpoint = history[int(self.rng.integers(len(history)))]
            old, _ = load_model(history_checkpoint, config, self.device, self.source)
        completed, total_rounds, all_events, all_captures, outcomes = 0, 0, {}, {}, []
        start, new_samples, history_games, probes_saved = time.perf_counter(), 0, 0, 0
        for first in range(0, config["games_per_generation"], config["environments"]):
            pool.reset(min(config["environments"], config["games_per_generation"] - first), rules_for(config))
            rows = pool.call("observe")
            trajectories, rngs, roles, game_ids = {}, {}, {}, {}
            for i, row in enumerate(rows):
                identity, game_id = key(row), first + i
                trajectories[identity] = []
                game_ids[identity] = game_id
                rngs[identity] = [np.random.default_rng(np.random.SeedSequence([config["seed"], generation, game_id, s])) for s in range(2)]
                roles[identity] = int(self.rng.integers(2)) if old and self.rng.random() < config["history_fraction"] else None
                history_games += roles[identity] is not None
            while rows:
                self.check_stop()
                chosen = searcher.search(rows, rngs, training=True)
                old_samples, old_meta = [], []
                for choice in chosen:
                    role = roles[key(choice)]
                    if role is not None:
                        old_samples.append(choice["samples"][role])
                        old_meta.append((choice, role))
                if old_samples:
                    logits, _ = predict(old, old_samples, self.device, config["amp"])
                    for (choice, role), scores in zip(old_meta, logits):
                        sample = choice["samples"][role]
                        prior = softmax(scores + searcher.bootstrap * heuristic_prior(sample["data"]))
                        choice["actions"][role] = sample["actions"][int(rngs[key(choice)][role].choice(len(prior), p=prior))]
                selected_map = {key(r): r for r in chosen}
                items = [{"_engine": c["_engine"], "env": c["env"], "actions": c["actions"], "replay": game_ids[key(c)] < 2} for c in chosen]
                for result in pool.call("step", items):
                    identity = key(result)
                    total_rounds += 1
                    tactical = bool(result["captures"]) or any(result["metrics"].get(k, 0) for k in ["contact", "drop_duel", "counter_capture"])
                    if tactical and probes_saved < 8:
                        root = next(row for row in rows if key(row) == identity)
                        choice = selected_map[identity]
                        atomic_json(self.run / "probes" / f"g{generation:04d}-{probes_saved:02d}.json", {
                            "generation": generation, "model_generation": generation-1, "round": root["round"] + 1,
                            "game": game_ids[identity], "state": {k: v for k, v in root.items() if k not in ["actions", "_engine", "env"]},
                            "candidates": [[root["actions"][s][j] for j in choice["selected"][s]] for s in range(2)],
                            "matrix": choice["matrix"].tolist(), "strategies": choice["strategies"], "restricted_gap": choice["gap"],
                            "actual_actions": choice["actions"], "captures": result["captures"], "events": result["metrics"],
                            "source_fingerprint": self.source, "rules_hash": self.manifest["rules_hash"],
                            "note": "Finite candidate matrix with approximate leaves; not full-game exploitability"})
                        probes_saved += 1
                    for s, sample in enumerate(selected_map[identity]["samples"]):
                        if roles[identity] != s:
                            trajectories[identity].append((sample, s, tactical))
                    for name, count in result["metrics"].items():
                        all_events[name] = all_events.get(name, 0) + count
                    for capture in result["captures"]:
                        name = capture["reason"] + ":" + capture["kind"]
                        all_captures[name] = all_captures.get(name, 0) + 1
                    if result["outcome"]:
                        winner = result["outcome"]["winner"]
                        trajectory = trajectories[identity]
                        # Limit repetitive long games; always retain tactical samples.
                        quiet = [i for i, (_, _, flag) in enumerate(trajectory) if not flag]
                        keep = set(self.rng.choice(quiet, min(96, len(quiet)), replace=False).tolist()) if quiet else set()
                        for i, (sample, side, flag) in enumerate(trajectory):
                            if flag or i in keep:
                                value = 0. if winner == "draw" else 1. if winner == ["A", "B"][side] else -1.
                                self.buffer.add(sample, value, generation, flag)
                                new_samples += 1
                        completed += 1
                        outcomes.append(result["outcome"])
                        if result.get("replay"):
                            atomic_json(self.run / "games" / f"g{generation:04d}-{game_ids[identity]:03d}.json",
                                        {"label": f"generation {generation} / game {game_ids[identity]}", "replay": result["replay"],
                                         "history_side": roles[identity]})
                        del trajectories[identity]
                if time.perf_counter() - self.last_progress > 2:
                    self.status("self_play", generation=generation, completed_games=completed, target_games=config["games_per_generation"],
                                rounds=total_rounds, rounds_per_second=total_rounds / max(.001, time.perf_counter() - start))
                    self.last_progress = time.perf_counter()
                rows = pool.call("observe")
        return {"games": completed, "rounds": total_rounds, "seconds": time.perf_counter() - start, "new_samples": new_samples,
                "history_games": history_games, "history_checkpoint": history_checkpoint.name if history_checkpoint else None,
                "events": all_events, "captures": all_captures, "outcomes": outcomes, "search": searcher.timing}

    def optimize(self, generation):
        self.model.train()
        start, losses = time.perf_counter(), []
        for update in range(self.config["updates"]):
            self.check_stop()
            samples = self.buffer.sample(self.config["batch_size"], self.rng, generation, self.config["recent_fraction"])
            if self.config["mirror_augmentation"]:
                samples = [mirror_sample(s) if self.rng.random() < .5 else s for s in samples]
            board, owners, indices, data, counts = pack(samples, self.device)
            targets = torch.as_tensor(np.concatenate([s["target"] for s in samples]), device=self.device)
            value_targets = torch.as_tensor([s["value"] for s in samples], device=self.device)
            self.optimizer.zero_grad(set_to_none=True)
            with autocast(self.device, self.config["amp"]):
                x, values = self.model.encode(board)
                logits = self.model.policy(x, owners, indices, data)
                policy_loss = torch.stack([-(target * torch.log_softmax(logit.float(), 0)).sum()
                                           for target, logit in zip(torch.split(targets, counts), torch.split(logits, counts))]).mean()
                value_loss = torch.nn.functional.mse_loss(values.float(), value_targets)
                loss = policy_loss + value_loss
            self.scaler.scale(loss).backward()
            self.scaler.unscale_(self.optimizer)
            torch.nn.utils.clip_grad_norm_(self.model.parameters(), 1.)
            self.scaler.step(self.optimizer)
            self.scaler.update()
            losses.append([float(policy_loss.detach()), float(value_loss.detach())])
            if update % 16 == 0:
                self.status("optimizing", generation=generation, update=update, target_updates=self.config["updates"])
        self.model.eval()
        return {"policy_loss": float(np.mean(losses, 0)[0]), "value_loss": float(np.mean(losses, 0)[1]),
                "seconds": time.perf_counter() - start, "updates": len(losses), "presentations": len(losses) * self.config["batch_size"]}

    def train(self):
        self.status("initializing")
        with EnginePool(self.config["workers"]) as pool:
            for generation in range(self.generation + 1, self.config["generations"] + 1):
                self.check_stop()
                started = time.perf_counter()
                play = self.self_play(pool, generation)
                optimize = self.optimize(generation)
                def progress(done, total, label):
                    self.check_stop()
                    if time.perf_counter() - self.last_progress > 2:
                        self.status("evaluating", generation=generation, completed_games=done, target_games=total, opponent=label)
                        self.last_progress = time.perf_counter()
                evaluations, promoted = [], False
                should_evaluate = generation == 1 or generation == self.config["generations"] or generation % self.config["eval_every"] == 0
                if should_evaluate:
                    for opponent in ["hunter", "defense", "upgrade"]:
                        evaluations.append(paired_match(pool, self.model, opponent, self.config, self.device, generation, opponent,
                                                        self.config["eval_pairs"], self.config["eval_seed"],
                                                        self.run / "evaluations" / f"g{generation:04d}", progress=progress))
                    champion, _ = load_model(self.run / self.manifest["champion_checkpoint"], self.config, self.device, self.source)
                    gate = paired_match(pool, self.model, champion, self.config, self.device, generation, "champion",
                                        self.config["eval_pairs"], self.config["eval_seed"] + generation * 10007,
                                        self.run / "evaluations" / f"g{generation:04d}", alpha=self.manifest["gate_alpha"], progress=progress)
                    evaluations.append(gate)
                    # Official limits + predeclared repeated-testing correction.
                    promoted = rules_for(self.config) == official_rules() and gate["interval"][0] > .5
                if promoted:
                    self.manifest.update(champion_checkpoint=f"checkpoints/g{generation:04d}.pt", champion_generation=generation)
                record = {"generation": generation, "timestamp": time.time(), "seconds": time.perf_counter() - started,
                          "self_play": play, "optimization": optimize, "evaluation": evaluations,
                          "promoted": promoted, "replay_size": len(self.buffer.rows), "duplicates_replaced": self.buffer.duplicates,
                          "source_fingerprint": self.source, "rules_hash": self.manifest["rules_hash"], "hardware": hardware(self.device)}
                atomic_json(self.run / "generations" / f"g{generation:04d}.json", record)
                self.generation = generation
                self.commit_checkpoint()
                self.status("generation_complete", promoted=promoted)
        self.status("complete")
        self.sync_mirror()


def main():
    parser = argparse.ArgumentParser(description="Colab-first simultaneous-shogi self-play training")
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--config")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--mirror-dir", help="Copy durable generation snapshots to Drive; train on local scratch")
    parser.add_argument("--smoke", action="store_true", help="Short CPU integration run; never evidence of strength")
    args = parser.parse_args()
    config = load_config(args.config, {"generations": 1, "games_per_generation": 2, "environments": 2, "workers": 1,
                                     "candidates": 3, "cheap_candidates": 2, "regret_iterations": 32, "updates": 2,
                                     "batch_size": 8, "eval_pairs": 1, "round_limit": 12, "channels": 8, "device": "cpu"} if args.smoke else None)
    run = Path(args.run_dir).resolve()
    run.mkdir(parents=True, exist_ok=True)
    lock = run / "RUNNING"
    try:
        # Explicit OS-level exclusive creation prevents two trainers overwriting a run.
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        raise SystemExit("RUNNING exists. Verify that the previous trainer is stopped before removing this stale lock.")
    os.write(fd, str(os.getpid()).encode())
    os.close(fd)
    trainer = None
    try:
        trainer = Trainer(run, config, args.resume, args.mirror_dir)
        def stop(*_):
            trainer.stopping = True
        signal.signal(signal.SIGINT, stop)
        signal.signal(signal.SIGTERM, stop)
        trainer.train()
    except StopRequested:
        trainer.status("stopped", note="Uncommitted generation discarded; resume starts from the last durable generation")
        trainer.sync_mirror()
    except Exception as error:
        if trainer:
            trainer.status("failed", error=str(error))
            trainer.sync_mirror()
        raise
    finally:
        lock.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
