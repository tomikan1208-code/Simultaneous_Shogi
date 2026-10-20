"""Guard the numerical/game semantics of the accelerated training path."""
import copy
import contextlib
import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import numpy as np
import torch

import reference_features as reference
from training.common import ROOT, load_config, rules_for, atomic_json, read_json
from training.engine import EnginePool, key
from training.features import actions, observation, observation_pair, compact_observations
from training.model import segmented_policy_loss
from training.rules import balance_for, PRESETS
from training.search import regret_match, Searcher
from training.model import Net
from training.train import Trainer, main


class PerformanceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        torch.set_num_threads(2)
        cls.config = load_config(overrides=dict(device='cpu', channels=8, candidates=4, cheap_candidates=2))

    def test_ray_masks_descriptors_and_compact_observations_match_frozen_encoder(self):
        rng = np.random.default_rng(3402)
        compared = 0
        with EnginePool(2) as pool:
            for label in PRESETS:
                config = dict(self.config, balance=balance_for(label))
                pool.reset(2, rules_for(config))
                for _ in range(12):
                    rows = pool.call('observe')
                    if not rows:
                        break
                    items = []
                    for row in rows:
                        for side, choices, board in zip(['A', 'B'], row['actions'], observation_pair(row)):
                            expected_indices, expected_data, expected_aliases = reference.actions(row, side, choices)
                            indices, data, aliases = actions(row, side, choices)
                            np.testing.assert_array_equal(indices, expected_indices)
                            np.testing.assert_array_equal(data, expected_data)
                            self.assertEqual(data.tobytes(), expected_data.tobytes())
                            self.assertEqual(aliases, expected_aliases)
                            np.testing.assert_array_equal(board, reference.observation(row, side))
                            compared += len(choices)
                        candidates = [[choices[int(j)] for j in rng.choice(len(choices), min(4, len(choices)), replace=False)] for choices in row['actions']]
                        items.append(dict(_engine=row['_engine'], env=row['env'], candidates=candidates))
                    full = {key(row): row for row in pool.call('preview', items)}
                    compact = pool.call('preview', [dict(item, compact=True) for item in items])
                    for row in compact:
                        expected = full[key(row)]
                        self.assertEqual(row['cells'], expected['cells'])
                        self.assertEqual(len(row['states']), len(expected['states']))
                        boards = compact_observations(row['states'])
                        for i, (packed, state) in enumerate(zip(row['states'], expected['states'])):
                            self.assertEqual(packed['outcome'], state['outcome'])
                            for side, board in zip(['A', 'B'], boards[2*i:2*i+2]):
                                np.testing.assert_array_equal(board, reference.observation(state, side))
                            self.assertAlmostEqual(packed['heuristic'], reference.heuristic_value(state), places=14)
                    pool.call('step', [dict(_engine=item['_engine'], env=item['env'], actions=[a[0] for a in item['candidates']]) for item in items])
        self.assertGreater(compared, 20_000)

    def test_compact_features_preserve_bans_activity_and_terminal_values(self):
        config = dict(self.config, balance=balance_for('D+BP-C2'), round_limit=1)
        with EnginePool(1) as pool:
            pool.reset(1, rules_for(config))
            root = pool.call('observe')[0]
            position = copy.deepcopy(root['position'])
            position['hands']['A'] = {'P': 2, 'R': 1}
            piece = next(p for p in position['pieces'] if p['side'] == 'A' and p['kind'] == 'P')
            position['activity'] = {piece['id']: dict(streak=3, fatigue=2)}
            position['dropBans'] = [dict(side='A', kind='P', to=[5, 5], remaining=1)]
            position['moveBans'] = [dict(side='A', piece=piece['id'], **{'from':piece['at']}, to=[piece['at'][0], 6], remaining=1)]
            pool.reset(1, rules_for(config), position)
            root = pool.call('observe')[0]
            item = dict(_engine=0, env=0, candidates=[[choices[-1]] for choices in root['actions']])
            full = pool.call('preview', [item])[0]['states']
            compact = pool.call('preview', [dict(item, compact=True)])[0]['states']
            for side, board in zip(['A', 'B'], compact_observations(compact)):
                np.testing.assert_array_equal(board, reference.observation(full[0], side))
            searcher = Searcher(pool, Net(8), config, torch.device('cpu'))
            np.testing.assert_array_equal(searcher.values(full), searcher.values(compact))
            self.assertIsNotNone(full[0]['outcome'])

    def test_native_solver_matches_reference_and_rejects_invalid_inputs(self):
        rng = np.random.default_rng(119)
        matrices = [rng.normal(size=shape) for shape in [(1, 1), (1, 8), (8, 1), (3, 5), (8, 8), (32, 32)]]
        matrices += [np.zeros((4, 3)), np.ones((5, 2)), np.array([[1., -1.], [-1., 1.]])]
        with EnginePool(1) as pool:
            pool.reset(1, rules_for(self.config))
            items = [dict(_engine=0, env=i, matrix=matrix.tolist(), iterations=128) for i, matrix in enumerate(matrices)]
            result = pool.call('solve', items)
            for row, matrix in zip(result, matrices):
                p, q, gap = regret_match(matrix, 128)
                np.testing.assert_allclose(row['p'], p, rtol=1e-10, atol=1e-12)
                np.testing.assert_allclose(row['q'], q, rtol=1e-10, atol=1e-12)
                self.assertAlmostEqual(row['gap'], gap, places=11)
            for matrix, iterations in [([], 8), ([[]], 8), ([[1], [1, 2]], 8), ([[1]], 0), ([[1]], 8193)]:
                with self.assertRaises(RuntimeError):
                    pool.call('solve', [dict(_engine=0, env=0, matrix=matrix, iterations=iterations)])

    def test_batched_policy_loss_and_gradients_match_ragged_reference(self):
        counts = [1, 2, 31, 5, 128, 3]
        for device in ['cpu'] + (['cuda'] if torch.cuda.is_available() else []):
            for dtype in [torch.float32, torch.float16]:
                generator = torch.Generator().manual_seed(110)
                raw = torch.randn(sum(counts), generator=generator) * 20
                raw[1:3] = torch.tensor([1000., -1000.])
                logits = raw.to(device=device, dtype=dtype).requires_grad_()
                expected_logits = logits.detach().clone().requires_grad_()
                owners = torch.repeat_interleave(torch.arange(len(counts), device=device), torch.tensor(counts, device=device), output_size=sum(counts))
                targets = torch.cat([torch.softmax(torch.randn(c, generator=generator), 0) for c in counts]).to(device)
                expected = torch.stack([-(target * torch.log_softmax(logit.float(), 0)).sum() for target, logit in zip(torch.split(targets, counts), torch.split(expected_logits, counts))]).mean()
                actual = segmented_policy_loss(logits, targets, owners, len(counts))
                expected.backward()
                actual.backward()
                torch.testing.assert_close(actual, expected, rtol=1e-6, atol=1e-6)
                torch.testing.assert_close(logits.grad, expected_logits.grad, rtol=2e-5, atol=1e-6)

    def test_cli_warm_start_preserves_weights_and_owns_new_optimizer_and_run(self):
        config = load_config(overrides=dict(device='cpu', channels=8, generations=1, games_per_generation=2,
            environments=2, workers=1, candidates=2, cheap_candidates=2, regret_iterations=8,
            batch_size=2, updates=1, round_limit=2, eval_pairs=1, history_fraction=0))
        (ROOT/'.cache/tests').mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=ROOT/'.cache/tests') as directory:
            base = Path(directory)
            parent = Trainer(base/'parent', config)
            original_manifest = (parent.run/'manifest.json').read_bytes()
            atomic_json(base/'config.json', config)
            args = ['training.train', '--run-dir', str(base/'child'), '--config', str(base/'config.json'), '--init-from', str(parent.run)]
            with patch.object(sys, 'argv', args), contextlib.redirect_stdout(io.StringIO()):
                main()
            child = read_json(base/'child/manifest.json')
            self.assertEqual(child['generation'], 1)
            initial = torch.load(base/'child/checkpoints/g0000.pt', weights_only=True)
            for name, tensor in parent.model.state_dict().items():
                torch.testing.assert_close(tensor, initial['model'][name], rtol=0, atol=0)
            self.assertEqual(initial['optimizer']['state'], {})
            self.assertEqual(child['parent']['generation'], 0)
            self.assertFalse((base/'child/RUNNING').exists())
            self.assertEqual((parent.run/'manifest.json').read_bytes(), original_manifest)


if __name__ == '__main__':
    unittest.main()
