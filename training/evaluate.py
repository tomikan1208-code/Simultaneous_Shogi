"""Paired, seeded, fixed-budget evaluation. Pair is the statistical unit."""
from __future__ import annotations
import argparse
from collections import Counter
from contextlib import nullcontext
import math
from pathlib import Path
import time
import numpy as np
import torch
from .common import ROOT, SCHEMA, LEGACY_SCHEMA, FORMAT, atomic_json, read_json, fingerprint, rules_for, rules_hash, load_config, hardware
from .compatibility import legacy_official_hash_valid, expanded_weights
from .engine import EnginePool, key
from .model import Net, device_for
from .search import Searcher
from .balance_metrics import EvidenceWriter, GameTracker
from .compatibility import network_hash
from .candidates import SEARCH_PROTOCOL
from .external import ExternalOpponent, external_opponent, count_decision
from .teacher import TeacherWriter


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
    if checkpoint.get("schema") not in [SCHEMA, LEGACY_SCHEMA] or checkpoint.get("format") != FORMAT:
        raise ValueError("Unsupported checkpoint schema")
    if source is not None and checkpoint["source_fingerprint"] != source:
        raise ValueError("Source fingerprint differs; use the source bundle that created this run")
    if checkpoint["rules_hash"] != rules_hash(rules_for(config)) and not legacy_official_hash_valid(path, checkpoint, rules_for(config)):
        raise ValueError("Rule fingerprint differs; evaluations cannot mix rules/limits")
    model = Net(checkpoint["channels"]).to(device)
    model.load_state_dict(expanded_weights(checkpoint["model"], model))
    model.eval()
    return model, checkpoint


def paired_match(pool, model, opponent, config, device, generation, label, pairs, seed, out_dir=None, alpha=.05, progress=None):
    evidence = EvidenceWriter(Path(out_dir) / f"{label}-evidence", dict(
        phase="paired_evaluation", generation=generation, label=label, rules=rules_for(config),
        rules_hash=rules_hash(rules_for(config)), source_fingerprint=fingerprint(), seed=seed, pairs=pairs,
        model_weights_sha256=network_hash(model), opponent_weights_sha256=network_hash(opponent) if isinstance(opponent,Net) else opponent.identity if isinstance(opponent, ExternalOpponent) else opponent,
        config=config)) if config.get("balance_logging") and out_dir else None
    teacher = TeacherWriter(Path(out_dir) / f'{label}-teacher.jsonl.gz', dict(
        phase='evaluation', generation=generation, rules=rules_for(config), rules_hash=rules_hash(rules_for(config)),
        source_fingerprint=fingerprint(), engine=opponent.identity, seed=seed, pairs=pairs,
        teacher_is_optimal_for_variant=False, value_target='actual completed simultaneous-game outcome')) if (
            isinstance(opponent, ExternalOpponent) and out_dir and config.get('external_ai_save_teacher', True)) else None
    try:
        result = _paired_match(pool, model, opponent, config, device, generation, label, pairs, seed, out_dir, alpha, progress, evidence, teacher)
        if teacher:
            summary = teacher.finish()
            result['teacher'] = dict(file=teacher.path.name, games=summary['games'], decisions=summary['decisions'])
            atomic_json(Path(out_dir) / f'{label}.json', result)
        return result
    finally:
        if evidence:
            evidence.close()
        if teacher:
            teacher.close()


def _paired_match(pool, model, opponent, config, device, generation, label, pairs, seed, out_dir, alpha, progress, evidence, teacher=None):
    started = time.perf_counter()
    all_games, events, captures, representative = [], {}, {}, []
    searcher = Searcher(pool, model, config, device, generation)
    other_searcher = Searcher(pool, opponent, config, device, generation) if isinstance(opponent, Net) else None
    external = opponent if isinstance(opponent, ExternalOpponent) else None
    external_counts = {}
    # Never split a pair between waves. Streams follow policy roles on a color swap.
    pairs_per_wave = max(1, config["environments"] // 2)
    for first in range(0, pairs, pairs_per_wave):
        batch_pairs = min(pairs_per_wave, pairs - first)
        pool.reset(batch_pairs * 2, rules_for(config))
        rows = pool.call("observe")
        identities, rngs, opponent_rngs, baseline_rngs, trackers = {}, {}, {}, {}, {}
        for i, row in enumerate(rows):
            pair, swapped = first + i // 2, bool(i % 2)
            model_side = int(swapped)
            identities[key(row)] = (pair, swapped, model_side)
            if evidence:
                trackers[key(row)] = GameTracker(pair*2+int(swapped), dict(pair=pair, swapped=swapped, model_side=model_side,
                                                                        round_limit=config["round_limit"]))
            streams = [np.random.default_rng(np.random.SeedSequence([seed, pair, role])) for role in range(2)]
            rngs[key(row)] = [streams[s ^ model_side] for s in range(2)]
            opponent_rngs[key(row)] = [np.random.default_rng(np.random.SeedSequence([seed, pair, 20 + (s ^ model_side)])) for s in range(2)]
            baseline_rngs[key(row)] = np.random.default_rng(np.random.SeedSequence([seed, pair, 99]))
            external_counts[key(row)] = Counter()
        while rows:
            choices = {key(r): r for r in searcher.search(rows, rngs)}
            if other_searcher:
                other = {key(r): r for r in other_searcher.search(rows, opponent_rngs)}
            elif external:
                other = {}
                for row in rows:
                    identity = key(row)
                    pair, swapped, model_side = identities[identity]
                    decision = external.choose(pool, row, 'AB'[1-model_side], baseline_rngs[identity])
                    other[identity] = decision
                    count_decision(external_counts[identity], decision)
                    if teacher:
                        teacher.decision(pair * 2 + int(swapped), row, 'AB'[1-model_side], decision)
                    if progress:
                        progress(len(all_games), pairs * 2, label)
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
                items.append({"_engine": identity[0], "env": identity[1], "actions": selected, "replay": bool(evidence) or pair == 0})
            roots = {key(row): row for row in rows}
            actual = {key(item): item["actions"] for item in items}
            decisions = {}
            for identity, choice in choices.items():
                decision = dict(choice, selected=[list(x) for x in choice["selected"]], strategies=list(choice["strategies"]),
                                sampling_strategies=list(choice['sampling_strategies']),coverage=list(choice['coverage']))
                if other_searcher:
                    opponent_side = 1-identities[identity][2]
                    decision["selected"][opponent_side] = other[identity]["selected"][opponent_side]
                    decision["strategies"][opponent_side] = other[identity]["strategies"][opponent_side]
                    decision['sampling_strategies'][opponent_side] = other[identity]['sampling_strategies'][opponent_side]
                    decision['coverage'][opponent_side] = other[identity]['coverage'][opponent_side]
                    decision["opponent_gap"] = other[identity]["gap"]
                elif external:
                    opponent_side = 1-identities[identity][2]
                    decision['sampling_strategies'][opponent_side] = None
                    decision['external_policy'] = dict(side=opponent_side, opponent_id=external.identity['id'],
                                                       source=other[identity]['source'], reason=other[identity].get('reason'))
                decisions[identity] = decision
            for result in pool.call("step", items):
                if evidence:
                    evidence.write(trackers[key(result)].observe(roots[key(result)], result, actual[key(result)], decisions[key(result)]))
                for name, count in result["metrics"].items():
                    events[name] = events.get(name, 0) + count
                for capture in result["captures"]:
                    name = capture["reason"] + ":" + capture["kind"]
                    captures[name] = captures.get(name, 0) + 1
                if result["outcome"]:
                    if evidence:
                        evidence.games.append(trackers[key(result)].finish())
                    pair, swapped, side = identities[key(result)]
                    winner = result["outcome"]["winner"]
                    score = .5 if winner == "draw" else float(winner == ["A", "B"][side])
                    all_games.append({"pair": pair, "swapped": swapped, "score": score, "rounds": result["round"], "outcome": result["outcome"],
                                      "model_side": 'AB'[side], **({'adapter_counts': dict(external_counts[key(result)])} if external else {})})
                    if teacher:
                        teacher.result(pair * 2 + int(swapped), result['outcome'])
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
               "budget": dict({k: config[k] for k in ["candidates", "regret_iterations", "round_limit", "bootstrap_weight", "bootstrap_generations"]},
                              search_protocol=SEARCH_PROTOCOL,repetition_candidate_multiplier=2,training_exploration=0)}
    results.update(win_rate=results['wins']/results['games'], draw_rate=results['draws']/results['games'],
                   loss_rate=results['losses']/results['games'])
    if external:
        results.update(engine=external.identity, opponent_id=external.identity['id'], opponent_name=external.identity['name'],
                       adapter=external.stats())
        results['budget'].update(external_ai_nodes=external.nodes, equal_wall_time=False)
    if evidence:
        results["balance"] = evidence.finish()
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
    parser.add_argument("--opponent", default="adapted_self", choices=["adapted_self","recent_checkpoint","external_usi","hunter", "defense", "upgrade", "random", "champion"])
    parser.add_argument('--nodes', type=int, help='Override the external engine node budget')
    parser.add_argument("--pairs", type=int, default=32)
    parser.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda"])
    args = parser.parse_args()
    if not 1 <= args.pairs <= 4096:
        parser.error("pairs must be 1..4096")
    run = Path(args.run_dir).resolve()
    manifest = read_json(run / "manifest.json")
    config = load_config(overrides=dict(manifest["config"], device=args.device, **({'external_ai_nodes': args.nodes} if args.nodes is not None else {})))
    torch.set_num_threads(max(1, min(4, config["workers"])))
    device = device_for(config)
    filename = manifest["latest_checkpoint"] if args.checkpoint == "latest" else f"checkpoints/g{int(args.checkpoint):04d}.pt"
    model, ckpt = load_model(run / filename, config, device, fingerprint())
    opponent = args.opponent
    reference_generation = None
    if opponent == 'adapted_self':
        opponent = model
    elif opponent == 'recent_checkpoint':
        previous = sorted(p for p in (run/'checkpoints').glob('g*.pt') if 0<int(p.stem[1:])<ckpt['generation'] and int(p.stem[1:])!=manifest.get('initial_generation',0))
        if not previous:parser.error('No prior learned checkpoint is available; use adapted_self')
        path=previous[-1]
        origin=manifest.get('checkpoint_origins',{}).get(path.relative_to(run).as_posix())
        if origin:
            from .compatibility import file_hash
            if file_hash(path)!=origin['sha256']:raise ValueError('Inherited checkpoint changed')
        opponent, saved=load_model(path,config,device,origin['source_fingerprint'] if origin else fingerprint())
        reference_generation=saved['generation']
    if opponent == "champion":
        opponent, _ = load_model(run / manifest["champion_checkpoint"], config, device, fingerprint())
    stamp = str(int(time.time()))
    with EnginePool(config["workers"]) as pool, (external_opponent(config, force=True) if opponent == 'external_usi' else nullcontext(None)) as external:
        if external:
            opponent = external
        results = paired_match(pool, model, opponent, config, device, ckpt["generation"], args.opponent,
                               args.pairs, config["eval_seed"], run / "local-evaluations" / stamp)
    if reference_generation is not None:
        results['reference_generation']=reference_generation
        atomic_json(run/'local-evaluations'/stamp/f'{args.opponent}.json',results)
    atomic_json(run / "local-evaluations" / stamp / "environment.json", hardware(device))
    print(f"Score {results['score']:.3f}, interval {results['interval']}, {results['decision']}")


if __name__ == "__main__":
    main()
