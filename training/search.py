"""One-round simultaneous payoff search, NOT alternating-turn MCTS.

Regret matching solves only the sampled finite root matrix. Its reported gap is
not an exploitability bound for the complete game or the omitted legal actions.
"""
import time
import numpy as np
import torch
from .engine import key
from .features import observation, actions, heuristic_prior, heuristic_value
from .model import predict, autocast


def softmax(x):
    p = np.exp(x - np.max(x))
    return p / p.sum()


def regret_match(matrix, iterations=128):
    matrix = np.asarray(matrix, dtype=np.float64)
    ra, rb = np.zeros(matrix.shape[0]), np.zeros(matrix.shape[1])
    sa, sb = ra.copy(), rb.copy()
    for t in range(1, iterations + 1):
        p = ra / ra.sum() if ra.sum() > 1e-12 else np.full(len(ra), 1 / len(ra))
        q = rb / rb.sum() if rb.sum() > 1e-12 else np.full(len(rb), 1 / len(rb))
        row, col = matrix @ q, -p @ matrix
        ra = np.maximum(0, ra + row - p @ row)
        rb = np.maximum(0, rb + col - q @ col)
        sa += t * p
        sb += t * q
    p, q = sa / sa.sum(), sb / sb.sum()
    gap = float(np.max(matrix @ q) - np.min(p @ matrix))
    return p, q, max(0., gap)


def terminal_value(state):
    outcome = state["outcome"]
    return {"A": 1., "B": -1., "draw": 0.}[outcome["winner"]] if outcome else None


class Searcher:
    def __init__(self, pool, model, config, device, generation=0):
        self.pool, self.model, self.config, self.device = pool, model, config, device
        self.bootstrap = config["bootstrap_weight"] * max(0, 1 - generation / config["bootstrap_generations"])
        self.timing = {"policy_seconds": 0., "preview_seconds": 0., "value_seconds": 0., "solver_seconds": 0., "cells": 0, "unique_leaves": 0, "roots": 0, "gap_sum": 0.}

    def policy_samples(self, rows):
        samples = []
        for row in rows:
            for side, choices in zip(["A", "B"], row["actions"]):
                indices, data, aliases = actions(row, side, choices)
                if not len(data):
                    raise RuntimeError("No specifiable action; the rules do not define pass/stalemate")
                samples.append({"board": observation(row, side), "indices": indices, "data": data,
                                "aliases": aliases, "actions": choices, "side": side})
        return samples

    @torch.inference_mode()
    def values(self, states):
        result = np.array([terminal_value(s) if s["outcome"] else 0. for s in states], np.float32)
        nonterminal = [i for i, s in enumerate(states) if not s["outcome"]]
        for start in range(0, len(nonterminal), 256):
            ids = nonterminal[start:start + 256]
            boards = np.stack([observation(states[i], side) for i in ids for side in ["A", "B"]])
            tensor = torch.as_tensor(boards, device=self.device)
            with autocast(self.device, self.config["amp"]):
                _, values = self.model.encode(tensor)
            values = values.float().cpu().numpy().reshape(-1, 2)
            estimates = (values[:, 0] - values[:, 1]) / 2
            for i, estimate in zip(ids, estimates):
                result[i] = (1 - self.bootstrap) * estimate + self.bootstrap * heuristic_value(states[i])
        return result

    def search(self, rows, rngs, training=False, forced_actions=None):
        t = time.perf_counter()
        samples = self.policy_samples(rows)
        logits, _ = predict(self.model, samples, self.device, self.config["amp"])
        selected, items = [], []
        for i, row in enumerate(rows):
            chosen = []
            for side in range(2):
                rng = rngs[key(row)][side]
                sample = samples[i * 2 + side]
                scores = logits[i * 2 + side] + self.bootstrap * heuristic_prior(sample["data"])
                prior = softmax(scores)
                order = np.argsort(-scores, kind="stable")
                unique, seen = [], set()
                for j in order:
                    alias = sample["aliases"][j]
                    if alias not in seen:
                        seen.add(alias)
                        unique.append(int(j))
                deep = not training or rng.random() < self.config["deep_fraction"] or np.any(sample["data"][:, 21])
                cap = self.config["candidates"] if deep else self.config["cheap_candidates"]
                ids = unique[:cap]
                if training and len(unique) > cap:
                    ids[-1] = int(rng.choice(unique[cap - 1:]))
                if forced_actions and key(row) in forced_actions:
                    # Replay analysis must actually evaluate the recorded move,
                    # including moves ranked below the network's shortlist.
                    actual = forced_actions[key(row)][side]
                    try:
                        actual_index = sample["actions"].index(actual)
                    except ValueError as error:
                        raise ValueError("The recorded action is not legal in this verified prefix") from error
                    if actual_index not in ids:
                        if len(ids) < cap:
                            ids.append(actual_index)
                        else:
                            ids[-1] = actual_index
                chosen.append(ids)
                sample["prior"] = prior
            selected.append(chosen)
            items.append({"_engine": row["_engine"], "env": row["env"],
                          "candidates": [[row["actions"][s][j] for j in chosen[s]] for s in range(2)]})
        self.timing["policy_seconds"] += time.perf_counter() - t
        t = time.perf_counter()
        previews = {key(r): r for r in self.pool.call("preview", items)}
        self.timing["preview_seconds"] += time.perf_counter() - t
        flat_states, ranges = [], []
        for row in rows:
            preview = previews[key(row)]
            ranges.append(len(flat_states))
            flat_states.extend(preview["states"])
        t = time.perf_counter()
        values = self.values(flat_states)
        self.timing["value_seconds"] += time.perf_counter() - t
        t = time.perf_counter()
        result = []
        for i, row in enumerate(rows):
            preview, chosen = previews[key(row)], selected[i]
            matrix = values[np.array(preview["cells"]) + ranges[i]].reshape(len(chosen[0]), len(chosen[1]))
            p, q, gap = regret_match(matrix, self.config["regret_iterations"])
            policies, selected_actions = [], []
            for s, marginal in enumerate([p, q]):
                sample = samples[i * 2 + s]
                target = np.zeros(len(sample["data"]), np.float32)
                target[chosen[s]] = marginal
                sample["target"] = target
                policies.append(sample)
                index = int(rngs[key(row)][s].choice(chosen[s], p=marginal))
                selected_actions.append(row["actions"][s][index])
            result.append({"_engine": row["_engine"], "env": row["env"], "actions": selected_actions,
                           "samples": policies, "gap": gap, "matrix": matrix, "selected": chosen,
                           "strategies": [p.tolist(), q.tolist()]})
            self.timing["cells"] += matrix.size
            self.timing["unique_leaves"] += len(preview["states"])
            self.timing["roots"] += 1
            self.timing["gap_sum"] += gap
        self.timing["solver_seconds"] += time.perf_counter() - t
        return result
