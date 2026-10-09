#!/usr/bin/env python3
"""Refresh pi-spaces from source and package the mobile runtime before every Android build."""
import gzip
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = Path(os.environ.get('PI_SPACES_SOURCE', str(ROOT.parent / 'pi-spaces'))).resolve()
RUNTIME = ROOT / 'runtime'
ASSETS = ROOT / 'android/app/src/main/assets'
FILES = ['server.mjs', 'common.mjs', 'remote-env.mjs', 'env-server.mjs', 'pi-serverd.mjs',
         'remote-client.mjs', 'remote-provision.mjs', 'remote-state.mjs', 'pi-spaces.mjs', 'package.json',
         'package-lock.json', 'public', 'node_modules']

source_available = (SOURCE / 'scripts/bundle-mobile.mjs').is_file()
if not source_available:
    print(f'WARNING: pi-spaces source checkout missing or incompatible: {SOURCE}; '
          'using existing mobile bundles without refreshing them. Set PI_SPACES_SOURCE to enable refresh.',
          file=sys.stderr)
if not (RUNTIME / 'node_modules/@earendil-works/pi-durable').is_dir():
    raise SystemExit('Mobile runtime dependencies missing; install the locked runtime dependencies first')
if not (ASSETS / 'rootfs.bin').is_file():
    raise SystemExit('Termux rootfs.bin is missing; prepare the rootfs asset first')
for name in FILES:
    if name not in ('pi-spaces.mjs', 'space-examples') and not (RUNTIME / name).exists():
        raise SystemExit(f'Required runtime input missing: {name}')
if source_available:
    subprocess.run(['npm', 'run', 'bundle'], cwd=SOURCE, check=True,
                   env={**os.environ, 'PI_SPACES_MOBILE_ROOT': str(ROOT)})
if not (RUNTIME / 'pi-spaces.mjs').is_file():
    raise SystemExit('Required mobile bundle missing: pi-spaces.mjs; prepare it from a pi-spaces source checkout first')
if (RUNTIME / 'space-examples').is_dir():
    FILES.append('space-examples')
else:
    print('WARNING: optional space-examples missing; packaging the runtime without CLI examples', file=sys.stderr)

def entries(path):
    if path.name == '.bin':
        return
    # Retain valid links, exclude broken links without deleting developer files.
    if path.is_symlink():
        if path.exists():
            yield path
        return
    yield path
    if path.is_dir():
        for child in sorted(path.iterdir()):
            yield from entries(child)

def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.digest()

def replace_if_changed(source, target):
    if target.is_file() and digest(source) == digest(target):
        source.unlink()
    else:
        source.replace(target)

ASSETS.mkdir(parents=True, exist_ok=True)
temporary = None
try:
    with tempfile.NamedTemporaryFile(dir=ASSETS, suffix='.tmp', delete=False) as raw:
        temporary = Path(raw.name)
        with gzip.GzipFile(fileobj=raw, mode='wb', filename='', mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode='w', format=tarfile.USTAR_FORMAT) as archive:
                for name in FILES:
                    for path in entries(RUNTIME / name):
                        info = archive.gettarinfo(str(path), 'runtime/' + path.relative_to(RUNTIME).as_posix())
                        info.uid = info.gid = info.mtime = 0
                        info.uname = info.gname = ''
                        if info.isfile():
                            with path.open('rb') as stream:
                                archive.addfile(info, stream)
                        else:
                            archive.addfile(info)
    replace_if_changed(temporary, ASSETS / 'runtime.bin')
    temporary = None
    # Both payloads determine extraction; RuntimeInstaller's version still covers installer changes.
    fingerprint = hashlib.sha256(digest(ASSETS / 'rootfs.bin') + digest(ASSETS / 'runtime.bin')).hexdigest()
    with tempfile.NamedTemporaryFile(dir=ASSETS, suffix='.tmp', delete=False) as raw:
        temporary = Path(raw.name)
        raw.write((fingerprint + '\n').encode('ascii'))
    replace_if_changed(temporary, ASSETS / 'payload.sha256')
    temporary = None
    print(f'Mobile assets prepared; payload {fingerprint}')
finally:
    if temporary:
        temporary.unlink(missing_ok=True)
