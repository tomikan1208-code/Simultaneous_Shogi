"""Persistent USI subprocess with bounded waits and no shell invocation."""
from __future__ import annotations

from collections import deque
from pathlib import Path
import queue
import re
import subprocess
import threading
import time


def parse_info(line):
    words = line.split()
    if not words or words[0] != "info" or "pv" not in words or "score" not in words:
        return None
    try:
        score = words.index("score")
        pv = words.index("pv")
        return dict(move=words[pv + 1], score_type=words[score + 1], score=words[score + 2],
                    bounded=any(x in words[score + 3:pv] for x in ("lowerbound", "upperbound")),
                    depth=int(words[words.index("depth") + 1]) if "depth" in words else 0,
                    multipv=int(words[words.index("multipv") + 1]) if "multipv" in words else 1)
    except (IndexError, ValueError):
        return None


class USIEngine:
    def __init__(self, command, options=None, timeout=30.):
        self.command = [str(x) for x in command]
        self.timeout = timeout
        self.name, self.options, self.applied_options = "", set(), {}
        self.lines, self.errors = queue.Queue(), deque(maxlen=20)
        self.process = subprocess.Popen(
            self.command, cwd=Path(self.command[0]).resolve().parent,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", errors="replace", bufsize=1,
            creationflags=subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0)
        self.readers = [threading.Thread(target=self._read, args=(self.process.stdout, False), daemon=True),
                        threading.Thread(target=self._read, args=(self.process.stderr, True), daemon=True)]
        for reader in self.readers:
            reader.start()
        try:
            self.send("usi")
            for line in self.until("usiok"):
                if line.startswith("id name "):
                    self.name = line[8:]
                match = re.match(r"option name (.+?) type ", line)
                if match:
                    self.options.add(match[1])
            for name, value in (options or {}).items():
                if name not in self.options:
                    raise ValueError(f"USI engine does not support option {name!r}")
                value = str(value).lower() if isinstance(value, bool) else str(value)
                self.send(f"setoption name {name} value {value}")
                self.applied_options[name] = value
            self.ready()
        except BaseException:
            self.close()
            raise

    def _read(self, stream, error):
        try:
            for line in stream:
                if error:
                    self.errors.append(line.rstrip())
                else:
                    self.lines.put(line.rstrip())
        finally:
            if not error:
                self.lines.put(None)

    def send(self, line):
        if "\n" in line or "\r" in line:
            raise ValueError("USI command contains a newline")
        try:
            self.process.stdin.write(line + "\n")
            self.process.stdin.flush()
        except (BrokenPipeError, OSError) as error:
            raise RuntimeError(f"USI engine exited: {'; '.join(self.errors)}") from error

    def until(self, token):
        deadline = time.monotonic() + self.timeout
        while True:
            try:
                line = self.lines.get(timeout=max(.001, deadline - time.monotonic()))
            except queue.Empty as error:
                raise TimeoutError(f"USI engine did not return {token!r} within {self.timeout}s") from error
            if line is None:
                raise RuntimeError(f"USI engine exited before {token!r}: {'; '.join(self.errors)}")
            yield line
            if line == token or line.startswith(token + " "):
                return
            if time.monotonic() >= deadline:
                raise TimeoutError(f"USI engine did not return {token!r} within {self.timeout}s")

    def ready(self):
        self.send("isready")
        for _ in self.until("readyok"):
            pass

    def analyse(self, sfen, nodes):
        # YaneuraOu clears its search state on isready. Each decision starts
        # fresh, so color-swapped games do not borrow one another's hash table.
        self.send("usinewgame")
        self.ready()
        self.send("position sfen " + sfen)
        self.send(f"go nodes {nodes}")
        proposals, best = {}, None
        for line in self.until("bestmove"):
            info = parse_info(line)
            if info:
                rank = info["multipv"]
                if rank not in proposals or info["depth"] >= proposals[rank]["depth"]:
                    proposals[rank] = info
            if line.startswith("bestmove "):
                best = line.split()[1]
        return dict(bestmove=best, proposals=[proposals[k] for k in sorted(proposals)])

    def close(self):
        if self.process.poll() is None:
            try:
                self.send("quit")
                self.process.wait(timeout=2)
            except (RuntimeError, subprocess.TimeoutExpired):
                self.process.kill()
                self.process.wait()
        for reader in self.readers:
            reader.join(timeout=2)
        for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
            stream.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()
