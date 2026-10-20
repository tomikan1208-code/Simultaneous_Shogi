"""Seeded self-play + real CUDA/CPU updates, optionally paired evaluation.

--root can select the frozen original source for alternating before/after runs.
Each measurement uses a new run directory and leaves the source run untouched.
"""
import argparse
import cProfile
import contextlib
import hashlib
import io
import json
from pathlib import Path
import pstats
import sys
import time

parser = argparse.ArgumentParser()
parser.add_argument('--root', default=str(Path(__file__).resolve().parents[1]))
parser.add_argument('--run', required=True)
parser.add_argument('--checkpoint', required=True)
parser.add_argument('--device', default='cuda')
parser.add_argument('--balance')
parser.add_argument('--evidence', action='store_true')
parser.add_argument('--games', type=int, default=16)
parser.add_argument('--eval-pairs', type=int, default=0)
parser.add_argument('--generation', type=int, help='Seed/schedule generation; defaults to source checkpoint generation + 1')
parser.add_argument('--profile', action='store_true')
args = parser.parse_args()
sys.path.insert(0, str(Path(args.root).resolve()))
import numpy as np
import torch
from training.common import load_config, hardware, fingerprint, rules_for
from training.engine import EnginePool
from training.train import Trainer
from training.evaluate import paired_match
from training.rules import balance_for
from training.compatibility import network_hash

config = load_config(overrides=dict(generations=1, games_per_generation=args.games,
    history_fraction=0, bootstrap_weight=0., device=args.device,
    balance=balance_for(args.balance) if args.balance else None, balance_logging=args.evidence))
initial_config = load_config(overrides=dict(device=args.device))
source_checkpoint = torch.load(args.checkpoint, map_location='cpu', weights_only=True)
generation = args.generation if args.generation is not None else source_checkpoint['generation'] + 1
profiler = cProfile.Profile()
with contextlib.redirect_stdout(io.StringIO()):
    trainer = Trainer(args.run, config, initial_checkpoint=args.checkpoint, initial_config=initial_config)
    initial_weights = network_hash(trainer.model)
    with EnginePool(config['workers']) as pool:
        # Warm CUDA and native geometry, outside the measured interval.
        pool.reset(config['environments'], rules_for(config))
        from training.search import Searcher
        rows = pool.call('observe')
        rngs = {(r['_engine'],r['env']):[np.random.default_rng(7),np.random.default_rng(8)] for r in rows}
        Searcher(pool,trainer.model,config,trainer.device,generation).search(rows,rngs)
        if trainer.device.type == 'cuda':
            torch.cuda.synchronize()
        start=time.perf_counter()
        if args.profile:
            profiler.enable()
        play=trainer.self_play(pool,generation)
        optimize=trainer.optimize(generation)
        if args.profile:
            profiler.disable()
        if trainer.device.type == 'cuda':
            torch.cuda.synchronize()
        elapsed=time.perf_counter()-start
        # Fixed weights, same seed and budget, separate from the trained model.
        evaluation = None
        if args.eval_pairs:
            from training.evaluate import load_model
            fixed, _ = load_model(args.checkpoint, initial_config, trainer.device)
            evaluation = paired_match(pool, fixed, fixed, config, trainer.device, generation,
                'same_weights', args.eval_pairs, config['eval_seed'], Path(args.run)/'evaluation')
digest=hashlib.sha256()
trainer.buffer.save(Path(args.run)/'measured-replay.npz')
for row in trainer.buffer.rows:
    for name in ['board','indices','data','target']:
        digest.update(row[name].tobytes())
    digest.update(str(row['value']).encode())
result=dict(format='simultaneous-shogi/training-benchmark-v1', root=str(Path(args.root).resolve()),source_fingerprint=fingerprint(), config=config,
    hardware=hardware(trainer.device),seconds=elapsed,self_play=play,optimization=optimize,
    replay_sha256=digest.hexdigest(), evaluation=evaluation, generation=generation,
    checkpoint_sha256=hashlib.sha256(Path(args.checkpoint).read_bytes()).hexdigest(),
    weights_updated=network_hash(trainer.model) != initial_weights,
    finite_weights=all(bool(torch.isfinite(tensor).all()) for tensor in trainer.model.state_dict().values()))
out=Path(args.run)/'benchmark.json'
out.write_text(json.dumps(result,indent=2),encoding='utf-8')
if args.profile:
    stats=io.StringIO()
    pstats.Stats(profiler,stream=stats).strip_dirs().sort_stats('cumulative').print_stats(45)
    (Path(args.run)/'profile.txt').write_text(stats.getvalue(),encoding='utf-8')
    print(stats.getvalue())
print(json.dumps({k:v for k,v in result.items() if k not in ['config','self_play','hardware']},indent=2))
print(json.dumps({k:v for k,v in play.items() if k not in ['outcomes','events','captures']},indent=2))
