import contextlib
import copy
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest

import torch
from training.common import ROOT, fingerprint, load_config, read_json, rules_for
from training.compatibility import file_hash
from training.engine import EnginePool
from training.train import Trainer
from external_shogi.adapter import attacks, move_action, projection_issue, to_sfen
from external_shogi.distill import distill_run, load_demonstrations
from external_shogi.experiment import match
from external_shogi.usi import USIEngine, parse_info

FIXTURE = ROOT / "tests/fixtures/fake_usi.py"


class ExternalShogiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        (ROOT / ".cache/tests").mkdir(parents=True, exist_ok=True)
        torch.set_num_threads(2)
        cls.config = load_config(overrides=dict(device="cpu", channels=8, workers=1, round_limit=2,
                                               batch_size=2, updates=1, replay_capacity=64, generations=1))
        with EnginePool(1) as pool:
            pool.reset(1, rules_for(cls.config))
            cls.row = pool.call("observe")[0]

    def test_sfen_coordinates_hands_and_promotion(self):
        pos = copy.deepcopy(self.row["position"])
        initial = "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1"
        self.assertEqual(to_sfen(pos, "A"), initial)
        self.assertEqual(to_sfen(pos, "B"), initial.replace(" b ", " w "))
        pawn = next(p for p in pos["pieces"] if p["id"] == "A:P:7")
        pawn["upgraded"] = True
        self.assertEqual(to_sfen(pos, "A"), initial)  # Rank has no SFEN field.
        pawn.update(upgraded=False, promoted=True)
        pos["hands"] = {"A": {"P": 2, "R": 1}, "B": {"S": 1}}
        self.assertIn("+P", to_sfen(pos, "A"))
        self.assertIn(" b R2Ps 1", to_sfen(pos, "A"))
        self.assertEqual(move_action(self.row, "A", "7g7f")["to"], [7, 6])
        self.assertEqual(move_action(self.row, "B", "3c3d")["piece"], "B:P:3")
        self.assertIsNone(move_action(self.row, "A", "resign"))
        self.assertIsNone(move_action(self.row, "A", "3c3d"))

    def test_projection_guard_preserves_checks_and_knight_geometry(self):
        self.assertIsNone(projection_issue(self.row["position"], "A"))
        piece = dict(kind="R", side="A", at=[5, 5], promoted=False)
        kings = [dict(kind="K", side="A", at=[1, 9]), dict(kind="K", side="B", at=[5, 1])]
        pos = dict(pieces=[piece, *kings], hands={})
        self.assertEqual(projection_issue(pos, "A"), "nonmoving_king_in_check")
        self.assertIsNone(projection_issue(pos, "B"))  # The side to move may be in check.
        blocker = dict(kind="P", side="B", at=[5, 3])
        pos["pieces"].append(blocker)
        self.assertIsNone(projection_issue(pos, "A"))
        knight = dict(kind="N", side="A", at=[5, 5], promoted=False)
        self.assertTrue(attacks(knight, [4, 3], {(4, 4), (5, 4)}))
        self.assertFalse(attacks(knight, [4, 4], set()))
        promoted_lance = dict(kind="L", side="A", at=[5, 5], promoted=True)
        self.assertFalse(attacks(promoted_lance, [5, 1], set()))

    def test_upgrade_mapping_and_native_drop_bans(self):
        pos = dict(pieces=[dict(id="ak", side="A", kind="K", at=[1, 9]),
                           dict(id="bk", side="B", kind="K", at=[9, 1]),
                           dict(id="s", side="A", kind="S", at=[5, 4])], hands={"A": {"P": 1}},
                   dropBans=[dict(side="A", kind="P", to=[4, 5], remaining=1)])
        with EnginePool(1) as pool:
            pool.reset(1, rules_for(self.config), position=pos)
            row = pool.call("observe")[0]
            self.assertEqual(move_action(row, "A", "5d5c")["choice"], "upgrade")
            self.assertEqual(move_action(row, "A", "5d5c+")["choice"], "promote")
            self.assertIsNone(move_action(row, "A", "P*4e"))
            self.assertIsNotNone(move_action(row, "A", "P*4f"))
            pos["pieces"][-1]["upgraded"] = True
            pool.reset(1, rules_for(self.config), position=pos)
            row = pool.call("observe")[0]
            self.assertIsNone(move_action(row, "A", "5d5c+"))
            self.assertEqual(move_action(row, "A", "5d5c")["choice"], "none")

    def test_protocol_info_and_timeout(self):
        info = parse_info("info depth 7 multipv 2 score mate + upperbound pv 7g7f")
        self.assertEqual(info["score_type"], "mate")
        self.assertTrue(info["bounded"])
        self.assertIsNone(parse_info("info string not a search result"))
        with USIEngine([sys.executable, FIXTURE]) as engine:
            self.assertEqual(engine.analyse(to_sfen(self.row["position"], "A"), 10)["bestmove"], "7g7f")
        with USIEngine([sys.executable, FIXTURE, "--stall"], timeout=2) as engine:
            engine.timeout = .1
            with self.assertRaises(TimeoutError):
                engine.analyse(to_sfen(self.row["position"], "A"), 10)
        self.assertIsNotNone(engine.process.poll())

    def test_match_records_verified_games_and_distills_into_separate_run(self):
        before_source = fingerprint()
        with tempfile.TemporaryDirectory(dir=ROOT / ".cache/tests") as temporary:
            temp = Path(temporary)
            with contextlib.redirect_stdout(io.StringIO()), USIEngine([sys.executable, FIXTURE]) as engine:
                result = match(engine, self.config, temp / "match", pairs=1, nodes=10)
            self.assertEqual(result["games"], 2)
            self.assertEqual(result["draws"], 2)
            self.assertEqual(result["interval"], [0., 1.])
            self.assertGreater(result["adapter"]["fallbacks"], 0)
            with EnginePool(1) as pool:
                for path in (temp / "match").glob("game-*.json"):
                    pool.restore(read_json(path)["replay"])
                    self.assertEqual(pool.call("observe"), [])
            dataset = temp / "match/teacher.jsonl"
            buffer, evidence = load_demonstrations(dataset, self.config)
            self.assertEqual(evidence["completed_decisions"], 2)
            self.assertTrue(all(s["value"] == 0 for s in buffer.rows))  # Ignores fake cp=9876.
            with self.assertRaisesRegex(ValueError, "identical current rules"):
                load_demonstrations(dataset, dict(self.config, round_limit=3))
            source = temp / "source"
            Trainer(source, self.config)
            checkpoint = source / "checkpoints/g0000.pt"
            initial = file_hash(checkpoint)
            with contextlib.redirect_stdout(io.StringIO()):
                distill_run(dataset, source, temp / "distilled", updates=1)
            saved = read_json(temp / "distilled/manifest.json")
            self.assertEqual(file_hash(checkpoint), initial)
            self.assertEqual(saved["generation"], 1)
            self.assertEqual(saved["champion_generation"], 0)
            self.assertFalse(saved["external_distillation"]["evaluated"])
            self.assertNotEqual(file_hash(temp / "distilled/checkpoints/g0001.pt"), initial)
            with self.assertRaises(FileExistsError):
                distill_run(dataset, source, temp / "distilled", updates=1)
        self.assertEqual(fingerprint(), before_source)

    def test_unfinished_games_never_get_draw_labels(self):
        with tempfile.TemporaryDirectory(dir=ROOT / ".cache/tests") as temporary:
            temp = Path(temporary)
            with contextlib.redirect_stdout(io.StringIO()), USIEngine([sys.executable, FIXTURE]) as engine:
                match(engine, self.config, temp / "match", pairs=1, nodes=10)
            records = [json.loads(line) for line in (temp / "match/teacher.jsonl").read_text(encoding="utf-8").splitlines()]
            path = temp / "unfinished.jsonl"
            path.write_text("\n".join(json.dumps(r) for r in records if r["type"] != "game_result"), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "No completed"):
                load_demonstrations(path, self.config)


if __name__ == "__main__":
    unittest.main()
