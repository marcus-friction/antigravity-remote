"""Validate 64-bit ELF LOAD segments and uncompressed APK library alignment."""
import struct
import sys
import zipfile
from pathlib import Path


def check_elf(name, data):
    if data[:6] != b'\x7fELF\x02\x01':
        raise ValueError(f'{name}: expected a 64-bit little-endian ELF library')
    offset = struct.unpack_from('<Q', data, 32)[0]
    entry_size, count = struct.unpack_from('<HH', data, 54)
    loads = 0
    for index in range(count):
        position = offset + index * entry_size
        if struct.unpack_from('<I', data, position)[0] != 1:
            continue
        loads += 1
        alignment = struct.unpack_from('<Q', data, position + 48)[0]
        if alignment < 16384:
            raise ValueError(f'{name}: LOAD alignment is {alignment}, requires at least 16384')
    if not loads:
        raise ValueError(f'{name}: missing ELF LOAD segments')


def check_artifact(target):
    checked = 0
    with zipfile.ZipFile(target) as archive, target.open('rb') as raw:
        for info in archive.infolist():
            if not info.filename.endswith('.so') or not any(
                f'/{arch}/' in info.filename for arch in ['arm64-v8a', 'x86_64']
            ):
                continue
            check_elf(info.filename, archive.read(info))
            if target.suffix == '.apk' and info.compress_type == zipfile.ZIP_STORED:
                raw.seek(info.header_offset + 26)
                name_length, extra_length = struct.unpack('<HH', raw.read(4))
                data_offset = info.header_offset + 30 + name_length + extra_length
                if data_offset % 16384:
                    raise ValueError(f'{info.filename}: APK data offset is not 16 KB aligned')
            checked += 1
    if not checked:
        raise ValueError('No 64-bit native libraries found; build arm64-v8a and/or x86_64 first')
    return checked


if __name__ == '__main__':
    artifact = Path(sys.argv[1]) if len(sys.argv) > 1 else (
        Path(__file__).resolve().parents[1] / 'android/app/build/outputs/bundle/release/app-release.aab'
    )
    try:
        count = check_artifact(artifact)
    except (OSError, ValueError, struct.error, zipfile.BadZipFile) as error:
        sys.exit(str(error))
    print(f'16 KB compatibility verified for {count} native libraries in {artifact.name}')
