"""Persistent gameplay inference; receives verified public history, never a pending move."""
import json
import sys
from collections import OrderedDict

import numpy as np
import torch

from training.common import load_config, rules_for
from training.engine import EnginePool, key
from training.evaluate import load_model
from training.model import device_for
from training.search import Searcher
from training.candidates import SEARCH_PROTOCOL


class Player:
    def __init__(self):
        torch.set_num_threads(2)
        self.device = device_for({"device": "auto"})
        self.models = OrderedDict()
        self.pool = None

    def load(self, model):
        identity = model["id"]
        if identity not in self.models:
            config = load_config(overrides=dict(model["config"], device="auto"))
            if model["rules"] != rules_for(config):
                raise ValueError("モデルと現在のゲームのルールが異なります。")
            # Gameplay checks the input schema, exact rules hash and state dict.
            # Training-only changes to the source fingerprint do not invalidate inference.
            network, checkpoint = load_model(model["path"], config, self.device)
            if checkpoint["generation"] != model["generation"]:
                raise ValueError("モデルの世代とファイル名が一致しません。")
            self.models[identity] = (network, config, checkpoint["generation"])
            while len(self.models) > 2:
                self.models.popitem(last=False)
        self.models.move_to_end(identity)
        return self.models[identity]

    def request(self, request):
        network, config, generation = self.load(request["model"])
        info = {"generation": generation, "device": str(self.device), "search_protocol": SEARCH_PROTOCOL}
        if request["cmd"] == "load":
            return info
        if request["cmd"] != "choose":
            raise ValueError("対応していないモデル操作です。")
        if request["side"] not in ("A", "B") or type(request["seed"]) is not int or request["seed"] < 0:
            raise ValueError("AIの陣営と乱数種を確認してください。")
        replay = request["replay"]
        if replay["rules"] != rules_for(config):
            raise ValueError("棋譜とモデルのルールが異なります。")
        if self.pool is None:
            self.pool = EnginePool(1)
        self.pool.restore(replay)  # Rust verifies every round and preserves repetition history.
        rows = self.pool.call("observe")
        if not rows:
            raise ValueError("この対局は終了しています。")
        streams = {key(rows[0]): [np.random.default_rng(np.random.SeedSequence([request["seed"], side])) for side in range(2)]}
        choice = Searcher(self.pool, network, config, self.device, generation).search(rows, streams)[0]
        action = choice["actions"][0 if request["side"] == "A" else 1]
        return dict(info, action=action, round=rows[0]["round"])

    def close(self):
        if self.pool is not None:
            self.pool.close()


def main():
    player = Player()
    try:
        for line in sys.stdin:
            request = None
            try:
                if len(line) > 2 * 1024 * 1024:
                    raise ValueError("棋譜のサイズが上限を超えています。")
                request = json.loads(line)
                value = player.request(request)
                response = {"id": request["id"], "ok": True, "value": value}
            except Exception as error:
                response = {"id": request.get("id") if isinstance(request, dict) else None, "ok": False,
                            "error": "学習モデルを利用できません: " + str(error)[:500]}
            print(json.dumps(response, ensure_ascii=False), flush=True)
    finally:
        player.close()


if __name__ == "__main__":
    main()
