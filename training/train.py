from __future__ import annotations
import argparse
import json
from itertools import count
import math
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
from .model import Net, device_for, pack, autocast, predict, segmented_policy_loss
from .replay import ReplayBuffer
from .search import Searcher
from .candidates import canonical_order, SEARCH_PROTOCOL
from .storage import replace_file
from .balance_metrics import EvidenceWriter, GameTracker
from .session import prepare_resume, process_alive, validate_continuation


class StopRequested(Exception):
    pass


def planned_evaluations(config):
    total, interval = config["generations"], config["eval_every"]
    if total == 0:
        return None
    return total // interval + int(interval > 1) + int(total > 1 and total % interval != 0)


def evaluation_alpha(config, generation):
    planned = planned_evaluations(config)
    if planned is not None:
        return .05 / planned
    # Evaluation 1, then each interval. Sum 1/(i*(i+1)) over all i is 1,
    # so the total error budget stays at .05 even with no final generation.
    index = 1 + generation // config["eval_every"] - int(config["eval_every"] == 1)
    return .05 / (index * (index + 1))


def champion_pairs(config, generation):
    if config["generations"] != 0:
        return config["eval_pairs"]
    # Shrinking alpha must not make a win statistically impossible, even with
    # a perfect score. Only champion gates grow, logarithmically with time.
    minimum = math.floor(2 * math.log(2 / evaluation_alpha(config, generation))) + 1
    return max(config["eval_pairs"], minimum)


def configuration_history(previous, config, generation):
    history = list(previous.get('config_history', [])) if previous else []
    if not history:
        history.append(dict(from_generation=previous.get('initial_generation', 0) + 1 if previous else 1,
                            timestamp=previous['created'] if previous else time.time(),
                            config=previous['config'] if previous else dict(config), reason='initial'))
    saved = history[-1]['config']
    changes = {key: dict(before=saved.get(key), after=value)
               for key, value in config.items() if saved.get(key) != value}
    if changes:
        history.append(dict(from_generation=generation + 1, timestamp=time.time(), config=dict(config),
                            changes=changes, reason='resume_settings'))
    return history


class Trainer:
    def __init__(self, run, config, resume=False, mirror=None, initial_checkpoint=None, initial_config=None, state_from=None):
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
            validate_continuation(config, load_config(overrides=existing['config']))
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
            parent = None
            inherited_history = {}
            original = None
            if state_from:
                from .compatibility import file_hash
                source_run = Path(state_from).resolve()
                original = read_json(source_run/'manifest.json')
                if not original or original.get('schema') != SCHEMA or source_run == self.run:
                    raise ValueError('State continuation requires a separate run with the same model schema')
                lock = source_run/'RUNNING'
                if lock.exists() and process_alive(int(lock.read_text())):
                    raise ValueError('Stop the source training before continuing its state')
                source_config = load_config(overrides=original['config'])
                validate_continuation(config, source_config)
                initial_checkpoint = source_run/original['latest_checkpoint']
                if not initial_checkpoint.resolve().is_relative_to(source_run):
                    raise ValueError('The committed checkpoint must be inside its run')
                self.model, checkpoint = load_model(initial_checkpoint, source_config, self.device, original['source_fingerprint'])
                self.optimizer = torch.optim.AdamW(self.model.parameters(), lr=config['learning_rate'], weight_decay=1e-4)
                self.optimizer.load_state_dict(checkpoint['optimizer'])
                if self.scaler.is_enabled() and checkpoint['scaler']:
                    self.scaler.load_state_dict(checkpoint['scaler'])
                torch.set_rng_state(checkpoint['torch_rng'])
                if self.device.type == 'cuda' and checkpoint.get('cuda_rng'):
                    torch.cuda.set_rng_state_all(checkpoint['cuda_rng'])
                self.generation = checkpoint['generation']
                self.rng.bit_generator.state = read_json(source_run/original['rng_file'])
                self.buffer.load(source_run/original['replay_file'])
                parent = dict(run=str(source_run),checkpoint=original['latest_checkpoint'],
                              sha256=file_hash(initial_checkpoint),generation=self.generation,
                              source_fingerprint=original['source_fingerprint'],kind='state_continuation',
                              preserved=['model','optimizer','scaler','torch_rng','cuda_rng','numpy_rng','replay'],
                              previous_parent=original.get('parent'))
                history = sorted((source_run/'checkpoints').glob('g*.pt'))
                history = [p for p in history if 0<int(p.stem[1:])<self.generation]
                history = history[-(config['history_size']-1):] if config['history_size']>1 else []
                for path in history:
                    relative = 'checkpoints/'+path.name
                    origin = original.get('checkpoint_origins',{}).get(relative)
                    source_id = origin['source_fingerprint'] if origin else original['source_fingerprint']
                    if origin and file_hash(path) != origin['sha256']:
                        raise ValueError('Inherited historical checkpoint changed')
                    _, saved = load_model(path, source_config, torch.device('cpu'), source_id)
                    target = self.run/relative;target.parent.mkdir(parents=True,exist_ok=True)
                    shutil.copy2(path,target)
                    inherited_history[relative]=dict(source_fingerprint=saved['source_fingerprint'],sha256=file_hash(target))
                # Loading historical network objects consumes Torch RNG; restore it last.
                torch.set_rng_state(checkpoint['torch_rng'])
                if self.device.type == 'cuda' and checkpoint.get('cuda_rng'):
                    torch.cuda.set_rng_state_all(checkpoint['cuda_rng'])
                initial_checkpoint = None
            if initial_checkpoint:
                from .compatibility import file_hash, load_initial_weights
                inherited, checkpoint = load_initial_weights(initial_checkpoint, self.device)
                if inherited.channels != config["channels"]:
                    raise ValueError("Warm start must preserve the source model's channels")
                self.model.load_state_dict(inherited.state_dict())
                parent = dict(checkpoint=str(Path(initial_checkpoint).resolve()), sha256=file_hash(initial_checkpoint),
                              generation=checkpoint["generation"], schema=checkpoint["schema"],
                              source_fingerprint=checkpoint["source_fingerprint"], rules_hash=checkpoint["rules_hash"], kind='weights_only')
            planned_gates = planned_evaluations(config)
            self.manifest = {"format": FORMAT, "schema": SCHEMA, "name": original['name'] if original else self.run.name, "created": time.time(),
                             "source_fingerprint": self.source, "rules": rules_for(config), "rules_hash": rules_hash(rules_for(config)),
                             "config": config, "hardware": hardware(self.device), "generation": 0,
                             "champion_checkpoint": f"checkpoints/g{self.generation:04d}.pt", "champion_generation": self.generation,
                             "evaluation_note": "Self-play and recent learned checkpoints only; fixed policies and the initial model are excluded",
                             "evaluation_protocol": "learned-only-v1", "initial_generation": original.get('initial_generation', 0) if original else self.generation,
                             "checkpoint_origins": inherited_history,
                             "config_history": configuration_history(original, config, self.generation),
                             "planned_gates": planned_gates, "gate_alpha": .05 / planned_gates if planned_gates else None,
                             "gate_schedule": "fixed-plan" if planned_gates else "summable-alpha"}
            if parent:
                self.manifest["parent"] = parent
            if fingerprint() != self.source:
                raise RuntimeError("Training sources changed during initialization. Restart after edits settle.")
            with zipfile.ZipFile(self.run / "source.zip", "w", zipfile.ZIP_DEFLATED) as snapshot:
                files = source_files() + [ROOT / "training/colab.ipynb", ROOT / "training/README.md"]
                for path in files:
                    if path.is_file():
                        snapshot.write(path, path.relative_to(ROOT).as_posix())
            self.commit_checkpoint()
        self.manifest['config_history'] = configuration_history(self.manifest, config, self.generation)
        self.manifest['search_protocol'] = SEARCH_PROTOCOL
        self.manifest['config'] = dict(config)
        planned_gates = planned_evaluations(config)
        self.manifest.update(planned_gates=planned_gates, gate_alpha=.05 / planned_gates if planned_gates else None,
                             gate_schedule='fixed-plan' if planned_gates else 'summable-alpha')
        self.manifest["last_hardware"] = hardware(self.device)
        atomic_json(self.run / "manifest.json", self.manifest)

    def status(self, phase, **extra):
        value = {"format": FORMAT, "phase": phase, "generation": self.generation,
                 "target_generations": self.config["generations"], "updated": time.time(), "device": str(self.device),
                 "samples": len(self.buffer.rows), **extra}
        atomic_json(self.run / "status.json", value)
        print(json.dumps(value, ensure_ascii=False), flush=True)

    def load_checkpoint(self, path):
        from .compatibility import file_hash
        relative = Path(path).relative_to(self.run).as_posix()
        origin = self.manifest.get('checkpoint_origins',{}).get(relative)
        if origin and file_hash(path) != origin['sha256']:
            raise ValueError('Inherited checkpoint identity changed')
        return load_model(path,self.config,self.device,origin['source_fingerprint'] if origin else self.source)

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
        replace_file(path.with_suffix(".tmp"), path)
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
            replace_file(temp, dest)

    def self_play(self, pool, generation):
        evidence = None
        if self.config.get("balance_logging"):
            from .compatibility import file_hash
            evidence = EvidenceWriter(self.run / "evidence" / f"g{generation:04d}", dict(
                phase="adaptive_training", generation=generation, model_generation=generation-1, search_protocol=SEARCH_PROTOCOL,
                model_sha256=file_hash(self.run / self.manifest["latest_checkpoint"]),
                source_fingerprint=self.source, rules_hash=self.manifest["rules_hash"], rules=rules_for(self.config),
                seed=self.config["seed"], config=self.config, parent=self.manifest.get("parent")))
        try:
            stats = self._self_play(pool, generation, evidence)
            if evidence:
                stats["balance"] = evidence.finish()
            return stats
        finally:
            if evidence:
                evidence.close()

    def _self_play(self, pool, generation, evidence=None):
        config = self.config
        searcher = Searcher(pool, self.model, config, self.device, generation)
        self.model.eval()
        initial = self.manifest.get('initial_generation',0)
        history = [p for p in (self.run / "checkpoints").glob("g*.pt") if 0 < int(p.stem[1:]) <= self.generation and int(p.stem[1:]) != initial]
        history = sorted(history, key=lambda p: int(p.stem[1:]))[-config["history_size"]:]
        old, history_checkpoint = None, None
        if history and config["history_fraction"] > 0:
            history_checkpoint = history[int(self.rng.integers(len(history)))]
            old, _ = self.load_checkpoint(history_checkpoint)
        completed, total_rounds, all_events, all_captures, outcomes = 0, 0, {}, {}, []
        start, new_samples, history_games, probes_saved = time.perf_counter(), 0, 0, 0
        for first in range(0, config["games_per_generation"], config["environments"]):
            pool.reset(min(config["environments"], config["games_per_generation"] - first), rules_for(config))
            rows = pool.call("observe")
            trajectories, rngs, roles, game_ids, trackers = {}, {}, {}, {}, {}
            for i, row in enumerate(rows):
                identity, game_id = key(row), first + i
                trajectories[identity] = []
                game_ids[identity] = game_id
                rngs[identity] = [np.random.default_rng(np.random.SeedSequence([config["seed"], generation, game_id, s])) for s in range(2)]
                roles[identity] = int(self.rng.integers(2)) if old and self.rng.random() < config["history_fraction"] else None
                history_games += roles[identity] is not None
                if evidence:
                    trackers[identity] = GameTracker(game_id, dict(generation=generation, history_side=roles[identity], round_limit=config["round_limit"]))
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
                        _, prior = canonical_order(sample, scores + searcher.bootstrap * heuristic_prior(sample["data"]))
                        actual_index = int(rngs[key(choice)][role].choice(len(prior), p=prior))
                        choice["actions"][role] = sample["actions"][actual_index]
                        choice['sampling_strategies'][role] = None  # Replaced by the historical prior below.
                        choice["history_policy"] = dict(side=role, checkpoint=history_checkpoint.name,
                                                       actual_probability=float(prior[actual_index]), legal_action_count=len(prior),
                                                       note="Historical side samples its full prior; the root search strategy for that side is not used")
                selected_map = {key(r): r for r in chosen}
                items = [{"_engine": c["_engine"], "env": c["env"], "actions": c["actions"], "replay": bool(evidence) or game_ids[key(c)] < 2} for c in chosen]
                roots = {key(row): row for row in rows}
                for result in pool.call("step", items):
                    identity = key(result)
                    if evidence:
                        evidence.write(trackers[identity].observe(roots[identity], result, selected_map[identity]["actions"], selected_map[identity]))
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
                        if evidence:
                            evidence.games.append(trackers[identity].finish())
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
                "events": all_events, "captures": all_captures, "outcomes": outcomes, "search": searcher.timing,
                "search_protocol": SEARCH_PROTOCOL}

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
                policy_loss = segmented_policy_loss(logits, targets, owners, len(counts))
                value_loss = torch.nn.functional.mse_loss(values.float(), value_targets)
                loss = policy_loss + value_loss
            self.scaler.scale(loss).backward()
            self.scaler.unscale_(self.optimizer)
            torch.nn.utils.clip_grad_norm_(self.model.parameters(), 1.)
            self.scaler.step(self.optimizer)
            self.scaler.update()
            losses.append(torch.stack([policy_loss.detach(), value_loss.detach()]))
            if update % 16 == 0:
                self.status("optimizing", generation=generation, update=update, target_updates=self.config["updates"])
        self.model.eval()
        policy_loss, value_loss = torch.stack(losses).mean(0).cpu().tolist()
        return {"policy_loss": policy_loss, "value_loss": value_loss,
                "seconds": time.perf_counter() - start, "updates": len(losses), "presentations": len(losses) * self.config["batch_size"]}

    def train(self, until_generation=None):
        if until_generation is not None and until_generation <= self.generation:
            raise ValueError('The stopping generation must exceed the committed generation')
        if self.config['generations'] and self.config['generations'] <= self.generation:
            raise ValueError('The generation limit must exceed the committed generation, or be 0 for continuous training')
        if until_generation is not None and self.config['generations'] and until_generation > self.config['generations']:
            raise ValueError('The stopping generation exceeds the configured generation limit')
        self.status("initializing")
        with EnginePool(self.config["workers"]) as pool:
            generations = count(self.generation + 1) if self.config["generations"] == 0 else range(self.generation + 1, self.config["generations"] + 1)
            for generation in generations:
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
                should_evaluate = generation == 1 or generation == self.config["generations"] or generation % self.config["eval_every"] == 0 or generation == until_generation
                if should_evaluate:
                    evaluations.append(paired_match(pool,self.model,self.model,self.config,self.device,generation,'adapted_self',
                                                   self.config['eval_pairs'],self.config['eval_seed']+1_000_003+generation*10007,
                                                   self.run/'evaluations'/f'g{generation:04d}',progress=progress))
                    initial = self.manifest.get('initial_generation',0)
                    previous = sorted(p for p in (self.run/'checkpoints').glob('g*.pt')
                                      if 0<int(p.stem[1:])<generation and int(p.stem[1:])!=initial)
                    if previous:
                        # Keep the same learned reference within each 25-generation window.
                        anchor = ((generation-1)//25)*25
                        reference = min(previous,key=lambda p:(abs(int(p.stem[1:])-anchor),int(p.stem[1:])))
                        other, saved = self.load_checkpoint(reference)
                        result = paired_match(pool,self.model,other,self.config,self.device,generation,'recent_checkpoint',
                                              self.config['eval_pairs'],self.config['eval_seed']+generation*10007,
                                              self.run/'evaluations'/f'g{generation:04d}',progress=progress)
                        result['reference_generation']=saved['generation']
                        atomic_json(self.run/'evaluations'/f'g{generation:04d}/recent_checkpoint.json',result)
                        evaluations.append(result)
                if promoted:
                    self.manifest.update(champion_checkpoint=f"checkpoints/g{generation:04d}.pt", champion_generation=generation)
                record = {"generation": generation, "timestamp": time.time(), "seconds": time.perf_counter() - started,
                          "self_play": play, "optimization": optimize, "evaluation": evaluations,
                          "promoted": promoted, "replay_size": len(self.buffer.rows), "duplicates_replaced": self.buffer.duplicates,
                          "source_fingerprint": self.source, "rules_hash": self.manifest["rules_hash"], "hardware": hardware(self.device),
                          "config": dict(self.config)}
                atomic_json(self.run / "generations" / f"g{generation:04d}.json", record)
                self.generation = generation
                self.commit_checkpoint()
                self.status("generation_complete", promoted=promoted)
                if until_generation is not None and generation >= until_generation:
                    break
        self.status("complete")
        self.sync_mirror()


def main():
    parser = argparse.ArgumentParser(description="Colab-first simultaneous-shogi self-play training")
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--config")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--resume", action="store_true")
    mode.add_argument("--init-from", help="Start a new run with the latest weights of this run directory; optimizer/replay start fresh")
    mode.add_argument('--continue-from',help='Continue full saved state in a new run with the current source and evaluation protocol')
    parser.add_argument("--until-generation", type=int, help="Runtime scheduling boundary; does not change training semantics")
    parser.add_argument("--mirror-dir", help="Copy durable generation snapshots to Drive; train on local scratch")
    parser.add_argument("--smoke", action="store_true", help="Short CPU integration run; never evidence of strength")
    parser.add_argument('--prepare-only',action='store_true',help='Save the inherited state without running more generations')
    args = parser.parse_args()
    if args.resume:
        existing = read_json(Path(args.run_dir)/'manifest.json')
        if existing and existing['source_fingerprint'] != fingerprint():
            from .launch import main as launch
            launch()
            return
    base = read_json(Path(args.run_dir)/'manifest.json') if args.resume else read_json(Path(args.continue_from)/'manifest.json') if args.continue_from else None
    saved_config = base['config'] if base and not args.config else None
    config = load_config(args.config, {"generations": 1, "games_per_generation": 2, "environments": 2, "workers": 1,
                                     "candidates": 3, "cheap_candidates": 2, "regret_iterations": 32, "updates": 2,
                                     "batch_size": 8, "eval_pairs": 1, "round_limit": 12, "channels": 8, "device": "cpu"} if args.smoke else saved_config)
    if args.continue_from and not args.config:
        config = dict(config,generations=0)
    initial_checkpoint, initial_config = None, None
    if args.init_from:
        source_run = Path(args.init_from).resolve()
        manifest = read_json(source_run / "manifest.json")
        if not manifest or manifest.get("format") != FORMAT:
            parser.error("--init-from must point to a training run with a valid manifest")
        initial_checkpoint = (source_run / manifest["latest_checkpoint"]).resolve()
        if not initial_checkpoint.is_relative_to(source_run):
            parser.error("The source checkpoint must be inside --init-from")
        initial_config = load_config(overrides=manifest["config"])
    run = Path(args.run_dir).resolve()
    run.mkdir(parents=True, exist_ok=True)
    if args.resume:
        prepare_resume(run)
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
        trainer = Trainer(run, config, args.resume, args.mirror_dir,
                          initial_checkpoint=initial_checkpoint, initial_config=initial_config,state_from=args.continue_from)
        def stop(*_):
            trainer.stopping = True
        signal.signal(signal.SIGINT, stop)
        signal.signal(signal.SIGTERM, stop)
        if args.prepare_only:
            trainer.status('ready',note='Saved state is ready; resume starts at the next generation')
        else:
            trainer.train(args.until_generation)
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
