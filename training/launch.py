"""Resume with the verified source snapshot that owns the checkpoint."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import signal
import subprocess
import sys
import zipfile
from uuid import uuid4
from .common import ROOT, FORMAT, fingerprint, read_json, load_config
from .session import prepare_resume, validate_continuation


def snapshot_fingerprint(directory):
    paths = [directory/name for name in ['Cargo.toml','Cargo.lock','RULES.md']]
    for folder, patterns in [('crates',['*.rs','Cargo.toml']),('training',['*.py','*.json','requirements.txt'])]:
        for pattern in patterns:
            paths.extend((directory/folder).rglob(pattern))
    digest = hashlib.sha256()
    for path in sorted(set(paths), key=lambda p:p.relative_to(directory).as_posix()):
        if not path.is_file() or path.is_symlink():
            raise ValueError(f'Missing or unsafe saved source: {path.name}')
        digest.update(path.relative_to(directory).as_posix().encode());digest.update(b'\0')
        digest.update(path.read_bytes().replace(b'\r\n',b'\n'))
    return digest.hexdigest()


def saved_source(run):
    manifest = read_json(Path(run)/'manifest.json')
    if not manifest or manifest.get('format') != FORMAT:
        raise ValueError('A committed training run is required')
    expected = manifest['source_fingerprint']
    if not re.fullmatch('[a-f0-9]{64}',expected):
        raise ValueError('Invalid source identity')
    if expected == fingerprint():
        return ROOT
    destination = ROOT/'.cache/training-sources'/expected
    if destination.is_dir() and snapshot_fingerprint(destination) == expected:
        return destination
    with zipfile.ZipFile(Path(run)/'source.zip') as archive:
        if sum(info.file_size for info in archive.infolist()) > 64*1024**2:
            raise ValueError('Saved source archive is too large')
        names = set()
        for info in archive.infolist():
            name = info.filename; path = PurePosixPath(name)
            allowed = name in ['Cargo.toml','Cargo.lock','RULES.md'] or (
                len(path.parts)>1 and path.parts[0] in ['training','crates'] and
                (path.suffix in ['.py','.rs','.json','.ipynb','.md'] or path.name in ['Cargo.toml','requirements.txt']))
            if not allowed or path.is_absolute() or '..' in path.parts or '\\' in name or ':' in name or name in names or ((info.external_attr >> 16) & 0o170000) == 0o120000:
                raise ValueError(f'Unsafe saved source entry: {name}')
            names.add(name)
        destination.mkdir(parents=True,exist_ok=True)
        for info in archive.infolist():
            target = destination/info.filename
            target.parent.mkdir(parents=True,exist_ok=True)
            target.write_bytes(archive.read(info))
    if snapshot_fingerprint(destination) != expected:
        raise ValueError('Saved source identity does not match the checkpoint; resume cancelled')
    return destination


def source_runtime_config(values, source):
    supported = read_json(source/'training/config.json')
    values = {k: v for k, v in values.items() if k in supported}
    if source != ROOT and values.get('external_ai_enabled'):
        # An extracted source snapshot has its own ROOT but no engine binaries.
        # Resolve the installed engine from the live project before changing cwd.
        from .external import external_settings
        command, options, weights = external_settings(values)
        values.update(external_ai_command=command, external_ai_options=options,
                      external_ai_weights=str(weights) if weights else '')
    return values


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-dir',required=True)
    parser.add_argument('--config')
    parser.add_argument('--resume',action='store_true')
    parser.add_argument('--until-generation',type=int)
    parser.add_argument('--mirror-dir')
    parser.add_argument('--prepare-only',action='store_true')
    args=parser.parse_args()
    run=Path(args.run_dir).resolve();source=saved_source(run)
    if args.prepare_only:
        print(json.dumps(dict(source=str(source),source_fingerprint=snapshot_fingerprint(source))))
        return
    manifest=read_json(run/'manifest.json')
    if args.until_generation is not None and args.until_generation<=manifest['generation']:
        raise ValueError('The stopping generation must exceed the committed generation')
    values=read_json(args.config) if args.config else manifest['config']
    current_config=load_config(overrides=values)
    validate_continuation(current_config,load_config(overrides=manifest['config']))
    saved_config=load_config(overrides=manifest['config'])
    changed=current_config != saved_config
    migrate=source != ROOT and changed
    destination=run.with_name(f'{run.name}-continued-{uuid4().hex[:10]}') if migrate else run
    if migrate:
        # Older snapshots reject changes to training budgets. Import their full
        # committed state into the current trainer without rewriting their source.
        source=ROOT
        values=current_config
    # Disabled new controls need not exist in an older verified snapshot.
    # Enabled/changed settings migrate above; exact resumption keeps its old schema.
    values=source_runtime_config(values, source)
    config=ROOT/'.cache/resume-configs'/f'{uuid4().hex}.json'
    config.parent.mkdir(parents=True,exist_ok=True)
    if not migrate:
        prepare_resume(run)
    config.write_text(json.dumps(values),encoding='utf-8')
    command=[sys.executable,'-u','-m','training.train','--run-dir',str(destination),'--config',str(config)]
    command+=['--continue-from',str(run)] if migrate else ['--resume']
    if args.until_generation is not None:command+=['--until-generation',str(args.until_generation)]
    if args.mirror_dir:command+=['--mirror-dir',str(Path(args.mirror_dir).resolve())]
    def stop(*_):
        destination.mkdir(parents=True,exist_ok=True)
        (destination/'STOP').write_text('Resume launcher stopped',encoding='utf-8')
    for signum in [signal.SIGINT,signal.SIGTERM]:signal.signal(signum,stop)
    print(json.dumps(dict(action='resume',source=str(source),run_dir=str(destination),generation=manifest['generation'])),flush=True)
    try:
        child=subprocess.Popen(command,cwd=source,env=dict(os.environ,PYTHONUNBUFFERED='1',PYTHONIOENCODING='utf-8'))
        raise SystemExit(child.wait())
    finally:
        config.unlink(missing_ok=True)


if __name__=='__main__':main()
