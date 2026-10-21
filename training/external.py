"""Lossy standard-shogi projection. The Rust engine still decides every result."""
from __future__ import annotations

from collections import Counter
from contextlib import contextmanager
import hashlib
import json
import math
from pathlib import Path
import re
import shutil
import time

BRIDGE_PROTOCOL = "simultaneous-shogi/usi-opponent-v2"


def validate_external_config(config):
    if type(config.get("external_ai_enabled", False)) is not bool:
        raise ValueError("external_ai_enabled must be boolean")
    if type(config.get("external_ai_save_teacher", True)) is not bool:
        raise ValueError("external_ai_save_teacher must be boolean")
    fraction = config.get("external_ai_fraction", .25)
    if isinstance(fraction, bool) or not isinstance(fraction, (int, float)) or not math.isfinite(fraction) or not 0 <= fraction <= 1:
        raise ValueError("external_ai_fraction must be in 0..1")
    for key, default, limit in [("external_ai_nodes", 2000, 100000000), ("external_ai_eval_pairs", 8, 4096)]:
        value = config.get(key, default)
        if type(value) is not int or not 1 <= value <= limit:
            raise ValueError(f"{key} must be an integer in 1..{limit}")
    timeout = config.get("external_ai_timeout", 30)
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or not 0 < timeout <= 300:
        raise ValueError("external_ai_timeout must be in (0, 300]")
    command = config.get("external_ai_command", [])
    if not isinstance(command, list) or any(not isinstance(x, str) or not x or '\n' in x or '\r' in x for x in command):
        raise ValueError("external_ai_command must be an argument list")
    options = config.get("external_ai_options", {})
    if not isinstance(options, dict) or any(not isinstance(k, str) or not k or '\n' in k or '\r' in k or
                                          not isinstance(v, (str, int, float, bool)) or '\n' in str(v) or '\r' in str(v)
                                          for k, v in options.items()):
        raise ValueError("Invalid external_ai_options")
    if not isinstance(config.get("external_ai_weights", ""), str):
        raise ValueError("external_ai_weights must be a path string")


def external_settings(config):
    """Resolve local files explicitly; a configured missing engine is an error."""
    from .common import ROOT
    validate_external_config(config)
    command = list(config.get("external_ai_command", []))
    options = dict(config.get("external_ai_options", {}))
    weights = config.get("external_ai_weights", "")
    if not command:
        command = [str(ROOT / ".cache/external-shogi/yaneuraou/NNUE_halfkp_256x2_32_32/YaneuraOu_NNUE_halfkp_256x2_32_32-V900Git_AVX2.exe")]
        defaults = dict(Threads=1, USI_Hash=64, MultiPV=4, USI_OwnBook=False, BookFile="no_book",
                        EnteringKingRule="NoEnteringKing", FV_SCALE=20,
                        EvalDir=str(ROOT / ".cache/external-shogi/tanuki/eval"))
        defaults.update(options)
        options = defaults
        weights = weights or str(Path(options["EvalDir"]) / "nn.bin")
    executable = Path(command[0])
    if not executable.is_absolute():
        executable = (ROOT / executable) if (ROOT / executable).is_file() else Path(shutil.which(command[0]) or command[0])
    executable = executable.resolve()
    weights = (Path(weights) if Path(weights).is_absolute() else ROOT / weights).resolve() if weights else None
    if not executable.is_file() or weights is not None and not weights.is_file():
        raise ValueError("既存AIのエンジン・評価関数がありません。scripts/setup-external-shogi.ps1 を実行するか、既存AIとの対戦を無効にしてください。")
    command[0] = str(executable)
    return command, options, weights


@contextmanager
def external_opponent(config, force=False):
    if not force and not config.get("external_ai_enabled", False):
        yield None
        return
    from .compatibility import file_hash
    from .usi import USIEngine
    command, options, weights = external_settings(config)
    with USIEngine(command, options, config.get("external_ai_timeout", 30)) as engine:
        opponent = ExternalOpponent(engine, config.get("external_ai_nodes", 2000))
        identity = dict(protocol=BRIDGE_PROTOCOL, name=engine.name, nodes=opponent.nodes,
                        executable_sha256=file_hash(command[0]),
                        argument_files_sha256=[file_hash(p) for p in command[1:] if Path(p).is_file()],
                        weights_sha256=file_hash(weights) if weights else None,
                        options={k: v for k, v in engine.applied_options.items() if k != "EvalDir"},
                        adapter_sha256=file_hash(__file__), fallback="native hunter")
        identity["id"] = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
        opponent.identity = dict(identity, command=command, weights=str(weights) if weights else None)
        yield opponent


def outcome_rates(games):
    """Scores are from the current learner's perspective, not the external AI's."""
    count = len(games)
    wins = sum(g["score"] == 1 for g in games)
    draws = sum(g["score"] == .5 for g in games)
    losses = sum(g["score"] == 0 for g in games)
    return dict(games=count, wins=wins, draws=draws, losses=losses,
                win_rate=wins / count if count else None, draw_rate=draws / count if count else None,
                loss_rate=losses / count if count else None,
                score=(wins + .5 * draws) / count if count else None)


def count_decision(counts, decision):
    counts["decisions"] += 1
    counts["queries"] += decision.get("analysis") is not None
    if decision["source"] == "usi":
        counts["usi_actions"] += 1
    else:
        counts["fallbacks"] += 1
        counts["fallback:" + decision["reason"]] += 1


def attacks(piece, target, occupied):
    """Conservative geometric attack test for guarding a USI input, not legality."""
    x, y = piece["at"]
    dx, dy = target[0] - x, target[1] - y
    if not (dx or dy):
        return False
    forward = -1 if piece["side"] == "A" else 1
    kind, promoted = piece["kind"], piece.get("promoted", False)
    gold = {(0, forward), (1, forward), (-1, forward), (1, 0), (-1, 0), (0, -forward)}
    if kind == "K":
        return max(abs(dx), abs(dy)) == 1
    if kind == "G" or promoted and kind in "PLNS":
        return (dx, dy) in gold
    if kind == "P":
        return (dx, dy) == (0, forward)
    if kind == "N":
        return abs(dx) == 1 and dy == 2 * forward
    if kind == "S":
        return (dx, dy) in {(0, forward), (1, forward), (-1, forward), (1, -forward), (-1, -forward)}
    if promoted and (kind == "R" and abs(dx) == abs(dy) == 1 or
                     kind == "B" and abs(dx) + abs(dy) == 1):
        return True
    ray = (kind == "R" and (dx == 0 or dy == 0) or
           kind == "B" and abs(dx) == abs(dy) or
           kind == "L" and dx == 0 and dy * forward > 0)
    if not ray:
        return False
    sx, sy = (dx > 0) - (dx < 0), (dy > 0) - (dy < 0)
    return all((x + sx * n, y + sy * n) not in occupied for n in range(1, max(abs(dx), abs(dy))))


def projection_issue(position, side):
    pieces = position["pieces"]
    kings = {s: [p for p in pieces if p["kind"] == "K" and p["side"] == s] for s in "AB"}
    if any(len(kings[s]) != 1 for s in "AB"):
        return "missing_king"
    counts = Counter(p["kind"] for p in pieces)
    for hand in position.get("hands", {}).values():
        counts.update(hand)
    if any(counts[k] > limit for k, limit in dict(K=2, P=18, L=4, N=4, S=4, G=4, B=2, R=2).items()):
        return "excess_material"
    occupied = {tuple(p["at"]) for p in pieces}
    other = "B" if side == "A" else "A"
    # A normal engine assumes the side that just moved has left its king safe.
    # Simultaneous shogi permits the opposite, including both kings in check.
    if any(attacks(p, kings[other][0]["at"], occupied) for p in pieces if p["side"] == side):
        return "nonmoving_king_in_check"
    return None


def to_sfen(position, side):
    board = {tuple(p["at"]): p for p in position["pieces"]}
    rows = []
    for y in range(1, 10):
        row, empty = "", 0
        for x in range(9, 0, -1):
            piece = board.get((x, y))
            if piece is None:
                empty += 1
                continue
            if empty:
                row += str(empty)
                empty = 0
            letter = piece["kind"] if piece["side"] == "A" else piece["kind"].lower()
            row += ("+" if piece.get("promoted") else "") + letter
        rows.append(row + (str(empty) if empty else ""))
    hands = ""
    for owner in "AB":
        for kind in "RBGSNLP":
            count = position.get("hands", {}).get(owner, {}).get(kind, 0)
            if count:
                hands += (str(count) if count > 1 else "") + (kind if owner == "A" else kind.lower())
    return "/".join(rows) + f" {'b' if side == 'A' else 'w'} {hands or '-'} 1"


def move_action(row, side, move):
    """Map only onto native-generated actions, including all temporary bans."""
    if not isinstance(move, str) or not re.fullmatch(r"(?:[1-9][a-i][1-9][a-i]\+?|[PLNSGRB]\*[1-9][a-i])", move):
        return None
    dest = [int(move[2]), ord(move[3]) - ord("a") + 1]
    if move[1] == "*":
        action = dict(type="drop", side=side, kind=move[0], to=dest)
    else:
        origin = [int(move[0]), ord(move[1]) - ord("a") + 1]
        piece = next((p for p in row["position"]["pieces"] if p["side"] == side and p["at"] == origin), None)
        if piece is None:
            return None
        promote = move.endswith("+")
        last = dest[1] if side == "A" else 10 - dest[1]
        mandatory = piece["kind"] in "PL" and last == 1 or piece["kind"] == "N" and last <= 2
        if promote and piece.get("upgraded") and not mandatory:
            return None  # This engine assumes an unavailable optional promotion.
        choice = "promote" if promote else "none"
        zone = (min(origin[1], dest[1]) <= 3 if side == "A" else max(origin[1], dest[1]) >= 7)
        if not promote and zone and piece["kind"] in "PLNSRB" and not piece.get("promoted") and not piece.get("upgraded"):
            choice = "upgrade"  # The game's non-promotion option keeps movement and gains rank.
        action = dict(type="move", side=side, piece=piece["id"], to=dest, choice=choice)
    return action if action in row["actions"][int(side == "B")] else None


class ExternalOpponent:
    def __init__(self, engine, nodes=2000):
        self.engine, self.nodes = engine, nodes
        self.counts, self.seconds = Counter(), 0.
        self.identity = dict(name=engine.name, nodes=nodes, protocol=BRIDGE_PROTOCOL)

    def choose(self, pool, row, side, rng):
        self.counts["decisions"] += 1
        issue = projection_issue(row["position"], side)
        analysis, sfen = None, None
        if issue is None:
            sfen = to_sfen(row["position"], side)
            start = time.perf_counter()
            analysis = self.engine.analyse(sfen, self.nodes)
            self.seconds += time.perf_counter() - start
            self.counts["queries"] += 1
            moves = [analysis["bestmove"]] + [p["move"] for p in analysis["proposals"]]
            for move in dict.fromkeys(moves):
                action = move_action(row, side, move)
                if action is not None:
                    self.counts["usi_actions"] += 1
                    return dict(action=action, source="usi", sfen=sfen, analysis=analysis, mapped_move=move)
            issue = "no_compatible_move"
        self.counts["fallbacks"] += 1
        self.counts["fallback:" + issue] += 1
        action = pool.call("baseline", [dict(_engine=row["_engine"], env=row["env"], side=side,
                                           policy="hunter", seed=int(rng.integers(0, 2**63)))])[0]["action"]
        return dict(action=action, source="hunter", reason=issue, sfen=sfen, analysis=analysis)

    def stats(self):
        return dict(dict.fromkeys(("decisions", "queries", "usi_actions", "fallbacks"), 0), **self.counts, seconds=self.seconds,
                    usi_coverage=self.counts["usi_actions"] / max(1, self.counts["decisions"]))
