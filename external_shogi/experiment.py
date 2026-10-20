"""Color-swapped matches and explicitly imperfect USI demonstrations."""
from __future__ import annotations

import json
from pathlib import Path
import time
import numpy as np
import torch

from training.common import ROOT, atomic_json, fingerprint, hardware, rules_for, rules_hash
from training.compatibility import file_hash
from training.engine import EnginePool, key
from training.evaluate import interval
from training.search import Searcher
from .adapter import ExternalOpponent

TEACHER_FORMAT = "simultaneous-shogi/usi-teacher-v1"


def adapter_hash():
    import hashlib
    digest = hashlib.sha256()
    for path in sorted(Path(__file__).parent.glob("*.py")):
        digest.update(path.name.encode())
        digest.update(path.read_bytes().replace(b"\r\n", b"\n"))
    return digest.hexdigest()


def match(engine, config, output, pairs=2, seed=719005, nodes=2000,
          model=None, generation=0, model_identity=None, baseline="hunter", weights=None):
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    opponent = ExternalOpponent(engine, nodes)
    rules = rules_for(config)
    metadata = dict(format=TEACHER_FORMAT, rules=rules, rules_hash=rules_hash(rules),
                    source_fingerprint=fingerprint(), adapter_sha256=adapter_hash(),
                    engine=dict(name=engine.name, executable=engine.command[0],
                                executable_sha256=file_hash(engine.command[0]), options=engine.applied_options,
                                weights_sha256=file_hash(weights) if weights else None),
                    nodes_per_query=nodes, seed=seed, pairs=pairs, config=config,
                    model=model_identity, baseline=baseline if model is None else None,
                    teacher_is_optimal_for_variant=False,
                    nonpromotion_mapping="upgrade if eligible, otherwise none",
                    fallback="native hunter; excluded from teacher decisions",
                    value_target="actual simultaneous-game outcome; USI scores are advisory only",
                    hardware=hardware(torch.device(config["device"])))
    atomic_json(output / "environment.json", metadata)
    atomic_json(output / "adapter-source.json", {
        p.name: p.read_text(encoding="utf-8") for p in Path(__file__).parent.glob("*.py")})
    started, games = time.perf_counter(), []
    with (output / "teacher.jsonl").open("x", encoding="utf-8") as teacher, EnginePool(1) as pool:
        def write(record):
            teacher.write(json.dumps(record, ensure_ascii=False, allow_nan=False) + "\n")
            teacher.flush()
        write(dict(type="header", **metadata))
        searcher = Searcher(pool, model, config, torch.device(config["device"]), generation) if model is not None else None
        for pair in range(pairs):
            for swapped in (False, True):
                learner_side = int(swapped)
                side = "AB"[1 - learner_side]
                game_id = pair * 2 + int(swapped)
                pool.reset(1, rules)
                rows = pool.call("observe")
                rngs = {key(rows[0]): [np.random.default_rng(np.random.SeedSequence([seed, pair, s ^ learner_side]))
                                      for s in range(2)]}
                fallback_rng = np.random.default_rng(np.random.SeedSequence([seed, pair, 20]))
                baseline_rng = np.random.default_rng(np.random.SeedSequence([seed, pair, 99]))
                before = opponent.counts.copy()
                while rows:
                    row = rows[0]
                    if searcher:
                        own = searcher.search(rows, rngs)[0]["actions"][learner_side]
                    else:
                        own = pool.call("baseline", [dict(_engine=row["_engine"], env=row["env"], side="AB"[learner_side],
                                                        policy=baseline, seed=int(baseline_rng.integers(0, 2**63)))])[0]["action"]
                    # Neither player receives the other's current commitment.
                    external = opponent.choose(pool, row, side, fallback_rng)
                    if external["source"] == "usi":
                        write(dict(type="decision", game=game_id, pair=pair, swapped=swapped, side=side,
                                   state={k: row[k] for k in ("position", "rules", "round", "repetition", "outcome")},
                                   legal_actions=row["actions"][1 - learner_side], action=external["action"],
                                   sfen=external["sfen"], analysis=external["analysis"], mapped_move=external["mapped_move"]))
                    actions = [own, external["action"]] if learner_side == 0 else [external["action"], own]
                    result = pool.call("step", [dict(_engine=row["_engine"], env=row["env"], actions=actions, replay=True)])[0]
                    if result["outcome"]:
                        winner = result["outcome"]["winner"]
                        score = .5 if winner == "draw" else float(winner == "AB"[learner_side])
                        counts = opponent.counts - before
                        game = dict(game=game_id, pair=pair, swapped=swapped, learner_side="AB"[learner_side],
                                    score=score, rounds=result["round"], outcome=result["outcome"],
                                    adapter_counts=dict(counts))
                        games.append(game)
                        write(dict(type="game_result", **game))
                        atomic_json(output / f"game-{game_id:04d}.json", dict(label=f"USI / pair {pair} / model {'AB'[learner_side]}", replay=result["replay"]))
                        print(json.dumps(dict(completed=len(games), total=pairs * 2, **game), ensure_ascii=False), flush=True)
                    rows = pool.call("observe")
    pair_scores = [sum(g["score"] for g in games if g["pair"] == p) / 2 for p in range(pairs)]
    score = float(np.mean(pair_scores))
    ci = interval(pair_scores)
    results = dict(format="simultaneous-shogi/usi-match-v1", model=model_identity, baseline=baseline if model is None else None,
                   engine=metadata["engine"], rules=rules, rules_hash=metadata["rules_hash"], pairs=pairs,
                   games=len(games), seed=seed, wins=sum(g["score"] == 1 for g in games),
                   draws=sum(g["score"] == .5 for g in games), losses=sum(g["score"] == 0 for g in games),
                   score=score, interval=ci, confidence=.95,
                   interval_method="Hoeffding on independent color-swapped pairs",
                   decision="better" if ci[0] > .5 else "worse" if ci[1] < .5 else "inconclusive",
                   adapter=opponent.stats(), seconds=time.perf_counter() - started,
                   search=searcher.timing if searcher else None, results=games,
                   budget=dict(nodes_per_usi_query=nodes, model_candidates=config["candidates"],
                               regret_iterations=config["regret_iterations"], equal_wall_time=False))
    atomic_json(output / "result.json", results)
    return results
