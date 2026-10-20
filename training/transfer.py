"""Explicit artifact transfer. A source snapshot stays an inactive nested ZIP."""
import argparse
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import tempfile
import zipfile
from .common import FORMAT, SCHEMA

ALLOWED = re.compile(r"source\.zip|(?:manifest|status)\.json|(?:checkpoints/g\d+\.pt)|(?:replay/g\d+\.(?:npz|rng\.json))|(?:generations/g\d+\.json)|(?:(?:games|probes|evaluations|local-evaluations)/[A-Za-z0-9_./-]+\.json)")


def allowed(name):
    p = PurePosixPath(name)
    return str(p) == name and not p.is_absolute() and ".." not in p.parts and "\\" not in name and bool(ALLOWED.fullmatch(name))


def export_run(run, output):
    run = Path(run)
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=1) as archive:
        for file in sorted(run.rglob("*")):
            name = file.relative_to(run).as_posix()
            if file.is_file() and not file.is_symlink() and allowed(name):
                archive.write(file, name)


def import_run(archive_path, destination):
    dest = Path(destination).resolve()
    if dest.exists():
        raise ValueError("Import destination already exists")
    dest.parent.mkdir(parents=True, exist_ok=True)
    temp = Path(tempfile.mkdtemp(prefix=".import-", dir=dest.parent))
    try:
        with zipfile.ZipFile(archive_path) as archive:
            members = archive.infolist()
            if len(members) > 10000 or sum(m.file_size for m in members) > 1024**3:
                raise ValueError("Archive exceeds the artifact limit (10000 files / 1 GiB)")
            names = set()
            for member in members:
                if member.is_dir():
                    continue
                if not allowed(member.filename) or member.filename in names or stat.S_ISLNK(member.external_attr >> 16):
                    raise ValueError(f"Invalid artifact path: {member.filename}")
                names.add(member.filename)
                target = (temp / member.filename).resolve()
                if not target.is_relative_to(temp):
                    raise ValueError("Archive path escapes the import directory")
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(member) as source, target.open("wb") as output:
                    shutil.copyfileobj(source, output)
            if not (temp / "manifest.json").is_file():
                raise ValueError("Missing manifest.json")
            manifest = json.loads((temp / "manifest.json").read_text(encoding="utf-8"))
            if manifest.get("format") != FORMAT or manifest.get("schema") != SCHEMA:
                raise ValueError("Unsupported run format")
            for field in ["latest_checkpoint", "champion_checkpoint", "replay_file", "rng_file"]:
                if not allowed(manifest[field]) or not (temp / manifest[field]).is_file():
                    raise ValueError(f"Missing artifact: {field}")
        temp.rename(dest)
    except Exception:
        shutil.rmtree(temp)
        raise
    return dest


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["export", "import"])
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--archive", required=True)
    args = parser.parse_args()
    if args.action == "export":
        export_run(args.run_dir, args.archive)
    else:
        import_run(args.archive, args.run_dir)
    print(args.run_dir)


if __name__ == "__main__":
    main()
