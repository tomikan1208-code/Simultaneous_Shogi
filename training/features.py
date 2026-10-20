"""Relative 9x9 observations, and sparse complete-action descriptors."""
from functools import lru_cache
import numpy as np
from .rules import rank_details

KINDS = "KPLNSGRB"
HAND = "PLNSGRB"
PLANES = 62
ACTION_FEATURES = 24
BOARD_SIZE = 9
BOARD_CELLS = BOARD_SIZE * BOARD_SIZE
KIND_INDEX = {kind: index for index, kind in enumerate(KINDS)}
HAND_INDEX = {kind: index for index, kind in enumerate(HAND)}
BASE_RANK = dict(K=0, P=1, L=2, N=3, S=4, G=5, R=6, B=6)
# Rotate by 180 degrees and exchange own/opponent feature planes.
OTHER_PLANES = np.array([*range(8, 16), *range(8), 17, 16, 19, 18,
                         *range(27, 34), *range(20, 27), *range(41, 48), *range(34, 41),
                         50, 51, 48, 49, 52, 53, 55, 54, 57, 56, 59, 58, 61, 60])


def other_observation(board):
    return board[OTHER_PLANES, ::-1, ::-1].copy()


def observation_pair(state):
    board = observation(state, "A")
    return board, other_observation(board)


def compact_observations(states):
    """Expand native sparse A observations; derive B with the same symmetry."""
    boards = np.zeros((len(states), PLANES, BOARD_CELLS), np.float32)
    flat = boards.reshape(len(states), -1)
    for i, state in enumerate(states):
        features = state["features"]
        for plane, value in features["planes"]:
            boards[i, plane] = value
        flat[i, features["indices"]] = features["values"]
    result = np.empty((len(states), 2, PLANES, BOARD_SIZE, BOARD_SIZE), np.float32)
    result[:, 0] = boards.reshape(-1, PLANES, BOARD_SIZE, BOARD_SIZE)
    result[:, 1] = result[:, 0, OTHER_PLANES, ::-1, ::-1]
    return result.reshape(-1, PLANES, BOARD_SIZE, BOARD_SIZE)


def square(q, side):
    x, y = q if side == "A" else (10 - q[0], 10 - q[1])
    return (y - 1) * 9 + x - 1


def observation(state, side):
    pos = state["position"]
    board = np.zeros((PLANES, 81), np.float32)
    for p in pos["pieces"]:
        rel = int(p["side"] != side)
        cell = square(p["at"], side)
        board[rel * 8 + KIND_INDEX[p["kind"]], cell] = 1
        board[16 + rel, cell] = p.get("promoted", False)
        board[18 + rel, cell] = p.get("upgraded", False)
    for owner in ["A", "B"]:
        rel = int(owner != side)
        for k, count in pos.get("hands", {}).get(owner, {}).items():
            if k in HAND:
                board[20 + rel * 7 + HAND_INDEX[k]] = count / (18 if k == "P" else 4)
    for ban in pos.get("dropBans", []):
        board[34 + int(ban["side"] != side) * 7 + HAND_INDEX[ban["kind"]], square(ban["to"], side)] = ban["remaining"]
    for ban in pos.get("moveBans", []):
        start = 48 + int(ban["side"] != side) * 2
        board[start, square(ban["from"], side)] = ban["remaining"]
        board[start + 1, square(ban["to"], side)] = ban["remaining"]
    rules = state["rules"]
    board[52] = max(0, 1 - state["round"] / rules["roundLimit"])
    board[53] = state["repetition"] / rules["repetitionLimit"]
    balance = rules.get("balance")
    if balance:
        for p in pos["pieces"]:
            rel, cell = int(p["side"] != side), square(p["at"], side)
            details = rank_details(p, pos, rules, moving=True)
            board[54 + rel, cell] = details["streak"] / balance["consecutiveThreshold"]
            board[56 + rel, cell] = details["fatigue"] / 8
            board[58 + rel, cell] = details["movement"] / 16
        for owner in ["A", "B"]:
            for y in range(1, 10):
                if (y > 9-balance["homeRows"] if owner == "A" else y <= balance["homeRows"]):
                    for x in range(1, 10):
                        board[60 + int(owner != side), square([x, y], side)] = balance["defenseBonus"] / 8
    return board.reshape(PLANES, 9, 9)


@lru_cache(maxsize=2 * BOARD_CELLS * BOARD_CELLS)
def path_geometry(start, end, leap):
    """81-bit ray mask, first-hit direction, and promotion-zone coverage.

    Occupancy only describes the first contact; it never removes destinations
    from this game's complete set of precommitments.
    """
    x, y = start % BOARD_SIZE + 1, start // BOARD_SIZE + 1
    tx, ty = end % BOARD_SIZE + 1, end // BOARD_SIZE + 1
    dx, dy = tx - x, ty - y
    distance = max(abs(dx), abs(dy))
    sx, sy = (dx > 0) - (dx < 0), (dy > 0) - (dy < 0)
    path = [(tx, ty)] if leap or not distance else [(x + sx * n, y + sy * n) for n in range(1, distance + 1)]
    mask = sum(1 << ((py - 1) * BOARD_SIZE + px - 1) for px, py in path)
    return mask, end > start, distance / 8, dx / 8, dy / 8, y <= 3 or any(py <= 3 for _, py in path), y >= 7 or any(py >= 7 for _, py in path)


def actions(state, side, choices):
    pos = state["position"]
    pieces = {p["id"]: p for p in pos["pieces"]}
    occupants = {square(p["at"], "A"): p for p in pos["pieces"]}
    occupied = sum(1 << cell for cell in occupants)
    enemy_king = next((p["at"] for p in pos["pieces"] if p["side"] != side and p["kind"] == "K"), [5, 5])
    indices = np.zeros((len(choices), 2), np.int64)
    data = np.zeros((len(choices), ACTION_FEATURES), np.float32)
    aliases = []
    descriptors = {}
    for i, action in enumerate(choices):
        drop = action["type"] == "drop"
        p = {"kind": action["kind"], "at": action["to"]} if drop else pieces[action["piece"]]
        to, start = action["to"], p["at"]
        choice = ["none", "promote", "upgrade"].index(action.get("choice", "none"))
        start_cell, end_cell = square(start, "A"), square(to, "A")
        identity = drop, action.get("piece", p["kind"]), end_cell
        cached = descriptors.get(identity)
        if cached is None:
            descriptor = np.zeros(ACTION_FEATURES, np.float32)
            mask, ascending, distance, dx, dy, zone_a, zone_b = path_geometry(start_cell, end_cell, drop or p["kind"] == "N" and not p.get("promoted", False))
            descriptor[KIND_INDEX[p["kind"]]] = 1
            descriptor[11:18] = [drop, (BASE_RANK[p["kind"]] + p.get("upgraded", False)) / 7,
                                 p.get("promoted", False), p.get("upgraded", False),
                                 distance, dx * (1 if side == "A" else -1) if dx else 0., dy * (-1 if side == "A" else 1) if dy else 0.]
            hit = occupied & mask
            if hit:
                cell = (hit & -hit).bit_length() - 1 if ascending else hit.bit_length() - 1
                victim = occupants[cell]
                descriptor[18 + int(victim["side"] != side)] = 1
                if victim["side"] != side:
                    descriptor[20] = BASE_RANK[victim["kind"]] / 7
                    descriptor[21] = victim["kind"] == "K"
            descriptor[22] = (abs(to[0] - enemy_king[0]) + abs(to[1] - enemy_king[1])) / 16
            can_change = not drop and p["kind"] not in "KG" and not p.get("promoted", False) and not p.get("upgraded", False) and (zone_a if side == "A" else zone_b)
            descriptor[23] = can_change
            relative = (start_cell, end_cell) if side == "A" else (BOARD_CELLS - 1 - start_cell, BOARD_CELLS - 1 - end_cell)
            cached = descriptors[identity] = relative, descriptor, can_change
        indices[i], data[i], can_change = cached
        data[i, 8 + choice] = 1
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
