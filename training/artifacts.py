"""Generation-bound evidence follows the manifest's last committed pointer."""
from pathlib import PurePosixPath
import re


def committed(name, generation):
    parts = PurePosixPath(name).parts
    if not parts or parts[0] not in ["checkpoints", "replay", "generations", "games", "probes", "evidence", "evaluations", "comparisons"]:
        return True
    for part in parts[1:]:
        match = re.match(r"^g(\d+)(?:[-.]|$)", part)
        if match and int(match[1]) > generation:
            return False
    return True
