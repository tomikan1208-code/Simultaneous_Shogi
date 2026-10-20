import copy
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
import zipfile
import numpy as np
import torch
from training.common import ROOT, FORMAT, SCHEMA, fingerprint, load_config, read_json, rules_for
from training.engine import EnginePool, key
from training.evaluate import interval, load_model, paired_match
from training.features import observation, actions, mirror_sample
from training.model import Net
from training.replay import ReplayBuffer
from training.search import regret_match, Searcher
from training.train import Trainer, StopRequested, planned_evaluations, evaluation_alpha, champion_pairs
from training.transfer import export_run, import_run


class LearningTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        (ROOT / '.cache/tests').mkdir(parents=True, exist_ok=True)
        torch.set_num_threads(2)
        cls.config = load_config(overrides={"generations": 2, "games_per_generation": 2, "environments": 2, "workers": 1,
                                          "candidates": 3, "cheap_candidates": 2, "regret_iterations": 32, "updates": 2,
                                          "batch_size": 8, "eval_pairs": 1, "round_limit": 12, "channels": 8, "device": "cpu"})

    def test_mixed_strategy_solver_and_conservative_paired_intervals(self):
        p, q, gap = regret_match([[1, -1], [-1, 1]], 256)
        np.testing.assert_allclose(p, [.5, .5])
        np.testing.assert_allclose(q, [.5, .5])
        self.assertLess(gap, 1e-8)
        p, q, gap = regret_match([[3, 0], [0, 1]], 4096)
        np.testing.assert_allclose(p, [.25, .75], atol=.015)
        np.testing.assert_allclose(q, [.25, .75], atol=.015)
        self.assertLess(gap, .04)
        p, _, _ = regret_match([[1, 1], [-1, -1]], 256)
        self.assertGreater(p[0], .999)
        self.assertEqual(interval([.5]), [0., 1.])
        self.assertLess(interval([1.])[0], .5)
        self.assertGreater(interval([1.] * 100)[0], .5)

    def test_encoding_rotation_and_horizontal_symmetry(self):
        with EnginePool(1) as pool:
            pool.reset(2, rules_for(self.config))
            state = pool.call('observe')[0]
        flipped = copy.deepcopy(state)
        for p in flipped['position']['pieces']:
            p['side'] = 'B' if p['side'] == 'A' else 'A'
            p['at'] = [10 - c for c in p['at']]
        hands = flipped['position']['hands']
        flipped['position']['hands'] = {'A': hands['B'], 'B': hands['A']}
        choices = copy.deepcopy(state['actions'][0])
        for action in choices:
            action['side'] = 'B'
            action['to'] = [10 - c for c in action['to']]
        np.testing.assert_array_equal(observation(state, 'A'), observation(flipped, 'B'))
        indices, data, _ = actions(state, 'A', state['actions'][0])
        indices2, data2, _ = actions(flipped, 'B', choices)
        np.testing.assert_array_equal(indices, indices2)
        np.testing.assert_array_equal(data, data2)
        sample = {'board': observation(state, 'A'), 'indices': indices, 'data': data}
        twice = mirror_sample(mirror_sample(sample))
        for k in sample:
            np.testing.assert_array_equal(sample[k], twice[k])

    def test_native_parallel_batches_preview_and_verified_prefix(self):
        with EnginePool(2) as pool:
            pool.reset(4, rules_for(self.config))
            states = pool.call('observe')
            self.assertEqual(len(states), 4)
            self.assertEqual(len({key(s) for s in states}), 4)
            for step in range(12):
                states = pool.call('observe')
                if not states:
                    break
                candidates = [{'env': s['env'], '_engine': s['_engine'], 'candidates': [[s['actions'][0][0]], [s['actions'][1][0]]]} for s in states]
                previews = {key(p): p for p in pool.call('preview', candidates)}
                results = pool.call('step', [{'env': c['env'], '_engine': c['_engine'], 'actions': [c['candidates'][0][0], c['candidates'][1][0]], 'replay': True} for c in candidates])
                for result in results:
                    preview = previews[key(result)]['states'][0]
                    self.assertEqual(result['position'], preview['position'])
                    self.assertEqual(result['outcome'], preview['outcome'])
            self.assertTrue(all(r['outcome'] for r in results))
            replay = results[0]['replay']
            replay['rounds'] = replay['rounds'][:-1]
            pool.restore(replay)
            self.assertEqual(len(pool.call('observe')), 1)

    def test_real_updates_resume_and_artifact_roundtrip(self):
        with tempfile.TemporaryDirectory(dir=ROOT / '.cache/tests') as folder:
            run = Path(folder) / 'run'
            mirror = Path(folder) / 'drive-mirror'
            trainer = Trainer(run, self.config, mirror=mirror)
            before = {k: v.clone() for k, v in trainer.model.state_dict().items()}
            with EnginePool(1) as pool:
                stats = trainer.self_play(pool, 1)
            self.assertEqual(stats['games'], 2)
            self.assertGreater(len(trainer.buffer.rows), 0)
            trainer.optimize(1)
            self.assertTrue(any(not torch.equal(before[k], v) for k, v in trainer.model.state_dict().items()))
            trainer.generation = 1
            trainer.commit_checkpoint()
            mirrored_manifest = read_json(mirror / 'manifest.json')
            self.assertEqual(mirrored_manifest['generation'], 1)
            for field in ['latest_checkpoint', 'replay_file', 'rng_file']:
                self.assertTrue((mirror / mirrored_manifest[field]).is_file())
            self.assertTrue((mirror / 'source.zip').is_file())
            resumed = Trainer(run, self.config, resume=True)
            self.assertEqual(trainer.rng.bit_generator.state, resumed.rng.bit_generator.state)
            self.assertEqual(len(trainer.buffer.rows), len(resumed.buffer.rows))
            for k, value in trainer.model.state_dict().items():
                self.assertTrue(torch.equal(value, resumed.model.state_dict()[k]))
            trainer.optimize(2)
            resumed.optimize(2)
            for k, value in trainer.model.state_dict().items():
                self.assertTrue(torch.equal(value, resumed.model.state_dict()[k]), k)
            zip_path = Path(folder) / 'results.zip'
            export_run(run, zip_path)
            imported = import_run(zip_path, Path(folder) / 'imported')
            self.assertEqual(read_json(imported / 'manifest.json')['generation'], 1)
            load_model(imported / 'checkpoints/g0001.pt', self.config, torch.device('cpu'), fingerprint())
            with self.assertRaises(ValueError):
                load_model(imported / 'checkpoints/g0001.pt', self.config, torch.device('cpu'), 'wrong-source')
            (run / 'STOP').write_text('stop')
            with self.assertRaises(StopRequested):
                resumed.check_stop()

    def test_unlimited_training_passes_twenty_generations_and_resumes(self):
        config = dict(self.config, generations=0, round_limit=1, candidates=2, cheap_candidates=2,
                      updates=1, batch_size=2, eval_every=1000, history_fraction=0)
        self.assertEqual(load_config(overrides=config)['generations'], 0)
        with tempfile.TemporaryDirectory(dir=ROOT / '.cache/tests') as folder:
            run = Path(folder) / 'continuous'
            trainer = Trainer(run, config)
            self.assertIsNone(trainer.manifest['planned_gates'])
            def stop_after(instance, target):
                save_status = instance.status
                def status(phase, **extra):
                    save_status(phase, **extra)
                    if phase == 'generation_complete' and instance.generation >= target:
                        instance.stopping = True
                instance.status = status
            stop_after(trainer, 21)
            with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(StopRequested):
                trainer.train()
            self.assertEqual(read_json(run / 'manifest.json')['generation'], 21)
            self.assertTrue((run / 'checkpoints/g0021.pt').is_file())
            resumed = Trainer(run, config, resume=True)
            stop_after(resumed, 22)
            with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(StopRequested):
                resumed.train()
            self.assertEqual(read_json(run / 'manifest.json')['generation'], 22)
            self.assertEqual(read_json(run / 'status.json')['target_generations'], 0)

    def test_continuous_evaluation_preserves_total_error_budget(self):
        for every in [1, 2, 5]:
            config = dict(self.config, generations=0, eval_every=every)
            generations = [1] + [g for g in range(2, 1001) if g % every == 0]
            alphas = [evaluation_alpha(config, g) for g in generations]
            self.assertLess(sum(alphas), .05)
            self.assertAlmostEqual(sum(alphas), .05 * (1 - 1 / (len(alphas) + 1)))
            self.assertTrue(all(a > b > 0 for a, b in zip(alphas, alphas[1:])))
            for generation in [1, 20, 100000]:
                pairs = champion_pairs(config, generation)
                self.assertGreaterEqual(pairs, config['eval_pairs'])
                self.assertGreater(interval([1.] * pairs, evaluation_alpha(config, generation))[0], .5)
            for total in [1, 2, 20, 23]:
                config['generations'] = total
                expected = sum(g == 1 or g == total or g % every == 0 for g in range(1, total + 1))
                self.assertEqual(planned_evaluations(config), expected)
                self.assertAlmostEqual(evaluation_alpha(config, 1), .05 / expected)
                self.assertEqual(champion_pairs(config, 1), config['eval_pairs'])

    def test_transfer_rejects_path_escape_and_executable_payloads(self):
        with tempfile.TemporaryDirectory(dir=ROOT / '.cache/tests') as folder:
            for i, name in enumerate(['../escape.json', '/escape.json', 'games/../../escape.json', 'training/train.py', 'checkpoints/a.py', 'games\\evil.json']):
                path = Path(folder) / f'bad{i}.zip'
                with zipfile.ZipFile(path, 'w') as z:
                    z.writestr(name, '{}')
                with self.assertRaises(ValueError):
                    import_run(path, Path(folder) / f'out{i}')
                self.assertFalse((Path(folder) / 'escape.json').exists())

    def test_replay_buffer_is_bounded_and_restores_numeric_arrays(self):
        with tempfile.TemporaryDirectory(dir=ROOT / '.cache/tests') as folder:
            buffer = ReplayBuffer(2)
            sample = {'board': np.zeros((54, 9, 9)), 'indices': np.array([[0, 1]]), 'data': np.zeros((1, 24)), 'target': np.array([1.])}
            buffer.add(sample, 1, 1, False)
            buffer.add(sample, -1, 2, True)
            self.assertEqual(len(buffer.rows), 1)
            self.assertEqual(buffer.rows[0]['value'], -1)
            for i in [1, 2]:
                sample['board'][0, 0, 0] = i
                buffer.add(sample, 0, 2, False)
            self.assertEqual(len(buffer.rows), 2)
            path = Path(folder) / 'buffer.npz'
            buffer.save(path)
            loaded = ReplayBuffer(2)
            loaded.load(path)
            self.assertEqual(loaded.cursor, buffer.cursor)
            for a, b in zip(loaded.rows, buffer.rows):
                for k in ['board', 'data', 'indices', 'target']:
                    np.testing.assert_array_equal(a[k], b[k])


if __name__ == '__main__':
    unittest.main()
