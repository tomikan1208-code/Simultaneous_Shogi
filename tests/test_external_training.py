import contextlib
import io
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile
from unittest.mock import patch

import torch
from training.common import ROOT, load_config, read_json, rules_for
from training.engine import EnginePool
from training.external import external_opponent, external_settings
from training.evaluate import paired_match
from training.distill import distill_run, load_demonstrations
from training.train import Trainer


class ExternalTrainingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        (ROOT / '.cache/tests').mkdir(parents=True, exist_ok=True)
        torch.set_num_threads(2)
        cls.config = load_config(overrides=dict(
            channels=8, device='cpu', amp=False, workers=2, environments=3, games_per_generation=4,
            round_limit=2, candidates=2, cheap_candidates=2, regret_iterations=8, batch_size=2,
            updates=1, eval_pairs=1, eval_every=1, history_fraction=0, generations=2,
            external_ai_enabled=True, external_ai_fraction=.5, external_ai_eval_pairs=1,
            external_ai_command=[sys.executable, str(ROOT / 'tests/fixtures/fake_usi.py')]))

    def test_default_budget_validation_and_missing_engine(self):
        self.assertEqual(load_config()['external_ai_nodes'], 2000)
        for changes in [dict(external_ai_nodes=0), dict(external_ai_nodes=True),
                        dict(external_ai_fraction=1.1), dict(external_ai_fraction=float('nan')),
                        dict(external_ai_enabled='yes'), dict(external_ai_eval_pairs=0),
                        dict(external_ai_command='a shell string')]:
            with self.assertRaises(ValueError):
                load_config(overrides=changes)
        with self.assertRaisesRegex(ValueError, '既存AI'):
            external_settings(dict(self.config, external_ai_command=['does-not-exist-usi.exe']))

    def test_saved_source_retains_the_installed_engine_location(self):
        from training.launch import source_runtime_config
        from training.common import atomic_json
        with tempfile.TemporaryDirectory(dir=ROOT / '.cache/tests') as temporary:
            project, snapshot = Path(temporary) / 'project', Path(temporary) / 'snapshot'
            installed = project / '.cache/external-shogi'
            executable = installed / 'yaneuraou/NNUE_halfkp_256x2_32_32/YaneuraOu_NNUE_halfkp_256x2_32_32-V900Git_AVX2.exe'
            weights = installed / 'tanuki/eval/nn.bin'
            for file in (executable, weights):
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_bytes(b'path-resolution fixture; not executed')
            config = dict(self.config, external_ai_command=[])
            atomic_json(snapshot / 'training/config.json', config)
            with patch('training.common.ROOT', project):
                resolved = source_runtime_config(config, snapshot)
            self.assertEqual(resolved['external_ai_command'], [str(executable.resolve())])
            self.assertEqual(resolved['external_ai_weights'], str(weights.resolve()))
            self.assertEqual(config['external_ai_command'], [])
            with patch('training.common.ROOT', snapshot):
                command, options, recovered_weights = external_settings(resolved)
            self.assertEqual(command, [str(executable.resolve())])
            self.assertEqual(recovered_weights, weights.resolve())

    def test_mixed_training_evaluations_teacher_and_recoverable_distillation(self):
        with tempfile.TemporaryDirectory(dir=ROOT / '.cache/tests') as temporary, contextlib.redirect_stdout(io.StringIO()):
            run = Path(temporary) / 'run'
            trainer = Trainer(run, self.config)
            trainer.train(1)
            record = read_json(run / 'generations/g0001.json')
            play = record['self_play']
            external = play['external_ai']
            self.assertEqual(play['games'], 4)
            self.assertEqual(external['games'], 2)
            self.assertEqual(external['draws'], 2)
            self.assertEqual(external['win_rate'], 0.)
            self.assertEqual(external['score'], .5)
            self.assertEqual(external['by_side']['A']['games'], 1)
            self.assertEqual(external['by_side']['B']['games'], 1)
            self.assertEqual(play['new_samples'], 12, 'External-side root targets must never enter the learner replay')
            self.assertEqual([e['opponent'] for e in record['evaluation']], ['adapted_self', 'external_usi'])
            evaluation = record['evaluation'][-1]
            self.assertEqual(evaluation['games'], 2)
            self.assertEqual(evaluation['win_rate'], 0.)
            self.assertEqual(evaluation['draw_rate'], 1.)
            self.assertEqual(evaluation['score'], .5)
            self.assertEqual(evaluation['engine']['nodes'], 2000)
            self.assertFalse(evaluation['budget']['equal_wall_time'])
            self.assertEqual({g['model_side'] for g in evaluation['results']}, {'A', 'B'})
            self.assertGreater(evaluation['adapter']['fallbacks'], 0)
            with zipfile.ZipFile(run / 'source.zip') as archive:
                self.assertIn('training/usi.py', archive.namelist())
                self.assertIn('training/external.py', archive.namelist())
                self.assertIn('training/teacher.py', archive.namelist())
                self.assertIn('training/distill.py', archive.namelist())
            for dataset in [run / external['teacher']['file'], run / 'evaluations/g0001/external_usi-teacher.jsonl.gz']:
                buffer, summary = load_demonstrations(dataset, self.config)
                self.assertEqual(summary['completed_games'], 2)
                self.assertEqual(summary['completed_decisions'], 2)
                self.assertTrue(all(row['value'] == 0 for row in buffer.rows), 'USI cp=9876 is not a variant value target')
                self.assertTrue(dataset.with_suffix('').with_suffix('.json').is_file())
            distill_run(run / external['teacher']['file'], run, Path(temporary) / 'distilled', updates=1)
            self.assertEqual(read_json(Path(temporary) / 'distilled/manifest.json')['generation'], 1)
            original_identity = evaluation['opponent_id']
            changed = dict(self.config, external_ai_nodes=100)
            resumed = Trainer(run, changed, resume=True)
            self.assertEqual(resumed.generation, 1)
            torch.testing.assert_close(trainer.model.input[0].weight, resumed.model.input[0].weight, rtol=0, atol=0)
            resumed.train(2)
            second = read_json(run / 'generations/g0002.json')
            self.assertEqual([e['opponent'] for e in second['evaluation']], ['adapted_self', 'recent_checkpoint', 'external_usi'])
            self.assertNotEqual(second['evaluation'][-1]['opponent_id'], original_identity)
            self.assertEqual(second['evaluation'][-1]['engine']['nodes'], 100)
            self.assertEqual(read_json(run / 'generations/g0001.json')['evaluation'][-1]['engine']['nodes'], 2000)


if __name__ == '__main__':
    unittest.main()
