"""Copy a stopped run across the verified Windows I/O-only patch.

The original run stays untouched. All checkpoint tensors, optimizer and RNG
states are retained; only audited source provenance changes in the new copy.
"""
import argparse
import ast
import hashlib
import json
from pathlib import Path
import shutil
import tempfile
import time
import zipfile

from training.common import ROOT, FORMAT, SCHEMA, source_files, fingerprint, read_json, atomic_json, rules_hash, rules_for
from training.storage import replace_file

IO_FILES = {'training/common.py', 'training/train.py', 'training/replay.py'}


def source_hash(files):
    digest = hashlib.sha256()
    for name, data in sorted(files.items()):
        digest.update(name.encode())
        digest.update(b'\0')
        digest.update(data.replace(b'\r\n', b'\n'))
    return digest.hexdigest()


class NormalizeIO(ast.NodeTransformer):
    def visit_ImportFrom(self, node):
        if node.level == 1 and node.module == 'storage' and [(a.name, a.asname) for a in node.names] == [('replace_file', None)]:
            return None
        return node

    def visit_Call(self, node):
        self.generic_visit(node)
        if isinstance(node.func, ast.Name) and node.func.id == 'replace_file':
            node.func = ast.Attribute(value=ast.Name(id='os', ctx=ast.Load()), attr='replace', ctx=ast.Load())
        return node


def verify_sources(previous, current, expected_hash):
    if source_hash(previous) != expected_hash:
        raise ValueError('The original source snapshot does not match the run fingerprint')
    if set(current) - set(previous) != {'training/storage.py'} or set(previous) - set(current):
        raise ValueError('Recovery permits only the additional storage retry helper')
    changed = []
    for name in previous:
        before, after = previous[name].replace(b'\r\n', b'\n'), current[name].replace(b'\r\n', b'\n')
        if before == after:
            continue
        if name not in IO_FILES:
            raise ValueError(f'Non-I/O source change: {name}')
        old_ast = ast.dump(NormalizeIO().visit(ast.parse(before)), include_attributes=False)
        new_ast = ast.dump(NormalizeIO().visit(ast.parse(after)), include_attributes=False)
        if old_ast != new_ast:
            raise ValueError(f'Learning logic changed: {name}')
        changed.append(name)
    return sorted(changed)


def snapshot_sources(path):
    def tracked(name):
        return name in ['Cargo.toml', 'Cargo.lock', 'RULES.md'] or (
            name.startswith('crates/') and (name.endswith('.rs') or name.endswith('/Cargo.toml'))) or (
            name.startswith('training/') and '__pycache__' not in name and (
                name.endswith('.py') or name.endswith('.json') or name.endswith('/requirements.txt')))
    with zipfile.ZipFile(path) as archive:
        if sum(info.file_size for info in archive.infolist()) > 32 * 1024**2:
            raise ValueError('Oversized source snapshot')
        names = archive.namelist()
        if len(names) != len(set(names)):
            raise ValueError('Ambiguous source snapshot')
        return {name: archive.read(name) for name in names if tracked(name)}


def same_state(before, after):
    import torch
    if isinstance(before, torch.Tensor):
        return isinstance(after, torch.Tensor) and before.dtype == after.dtype and torch.equal(before, after)
    if type(before) is not type(after):
        return False
    if isinstance(before, dict):
        return before.keys() == after.keys() and all(same_state(value, after[key]) for key, value in before.items())
    if isinstance(before, (list, tuple)):
        return len(before) == len(after) and all(same_state(a, b) for a, b in zip(before, after))
    return before == after


def recover(run, destination):
    import torch
    run, destination = Path(run).resolve(), Path(destination).resolve()
    runs_root = (ROOT / 'dashboard/runs').resolve()
    if not run.is_relative_to(runs_root) or not destination.is_relative_to(runs_root) or destination == runs_root:
        raise ValueError('Recovery paths must be inside dashboard/runs')
    if destination.exists():
        raise ValueError('The destination already exists')
    if (run / 'RUNNING').exists():
        raise ValueError('The original trainer must be stopped first')
    original_manifest = (run / 'manifest.json').read_bytes()
    manifest = json.loads(original_manifest)
    if manifest.get('format') != FORMAT or manifest.get('schema') != SCHEMA:
        raise ValueError('Unsupported run format')
    previous = snapshot_sources(run / 'source.zip')
    current = {path.relative_to(ROOT).as_posix(): path.read_bytes() for path in source_files()}
    changed = verify_sources(previous, current, manifest['source_fingerprint'])
    new_hash = source_hash(current)
    if new_hash != fingerprint() or manifest['rules_hash'] != rules_hash(rules_for(manifest['config'])):
        raise ValueError('Rule or source identity mismatch')
    original_status = read_json(run / 'status.json', {})
    audit = {'kind': 'windows-storage-retry', 'parent_run': run.name, 'generation': manifest['generation'],
             'parent_source_fingerprint': manifest['source_fingerprint'], 'new_source_fingerprint': new_hash,
             'verified_io_changes': changed, 'timestamp': time.time(), 'original_error': original_status.get('error'),
             'checkpoint_change': 'Source provenance only; model/optimizer/scaler/RNG states retained'}
    cache = ROOT / '.cache/io-recovery'
    cache.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=cache) as folder:
        stage = Path(folder) / 'run'
        shutil.copytree(run, stage, ignore=shutil.ignore_patterns('RUNNING', 'STOP', '*.tmp'))
        for path in sorted((stage / 'checkpoints').glob('g*.pt')):
            checkpoint = torch.load(path, map_location='cpu', weights_only=True)
            if checkpoint.get('source_fingerprint') != manifest['source_fingerprint'] or checkpoint.get('rules_hash') != manifest['rules_hash']:
                raise ValueError(f'Checkpoint identity mismatch: {path.name}')
            checkpoint['recovery_parent_source_fingerprint'] = manifest['source_fingerprint']
            checkpoint['source_fingerprint'] = new_hash
            torch.save(checkpoint, path.with_suffix('.tmp'))
            if not same_state(checkpoint, torch.load(path.with_suffix('.tmp'), map_location='cpu', weights_only=True)):
                raise ValueError(f'Checkpoint roundtrip changed training state: {path.name}')
            replace_file(path.with_suffix('.tmp'), path)
        manifest.update(name=destination.name, created=audit['timestamp'], source_fingerprint=new_hash, recovery=audit)
        atomic_json(stage / 'manifest.json', manifest)
        atomic_json(stage / 'status.json', dict(original_status, phase='stopped', error=None, updated=time.time(),
                    note='Recovered from a Windows file lock; ready to resume the saved generation'))
        with zipfile.ZipFile(stage / 'source.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
            for path in source_files() + [ROOT / 'training/colab.ipynb', ROOT / 'training/README.md']:
                archive.write(path, path.relative_to(ROOT).as_posix())
            archive.write(run / 'source.zip', 'recovery/original-source.zip')
            archive.writestr('recovery/audit.json', json.dumps(audit, ensure_ascii=False, indent=2))
        if (run / 'manifest.json').read_bytes() != original_manifest or (run / 'RUNNING').exists() or fingerprint() != new_hash:
            raise ValueError('The run or sources changed during recovery')
        destination.parent.mkdir(parents=True, exist_ok=True)
        replace_file(stage, destination)
    return audit


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-dir', required=True)
    parser.add_argument('--destination', required=True)
    args = parser.parse_args()
    print(json.dumps(recover(args.run_dir, args.destination), ensure_ascii=False, indent=2))
