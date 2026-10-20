from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import json
import subprocess
from .common import ensure_native


def key(row):
    return row["_engine"], row["env"]


class Native:
    def __init__(self, binary):
        self.process = subprocess.Popen([str(binary), "training"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        text=True, encoding="utf-8", bufsize=1)
        if self.call({"cmd": "hello"})["protocol"] != "shogi-training-v1":
            raise RuntimeError("Unsupported native training protocol")

    def call(self, request):
        self.process.stdin.write(json.dumps(request, separators=(",", ":")) + "\n")
        self.process.stdin.flush()
        line = self.process.stdout.readline()
        if not line:
            raise RuntimeError(f"Native engine exited ({self.process.poll()})")
        response = json.loads(line)
        if not response["ok"]:
            raise RuntimeError(response["error"])
        return response["value"]

    def close(self):
        if self.process.poll() is None:
            self.process.stdin.close()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        self.process.stdout.close()


class EnginePool:
    """Concurrent persistent Rust processes, each with a vector of environments."""
    def __init__(self, workers):
        binary = ensure_native()
        self.engines = [Native(binary) for _ in range(workers)]
        self.executor = ThreadPoolExecutor(max_workers=workers)
        self.active = []

    def reset(self, count, rules, position=None):
        self.active = list(range(min(len(self.engines), count)))
        requests = []
        for i in self.active:
            n = count // len(self.active) + int(i < count % len(self.active))
            requests.append((i, {"cmd": "reset", "count": n, "rules": rules, "position": position}))
        self._call(requests)

    def _call(self, requests):
        pending = [(i, self.executor.submit(self.engines[i].call, req)) for i, req in requests]
        return [(i, task.result()) for i, task in pending]

    def restore(self, replay):
        self.active = [0]
        self.engines[0].call({"cmd": "restore", "replay": replay})

    def call(self, command, items=None):
        requests = []
        for i in self.active:
            request = {"cmd": command}
            if items is not None:
                request["items"] = [{k: v for k, v in row.items() if k != "_engine"}
                                    for row in items if row["_engine"] == i]
                if not request["items"]:
                    continue
            requests.append((i, request))
        return [dict(row, _engine=i) for i, rows in self._call(requests) for row in rows]

    def close(self):
        for engine in self.engines:
            engine.close()
        self.executor.shutdown(wait=True)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()
