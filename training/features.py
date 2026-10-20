"""Relative 9x9 observations, and sparse complete-action descriptors."""
import numpy as np

KINDS = "KPLNSGRB"
HAND = "PLNSGRB"
PLANES = 54
ACTION_FEATURES = 24


def square(q, side):
    x, y = q if side == "A" else (10 - q[0], 10 - q[1])
    return (y - 1) * 9 + x - 1


def observation(state, side):
    pos = state["position"]
    board = np.zeros((PLANES, 81), np.float32)
    for p in pos["pieces"]:
        rel = int(p["side"] != side)
        cell = square(p["at"], side)
        board[rel * 8 + KINDS.index(p["kind"]), cell] = 1
        board[16 + rel, cell] = p.get("promoted", False)
        board[18 + rel, cell] = p.get("upgraded", False)
    for owner in ["A", "B"]:
        rel = int(owner != side)
        for k, count in pos.get("hands", {}).get(owner, {}).items():
            if k in HAND:
                board[20 + rel * 7 + HAND.index(k)] = count / (18 if k == "P" else 4)
    for ban in pos.get("dropBans", []):
        board[34 + int(ban["side"] != side) * 7 + HAND.index(ban["kind"]), square(ban["to"], side)] = ban["remaining"]
    for ban in pos.get("moveBans", []):
        start = 48 + int(ban["side"] != side) * 2
        board[start, square(ban["from"], side)] = ban["remaining"]
        board[start + 1, square(ban["to"], side)] = ban["remaining"]
    rules = state["rules"]
    board[52] = max(0, 1 - state["round"] / rules["roundLimit"])
    board[53] = state["repetition"] / rules["repetitionLimit"]
    return board.reshape(PLANES, 9, 9)


def actions(state, side, choices):
    pos = state["position"]
    pieces = {p["id"]: p for p in pos["pieces"]}
    occupants = {tuple(p["at"]): p for p in pos["pieces"]}
    enemy_king = next((p["at"] for p in pos["pieces"] if p["side"] != side and p["kind"] == "K"), [5, 5])
    indices = np.zeros((len(choices), 2), np.int64)
    data = np.zeros((len(choices), ACTION_FEATURES), np.float32)
    aliases = []
    for i, action in enumerate(choices):
        drop = action["type"] == "drop"
        p = {"kind": action["kind"], "at": action["to"]} if drop else pieces[action["piece"]]
        to, start = action["to"], p["at"]
        dx, dy = to[0] - start[0], to[1] - start[1]
        choice = ["none", "promote", "upgrade"].index(action.get("choice", "none"))
        rank = {"K": 0, "P": 1, "L": 2, "N": 3, "S": 4, "G": 5, "R": 6, "B": 6}[p["kind"]]
        indices[i] = [square(start, side), square(to, side)]
        data[i, KINDS.index(p["kind"])] = 1
        data[i, 8 + choice] = 1
        data[i, 11:18] = [drop, (rank + p.get("upgraded", False)) / 7,
                           p.get("promoted", False), p.get("upgraded", False),
                           max(abs(dx), abs(dy)) / 8, dx * (1 if side == "A" else -1) / 8, dy * (-1 if side == "A" else 1) / 8]
        path = [to] if drop or (p["kind"] == "N" and not p.get("promoted", False)) else [
            [start[0] + int(np.sign(dx)) * n, start[1] + int(np.sign(dy)) * n]
            for n in range(1, max(abs(dx), abs(dy)) + 1)]
        for cell in path:
            victim = occupants.get(tuple(cell))
            if victim:
                data[i, 18 + int(victim["side"] != side)] = 1
                if victim["side"] != side:
                    data[i, 20] = {"K": 0, "P": 1, "L": 2, "N": 3, "S": 4, "G": 5, "R": 6, "B": 6}[victim["kind"]] / 7
                    data[i, 21] = victim["kind"] == "K"
                break
        data[i, 22] = (abs(to[0] - enemy_king[0]) + abs(to[1] - enemy_king[1])) / 16
        zone = lambda q: q[1] <= 3 if side == "A" else q[1] >= 7
        can_change = not drop and p["kind"] not in "KG" and not p.get("promoted", False) and not p.get("upgraded", False) and (zone(start) or any(zone(q) for q in path))
        data[i, 23] = can_change
        # Search aliases only when a change cannot affect ANY actual endpoint.
        effective_choice = choice if can_change and not (choice == 2 and p.get("upgraded", False)) else 0
        aliases.append((action.get("piece", p["kind"]), tuple(to), effective_choice))
    return indices, data, aliases


def heuristic_prior(data):
    return 8 * data[:, 21] + 2 * data[:, 20] - 3 * data[:, 18] - data[:, 22] + .25 * data[:, 23] * (data[:, 9] + data[:, 10])


def mirror_sample(sample):
    """Horizontal symmetry preserves forward motion, ranks and all rule cases."""
    mirrored = dict(sample)
    mirrored["board"] = sample["board"][:, :, ::-1].copy()
    indices = sample["indices"].copy()
    mirrored["indices"] = (indices // 9) * 9 + 8 - indices % 9
    data = sample["data"].copy()
    data[:, 16] *= -1
    mirrored["data"] = data
    return mirrored


def heuristic_value(state):
    values = {"K": 0, "P": 1, "L": 3, "N": 3, "S": 5, "G": 6, "R": 10, "B": 9}
    pos = state["position"]
    total = sum((1 if p["side"] == "A" else -1) * (values[p["kind"]] + 2 * p.get("promoted", False) + p.get("upgraded", False)) for p in pos["pieces"])
    total += sum((1 if s == "A" else -1) * values[k] * n for s, h in pos.get("hands", {}).items() for k, n in h.items())
    return float(np.tanh(total / 25))
