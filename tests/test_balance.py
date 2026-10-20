import contextlib
import copy
import gzip
import io
import json
from pathlib import Path
import tempfile
import unittest
import zipfile
import numpy as np
import torch
from training.common import ROOT, load_config, read_json, rules_for
from training.rules import balance_for, variants
from training.features import observation
from training.compatibility import expanded_weights, network_hash
from training.model import Net
from training.engine import EnginePool
from training.balance_metrics import GameTracker, summarize, survival
from training.experiments import initialize, evaluate_run, schedule, report, export_experiment
from training.train import Trainer, StopRequested
from training.transfer import export_run, import_run
from training.artifacts import committed


class BalanceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        (ROOT / '.cache/tests').mkdir(parents=True, exist_ok=True)
        torch.set_num_threads(2)
        cls.config = load_config(overrides=dict(generations=0,games_per_generation=2,environments=2,workers=1,
            candidates=2,cheap_candidates=2,regret_iterations=8,updates=1,batch_size=2,eval_pairs=1,
            eval_every=2,round_limit=3,channels=8,device='cpu',history_fraction=0))

    def test_rule_grid_validation_and_complete_enumeration(self):
        rows = variants(['A','B','B+','C','C+','D'],dict(movement=['upgrade_only','progressive'],consecutiveThreshold=[2,4],defenseBonus=[1,2]))
        self.assertEqual(len(rows),14)
        self.assertIsNone(rows[0]['balance'])
        self.assertEqual(balance_for('B+')['rankOffset'],1)
        with self.assertRaises(ValueError):
            balance_for('A',dict(defenseBonus=1))
        with self.assertRaises(ValueError):
            balance_for('B',dict(consecutiveThreshold=1))
        with self.assertRaises(ValueError):
            variants(['D'],dict(homeRows=[0]))
        self.assertEqual(variants(['B'],overrides={'B':dict(consecutiveThreshold=4)})[0]['balance']['consecutiveThreshold'],4)

    def test_original_v06_golden_replay_keeps_all_hashes(self):
        replay=read_json(ROOT/'tests/fixtures/official-v06-replay.json')
        with EnginePool(1) as pool:
            pool.restore(replay)
            self.assertEqual(pool.call('observe')[0]['round'],len(replay['rounds']))
        self.assertTrue(committed('evidence/g0001/rounds.jsonl.gz',1))
        self.assertFalse(committed('evidence/g0002/rounds.jsonl.gz',1))
        self.assertFalse(committed('comparisons/long/g0002/comparison.json',1))

    def test_all_piece_fatigue_features_and_weights_only_rule_transfer(self):
        from training.rules import rank_details, base_rank
        from training.features import compact_observations
        config=dict(self.config,balance=balance_for('D+ALL2-C1'))
        rules=rules_for(config)
        for kind in 'KPLNSGRB':
            piece=dict(id='p',side='A',kind=kind,at=[5,5],upgraded=False,promoted=False)
            pos=dict(activity={'p':dict(streak=1,fatigue=0)})
            self.assertEqual(rank_details(piece,pos,rules,True)['movement'],max(0,base_rank(piece)-1))
        with EnginePool(1) as pool:
            pool.reset(1,rules)
            state=pool.call('observe')[0]
            items=[dict(env=state['env'],_engine=state['_engine'],candidates=[[state['actions'][0][0]],[state['actions'][1][0]]])]
            full=pool.call('preview',items)[0]['states'][0]
            compact=pool.call('preview',[dict(items[0],compact=True)])[0]['states'][0]
            boards=compact_observations([compact])
            np.testing.assert_array_equal(boards[0],observation(full,'A'))
        with tempfile.TemporaryDirectory(dir=ROOT/'.cache/tests') as folder,contextlib.redirect_stdout(io.StringIO()):
            source=Trainer(Path(folder)/'source',dict(self.config,balance=balance_for('D+B2-C1')));source.train(1)
            target=Trainer(Path(folder)/'new-rule',config,initial_checkpoint=source.run/source.manifest['latest_checkpoint'])
            self.assertEqual(target.generation,0)
            self.assertEqual(len(target.buffer.rows),0)
            self.assertEqual(len(target.optimizer.state),0)
            self.assertNotEqual(target.manifest['rules_hash'],source.manifest['rules_hash'])
            self.assertEqual(target.manifest['parent']['kind'],'weights_only')
            for key,value in source.model.state_dict().items():
                torch.testing.assert_close(value,target.model.state_dict()[key],rtol=0,atol=0)

    def test_old_input_weights_are_preserved_and_new_features_are_observable(self):
        model=Net(8)
        old={k:v.clone() for k,v in model.state_dict().items()}
        old['input.0.weight']=old['input.0.weight'][:,:54].clone()
        expanded=expanded_weights(old,model)
        np.testing.assert_array_equal(expanded['input.0.weight'][:,:54],old['input.0.weight'])
        self.assertEqual(torch.count_nonzero(expanded['input.0.weight'][:,54:]),0)
        model.load_state_dict(expanded)
        board=torch.randn(2,62,9,9)
        expected=torch.nn.functional.conv2d(board[:,:54],old['input.0.weight'],old['input.0.bias'],padding=1)
        torch.testing.assert_close(model.input[0](board),expected)
        with EnginePool(1) as pool:
            pool.reset(1,rules_for(dict(self.config,balance=balance_for('D+BP-C2'))))
            state=pool.call('observe')[0]
        p=state['position']['pieces'][0]
        state['position']['activity']={p['id']:dict(streak=3,fatigue=2)}
        encoded=observation(state,'A')
        clean=copy.deepcopy(state)
        clean['position'].pop('activity')
        self.assertFalse(np.array_equal(encoded,observation(clean,'A')))
        self.assertEqual(encoded.shape,(62,9,9))

    def test_real_contact_and_stationary_capture_metrics_with_censoring(self):
        position=dict(pieces=[dict(id='AK',side='A',kind='K',at=[9,9]),dict(id='BK',side='B',kind='K',at=[9,1]),
            dict(id='AR',side='A',kind='R',at=[5,7],upgraded=True),dict(id='BP',side='B',kind='P',at=[5,5]),
            dict(id='BR',side='B',kind='R',at=[6,6])])
        def mv(side,piece,to):
            return dict(type='move',side=side,piece=piece,to=to,choice='none')
        with EnginePool(1) as pool:
            pool.reset(1,rules_for(self.config),position)
            tracker=GameTracker(0)
            for actions in [[mv('A','AK',[8,9]),mv('B','BP',[5,6])],
                            [mv('A','AR',[5,6]),mv('B','BP',[5,7])],
                            [mv('A','AK',[9,9]),mv('B','BR',[5,6])]]:
                before=pool.call('observe')[0]
                result=pool.call('step',[dict(_engine=0,env=0,actions=actions,replay=True)])[0]
                tracker.observe(before,result,actions)
            game=tracker.finish()
            stats=summarize([game])
            self.assertEqual(stats['elite_collision_wins'],1)
            self.assertEqual(stats['elite_stationary_captures'],1)
            self.assertEqual(stats['elite_survival']['mean_completed_rounds'],3)
            self.assertEqual(stats['elite_survival']['censored'],0)
            self.assertEqual(stats['elite_ownership']['only_one_games'],1)
            self.assertEqual(stats['draw_rate'],1)
            self.assertEqual(stats['elite_idle_when_mobile_rate'],2/3)
            pool.restore(result['replay'])
        censored=survival([dict(duration=2,censored=False),dict(duration=4,censored=True)])
        self.assertEqual(censored['km_restricted_mean_rounds'],3)
        self.assertEqual(censored['censored'],1)
        self.assertIsNone(survival([])['mean_completed_rounds'])

    def test_uncommitted_checkpoint_is_not_a_historical_opponent(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'.cache/tests') as folder, contextlib.redirect_stdout(io.StringIO()):
            trainer=Trainer(Path(folder)/'run',dict(self.config,history_fraction=1,history_size=1))
            (trainer.run/'checkpoints/g9999.pt').write_bytes(b'uncommitted checkpoint')
            with EnginePool(1) as pool:
                stats=trainer.self_play(pool,1)
            self.assertIsNone(stats['history_checkpoint'])
            self.assertEqual(stats['history_games'],0)

    def test_frozen_branches_parallel_learning_resume_and_exported_evidence(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'.cache/tests') as folder, contextlib.redirect_stdout(io.StringIO()):
            parent=Trainer(Path(folder)/'parent',self.config)
            experiment_dir=Path(folder)/'comparison'
            experiment=initialize(experiment_dir,parent.run,plan=dict(rules=['A','B+'],short_pairs=1,long_pairs=1,max_parallel=2,chunk_generations=1))
            weights=[]
            for row in experiment['runs']:
                run=experiment_dir/row['directory']
                self.assertEqual(read_json(run/'manifest.json')['parent']['generation'],0)
                weights.append(torch.load(run/'checkpoints/g0000.pt',weights_only=True)['model'])
            self.assertTrue(all(torch.equal(weights[0][k],weights[1][k]) for k in weights[0]))
            short=evaluate_run(experiment_dir,experiment['runs'][0],'short',1)
            self.assertEqual(short['self_play']['balance']['games'],2)
            (experiment_dir/'STOP').write_text('stop',encoding='utf-8')
            with self.assertRaises(StopRequested):
                evaluate_run(experiment_dir,experiment['runs'][0],'short',1)
            (experiment_dir/'STOP').unlink()
            schedule(experiment_dir,'train',generations=1)
            for row in experiment['runs']:
                run=experiment_dir/row['directory']
                manifest=read_json(run/'manifest.json')
                self.assertEqual(manifest['generation'],1)
                self.assertEqual(len(list((run/'games').glob('g0001-*.json'))),2)
                evidence=read_json(run/'evidence/g0001/summary.json')
                self.assertEqual(len(evidence['games']),2)
                with gzip.open(run/'evidence/g0001/rounds.jsonl.gz','rt',encoding='utf-8') as stream:
                    rounds=[json.loads(line) for line in stream]
                self.assertEqual(rounds[0]['type'],'header')
                self.assertEqual(len(rounds)-1,evidence['summary']['rounds'])
                self.assertTrue(all(r['decision'] for r in rounds[1:]))
                changed=torch.load(run/manifest['latest_checkpoint'],weights_only=True)['model']
                self.assertTrue(any(not torch.equal(changed[k],weights[0][k]) for k in changed))
                with EnginePool(1) as pool:
                    for path in (run/'games').glob('g0001-*.json'):
                        pool.restore(read_json(path)['replay'])
            long=evaluate_run(experiment_dir,experiment['runs'][0],'long',1)
            self.assertNotEqual(short['metadata']['seed'],long['metadata']['seed'])
            self.assertNotIn('against_initial',long)
            result=report(experiment_dir)
            self.assertEqual({r['stage'] for r in result['results']},{'short','long'})
            schedule(experiment_dir,'train',generations=2)
            self.assertTrue(all(read_json(experiment_dir/r['directory']/'manifest.json')['generation']==2 for r in experiment['runs']))
            archive=Path(folder)/'evidence.zip'
            export_experiment(experiment_dir,archive)
            with zipfile.ZipFile(archive) as z:
                self.assertTrue(any(name.endswith('rounds.jsonl.gz') for name in z.namelist()))
                self.assertIn('report.json',z.namelist())
                self.assertFalse(any(name.endswith('/RUNNING') for name in z.namelist()))
            run=experiment_dir/experiment['runs'][0]['directory']
            pending=run/'games/g0003-000.json'
            pending.write_text('{}',encoding='utf-8')
            export_run(run,Path(folder)/'one-run.zip')
            imported=import_run(Path(folder)/'one-run.zip',Path(folder)/'imported')
            self.assertTrue((imported/'evidence/g0001/rounds.jsonl.gz').is_file())
            self.assertFalse((imported/'games/g0003-000.json').exists())


if __name__=='__main__':
    unittest.main()
