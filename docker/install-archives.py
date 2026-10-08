#!/usr/bin/env python3
"""Extract explicitly selected tool archives during a Docker image build."""
import copy
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import sys
import tarfile
import zipfile


def stripped(name: str, count: int) -> str | None:
    name = name.replace('\\', '/')
    parts = PurePosixPath(name).parts
    if name.startswith('/') or '..' in parts or (parts and ':' in parts[0]):
        raise ValueError(f'Unsafe archive member: {name}')
    remaining = parts[count:]
    return '/'.join(remaining) if remaining else None


def unpack(source: Path, destination: Path, count: int) -> None:
    if count < 0:
        raise ValueError('stripComponents must be nonnegative')
    destination.mkdir(parents=True, exist_ok=True)
    if zipfile.is_zipfile(source):
        root = destination.resolve()
        with zipfile.ZipFile(source) as archive:
            for item in archive.infolist():
                name = stripped(item.filename, count)
                if not name:
                    continue
                target = destination / name
                if not target.resolve().is_relative_to(root):
                    raise ValueError(f'ZIP member escapes destination: {item.filename}')
                mode = item.external_attr >> 16
                if item.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                if stat.S_ISLNK(mode):
                    link = archive.read(item).decode('utf-8')
                    if os.path.isabs(link) or not (target.parent / link).resolve().is_relative_to(root):
                        raise ValueError(f'Unsafe ZIP symlink: {item.filename}')
                    if target.is_symlink() or target.exists():
                        target.unlink()
                    target.symlink_to(link)
                else:
                    with archive.open(item) as src, target.open('wb') as dst:
                        shutil.copyfileobj(src, dst)
                    if mode & 0o777:
                        target.chmod(mode & 0o777)
    else:
        if not hasattr(tarfile, 'data_filter'):
            raise RuntimeError('Python with tarfile.data_filter is required (Python 3.12 or a supported backport)')
        with tarfile.open(source) as archive:
            def member_filter(member: tarfile.TarInfo, dest: str) -> tarfile.TarInfo | None:
                name = stripped(member.name, count)
                if not name:
                    return None
                item = copy.copy(member)
                item.name = name
                if item.islnk():
                    link = stripped(item.linkname, count)
                    if not link:
                        raise ValueError(f'Hardlink target removed by stripComponents: {member.name}')
                    item.linkname = link
                return tarfile.data_filter(item, dest)
            archive.extractall(destination, filter=member_filter)


def main() -> None:
    manifest = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
    base = Path(sys.argv[2]).resolve()
    for item in manifest:
        source = (base / item['source']).resolve()
        if not source.is_relative_to(base):
            raise ValueError('Archive source escapes staging directory')
        destination = Path(item['destination'])
        if not destination.is_absolute() or destination == Path('/') or '..' in destination.parts:
            raise ValueError('Invalid destination')
        print(f'Extract {source.name} -> {destination}', flush=True)
        unpack(source, destination, int(item.get('stripComponents', 0)))


if __name__ == '__main__':
    main()
