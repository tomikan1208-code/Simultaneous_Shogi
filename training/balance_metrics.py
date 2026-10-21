"""Per-game evidence and descriptive metrics; no automatic rule ranking."""
from collections import Counter
import gzip
import json
import math
from pathlib import Path
import numpy as np
from .common import atomic_json
from .rules import elite, rank_details
from .storage import replace_file

EVIDENCE_FORMAT = "simultaneous-shogi/balance-evidence-v1"


def ratio(numerator, denominator):
    return numerator / denominator if denominator else None


def action_signature(action, pieces):
    if action["type"] == "drop":
        return f"drop:{action['kind']}:{action['to']}"
    piece = pieces[action["piece"]]
    return f"move:{piece['kind']}:{piece['at']}:{action['to']}:{action.get('choice','none')}"


def can_advance(piece, actions, occupants):
    for action in actions:
        if action["type"] != "move" or action["piece"] != piece["id"]:
            continue
        to, at = action["to"], piece["at"]
        if piece["kind"] == "N" and not piece.get("promoted"):
            first = to
        else:
            first = [at[i] + int(np.sign(to[i]-at[i])) for i in range(2)]
        blocker = occupants.get(tuple(first))
        if blocker is None or blocker["side"] != piece["side"]:
            return True
    return False


class GameTracker:
    def __init__(self, game_id, metadata=None):
        self.id, self.metadata = game_id, metadata or {}
        self.counts, self.actions, self.opening = Counter(), Counter(), []
        self.lives, self.active, self.ever, self.first = [], {}, set(), []
        self.streak, self.max_streak, self.holding = {}, 0, Counter()
        self.rounds, self.outcome = 0, None

    def observe(self, before, result, chosen, search=None):
        pos, rules = before["position"], before["rules"]
        pieces = {p["id"]: p for p in pos["pieces"]}
        after = {p["id"]: p for p in result["position"]["pieces"]}
        round_number = result["round"]
        old_elites = {pid: p for pid, p in pieces.items() if elite(p)}
        if old_elites and not self.ever:
            self.first = sorted({p["side"] for p in old_elites.values()})
        for pid, p in old_elites.items():
            if pid not in self.active:
                self.active[pid] = dict(piece=pid, side=p["side"], born=before["round"], initial=True)
                self.ever.add(p["side"])
        holders = {p["side"] for p in old_elites.values()}
        for side in holders:
            self.holding[side] += 1
        movements = {m["piece"]: m for m in result["movements"]}
        self.counts['no_movement_rounds'] += not any(m['moved'] for m in movements.values())
        self.counts['unchanged_position_rounds'] += pos == result['position']
        occupants = {tuple(p["at"]): p for p in pos["pieces"]}
        for pid, p in old_elites.items():
            moved = movements.get(pid, {}).get("moved", False)
            self.counts["elite_piece_rounds"] += 1
            available = can_advance(p, before["actions"][int(p["side"] == "B")], occupants)
            self.counts["elite_mobile_piece_rounds"] += available
            self.counts["elite_idle_when_mobile"] += available and not moved
            self.counts["elite_moves"] += moved
            self.counts["elite_rests"] += not moved
            previous = self.streak.get(pid, 0)
            self.counts["elite_consecutive_moves"] += moved and previous > 0
            self.counts["elite_rest_after_move"] += not moved and previous > 0
            self.streak[pid] = previous + 1 if moved else 0
            self.max_streak = max(self.max_streak, self.streak[pid])
            self.counts["elite_fatigue_recovery_rounds"] += not moved and pos.get("activity", {}).get(pid, {}).get("fatigue", 0) > 0
        for side in range(2):
            eligible = {a["piece"] for a in before["actions"][side] if a["type"] == "move" and a.get("choice") == "upgrade"
                        and pieces[a["piece"]]["kind"] in ["R", "B"] and not pieces[a["piece"]].get("upgraded")
                        and not pieces[a["piece"]].get("promoted")
                        and (min(pieces[a["piece"]]["at"][1], a["to"][1]) <= 3 if side == 0 else max(pieces[a["piece"]]["at"][1], a["to"][1]) >= 7)}
            self.counts["elite_upgrade_opportunity_side_rounds"] += bool(eligible)
            action = chosen[side]
            if action['type'] == 'move':
                p = pieces[action['piece']]
                can_change = p['kind'] not in 'KG' and not p['promoted'] and not p['upgraded'] and (min(p['at'][1],action['to'][1])<=3 if side==0 else max(p['at'][1],action['to'][1])>=7)
                self.counts['move_intents'] += 1
                self.counts['ineffective_change_requests'] += action['choice']!='none' and not can_change
                self.counts['zero_move_intents'] += not movements[action['piece']]['moved']
            self.counts["elite_upgrade_attempts"] += action["type"] == "move" and action.get("choice") == "upgrade" and action["piece"] in eligible
            self.actions[action_signature(action, pieces)] += 1
            self.counts["actions:" + (action["kind"] if action["type"] == "drop" else pieces[action["piece"]]["kind"])] += 1
            if before["round"] == 0:
                self.opening.append(action_signature(action, pieces))
        for contact in result.get("contacts", []):
            self.counts["contacts"] += 1
            if contact["reason"] == "rank":
                self.counts["rank_contacts"] += 1
                winner = contact.get("winner")
                self.counts["elite_collision_wins"] += winner in old_elites
                self.counts["elite_rank_contacts"] += any(pid in old_elites for pid in contact["actors"])
                self.counts["elite_mutual_collisions"] += winner is None and any(pid in old_elites for pid in contact["actors"])
                if rules.get("balance", {}).get("defenseBonus", 0):
                    for index, pid in enumerate(contact["actors"]):
                        movement_rank = rank_details(pieces[pid], pos, rules, moving=True)["movement"]
                        self.counts["defense_boosted_contacts"] += contact["ranks"][index] > movement_rank
        for capture in result["captures"]:
            self.counts["captures:" + capture["kind"]] += 1
            self.counts["capture_reason:" + capture["reason"]] += 1
            if capture["victim"] in old_elites:
                self.counts["elite_captures"] += 1
                self.counts["elite_stationary_captures"] += capture["reason"] in ["static", "stopped", "unmoved"]
        lost = [pid for pid in self.active if pid not in after or not elite(after[pid])]
        for pid in lost:
            life = self.active.pop(pid)
            capture = next((c for c in result["captures"] if c["victim"] == pid), None)
            life.update(ended=round_number, duration=round_number-life["born"], censored=False,
                        reason=capture["reason"] if capture else "upgrade_lost")
            self.lives.append(life)
        new = [p for p in after.values() if elite(p) and p["id"] not in old_elites]
        if new and not self.ever:
            self.first = sorted({p["side"] for p in new})
        for p in new:
            self.counts["elite_upgrades"] += 1
            self.ever.add(p["side"])
            self.active[p["id"]] = dict(piece=p["id"], side=p["side"], born=round_number, initial=False)
            self.streak[p["id"]] = 1
            self.max_streak = max(self.max_streak, 1)
        self.counts["board_piece_rounds"] += len(pieces)
        self.counts["rounds"] += 1
        self.rounds, self.outcome = round_number, result["outcome"]
        decision = None
        if search:
            decision = dict(candidates=[[before["actions"][side][i] for i in search["selected"][side]] for side in range(2)],
                            strategies=search["strategies"], restricted_gap=search["gap"],
                            opponent_restricted_gap=search.get("opponent_gap"), historical_policy=search.get("history_policy"),
                            external_policy=search.get('external_policy'),
                            coverage=search.get('coverage'), search_protocol=search.get('search_protocol','legacy-restricted-v1'),
                            sampling_strategies=search.get('sampling_strategies'), exploration_epsilon=search.get('exploration_epsilon',0.),
                            legal_action_counts=[len(a) for a in before["actions"]])
            for coverage in search.get('coverage', []):
                self.counts['search_side_rounds'] += 1
                self.counts['search_all_waiting_shortlists'] += coverage['active']==0
                self.counts['search_filtered_actions'] += coverage.get('filtered_actions',0)
        return dict(format=EVIDENCE_FORMAT, game=self.id, round=round_number, decision=decision,
                    actions=chosen, before=pos, after=result["position"],
                    ranks=[dict(piece=p["id"], **rank_details(p, pos, rules, moving=p["id"] in movements and movements[p["id"]]["moved"])) for p in pieces.values()],
                    movements=result["movements"], contacts=result.get("contacts", []), captures=result["captures"],
                    metrics=result["metrics"], outcome=result["outcome"])

    def finish(self):
        if not self.outcome:
            raise ValueError("Incomplete games cannot enter balance statistics")
        lives = self.lives + [dict(life, ended=self.rounds, duration=self.rounds-life["born"], censored=True, reason="game_end") for life in self.active.values()]
        return dict(format=EVIDENCE_FORMAT, game=self.id, **self.metadata, rounds=self.rounds, outcome=self.outcome,
                    counts=dict(self.counts), lives=lives, elite_owners=sorted(self.ever), first_elite_owners=self.first,
                    holding_rounds=dict(self.holding), max_elite_move_streak=self.max_streak,
                    actions=dict(self.actions), opening=self.opening)


def survival(lives):
    if not lives:
        return dict(n=0, captured=0, censored=0, mean_observed_rounds=None, mean_completed_rounds=None, km_restricted_mean_rounds=None, horizon=0)
    risk, s, area, last = len(lives), 1., 0., 0
    for duration in sorted({life["duration"] for life in lives}):
        area += s * (duration-last)
        same = [life for life in lives if life["duration"] == duration]
        deaths = sum(not life["censored"] for life in same)
        s *= 1-deaths/risk
        risk -= len(same)
        last = duration
    completed = [life["duration"] for life in lives if not life["censored"]]
    return dict(n=len(lives), captured=len(completed), censored=len(lives)-len(completed),
                mean_observed_rounds=float(np.mean([life["duration"] for life in lives])),
                mean_completed_rounds=float(np.mean(completed)) if completed else None,
                km_restricted_mean_rounds=area, horizon=last)


def summarize(games):
    counts, owners, actions, reasons, opening = Counter(), Counter(), Counter(), Counter(), Counter()
    lives = []
    for game in games:
        counts.update(game["counts"])
        actions.update(game["actions"])
        opening.update([str(game["opening"])])
        lives.extend(game["lives"])
        reasons[game["outcome"]["reason"]] += 1
        winner = game["outcome"]["winner"]
        acquired = game["elite_owners"]
        group = "neither" if not acquired else "both" if len(acquired) == 2 else "only_one"
        owners[group + "_games"] += 1
        if len(acquired) == 1:
            owners["only_one_wins"] += winner == acquired[0]
            owners["only_one_draws"] += winner == "draw"
            owners["only_one_score_sum"] += .5 if winner == "draw" else float(winner == acquired[0])
        if len(game["first_elite_owners"]) == 1:
            first = game["first_elite_owners"][0]
            owners["first_owner_games"] += 1
            owners["first_owner_wins"] += winner == first
            owners["first_owner_score_sum"] += .5 if winner == "draw" else float(winner == first)
        for side, rounds in game["holding_rounds"].items():
            owners["holder_rounds"] += rounds
            owners["holder_winning_rounds"] += rounds * (winner == side)
    n = len(games)
    round_values = [g["rounds"] for g in games]
    draws = sum(g["outcome"]["winner"] == "draw" for g in games)
    # Pair, not game, is the uncertainty unit. Training games have no paired CI.
    pairs = {}
    for game in games:
        if "pair" in game:
            pairs.setdefault(game["pair"], []).append(game)
    paired = bool(pairs) and all(len(p) == 2 for p in pairs.values())
    confidence = {}
    if paired:
        for name, values, low, high in [
            ("mean_rounds", [np.mean([g["rounds"] for g in p]) for p in pairs.values()], 0, max(g.get("round_limit", 200) for g in games)),
            ("draw_rate", [np.mean([g["outcome"]["winner"] == "draw" for g in p]) for p in pairs.values()], 0, 1),
            ("repetition_rate", [np.mean([g["outcome"]["reason"] == "repetition" for g in p]) for p in pairs.values()], 0, 1),
        ]:
            radius = (high-low) * math.sqrt(math.log(40)/(2*len(values)))
            center = float(np.mean(values))
            confidence[name] = [max(low, center-radius), min(high, center+radius)]
    owner_data = dict(owners)
    owner_data.update(only_one_win_rate=ratio(owners["only_one_wins"], owners["only_one_games"]),
                      only_one_score=ratio(owners["only_one_score_sum"], owners["only_one_games"]),
                      first_owner_win_rate=ratio(owners["first_owner_wins"], owners["first_owner_games"]),
                      holder_round_win_rate=ratio(owners["holder_winning_rounds"], owners["holder_rounds"]))
    total_actions = sum(actions.values())
    entropy = -sum((v/total_actions)*math.log(v/total_actions) for v in actions.values()) if total_actions else None
    return dict(games=n, rounds=sum(round_values), mean_rounds=ratio(sum(round_values), n),
                draws=draws, draw_rate=ratio(draws, n), repetition_rate=ratio(reasons["repetition"], n),
                elite_upgrades_per_game=ratio(counts["elite_upgrades"], n),
                elite_upgrades_per_100_piece_rounds=ratio(100*counts["elite_upgrades"], counts["board_piece_rounds"]),
                elite_survival=survival(lives), elite_collision_wins=counts["elite_collision_wins"],
                elite_stationary_captures=counts["elite_stationary_captures"], elite_ownership=owner_data,
                elite_idle_when_mobile_rate=ratio(counts["elite_idle_when_mobile"], counts["elite_mobile_piece_rounds"]),
                elite_consecutive_move_rate=ratio(counts["elite_consecutive_moves"], counts["elite_moves"]),
                elite_rest_after_move_rate=ratio(counts["elite_rest_after_move"], counts["elite_rests"]),
                max_elite_move_streak=max((g["max_elite_move_streak"] for g in games), default=0),
                elite_upgrade_attempt_rate=ratio(counts["elite_upgrade_attempts"], counts["elite_upgrade_opportunity_side_rounds"]),
                wins_by_side={s:sum(g["outcome"]["winner"] == s for g in games) for s in ["A", "B"]},
                unique_openings=len(opening), action_entropy=entropy, unique_actions=len(actions),
                counts=dict(counts), outcome_reasons=dict(reasons), paired_95_intervals=confidence,
                interval_note="Unadjusted descriptive Hoeffding intervals on color-swapped pairs" if paired else "Unpaired training statistics; no confidence claim",
                ownership_note="Observational association, not the causal value of acquiring an elite",
                survival_note="Right censoring at game end; compare KM restricted means only at a shared supported horizon")


class EvidenceWriter:
    def __init__(self, directory, metadata):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.path = self.directory / "rounds.jsonl.gz"
        self.temp = self.path.with_suffix(".gz.tmp")
        self.stream = gzip.open(self.temp, "wt", encoding="utf-8", compresslevel=1)
        self.games = []
        self.metadata = metadata
        self.write(dict(format=EVIDENCE_FORMAT, type="header", **metadata))

    def write(self, row):
        self.stream.write(json.dumps(row, ensure_ascii=False, separators=(",", ":"), allow_nan=False)+"\n")

    def finish(self):
        self.stream.close()
        replace_file(self.temp, self.path)
        value = dict(format=EVIDENCE_FORMAT, metadata=self.metadata, summary=summarize(self.games), games=self.games)
        atomic_json(self.directory / "summary.json", value)
        return value["summary"]

    def close(self):
        self.stream.close()
