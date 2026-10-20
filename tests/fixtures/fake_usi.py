"""Deterministic USI transport fixture; it is not a shogi engine."""
import sys

side = "b"
for raw in sys.stdin:
    line = raw.strip()
    if line == "usi":
        print("id name USI transport fixture", flush=True)
        print("usiok", flush=True)
    elif line == "isready":
        print("readyok", flush=True)
    elif line.startswith("position sfen "):
        side = line.split()[3]
    elif line.startswith("go ") and "--stall" not in sys.argv:
        move = "7g7f" if side == "b" else "3c3d"
        print(f"info depth 4 multipv 1 score cp 9876 pv {move}", flush=True)
        print("bestmove " + move, flush=True)
    elif line == "quit":
        break
