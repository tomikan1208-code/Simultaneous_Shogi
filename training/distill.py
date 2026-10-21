"""Imitate external moves in a separate run; learn value from actual outcomes."""
from __future__ import annotations

import gzip
import argparse
import json
import os
from pathlib import Path
import shutil
import numpy as np

from .common import ROOT, atomic_json, load_config, read_json, rules_for, rules_hash, fingerprint
from .compatibility import file_hash
from .features import observation, actions
from .replay import ReplayBuffer
from .train import Trainer, StopRequested
from .teacher import TEACHER_FORMAT
from .session import validate_continuation


def load_demonstrations(path, config):
    """Only a completed game's real result supplies value labels.

    This is noisy behavior imitation, not an optimal-strategy target. USI cp,
    mate, resign and declaration-win messages never become variant results.
    """
    rules, buffer = rules_for(config), ReplayBuffer(config["replay_capacity"])
    pending, completed = {}, set()
    header, decisions = None, 0
    with (gzip.open(path, "rt", encoding="utf-8") if str(path).endswith(".gz") else Path(path).open(encoding="utf-8")) as stream:
        for line in stream:
            row = json.loads(line)
            if header is None:
                if row.get("type") != "header" or row.get("format") != TEACHER_FORMAT:
                    raise ValueError("Missing USI teacher header")
                if row["rules"] != rules or row["rules_hash"] != rules_hash(rules):
                    raise ValueError("Teacher data and destination must use identical current rules")
                header = row
                continue
            if row.get("type") == "decision":
                game = row["game"]
                state, side, choices = row["state"], row["side"], row["legal_actions"]
                if game in completed or side not in "AB" or len(side) != 1 or state["rules"] != rules or state["outcome"] is not None:
                    raise ValueError("Invalid teacher decision")
                if not choices or any(a["side"] != side for a in choices):
                    raise ValueError("Invalid teacher action set")
                index = choices.index(row["action"])
                indices, data, _ = actions(state, side, choices)
                target = np.zeros(len(choices), np.float32)
                target[index] = 1.
                sample = dict(board=observation(state, side), indices=indices, data=data, target=target)
                pending.setdefault(game, []).append((side, sample))
            elif row.get("type") == "game_result":
                game, outcome = row["game"], row["outcome"]
                if game in completed or not outcome or outcome["winner"] not in ("A", "B", "draw"):
                    raise ValueError("Invalid/duplicate completed game")
                completed.add(game)
                for side, sample in pending.pop(game, []):
                    value = 0. if outcome["winner"] == "draw" else 1. if outcome["winner"] == side else -1.
                    buffer.add(sample, value, generation=1, tactical=True)
                    decisions += 1
            else:
                raise ValueError("Unknown teacher record")
    if header is None or not buffer.rows:
        raise ValueError("No completed USI demonstrations; unfinished games and fallback moves are excluded")
    return buffer, dict(completed_games=len(completed), completed_decisions=decisions,
                       unique_samples=len(buffer.rows), discarded_unfinished=sum(map(len, pending.values())),
                       teacher=header)


def distill_run(data, source_run, output, updates=32, device="cpu", checkpoint_name="latest", config_path=None):
    source_run, output = Path(source_run).resolve(), Path(output).resolve()
    manifest = read_json(source_run / "manifest.json")
    saved_config = load_config(overrides=manifest['config'])
    config = load_config(config_path) if config_path else saved_config
    validate_continuation(config, saved_config)
    config = dict(config, device=device, updates=updates, workers=1, generations=0)
    buffer, evidence = load_demonstrations(data, config)
    filename = manifest["latest_checkpoint"] if checkpoint_name == "latest" else f"checkpoints/g{int(checkpoint_name):04d}.pt"
    checkpoint = (source_run / filename).resolve()
    if not checkpoint.is_relative_to(source_run):
        raise ValueError("Source checkpoint escapes its run")
    # Exclusive directory creation protects existing runs, including a running trainer.
    output.mkdir(parents=True, exist_ok=False)
    lock = output / "RUNNING"
    lock.write_text(str(os.getpid()), encoding="ascii")
    trainer = None
    try:
        trainer = Trainer(output, config, initial_checkpoint=checkpoint)
        trainer.buffer = buffer
        losses = trainer.optimize(1)
        trainer.generation = 1
        evidence.update(data_sha256=file_hash(data), adapter_sha256=fingerprint(), updates=updates, losses=losses,
                        method="behavior imitation + actual simultaneous-game result",
                        evaluated=False, improved_strength_is_established=False)
        trainer.manifest["external_distillation"] = evidence
        trainer.manifest["name"] = "USI教師からの追加学習（未評価）"
        trainer.manifest["evaluation_note"] = "External demonstration warm start; no strength evaluation or champion promotion performed"
        atomic_json(output / "evidence/usi-distillation.json", evidence)
        with (gzip.open(data, "rb") if str(data).endswith(".gz") else Path(data).open("rb")) as source, gzip.open(output / "evidence/usi-teacher.jsonl.gz", "wb") as dest:
            shutil.copyfileobj(source, dest)
        atomic_json(output / "evidence/usi-adapter-source.json", {
            p.name: p.read_text(encoding="utf-8") for p in Path(__file__).parent.glob("*.py")})
        trainer.commit_checkpoint()
        trainer.status("ready", note="USI demonstration weights saved in a separate run; evaluate before adoption", **losses)
    except StopRequested:
        if trainer:
            trainer.status('stopped', note='Distillation stopped; the initial committed weights remain available')
        return output
    except Exception as error:
        if trainer:
            trainer.status('failed', error=str(error))
        raise
    finally:
        lock.unlink(missing_ok=True)
    print(json.dumps(dict(run=str(output), samples=len(buffer.rows), **losses), ensure_ascii=False))
    return output


def main():
    parser = argparse.ArgumentParser(description='Distill completed external-engine demonstrations into a separate run')
    parser.add_argument('--data', required=True)
    parser.add_argument('--init-from', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--checkpoint', default='latest')
    parser.add_argument('--config', help='Optional current dashboard settings; rules and model shape must match the source')
    parser.add_argument('--updates', type=int, default=32)
    parser.add_argument('--device', default='cpu', choices=['cpu', 'cuda'])
    args = parser.parse_args()
    if not 1 <= args.updates <= 4096:
        parser.error('updates must be 1..4096')
    distill_run(args.data, args.init_from, args.output, args.updates, args.device, args.checkpoint, args.config)


if __name__ == '__main__':
    main()
