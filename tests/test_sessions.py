import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile
from unittest.mock import patch
import torch
from training.common import ROOT, load_config, read_json, fingerprint
from training.train import Trainer
from training.launch import saved_source, snapshot_fingerprint
from training.session import prepare_resume, process_alive
from training.experiments import initialize, schedule
from training.rules import balance_for


class SessionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        (ROOT/'.cache/tests').mkdir(parents=True,exist_ok=True)
        cls.config=load_config(overrides=dict(generations=0,games_per_generation=2,environments=2,workers=1,
            candidates=2,cheap_candidates=2,regret_iterations=8,updates=1,batch_size=2,eval_pairs=1,
            eval_every=1,round_limit=2,channels=8,device='cpu',amp=False,history_fraction=1,balance_logging=True))

    def test_stop_resume_uses_saved_settings_and_excludes_initial_opponents(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'.cache/tests') as folder,contextlib.redirect_stdout(io.StringIO()):
            run=Path(folder)/'run';trainer=Trainer(run,self.config);trainer.train(1)
            self.assertEqual(read_json(run/'generations/g0001.json')['self_play']['history_games'],0)
            (run/'STOP').write_text('stopped')
            dead=subprocess.run([sys.executable,'-c','import os; print(os.getpid())'],capture_output=True,text=True,check=True)
            (run/'RUNNING').write_text(dead.stdout.strip())
            result=subprocess.run([sys.executable,'-m','training.train','--run-dir',str(run),'--resume','--until-generation','2'],
                                  cwd=ROOT,capture_output=True,text=True,timeout=90)
            self.assertEqual(result.returncode,0,result.stderr+result.stdout)
            self.assertEqual(read_json(run/'manifest.json')['generation'],2)
            record=read_json(run/'generations/g0002.json')
            self.assertEqual(record['self_play']['history_checkpoint'],'g0001.pt')
            self.assertEqual([e['opponent'] for e in record['evaluation']],['adapted_self','recent_checkpoint'])
            self.assertEqual(record['evaluation'][1]['reference_generation'],1)
            self.assertFalse((run/'STOP').exists());self.assertFalse((run/'RUNNING').exists())

    def test_live_session_cannot_be_unlocked(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'.cache/tests') as folder:
            run=Path(folder);(run/'RUNNING').write_text(str(os.getpid()));(run/'STOP').write_text('stop')
            self.assertTrue(process_alive(os.getpid()))
            with self.assertRaisesRegex(ValueError,'still running'):prepare_resume(run)
            self.assertTrue((run/'STOP').exists());self.assertTrue((run/'RUNNING').exists())

    def test_resume_changes_budgets_without_resetting_the_saved_training_state(self):
        def same(left, right):
            if isinstance(left, torch.Tensor):
                torch.testing.assert_close(left, right, rtol=0, atol=0)
            elif isinstance(left, dict):
                self.assertEqual(left.keys(), right.keys())
                for key in left: same(left[key], right[key])
            elif isinstance(left, (list, tuple)):
                self.assertEqual(len(left), len(right))
                for a, b in zip(left, right): same(a, b)
            else:
                self.assertEqual(left, right)
        with tempfile.TemporaryDirectory(dir=ROOT/'.cache/tests') as folder,contextlib.redirect_stdout(io.StringIO()):
            config=dict(self.config,balance=balance_for('D+B2-C1'))
            trainer=Trainer(Path(folder)/'run',config);trainer.train(2)
            saved=torch.load(trainer.run/trainer.manifest['latest_checkpoint'],map_location='cpu',weights_only=True)
            changed=dict(config,generations=4,games_per_generation=4,environments=3,workers=2,
                         candidates=3,batch_size=4,updates=2,eval_pairs=2,eval_every=2)
            resumed=Trainer(trainer.run,changed,resume=True)
            self.assertEqual(resumed.generation,2)
            same(saved['model'],resumed.model.state_dict())
            same(saved['optimizer'],resumed.optimizer.state_dict())
            same(saved['scaler'],resumed.scaler.state_dict())
            self.assertTrue(torch.equal(saved['torch_rng'],torch.get_rng_state()))
            self.assertEqual(trainer.rng.bit_generator.state,resumed.rng.bit_generator.state)
            self.assertEqual(len(trainer.buffer.rows),len(resumed.buffer.rows))
            for a,b in zip(trainer.buffer.rows,resumed.buffer.rows):
                for key in a:
                    if hasattr(a[key],'shape'):
                        import numpy as np
                        np.testing.assert_array_equal(a[key],b[key])
                    else:self.assertEqual(a[key],b[key])
            manifest=read_json(trainer.run/'manifest.json')
            self.assertEqual(manifest['config'],changed)
            self.assertEqual(manifest['rules_hash'],trainer.manifest['rules_hash'])
            revision=manifest['config_history'][-1]
            self.assertEqual(revision['from_generation'],3)
            self.assertEqual(revision['changes']['games_per_generation'],dict(before=2,after=4))
            for forbidden in [dict(balance=balance_for('C')),dict(channels=16),dict(seed=1),dict(bootstrap_weight=.9)]:
                with self.assertRaisesRegex(ValueError,'preserve training settings'):
                    Trainer(trainer.run,dict(changed,**forbidden),resume=True)
            resumed.train(3)
            record=read_json(trainer.run/'generations/g0003.json')
            self.assertEqual(record['config'],changed)
            self.assertEqual(record['self_play']['games'],4)
            self.assertEqual(record['optimization']['updates'],2)
            self.assertEqual(record['optimization']['presentations'],8)
            self.assertTrue(all(e['pairs']==2 for e in record['evaluation']))
            self.assertEqual([e['opponent'] for e in record['evaluation']],['adapted_self','recent_checkpoint'])
            second=Trainer(trainer.run,changed,resume=True)
            self.assertEqual(second.generation,3)
            self.assertEqual(len(second.manifest['config_history']),2,'Unchanged settings must not add a revision')

    def test_saved_source_is_verified_and_can_be_selected_after_an_update(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'.cache/tests') as folder,contextlib.redirect_stdout(io.StringIO()):
            trainer=Trainer(Path(folder)/'run',self.config)
            expected=fingerprint()
            with patch('training.launch.fingerprint',return_value='0'*64):
                source=saved_source(trainer.run)
            self.assertNotEqual(source,ROOT)
            self.assertEqual(snapshot_fingerprint(source),expected)

    def test_cli_really_resumes_in_a_different_saved_source_tree(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'.cache/tests') as folder,contextlib.redirect_stdout(io.StringIO()):
            run=Path(folder)/'run';trainer=Trainer(run,self.config)
            tree=Path(folder)/'snapshot'
            with zipfile.ZipFile(run/'source.zip') as archive:archive.extractall(tree)
            runtime=tree/'training/runtime.py'
            runtime.write_bytes(runtime.read_bytes()+b'\n# Archived source fixture.\n')
            expected=snapshot_fingerprint(tree)
            with zipfile.ZipFile(run/'source.zip','w',zipfile.ZIP_DEFLATED) as archive:
                for file in tree.rglob('*'):
                    if file.is_file():archive.write(file,file.relative_to(tree).as_posix())
            # This is a synthetic archived fixture, never a user checkpoint.
            checkpoint=torch.load(run/'checkpoints/g0000.pt',map_location='cpu',weights_only=True)
            checkpoint['source_fingerprint']=expected;torch.save(checkpoint,run/'checkpoints/g0000.pt')
            manifest=read_json(run/'manifest.json');manifest['source_fingerprint']=expected
            import json
            (run/'manifest.json').write_text(json.dumps(manifest),encoding='utf-8')
            (run/'STOP').write_text('pause')
            result=subprocess.run([sys.executable,'-m','training.train','--run-dir',str(run),'--resume','--until-generation','1'],
                                  cwd=ROOT,capture_output=True,text=True,timeout=180)
            self.assertEqual(result.returncode,0,result.stderr+result.stdout)
            self.assertEqual(read_json(run/'manifest.json')['generation'],1)
            self.assertEqual(read_json(run/'generations/g0001.json')['source_fingerprint'],expected)
            changed=dict(self.config,generations=2,games_per_generation=4,environments=3)
            config_file=Path(folder)/'changed.json';config_file.write_text(json.dumps(changed),encoding='utf-8')
            result=subprocess.run([sys.executable,'-m','training.launch','--run-dir',str(run),'--resume',
                                   '--config',str(config_file),'--until-generation','2'],
                                  cwd=ROOT,capture_output=True,text=True,timeout=180)
            self.assertEqual(result.returncode,0,result.stderr+result.stdout)
            action=json.loads(result.stdout.splitlines()[0])
            continued=Path(action['run_dir'])
            self.assertNotEqual(continued,run)
            manifest=read_json(continued/'manifest.json')
            self.assertEqual(manifest['generation'],2)
            self.assertEqual(manifest['config'],changed)
            self.assertEqual(manifest['parent']['source_fingerprint'],expected)
            self.assertEqual(read_json(continued/'generations/g0002.json')['self_play']['games'],4)
            self.assertEqual(read_json(run/'manifest.json')['generation'],1,'Archived input remains unchanged')

    def test_state_continuation_preserves_optimizer_replay_rng_and_next_update(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'.cache/tests') as folder,contextlib.redirect_stdout(io.StringIO()):
            source=Trainer(Path(folder)/'source',self.config);source.train(2)
            continued=Trainer(Path(folder)/'continued',self.config,state_from=source.run)
            self.assertEqual(continued.generation,2)
            self.assertEqual(continued.rng.bit_generator.state,source.rng.bit_generator.state)
            saved=torch.load(source.run/source.manifest['latest_checkpoint'],map_location='cpu',weights_only=True)
            self.assertTrue(torch.equal(torch.get_rng_state(),saved['torch_rng']))
            self.assertEqual(len(continued.buffer.rows),len(source.buffer.rows))
            for key,value in source.model.state_dict().items():torch.testing.assert_close(continued.model.state_dict()[key],value,rtol=0,atol=0)
            self.assertTrue((continued.run/'checkpoints/g0001.pt').is_file())
            continued.load_checkpoint(continued.run/'checkpoints/g0001.pt')
            self.assertEqual(continued.manifest['parent']['kind'],'state_continuation')
            source.optimize(3);continued.optimize(3)
            for key,value in source.model.state_dict().items():torch.testing.assert_close(continued.model.state_dict()[key],value,rtol=0,atol=0)
            with self.assertRaisesRegex(ValueError,'preserve training settings'):
                Trainer(Path(folder)/'wrong-rule',dict(self.config,balance=balance_for('C')),state_from=source.run)

    def test_balanced_model_can_seed_new_comparison_and_only_one_rule_advances(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'.cache/tests') as folder,contextlib.redirect_stdout(io.StringIO()):
            source=Trainer(Path(folder)/'source',dict(self.config,balance=balance_for('D+B2-C1')))
            exp=Path(folder)/'comparison'
            manifest=initialize(exp,source.run,plan=dict(rules=['A','D+B2-C1'],short_pairs=1,long_pairs=1,chunk_generations=1))
            self.assertEqual(manifest['max_parallel'],1)
            schedule(exp,'train',generations=1,rules=['D+B2-C1'])
            actual={r['rule']:read_json(exp/r['directory']/'manifest.json')['generation'] for r in manifest['runs']}
            self.assertEqual(actual,{'A':0,'D+B2-C1':1})


if __name__=='__main__':unittest.main()
