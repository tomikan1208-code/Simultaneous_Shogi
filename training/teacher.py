"""Stream completed external-engine demonstrations with a small dataset index."""
import gzip
import json
from pathlib import Path

from .common import atomic_json

TEACHER_FORMAT = "simultaneous-shogi/usi-teacher-v1"


class TeacherWriter:
    def __init__(self, path, metadata):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.stream = gzip.open(self.path, "wt", encoding="utf-8")
        self.metadata = dict(metadata, format=TEACHER_FORMAT)
        self.decisions, self.games = 0, 0
        self.write(dict(type="header", **self.metadata))

    def write(self, record):
        self.stream.write(json.dumps(record, ensure_ascii=False, allow_nan=False) + "\n")

    def decision(self, game, row, side, decision):
        if decision["source"] != "usi":
            return
        self.write(dict(type="decision", game=game, side=side,
                        state={k: row[k] for k in ("position", "rules", "round", "repetition", "outcome")},
                        legal_actions=row["actions"][int(side == "B")], action=decision["action"],
                        sfen=decision["sfen"], analysis=decision["analysis"], mapped_move=decision["mapped_move"]))
        self.decisions += 1

    def result(self, game, outcome):
        self.write(dict(type="game_result", game=game, outcome=outcome))
        self.games += 1

    def finish(self):
        self.close()
        summary = dict(self.metadata, format="simultaneous-shogi/usi-dataset-v1", complete=True,
                       file=self.path.name, games=self.games, decisions=self.decisions)
        atomic_json(self.path.with_suffix("").with_suffix(".json"), summary)
        return summary

    def close(self):
        if not self.stream.closed:
            self.stream.close()
