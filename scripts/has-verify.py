#!/usr/bin/env python3
"""
scripts/has-verify.py  —  screenshot each main AC tile name in Apple's
HomeKit Accessory Simulator (HAS) as visual proof the plugin labels work.

Patches the AccessoryInformation.Name in the host Mac's own HAS BLE-adapter
file — this guarantees the plist format is always accepted by HAS. On first
run the script launches HAS briefly so it writes its BLE adapter file, then
uses that as the template for every test tile.

What this verifies
------------------
• Each main AC tile name (English, Japanese, Traditional Chinese) renders
  correctly in HAS — correct encoding, capitalisation, no garbled characters.
• AccessoryInformation.Name is set from the plugin's configured name.

What this does NOT verify (use the HAP pipeline instead)
---------------------------------------------------------
• Secondary service labels (Swing, Fan Auto, H-Swing, Humidity) — these are
  linked services inside the AC panel, not separate HAS tiles. HAS has no
  visual for service-level Name characteristics. The HAP verify pipeline
  (hap-verify.mjs) reads and asserts all LINKED: labels via the real protocol.
• Tile topology — that secondary services stay inside the AC panel and do not
  appear as independent room tiles. Verified by the HAP pipeline write test.

Bugs this catches
-----------------
• Wrong or garbled main tile label (encoding issue, wrong language string)
• AccessoryInformation.Name not set from plugin config name

Requirements
------------
• macOS only. HAS is a macOS desktop application.
• HomeKit Accessory Simulator from "Additional Tools for Xcode":
    https://developer.apple.com/download/all/

Usage
-----
  python3 scripts/has-verify.py              # saves to docs/has-screenshots/
  python3 scripts/has-verify.py /tmp/shots   # custom output directory

This script is NOT part of CI. For automated CI verification use the Docker
HAP verify pipeline, which proves tile names and linked service labels via
the real HAP protocol:
  docker compose -f docker-compose.test.yml up --build homebridge-test hap-verify
"""

import plistlib, struct, subprocess, sys, time, pathlib

# ── Paths ─────────────────────────────────────────────────────────────────────
HAS_APP = pathlib.Path("/Applications/HomeKit Accessory Simulator.app")
HAS_LIB = (pathlib.Path.home()
           / "Library/Application Support/HomeKit Accessory Simulator"
           / "HomeKit Accessory Simulator.haslibrary")
OUT_DIR = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path("docs/has-screenshots")

# ── Main AC tiles to verify ───────────────────────────────────────────────────
# HAS shows one tile per .hasaccessory file (AccessoryInformation.Name).
# Secondary service labels (Swing, Fan Auto, H-Swing, Humidity) are linked
# services inside each AC panel — verified by hap-verify.mjs, not here.
TILES = [
    "Living Room MAXE AC",  # English
    "リビングエアコン",          # Japanese
    "客廳冷氣",                # Traditional Chinese
]


# ── Plist template helpers ────────────────────────────────────────────────────

def _patch_name(template_data: bytes, new_name: str) -> bytes:
    """
    Patch AccessoryInformation.Name in a real HAS .hasaccessory file.

    Uses binary editing to avoid a plistlib round-trip, which is lossy for
    NSKeyedArchiver plists (plistlib inlines primitive UID references,
    producing a structurally different file that HAS rejects as corrupted).

    Strategy:
      1. Parse with plistlib (read-only) to locate the Name string's object
         index in the NSKeyedArchiver $objects table.
      2. Use the binary plist offset table to find the exact byte position of
         that object in the raw file.
      3. Read the existing encoded bytes directly from the file (no encoding
         assumption) and replace them with the new name's encoding.
      4. Shift all offset-table entries that point past the replaced bytes,
         and update the offset-table pointer in the trailer.

    Everything outside the replaced string bytes is byte-identical to the
    original file, so HAS always accepts it.
    """
    ACC_INFO_UUID_SHORT = 0x3E
    NAME_UUID_SHORT     = 0x23

    # ── Step 1: parse (read-only) to find the Name UID index ─────────────────
    d    = plistlib.loads(template_data)
    objs = d['$objects']

    root    = objs[d['$top']['root'].data]
    keys    = [objs[k.data] if hasattr(k, 'data') else k for k in root['NS.keys']]
    acc_idx = next(i for i, k in enumerate(keys) if k == 'accessory')
    acc     = objs[root['NS.objects'][acc_idx].data]

    name_uid_idx = None
    for svc_uid in objs[acc['HAK.services'].data]['NS.objects']:
        svc       = objs[svc_uid.data]
        svc_uuid  = objs[objs[svc['HAK.uuid'].data]['HAK.uuid'].data]
        svc_short = int.from_bytes(svc_uuid['NS.uuidbytes'][:4], 'big')
        if svc_short != ACC_INFO_UUID_SHORT:
            continue
        for char_uid in objs[svc['HAK.characteristics'].data]['NS.objects']:
            char       = objs[char_uid.data]
            char_uuid  = objs[objs[char['HAK.uuid'].data]['HAK.uuid'].data]
            char_short = int.from_bytes(char_uuid['NS.uuidbytes'][:4], 'big')
            if char_short != NAME_UUID_SHORT:
                continue
            val = char.get('HAK.value')
            if hasattr(val, 'data'):
                name_uid_idx = val.data
            break
        break

    if name_uid_idx is None:
        raise ValueError('Could not locate Name UID in template plist')

    # ── Step 2: locate the object in the raw binary file ─────────────────────
    trailer            = template_data[-32:]
    offset_size        = trailer[6]
    num_objects        = struct.unpack('>Q', trailer[8:16])[0]
    offset_table_start = struct.unpack('>Q', trailer[24:32])[0]

    entry_start = offset_table_start + name_uid_idx * offset_size
    obj_pos     = int.from_bytes(
        template_data[entry_start:entry_start + offset_size], 'big')

    # ── Step 3: read existing encoded bytes; encode new name ─────────────────
    old_enc = _bplist_read_str(template_data, obj_pos)
    new_enc = _bplist_encode_str(new_name)
    if old_enc == new_enc:
        return template_data

    delta = len(new_enc) - len(old_enc)

    # ── Step 4: splice the new string into the object area ───────────────────
    new_obj_area = (template_data[:obj_pos]
                    + new_enc
                    + template_data[obj_pos + len(old_enc):offset_table_start])

    # ── Step 5: rebuild offset table (shift entries after the patched object) ─
    new_off_table = bytearray()
    for i in range(num_objects):
        s   = offset_table_start + i * offset_size
        off = int.from_bytes(template_data[s:s + offset_size], 'big')
        if off > obj_pos:
            off += delta
        new_off_table += off.to_bytes(offset_size, 'big')

    # ── Step 6: update the offset_table_offset field in the trailer ──────────
    new_trailer = bytearray(trailer)
    struct.pack_into('>Q', new_trailer, 24, offset_table_start + delta)

    return bytes(new_obj_area) + bytes(new_off_table) + bytes(new_trailer)


def _bplist_read_str(data: bytes, pos: int) -> bytes:
    """Return the exact encoded bytes of the binary plist string object at pos."""
    marker = data[pos]
    typ    = marker >> 4
    low    = marker & 0x0F
    assert typ in (5, 6), f'Expected string object at offset {pos}, got {marker:#04x}'
    if low < 0xF:
        byte_count = low if typ == 5 else low * 2
        return data[pos:pos + 1 + byte_count]
    # Long string: marker byte, then an integer object, then chars
    int_marker = data[pos + 1]
    assert int_marker >> 4 == 1, f'Expected int marker at offset {pos + 1}, got {int_marker:#04x}'
    int_bytes  = 1 << (int_marker & 0xF)   # 0x10→1, 0x11→2, 0x12→4, 0x13→8
    char_count = int.from_bytes(data[pos + 2:pos + 2 + int_bytes], 'big')
    byte_count = char_count if typ == 5 else char_count * 2
    return data[pos:pos + 2 + int_bytes + byte_count]


def _bplist_encode_str(s: str) -> bytes:
    """Encode a Python string as a binary plist string object."""
    try:
        raw  = s.encode('ascii')
        code = 0x50
        nc   = len(raw)
    except UnicodeEncodeError:
        raw  = s.encode('utf-16-be')
        code = 0x60
        nc   = len(s)       # char count (not byte count) for UTF-16
    if nc < 15:
        return bytes([code | nc]) + raw
    # Long string: type|0xF + int-object encoding the char count + raw bytes
    int_enc = _bplist_encode_int(nc)
    return bytes([code | 0xF]) + int_enc + raw


def _bplist_encode_int(n: int) -> bytes:
    """Encode n as a binary plist integer object."""
    if n < 256:
        return bytes([0x10, n])
    if n < 65536:
        return bytes([0x11]) + struct.pack('>H', n)
    if n < 2 ** 32:
        return bytes([0x12]) + struct.pack('>I', n)
    return bytes([0x13]) + struct.pack('>Q', n)


def _ensure_template() -> bytes:
    """
    Return bytes of a valid .hasaccessory template from the HAS library.

    If no .hasaccessory file exists, launches HAS briefly so it writes its
    BLE-adapter file, then kills it and returns those bytes.
    """
    HAS_LIB.mkdir(parents=True, exist_ok=True)
    existing = list(HAS_LIB.glob('*.hasaccessory'))
    if existing:
        return existing[0].read_bytes()

    print('No .hasaccessory template found — launching HAS to create one...')
    (HAS_LIB / 'AppState.hasstate').unlink(missing_ok=True)
    subprocess.Popen(['open', '-a', 'HomeKit Accessory Simulator'])

    for _ in range(30):
        time.sleep(0.5)
        files = list(HAS_LIB.glob('*.hasaccessory'))
        if files:
            time.sleep(1.0)                # let HAS finish writing
            data = files[0].read_bytes()
            subprocess.run(['pkill', '-f', 'HomeKit Accessory Simulator'],
                           capture_output=True)
            time.sleep(0.8)
            print(f'  Template: {files[0].name}\n')
            return data

    subprocess.run(['pkill', '-f', 'HomeKit Accessory Simulator'], capture_output=True)
    sys.exit('ERROR: HAS did not create a BLE adapter file within 15 s.')


# ── HAS control helpers ───────────────────────────────────────────────────────

def _kill_has() -> None:
    subprocess.run(['pkill', '-f', 'HomeKit Accessory Simulator'], capture_output=True)
    time.sleep(0.8)


def _launch_has() -> None:
    # Remove AppState so HAS starts fresh with only the single test accessory
    (HAS_LIB / 'AppState.hasstate').unlink(missing_ok=True)
    subprocess.Popen(['open', '-a', 'HomeKit Accessory Simulator'])


_SWIFT_WID = r"""
import CoreGraphics
import Foundation
let wins = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] ?? []
var maxArea = 0
var mainWID = 0
for w in wins {
    guard let owner = w["kCGWindowOwnerName"] as? String,
          owner.contains("HomeKit"),
          let layer = w["kCGWindowLayer"] as? Int, layer == 0,
          let bounds = w["kCGWindowBounds"] as? [String: Any],
          let width  = bounds["Width"]  as? Int,
          let height = bounds["Height"] as? Int,
          height > 200
    else { continue }
    let area = width * height
    if area > maxArea { maxArea = area; mainWID = w["kCGWindowNumber"] as? Int ?? 0 }
}
print(mainWID)
"""


def _get_has_wid() -> int:
    """Return the CGWindowID of the main HAS window via CGWindowListCopyWindowInfo (Swift)."""
    out = subprocess.check_output(['swift', '-e', _SWIFT_WID],
                                  stderr=subprocess.DEVNULL).decode().strip()
    wid = int(out) if out else 0
    if wid == 0:
        raise ValueError('HAS main window not found via CGWindowListCopyWindowInfo')
    return wid


def _screenshot(wid: int, path: pathlib.Path) -> None:
    # -l captures by window ID regardless of focus; never use -x (focus-stealing risk)
    subprocess.run(['screencapture', '-l', str(wid), str(path)], check=True)


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    if not HAS_APP.is_dir():
        sys.exit(
            f'ERROR: HomeKit Accessory Simulator not found at {HAS_APP}\n'
            'Install "Additional Tools for Xcode" from:\n'
            '  https://developer.apple.com/download/all/'
        )

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # Ensure a valid template before touching the library
    _kill_has()
    template = _ensure_template()

    # Back up any existing accessories; restored unconditionally at the end
    backup: dict[str, bytes] = {}
    for f in HAS_LIB.glob('*.hasaccessory'):
        backup[f.name] = f.read_bytes()
    if backup:
        print(f'Backed up {len(backup)} existing accessory file(s) — will restore after run\n')

    results: list[tuple[str, bool]] = []

    try:
        _kill_has()

        for idx, tile in enumerate(TILES, 1):
            print(f'[{idx}/{len(TILES)}] {tile}')

            # HAS BLE constraint: only ONE accessory per session
            for f in HAS_LIB.glob('*.hasaccessory'):
                f.unlink()
            (HAS_LIB / f'{tile}.hasaccessory').write_bytes(_patch_name(template, tile))

            _launch_has()

            # Wait for HAS window (up to 10 s)
            wid: int | None = None
            for _ in range(20):
                time.sleep(0.5)
                try:
                    wid = _get_has_wid()
                    break
                except (subprocess.CalledProcessError, ValueError):
                    pass

            if wid is None:
                print('  WARNING: HAS window did not appear — skipping\n')
                results.append((tile, False))
                _kill_has()
                continue

            time.sleep(1.5)  # let HAS UI finish rendering

            out_path = OUT_DIR / f"{tile.replace(' ', '_')}.png"
            _screenshot(wid, out_path)
            print(f'  saved → {out_path}\n')
            results.append((tile, True))

            _kill_has()

    finally:
        # Restore original library
        for f in HAS_LIB.glob('*.hasaccessory'):
            f.unlink()
        for fname, data in backup.items():
            (HAS_LIB / fname).write_bytes(data)
        if backup:
            print(f'Restored {len(backup)} original accessory file(s)')

    # ── Summary ───────────────────────────────────────────────────────────────
    passed = sum(1 for _, ok in results if ok)
    failed = [t for t, ok in results if not ok]

    print(f"\n{'─'*60}")
    print(f'Result: {passed}/{len(TILES)} screenshots saved to {OUT_DIR}/')
    if failed:
        print(f'Failed: {failed}')
        sys.exit(1)
    print('Open each image and confirm the main AC tile name shown in HAS matches exactly.')
    print('For secondary service labels (Swing, Fan Auto, H-Swing, Humidity) run the HAP pipeline:')
    print('  docker compose -f docker-compose.test.yml up --build homebridge-test hap-verify')


if __name__ == '__main__':
    main()
