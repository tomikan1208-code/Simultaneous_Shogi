"""Bounded replay, exact duplicate replacement, recent/uniform mixture.

All persisted arrays are numeric; loading never enables NumPy object pickles.
"""
import hashlib
import os
from pathlib import Path
import numpy as np
from .features import PLANES, ACTION_FEATURES


class ReplayBuffer:
    def __init__(self, capacity):
        self.capacity, self.rows, self.lookup, self.cursor = capacity, [], {}, 0
        self.duplicates = 0

    @staticmethod
    def identity(row):
        h = hashlib.sha256(row["board"].tobytes())
        h.update(row["indices"].tobytes())
        h.update(row["data"].tobytes())
        return h.hexdigest()

    def add(self, sample, value, generation, tactical):
        row = {"board": sample["board"].astype(np.float16), "indices": sample["indices"].astype(np.int64),
               "data": sample["data"].astype(np.float16), "target": sample["target"].astype(np.float32),
               "value": float(value), "generation": generation, "tactical": bool(tactical)}
        identity = self.identity(row)
        if identity in self.lookup:
            self.rows[self.lookup[identity]] = row
            self.duplicates += 1
            return
        if len(self.rows) < self.capacity:
            self.lookup[identity] = len(self.rows)
            self.rows.append(row)
        else:
            del self.lookup[self.identity(self.rows[self.cursor])]
            self.rows[self.cursor] = row
            self.lookup[identity] = self.cursor
            self.cursor = (self.cursor + 1) % self.capacity

    def sample(self, size, rng, generation, recent_fraction):
        recent = [i for i, row in enumerate(self.rows) if row["generation"] >= generation - 1]
        result = []
        for _ in range(size):
            if recent and rng.random() < recent_fraction:
                index = recent[int(rng.integers(len(recent)))]
            else:
                index = int(rng.integers(len(self.rows)))
            result.append(self.rows[index])
        return result

    def save(self, path):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix(".tmp")
        lengths = [len(row["data"]) for row in self.rows]
        with temp.open("wb") as f:
            np.savez_compressed(f, boards=np.stack([r["board"] for r in self.rows]) if self.rows else np.empty((0, PLANES, 9, 9), np.float16),
                                indices=np.concatenate([r["indices"] for r in self.rows]) if self.rows else np.empty((0, 2), np.int64),
                                data=np.concatenate([r["data"] for r in self.rows]) if self.rows else np.empty((0, ACTION_FEATURES), np.float16),
                                targets=np.concatenate([r["target"] for r in self.rows]) if self.rows else np.empty(0, np.float32),
                                lengths=np.array(lengths, np.int64), values=np.array([r["value"] for r in self.rows], np.float32),
                                generations=np.array([r["generation"] for r in self.rows], np.int64),
                                tactical=np.array([r["tactical"] for r in self.rows], bool), cursor=np.array(self.cursor))
        os.replace(temp, path)

    def load(self, path):
        with np.load(path, allow_pickle=False) as values:
            arrays = {name: values[name] for name in values.files}
            lengths = arrays["lengths"]
            if len(lengths) > self.capacity or np.any(lengths <= 0) or int(lengths.sum()) != len(arrays["data"]):
                raise ValueError("Invalid replay lengths")
            offset = 0
            for i, length in enumerate(lengths):
                end = offset + int(length)
                row = {"board": arrays["boards"][i], "indices": arrays["indices"][offset:end], "data": arrays["data"][offset:end],
                       "target": arrays["targets"][offset:end], "value": float(arrays["values"][i]),
                       "generation": int(arrays["generations"][i]), "tactical": bool(arrays["tactical"][i])}
                self.lookup[self.identity(row)] = len(self.rows)
                self.rows.append(row)
                offset = end
            self.cursor = int(arrays["cursor"])
