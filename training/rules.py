"""Explicit, serializable balance profiles. A remains the official rule set."""
from copy import deepcopy
from itertools import product

DEFAULT_BALANCE = dict(movement="none", consecutiveThreshold=3, rankOffset=0, minimumRank=0,
                       restRecovery=1, homeRows=3, defenseBonus=0, defensePosition="destination", defenseCap=None)
PRESETS = {
    "A": None,
    "B": dict(movement="upgrade_only"),
    "B+": dict(movement="progressive", rankOffset=1),
    "C": dict(defenseBonus=1),
    "C+": dict(defenseBonus=2),
    "D": dict(movement="upgrade_only", defenseBonus=1),
    "D+B-C2": dict(movement="upgrade_only", defenseBonus=2),
    "D+BP-C1": dict(movement="progressive", rankOffset=1, defenseBonus=1),
    "D+BP-C2": dict(movement="progressive", rankOffset=1, defenseBonus=2),
    "D+B2-C1": dict(movement="upgrade_only", consecutiveThreshold=2, defenseBonus=1),
}
PLAY_PRESET = 'D+ALL2-C1'
PLAY_BALANCE = dict(movement='all_pieces', consecutiveThreshold=2, defenseBonus=1)


def balance_for(label, overrides=None):
    if label not in PRESETS and label != PLAY_PRESET:
        raise ValueError(f"Unknown rule preset: {label}")
    if label == "A":
        if overrides:
            raise ValueError("A is the unchanged official baseline")
        return None
    result = dict(DEFAULT_BALANCE, **(PLAY_BALANCE if label == PLAY_PRESET else PRESETS[label]))
    unknown = set(overrides or {}) - set(result)
    if unknown:
        raise ValueError(f"Unknown balance parameters: {sorted(unknown)}")
    result.update(overrides or {})
    validate_balance(result)
    return result


def validate_balance(balance):
    if balance is None:
        return
    if not isinstance(balance, dict) or set(balance) != set(DEFAULT_BALANCE):
        raise ValueError("Balance parameters must be complete and contain no unknown fields")
    if balance["movement"] not in ["none", "upgrade_only", "all_pieces", "progressive"]:
        raise ValueError("Invalid movement rule")
    if balance["defensePosition"] not in ["round_start", "stage_from", "destination"]:
        raise ValueError("Invalid defense position")
    for name, lo, hi in [("consecutiveThreshold", 2, 32), ("rankOffset", 0, 1), ("minimumRank", 0, 0),
                         ("restRecovery", 1, 16), ("homeRows", 1, 9), ("defenseBonus", 0, 8)]:
        value = balance[name]
        if type(value) is not int or not lo <= value <= hi:
            raise ValueError(f"{name} must be {lo}..{hi}")
    if balance["rankOffset"] != int(balance["movement"] == "progressive"):
        raise ValueError("Progressive fatigue uses the +1 scale")
    cap = balance["defenseCap"]
    if cap is not None and (type(cap) is not int or not 7 + balance["rankOffset"] <= cap <= 16):
        raise ValueError("Invalid defense cap")


def variants(labels=None, grid=None, overrides=None):
    """Enumerate every member of a declared finite grid, removing duplicates."""
    labels = list(PRESETS if labels is None else labels)
    if not labels or len(set(labels)) != len(labels):
        raise ValueError("Rule labels must be nonempty and unique")
    if set(overrides or {}) - set(labels):
        raise ValueError("Overrides must refer to a selected rule")
    rows = [dict(id=label, balance=balance_for(label, (overrides or {}).get(label))) for label in labels]
    if grid:
        unknown = set(grid) - set(DEFAULT_BALANCE)
        if unknown or any(not isinstance(v, list) or not v for v in grid.values()):
            raise ValueError("Grid must contain nonempty lists of known balance parameters")
        size = 1
        for values in grid.values():
            size *= len(values)
        if size > 512:
            raise ValueError("Split grids exceeding 512 combinations into separate experiments")
        for index, values in enumerate(product(*grid.values())):
            overrides = dict(zip(grid, values))
            balance = dict(DEFAULT_BALANCE, **overrides)
            if "rankOffset" not in overrides:
                balance["rankOffset"] = int(balance["movement"] == "progressive")
            validate_balance(balance)
            if all(row["balance"] != balance for row in rows):
                rows.append(dict(id=f"D+grid-{index:03d}", balance=balance))
    return deepcopy(rows)


def base_rank(piece):
    return dict(K=0, P=1, L=2, N=3, S=4, G=5, R=6, B=6)[piece["kind"]] + int(piece.get("upgraded", False) and not piece.get("promoted", False))


def elite(piece):
    return piece["kind"] in ["R", "B"] and base_rank(piece) == 7


def rank_details(piece, position, rules, moving=False):
    """For logging/features; Rust exclusively adjudicates the actual contacts."""
    base = base_rank(piece)
    balance = rules.get("balance")
    if balance is None:
        return dict(base=base, nominal=base, movement=base, streak=0, fatigue=0)
    activity = position.get("activity", {}).get(piece["id"], {})
    streak, fatigue = activity.get("streak", 0), activity.get("fatigue", 0)
    loss = 0
    if balance["movement"] == "upgrade_only":
        loss = int(base == 7 and streak + int(moving) >= balance["consecutiveThreshold"])
    elif balance["movement"] == "all_pieces":
        loss = int(streak + int(moving) >= balance["consecutiveThreshold"])
    elif balance["movement"] == "progressive":
        loss = fatigue + int(moving and streak + 1 >= balance["consecutiveThreshold"])
    nominal = base + balance["rankOffset"]
    return dict(base=base, nominal=nominal, movement=max(balance["minimumRank"], nominal-loss), streak=streak, fatigue=fatigue)
