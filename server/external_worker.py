"""Gameplay bridge to the configured USI engine, using public replay only."""
import json
from pathlib import Path
import sys

from training.external import external_opponent, external_settings


class Player:
    def __init__(self):
        self.context = self.opponent = self.config = self.pool = None

    def close_engine(self):
        context = self.context
        self.context = self.opponent = self.config = None
        if context is not None:
            context.__exit__(None, None, None)

    def load(self, request):
        import numpy  # Check the gameplay dependency before starting a match.
        from training.engine import EnginePool
        config = request["config"]
        if self.opponent is None or self.config != config or self.opponent.engine.process.poll() is not None:
            self.close_engine()
            context = external_opponent(config, force=True)
            self.opponent = context.__enter__()
            self.context, self.config = context, config
        identity = self.opponent.identity["id"][:24]
        if request.get("engine", identity) != identity:
            raise ValueError("既存AIが更新されました。AI対戦の設定から接続し直してください。")
        if self.pool is None:
            self.pool = EnginePool(1)
        return dict(engine=identity, name=self.opponent.engine.name,
                    label=self.opponent.engine.name if config.get("external_ai_command") else "やねうら王（Háo）",
                    nodes=self.opponent.nodes, rules=request["rules"])

    def request(self, request):
        command = request["cmd"]
        if command == "status":
            config = request["config"]
            label = "設定済みUSIエンジン" if config.get("external_ai_command") else "やねうら王（Háo）"
            try:
                executable, _, _ = external_settings(config)
                if config.get("external_ai_command"):
                    label = Path(executable[0]).stem
                return dict(available=True, label=label, nodes=config.get("external_ai_nodes", 2000), reason="")
            except ValueError as error:
                return dict(available=False, label=label, nodes=config.get("external_ai_nodes", 2000),
                            reason="既存AIを利用できません: " + str(error) + " 学習パネルの設定で「既存AIを準備」を実行し、接続を確認してください。")
        if command not in ("load", "choose"):
            raise ValueError("対応していない既存AIの操作です。")
        info = self.load(request)
        if command == "load":
            return info
        if request["side"] not in ("A", "B") or type(request["seed"]) is not int or request["seed"] < 0:
            raise ValueError("AIの陣営と乱数種を確認してください。")
        replay = request["replay"]
        if replay["rules"] != request["rules"]:
            raise ValueError("棋譜と既存AIの対局ルールが異なります。")
        self.pool.restore(replay)  # Rust verifies the entire replay, including repetition history.
        rows = self.pool.call("observe")
        if not rows:
            raise ValueError("この対局は終了しています。")
        import numpy as np
        row = rows[0]
        decision = self.opponent.choose(self.pool, row, request["side"], np.random.default_rng(request["seed"]))
        return dict(engine=info["engine"], nodes=info["nodes"], round=row["round"], action=decision["action"],
                    source=decision["source"], reason=decision.get("reason"))

    def close(self):
        try:
            self.close_engine()
        finally:
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
                response = dict(id=request["id"], ok=True, value=player.request(request))
            except Exception as error:
                player.close_engine()  # Discard any unfinished USI response before a retry.
                response = dict(id=request.get("id") if isinstance(request, dict) else None,
                                ok=False, error="既存AIを利用できません: " + str(error)[:500])
            print(json.dumps(response, ensure_ascii=False), flush=True)
    finally:
        player.close()


if __name__ == "__main__":
    main()
