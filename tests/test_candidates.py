import unittest
import numpy as np
import torch

from training.candidates import action_coverage, attack_mask, canonical_order, shortlist, TRAINING_EXPLORATION
from training.common import load_config, rules_for
from training.engine import EnginePool, key
from training.features import actions
from training.model import Net
from training.search import Searcher


class CandidateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        torch.set_num_threads(2)
        cls.config = load_config(overrides=dict(device='cpu',amp=False,bootstrap_weight=0,
            candidates=4,cheap_candidates=4,regret_iterations=8,channels=8))

    def sample(self, row, side=0):
        choices=row['actions'][side]
        indices,data,aliases=actions(row,'AB'[side],choices)
        return dict(actions=choices,indices=indices,data=data,aliases=aliases)

    def test_ignored_changes_keep_learned_geometry_score_and_use_none(self):
        with EnginePool(1) as pool:
            pool.reset(1,rules_for(self.config))
            row=pool.call('observe')[0]
        sample=self.sample(row)
        upgrade=next(i for i,a in enumerate(sample['actions']) if a['piece']=='A:P:7' and a['choice']=='upgrade')
        scores=np.full(len(sample['actions']),-20.)
        scores[upgrade]=10
        order,prior=canonical_order(sample,scores)
        self.assertEqual(sample['actions'][order[0]],dict(sample['actions'][upgrade],choice='none'))
        self.assertGreater(prior[order[0]],.999)
        self.assertTrue(all(sample['actions'][i]['choice']=='none' for i in order if not sample['data'][i,23]))
        self.assertAlmostEqual(prior.sum(),1)

    def test_enemy_zone_choices_and_conditional_wait_tactics_are_preserved(self):
        def piece(id,side,kind,at):
            return dict(id=id,side=side,kind=kind,at=at,promoted=False,upgraded=False)
        pos=dict(pieces=[piece('ak','A','K',[9,9]),piece('ar','A','R',[5,8]),piece('ap','A','P',[5,7]),
                         piece('bk','B','K',[1,1]),piece('br','B','R',[5,1])],hands={'A':{},'B':{}},dropBans=[],moveBans=[],nextPieceId=0)
        with EnginePool(1) as pool:
            pool.reset(1,rules_for(self.config),pos)
            row=pool.call('observe')[0]
            sample=self.sample(row)
            coverage=action_coverage(row,0)
            ids=[i for i,a in enumerate(sample['actions']) if a['piece']=='ar' and a['to']==[5,2]]
            self.assertEqual(len({sample['aliases'][i] for i in ids}),3)
            self.assertTrue(all(coverage['waiting'][i] and not coverage['inert'][i] for i in ids))
            own=next(a for a in sample['actions'] if a['piece']=='ar' and a['to']==[5,6] and a['choice']=='none')
            enemy=next(a for a in row['actions'][1] if a['piece']=='br' and a['to']==[5,7] and a['choice']=='none')
            result=pool.call('step',[dict(_engine=0,env=0,actions=[own,enemy])])[0]
            self.assertTrue(next(m for m in result['movements'] if m['piece']=='ar')['moved'])

    def test_collapse_guaranteed_waits_keep_active_moves_and_rest(self):
        with EnginePool(1) as pool:
            pool.reset(1,rules_for(self.config))
            row=pool.call('observe')[0]
        sample=self.sample(row)
        coverage=action_coverage(row,0)
        scores=np.array([100 if coverage['inert'][j] else 0 for j in range(len(sample['actions']))])
        order,_=canonical_order(sample,scores)
        for rng in [None,np.random.default_rng(12)]:
            ids=shortlist(order,coverage,4,rng)
            self.assertEqual(sum(coverage['inert'][j] for j in ids),1)
            self.assertGreaterEqual(sum(not coverage['waiting'][j] for j in ids),2)
            self.assertGreaterEqual(len({coverage['actors'][j] for j in ids if not coverage['waiting'][j]}),2)
            self.assertEqual(len(ids),len(set(ids)))

    def test_search_keeps_recorded_alias_and_widens_at_real_repetition(self):
        model=Net(8).eval()
        with EnginePool(1) as pool:
            pool.reset(1,rules_for(self.config))
            row=pool.call('observe')[0]
            waits=[]
            for side in range(2):
                cov=action_coverage(row,side)
                waits.append(next(a for j,a in enumerate(row['actions'][side]) if cov['inert'][j] and a['choice']=='upgrade'))
            with self.assertRaisesRegex(RuntimeError,'destination'):
                bad=dict(waits[0],to=next(p['at'] for p in row['position']['pieces'] if p['id']==waits[0]['piece']))
                pool.call('step',[dict(_engine=0,env=0,actions=[bad,waits[1]])])
            pool.call('step',[dict(_engine=0,env=0,actions=waits)])
            rows=pool.call('observe')
            self.assertEqual(rows[0]['repetition'],2)
            search=Searcher(pool,model,self.config,torch.device('cpu'))
            streams={key(rows[0]):[np.random.default_rng(1),np.random.default_rng(2)]}
            choice=search.search(rows,streams,forced_actions={key(rows[0]):waits})[0]
            self.assertEqual(search.timing['repetition_widened'],2)
            for side in range(2):
                self.assertIn(waits[side],[rows[0]['actions'][side][j] for j in choice['selected'][side]])
                self.assertGreater(len(choice['selected'][side]),4)
                self.assertAlmostEqual(float(choice['samples'][side]['target'].sum()),1,places=5)
            inference=search.search(rows,streams)[0]
            self.assertEqual(inference['exploration_epsilon'],0)
            self.assertEqual(inference['sampling_strategies'],inference['strategies'])
            training=search.search(rows,streams,training=True)[0]
            for side in range(2):
                sample=training['samples'][side]
                executed=np.array(training['sampling_strategies'][side])
                active=np.array([not sample['coverage']['waiting'][j] for j in training['selected'][side]])
                self.assertAlmostEqual(executed.sum(),1)
                self.assertTrue(np.all(executed[active] >= TRAINING_EXPLORATION/active.sum()))
                self.assertAlmostEqual(float(sample['target'].sum()),1,places=5)

    def test_collapsed_waits_have_identical_native_results_against_all_responses(self):
        def piece(id,side,kind,at):
            return dict(id=id,side=side,kind=kind,at=at,promoted=False,upgraded=False)
        pos=dict(pieces=[piece('ak','A','K',[9,9]),piece('ar','A','R',[5,8]),piece('ap','A','P',[5,7]),
                         piece('as','A','S',[7,8]),piece('aq','A','P',[7,7]),
                         piece('bk','B','K',[1,1]),piece('br','B','R',[1,8])],hands={'A':{},'B':{}},dropBans=[],moveBans=[],nextPieceId=0)
        with EnginePool(1) as pool:
            pool.reset(1,rules_for(self.config),pos)
            row=pool.call('observe')[0]
            cov=action_coverage(row,0)
            waits=[next(a for i,a in enumerate(row['actions'][0]) if a['piece']==pid and cov['inert'][i] and a['choice']=='none') for pid in ['ar','as']]
            for start in range(0,len(row['actions'][1]),32):
                responses=row['actions'][1][start:start+32]
                result=pool.call('preview',[dict(_engine=0,env=0,candidates=[waits,responses])])[0]
                for j in range(len(responses)):
                    self.assertEqual(result['cells'][j],result['cells'][len(responses)+j])
        # Random exploration must not undo the reserved second piece.
        cov=dict(inert=[False]*8,waiting=[False]*8,actors=['a']*7+['b'])
        for seed in range(20):
            ids=shortlist(list(range(8)),cov,4,np.random.default_rng(seed))
            self.assertEqual({cov['actors'][i] for i in ids},{'a','b'})

    def test_unattacked_friendly_targets_and_blocked_starts_cannot_be_selected(self):
        with EnginePool(1) as pool:
            pool.reset(1,rules_for(self.config))
            row=pool.call('observe')[0]
            sample=self.sample(row)
            sample['coverage']=cov=action_coverage(row,0)
            denied=[j for j,allowed in enumerate(cov['selectable']) if not allowed]
            self.assertTrue(denied)
            scores=np.zeros(len(sample['actions']))
            scores[denied]=1000  # A high learned score must not bypass the guard.
            order,prior=canonical_order(sample,scores)
            self.assertFalse(set(order)&set(denied))
            self.assertEqual(float(prior[denied].sum()),0)
            draws=np.random.default_rng(5).choice(len(prior),size=1000,p=prior)
            self.assertTrue(all(cov['selectable'][j] for j in draws))
            search=Searcher(pool,Net(8).eval(),self.config,torch.device('cpu'))
            streams={key(row):[np.random.default_rng(1),np.random.default_rng(2)]}
            for training in [False,True]:
                choice=search.search([row],streams,training=training)[0]
                for side in range(2):
                    sample=choice['samples'][side]
                    self.assertTrue(all(sample['coverage']['selectable'][j] for j in choice['selected'][side]))
                    denied=[j for j,allowed in enumerate(sample['coverage']['selectable']) if not allowed]
                    self.assertEqual(float(sample['target'][denied].sum()),0)
                # The game engine also validates both actual selected inputs.
                preview=pool.call('preview',[dict(_engine=0,env=0,candidates=[[choice['actions'][0]],[choice['actions'][1]]])])
                self.assertTrue(preview)

    def test_attack_requires_a_clear_ray_and_knight_leaps_still_count(self):
        def piece(id,side,kind,at):
            return dict(id=id,side=side,kind=kind,at=at,promoted=False,upgraded=False)
        base=[piece('ak','A','K',[9,9]),piece('ar','A','R',[5,8]),piece('ap','A','P',[5,7]),piece('bk','B','K',[1,1])]
        for attackers,allowed in [
            ([piece('br','B','R',[5,1])],True),
            ([piece('br','B','R',[5,1]),piece('bp','B','P',[5,2])],False),
            ([piece('bb','B','B',[1,3])],True),
            ([piece('bb','B','B',[1,3]),piece('bp','B','P',[2,4])],False),
            ([piece('bl','B','L',[5,1])],True),
            ([piece('bl','B','L',[5,1]),piece('bp','B','P',[5,2])],False),
            ([dict(piece('bb','B','B',[4,7]),promoted=True)],True),
            ([piece('bb','B','B',[4,7])],False),
            ([dict(piece('br','B','R',[4,6]),promoted=True)],True),
            ([piece('br','B','R',[4,6])],False),
            ([piece('bn','B','N',[4,5]),piece('bp','B','P',[4,6])],True),
            ([piece('bn','B','N',[4,5]),piece('bp','B','P',[4,6]),piece('bp2','B','P',[5,6])],True),
        ]:
            pos=dict(pieces=base+attackers,hands={'A':{},'B':{}},dropBans=[],moveBans=[],nextPieceId=0)
            with self.subTest(attackers=attackers),EnginePool(1) as pool:
                pool.reset(1,rules_for(self.config),pos)
                row=pool.call('observe')[0]
                cov=action_coverage(row,0)
                target=[i for i,a in enumerate(row['actions'][0]) if a['piece']=='ar' and a['to']==[5,7]]
                self.assertTrue(target)
                self.assertTrue(all(cov['selectable'][i]==allowed for i in target))
                beyond=[i for i,a in enumerate(row['actions'][0]) if a['piece']=='ar' and a['to']==[5,6]]
                self.assertTrue(all(cov['selectable'][i]==allowed for i in beyond))
                # A restricted AI move remains a legal conditional engine input.
                own=row['actions'][0][target[0]]
                enemy=next(a for a in row['actions'][1] if a['piece']=='bk' and a['choice']=='none')
                self.assertTrue(pool.call('preview',[dict(_engine=0,env=0,candidates=[[own],[enemy]])]))

    def test_partial_movement_is_kept_and_no_forbidden_fallback_is_added(self):
        with EnginePool(1) as pool:
            pool.reset(1,rules_for(self.config))
            row=pool.call('observe')[0]
        cov=action_coverage(row,0)
        # The lance can advance once, although its later ray is blocked by a pawn.
        index=next(i for i,a in enumerate(row['actions'][0]) if a['piece']=='A:L:1' and a['to']==[1,2] and a['choice']=='none')
        self.assertTrue(cov['selectable'][index])
        sample=self.sample(row)
        sample['coverage']={'selectable':[False]*len(sample['actions'])}
        with self.assertRaisesRegex(RuntimeError,'AI候補'):
            canonical_order(sample,np.zeros(len(sample['actions'])))


if __name__=='__main__':
    unittest.main()
