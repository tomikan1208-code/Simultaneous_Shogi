from __future__ import annotations

import hashlib
from functools import lru_cache
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import time
from .storage import replace_file

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = "simultaneous-shogi/net-v2-62x24"
LEGACY_SCHEMA = "simultaneous-shogi/net-v1-54x24"
FORMAT = "simultaneous-shogi/training-v1"


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
    replace_file(temp, path)


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def source_files():
    paths = [ROOT / "Cargo.toml", ROOT / "Cargo.lock", ROOT / "RULES.md"]
    for folder, patterns in [("crates", ["*.rs", "Cargo.toml"]), ("training", ["*.py", "*.json", "requirements.txt"])]:
        for pattern in patterns:
            paths.extend((ROOT / folder).rglob(pattern))
    return sorted(set(p for p in paths if p.is_file() and "__pycache__" not in p.parts), key=lambda p: p.relative_to(ROOT).as_posix())


def fingerprint():
    digest = hashlib.sha256()
    for path in source_files():
        digest.update(path.relative_to(ROOT).as_posix().encode())
        digest.update(b"\0")
        digest.update(path.read_bytes().replace(b"\r\n", b"\n"))
    return digest.hexdigest()


def rules_for(config):
    rules = dict(official_rules(), roundLimit=config["round_limit"])
    if config.get("balance") is not None:
        rules.update(profile="balance-v1", balance=config["balance"])
    return rules


def rules_hash(rules):
    h = hashlib.sha256(json.dumps(rules, sort_keys=True).encode())
    for file in ["RULES.md", "crates/shogi-core/src/resolution.rs", "crates/shogi-core/src/types.rs"]:
        h.update((ROOT / file).read_bytes().replace(b"\r\n", b"\n"))
    return h.hexdigest()


def load_config(path=None, overrides=None):
    config = read_json(ROOT / "training/config.json")
    if path:
        values = read_json(path)
        unknown = set(values) - set(config)
        if unknown:
            raise ValueError(f"Unknown settings: {sorted(unknown)}")
        config.update(values)
    config.update({k: v for k, v in (overrides or {}).items() if v is not None or k == "balance"})
    limits = {"generations": (0, 100000), "games_per_generation": (2, 4096), "environments": (1, 256),
              "workers": (1, 32), "candidates": (2, 32), "cheap_candidates": (2, 32),
              "regret_iterations": (8, 8192), "batch_size": (2, 4096), "updates": (1, 4096),
              "value_batch_size": (1, 4096),
              "replay_capacity": (32, 100000), "eval_pairs": (1, 4096), "eval_every": (1, 100000), "history_size": (1, 32),
              "round_limit": (1, 200), "bootstrap_generations": (1, 100000), "channels": (8, 128),
              "seed": (0, 2**32-1), "eval_seed": (0, 2**32-1)}
    for key, (lo, hi) in limits.items():
        if type(config[key]) is not int or not lo <= config[key] <= hi:
            raise ValueError(f"{key} must be an integer in {lo}..{hi}")
    for key in ["deep_fraction", "recent_fraction", "history_fraction", "bootstrap_weight"]:
        if not isinstance(config[key], (int, float)) or not 0 <= config[key] <= 1:
            raise ValueError(f"{key} must be in 0..1")
    if config["cheap_candidates"] > config["candidates"]:
        raise ValueError("cheap_candidates must not exceed candidates")
    if config["device"] not in ["auto", "cpu", "cuda"] or type(config["amp"]) is not bool or type(config["mirror_augmentation"]) is not bool:
        raise ValueError("Invalid device / amp")
    if not isinstance(config["learning_rate"], (int, float)) or not 0 < config["learning_rate"] <= .1:
        raise ValueError("Invalid learning_rate")
    from .rules import validate_balance
    validate_balance(config.get("balance"))
    if type(config.get("balance_logging", False)) is not bool:
        raise ValueError("balance_logging must be boolean")
    return config


def native_binary():
    return ROOT / "target/balance/release" / ("shogi.exe" if os.name == "nt" else "shogi")


def ensure_native():
    binary = native_binary()
    inputs = list((ROOT / "crates").rglob("*.rs")) + list((ROOT / "crates").rglob("Cargo.toml")) + [ROOT / "Cargo.toml", ROOT / "Cargo.lock"]
    if not binary.exists() or any(p.stat().st_mtime > binary.stat().st_mtime for p in inputs):
        native_temp = ROOT / ".cache/native-temp"
        native_temp.mkdir(parents=True, exist_ok=True)
        env = dict(os.environ, TMP=str(native_temp), TEMP=str(native_temp))
        subprocess.run(["cargo", "build", "-p", "shogi-cli", "--release", "--locked", "--target-dir", str(ROOT / "target/balance")], cwd=ROOT, env=env, check=True)
    return binary


@lru_cache(maxsize=1)
def official_rules():
    """The Rust engine is the only authority for current rule version/limits."""
    binary = ensure_native()
    response = subprocess.run([str(binary), "training"], input='{"cmd":"hello"}\n',
                              text=True, encoding="utf-8", capture_output=True, check=True)
    value = json.loads(response.stdout)
    if not value["ok"]:
        raise RuntimeError(value["error"])
    return value["value"]["rules"]


def hardware(device):
    import torch
    return {"python": sys.version.split()[0], "torch": torch.__version__, "platform": platform.platform(),
            "cpu_threads": torch.get_num_threads(), "device": str(device),
            "gpu": torch.cuda.get_device_name(0) if device.type == "cuda" else None,
            "cuda": torch.version.cuda, "runtime": os.environ.get("SHOGI_RUNTIME", "local"), "timestamp": time.time()}
