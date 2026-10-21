"""Narrow legacy v0.6 verification and lossless input-plane expansion."""
import hashlib
import json
from pathlib import Path
import zipfile
from .common import ROOT, read_json, LEGACY_SCHEMA, SCHEMA, FORMAT


def file_hash(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def network_hash(model):
    digest = hashlib.sha256()
    for name, tensor in sorted(model.state_dict().items()):
        digest.update(name.encode())
        digest.update(tensor.detach().cpu().contiguous().numpy().tobytes())
    return digest.hexdigest()


def legacy_official_hash_valid(checkpoint_path, checkpoint, rules):
    if checkpoint.get("schema") != LEGACY_SCHEMA or rules.get("balance") or rules.get("profile") != "official-v0.6":
        return False
    run = Path(checkpoint_path).resolve().parent.parent
    manifest = read_json(run / "manifest.json")
    if not manifest or manifest.get("rules") != rules or manifest.get("rules_hash") != checkpoint.get("rules_hash"):
        return False
    expected = read_json(ROOT / "training/legacy-v06.json")
    digest = hashlib.sha256(json.dumps(rules, sort_keys=True).encode())
    try:
        with zipfile.ZipFile(run / "source.zip") as archive:
            for name in ["RULES.md", "crates/shogi-core/src/resolution.rs", "crates/shogi-core/src/types.rs"]:
                trusted_hash = expected[name]
                source = archive.read(name).replace(b"\r\n", b"\n")
                if hashlib.sha256(source).hexdigest() != trusted_hash:
                    return False
                digest.update(source)
    except (OSError, KeyError, zipfile.BadZipFile):
        return False
    return digest.hexdigest() == checkpoint["rules_hash"]


def expanded_weights(weights, model):
    import torch
    result = dict(weights)
    old = result["input.0.weight"]
    shape = model.state_dict()["input.0.weight"].shape
    if old.shape[1] == 54 and shape[1] == 62:
        padded = torch.zeros(shape, dtype=old.dtype, device=old.device)
        padded[:, :54] = old
        result["input.0.weight"] = padded
    return result


def load_initial_weights(path, device):
    """Explicit weights-only transfer across rule profiles, verified against the source archive.

    Evaluation and exact resumption must still use load_model's current-rule checks.
    """
    import torch
    from .model import Net
    path = Path(path).resolve()
    checkpoint = torch.load(path, map_location='cpu', weights_only=True)
    manifest = read_json(path.parent.parent/'manifest.json')
    if checkpoint.get('format') != FORMAT or checkpoint.get('schema') not in [SCHEMA, LEGACY_SCHEMA]:
        raise ValueError('Unsupported warm-start checkpoint schema')
    if not manifest or manifest.get('format') != FORMAT or manifest.get('rules_hash') != checkpoint.get('rules_hash') or manifest.get('source_fingerprint') != checkpoint.get('source_fingerprint'):
        raise ValueError('Warm-start checkpoint does not match its saved run')
    digest = hashlib.sha256(json.dumps(manifest['rules'], sort_keys=True).encode())
    try:
        with zipfile.ZipFile(path.parent.parent/'source.zip') as archive:
            for name in ['RULES.md', 'crates/shogi-core/src/resolution.rs', 'crates/shogi-core/src/types.rs']:
                digest.update(archive.read(name).replace(b'\r\n', b'\n'))
    except (OSError, KeyError, zipfile.BadZipFile) as error:
        raise ValueError('Warm start requires the source rule archive') from error
    if digest.hexdigest() != checkpoint['rules_hash']:
        raise ValueError('Warm-start rule archive differs from the saved checkpoint')
    model = Net(checkpoint['channels']).to(device)
    model.load_state_dict(expanded_weights(checkpoint['model'], model))
    model.eval()
    return model, checkpoint
