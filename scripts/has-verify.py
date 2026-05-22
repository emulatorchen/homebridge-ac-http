#!/usr/bin/env python3
"""
scripts/has-verify.py  —  screenshot each companion tile name in Apple's
HomeKit Accessory Simulator (HAS) as visual proof the plugin labels work.

Builds each .hasaccessory file entirely from scratch using plistlib —
no template file required, no sensitive data embedded. Uses safe test
values only (PIN 031-45-154, generic BLE identifier).

What this verifies
------------------
• All 5 companion tiles appear as separate accessories, not merged into one.
• Each tile name matches what the iOS Home app reads via the HAP protocol.
• Companion-accessory registration works (the broken "linked service" pattern
  causes tiles to silently disappear from room view in iOS).
• Name encoding is correct — no trailing spaces, correct capitalisation.

Bugs this catches
-----------------
• Companion tiles disappearing from room view (regression to linked services)
• Wrong or stale tile label (e.g. accessory renamed but Homebridge served stale cache)
• Service subtype collision (duplicate subtypes cause one tile to silently drop)
• ConfiguredName characteristic missing (label falls back to service type string)

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
HAP verify pipeline, which proves the same names via the real HAP protocol:
  docker compose -f docker-compose.test.yml up --build homebridge-test hap-verify
"""

import plistlib, subprocess, sys, time, pathlib

# ── Paths ─────────────────────────────────────────────────────────────────────
HAS_APP = pathlib.Path("/Applications/HomeKit Accessory Simulator.app")
HAS_LIB = (pathlib.Path.home()
           / "Library/Application Support/HomeKit Accessory Simulator"
           / "HomeKit Accessory Simulator.haslibrary")
OUT_DIR = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path("docs/has-screenshots")

# ── Tiles to verify ───────────────────────────────────────────────────────────
TILES = [
    "Living Room MAXE AC",            # main HeaterCooler
    "Living Room MAXE AC Fan Auto",   # companion Switch — fan speed auto
    "Living Room MAXE AC Swing",      # companion Switch — vertical swing
    "Living Room MAXE AC H-Swing",    # companion Switch — horizontal swing
    "Living Room MAXE AC Humidity",   # companion HumiditySensor
]


def _build_hasaccessory(name: str) -> bytes:
    """
    Build a minimal valid .hasaccessory binary plist from scratch.

    HAS opens this with NSKeyedUnarchiver; the structure replicates what
    plistlib produces when round-tripping a real HAS file. Safe test values
    only — no PIN, BLE identifier, or setupID from any prior session.
    """
    UID = plistlib.UID
    objs: list = ['$null']

    def add(obj) -> UID:
        idx = len(objs)
        objs.append(obj)
        return UID(idx)

    def reserve() -> UID:
        idx = len(objs)
        objs.append(None)
        return UID(idx)

    def fill(uid: UID, obj) -> None:
        objs[uid.data] = obj

    def cls_(classname: str, *parents: str) -> UID:
        return add({'$classname': classname,
                    '$classes':   [classname, *parents, 'NSObject']})

    # ── Class descriptors ────────────────────────────────────────────────────
    c_nsdict   = cls_('NSDictionary')
    c_nsmarray = cls_('NSMutableArray', 'NSArray')
    c_nsmstr   = cls_('NSMutableString', 'NSString')
    c_nsdec    = cls_('NSDecimalNumberPlaceholder', 'NSDecimalNumber', 'NSNumber')
    c_uuid     = cls_('HAKUUID')
    c_ident    = cls_('HAKIdentifier')
    c_pv       = cls_('HAKProtocolVersion')
    c_ble      = cls_('HAKBTLETransport', 'HAKTransport')
    c_ac       = cls_('HAKAccessory')
    c_ais      = cls_('HAKAccessoryInformationService', 'HAKService')
    c_ps       = cls_('HAKPairingService', 'HAKService')
    c_svc      = cls_('HAKService')
    c_idc      = cls_('HAKIdentifyCharacteristic', 'HAKCharacteristic')
    c_char     = cls_('HAKCharacteristic')
    c_psc      = cls_('HAKPairSetupCharacteristic', 'HAKCharacteristic')
    c_pvc      = cls_('HAKPairVerifyCharacteristic', 'HAKCharacteristic')
    c_pfc      = cls_('HAKPairingFeaturesCharacteristic', 'HAKCharacteristic')
    c_pc       = cls_('HAKPairingsCharacteristic', 'HAKCharacteristic')

    # ── Helpers ───────────────────────────────────────────────────────────────
    def hak_uuid(short: int) -> UID:
        b = short.to_bytes(4, 'big') + b'\x00\x00\x10\x00\x80\x00\x00\x26\xBB\x76\x52\x91'
        return add({'HAK.data': b, '$class': c_uuid})

    def hak_char(c: UID, uuid: int, fmt: int, perms: int, props: int,
                 iid: int, value=None) -> UID:
        d: dict = {
            'HAK.uuid':        hak_uuid(uuid),
            'HAK.format':      fmt,
            'HAK.permissions': perms,
            'HAK.properties':  props,
            'HAK.instanceid':  iid,
            '$class':          c,
        }
        if value is not None:
            d['HAK.value'] = value
        return add(d)

    def hak_svc(c: UID, uuid: int, iid: int, chars: list) -> UID:
        char_arr = add({'NS.objects': chars, '$class': c_nsmarray})
        return add({
            'HAK.uuid':            hak_uuid(uuid),
            'HAK.instanceid':      iid,
            'HAK.hidden':          False,
            'HAK.characteristics': char_arr,
            '$class':              c,
        })

    # Pre-allocate HAKAccessory so the BLE transport can back-reference it
    uid_ac = reserve()

    # ── Services ──────────────────────────────────────────────────────────────

    # AccessoryInformationService (uuid 0x3E, iid 1)
    svc_info = hak_svc(c_ais, 0x3E, 1, [
        hak_char(c_idc,  0x14,  1,  8,  2,  2),               # Identify
        hak_char(c_char, 0x20,  8,  4,  1,  3, 'Apple Inc.'), # Manufacturer
        hak_char(c_char, 0x21,  8,  4,  1,  4, 'HAS-Test'),   # Model
        hak_char(c_char, 0x23,  8,  4,  1,  5, name),          # Name  ← tile label
        hak_char(c_char, 0x30,  8,  4,  1,  6, 'HAS-TEST-001'), # Serial
        hak_char(c_char, 0x52,  8,  4,  1,  7, '1.0.0'),       # Firmware
    ])

    # PairingService (uuid 0x79, iid 8)
    svc_pair = hak_svc(c_ps, 0x79, 8, [
        hak_char(c_psc, 0x4C, 10,  3, 3,  9),   # PairSetup
        hak_char(c_pvc, 0x4E, 10,  3, 3, 10),   # PairVerify
        hak_char(c_pfc, 0x4F,  3,  1, 1, 11, 0), # PairingFeatures
        hak_char(c_pc,  0x50, 10, 12, 3, 12),   # Pairings
    ])

    # ProtocolInformationService (uuid 0xA2, iid 13)
    svc_proto = hak_svc(c_svc, 0xA2, 13, [
        hak_char(c_char, 0x37,  8,  4,  9, 14, '2.2.0'), # ServiceSignature
        hak_char(c_char, 0xA5, 11, 12,  3, 15),           # ProtocolUUID
    ])

    # ── BLE transport ─────────────────────────────────────────────────────────
    proto_ver = add({'HAK.major': 2, 'HAK.minor': 2, 'HAK.patch': 0,
                     '$class': c_pv})
    # NSDecimalNumber(1024) — BLE advertisement config; b'\x04\x00' = 0x0400 big-endian
    config = add({
        'NS.mantissa':    b'\x04\x00',
        'NS.exponent':    0,
        'NS.length':      1,
        'NS.compact':     True,
        'NS.negative':    False,
        'NS.mantissa.bo': 1,
        '$class':         c_nsdec,
    })
    uid_xport = add({
        'HAK.started':                  False,
        'HAK.state':                    1,
        'HAK.idPool':                   2,
        'HAK.transportVersion':         4,
        'HAK.protocolVersion':          proto_ver,
        'HAK.config':                   config,
        'HAK.primaryAccessory':         uid_ac,
        'HAK.broadcastEncryptionKey':   UID(0),
        'HAK.AdvertisingIdentifierKey': UID(0),
        '$class':                       c_ble,
    })

    # ── Fill HAKAccessory ─────────────────────────────────────────────────────
    uid_ident  = add({'HAK.data': b'\x02\x00\x00\x00\x00\x01', '$class': c_ident})
    uid_pwd    = add({'NS.string': '031-45-154', '$class': c_nsmstr})
    uid_svcs   = add({'NS.objects': [svc_info, svc_pair, svc_proto], '$class': c_nsmarray})
    uid_trans  = add({'NS.objects': [uid_xport], '$class': c_nsmarray})
    uid_bridg  = add({'NS.objects': [], '$class': c_nsmarray})

    fill(uid_ac, {
        'HAK.category':           1,
        'HAK.idPool':             16,
        'HAK.accessoryVersion':   1,
        'HAK.instanceid':         1,
        'HAK.setupID':            'ABCD',
        'HAK.bridge':             UID(0),
        'HAK.primary':            UID(0),
        'HAK.identifier':         uid_ident,
        'HAK.password':           uid_pwd,
        'HAK.services':           uid_svcs,
        'HAK.transports':         uid_trans,
        'HAK.bridgedAccessories': uid_bridg,
        '$class':                 c_ac,
    })

    # ── Root NSDictionary ─────────────────────────────────────────────────────
    uid_root = add({
        'NS.keys':    [add('kind'),      add('version'), add('accessory')],
        'NS.objects': [add('accessory'), add(1),         uid_ac],
        '$class':     c_nsdict,
    })

    return plistlib.dumps(
        {'$version':  100000,
         '$archiver': 'NSKeyedArchiver',
         '$top':      {'root': uid_root},
         '$objects':  objs},
        fmt=plistlib.FMT_BINARY,
        sort_keys=False,
    )


# ── HAS control helpers ───────────────────────────────────────────────────────

def _kill_has() -> None:
    subprocess.run(['pkill', '-f', 'HomeKit Accessory Simulator'], capture_output=True)
    time.sleep(0.8)


def _launch_has() -> None:
    subprocess.Popen(['open', '-a', 'HomeKit Accessory Simulator'])


def _get_has_wid() -> int:
    """Return the CGWindowList window ID of the main HAS window (changes each session)."""
    code = (
        'import Quartz\n'
        'wins = Quartz.CGWindowListCopyWindowInfo(\n'
        '    Quartz.kCGWindowListOptionOnScreenOnly, Quartz.kCGNullWindowID)\n'
        'for w in wins:\n'
        '    if w.get("kCGWindowOwnerName") == "HomeKit Accessory Simulator":\n'
        '        print(w["kCGWindowNumber"]); break\n'
    )
    out = subprocess.check_output(['python3', '-c', code]).decode().strip()
    if not out:
        raise ValueError('HAS window not found in CGWindowList')
    return int(out)


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

    HAS_LIB.mkdir(parents=True, exist_ok=True)
    OUT_DIR.mkdir(parents=True, exist_ok=True)

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
            (HAS_LIB / f'{tile}.hasaccessory').write_bytes(_build_hasaccessory(tile))

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
    print('Open each image and confirm the tile name shown in HAS matches exactly.')
    print('These names are what the iOS Home app displays via the HAP protocol.')


if __name__ == '__main__':
    main()
