/**
 * Platform integration test — verifies that companion accessories are registered
 * with the correct AccessoryInformation.Name so iOS tile labels will be visible.
 *
 * Runs the full AcHttpPlatform with a real PlatformAccessory constructor and a
 * real Homebridge API mock. Captures every accessory passed to
 * registerPlatformAccessories and checks names directly.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import path from 'path';
import { AcHttpPlatform } from './platform.js';
const req = createRequire(import.meta.url);
// hap-nodejs is @homebridge/hap-nodejs on HB 2.x, hap-nodejs on HB 1.x
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let hapMod: any;
try { hapMod = req('@homebridge/hap-nodejs'); } catch { hapMod = req('hap-nodejs'); }
const { Accessory: HapAccessory, Service, Characteristic, HAPStatus, HapStatusError, uuid } = hapMod;
// platformAccessory.js lives next to homebridge's main entry (dist/ on HB 2.x, lib/ on HB 1.x)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { PlatformAccessory } = req(
  path.join(path.dirname(req.resolve('homebridge')), 'platformAccessory.js')
) as any;

function makeFakeApi(config: object) {
  const registered: typeof PlatformAccessory[] = [];
  let launchCb: (() => void) | undefined;

  const api = {
    hap: { Service, Characteristic, HAPStatus, HapStatusError, uuid },
    platformAccessory: PlatformAccessory,
    on: (_event: string, cb: () => void) => { launchCb = cb; },
    registerPlatformAccessories: (_pn: string, _pl: string, accs: typeof PlatformAccessory[]) => {
      registered.push(...accs);
    },
    updatePlatformAccessories: () => {},
    unregisterPlatformAccessories: () => {},
  };

  const platform = new AcHttpPlatform(
    { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
    { platform: 'AcHttpPlatform', ...config } as never,
    api as never,
  );

  // Trigger didFinishLaunching
  launchCb!();

  return { registered, platform };
}

function getName(acc: typeof PlatformAccessory): string {
  return (acc as never as { getService: typeof Service['AccessoryInformation'] })
    .getService(Service.AccessoryInformation)
    ?.getCharacteristic(Characteristic.Name)?.value as string;
}

// ── HAP name chain proof ──────────────────────────────────────────────────────
// Pins the two source-level facts that guarantee labels appear in iOS:
//   1. hap-nodejs Accessory constructor (Accessory.js:241):
//        .setCharacteristic(Characteristic.Name, displayName)
//   2. Homebridge PlatformAccessory constructor (platformAccessory.js:29):
//        new Accessory(displayName, uuid)
// Together: new PlatformAccessory(label, uuid)  →  AccessoryInformation.Name = label
// iOS reads AccessoryInformation.Name (HAP char 0x23) to render the tile label.
// If either library changes this behavior these tests will fail before shipping.
describe('HAP name chain — AccessoryInformation.Name is set from PlatformAccessory name', () => {
  it('hap.Accessory constructor sets AccessoryInformation.Name from displayName arg (hap-nodejs Accessory.js:241)', () => {
    const acc = new HapAccessory('My Label', uuid.generate('chain-test'));
    const name = acc.getService(Service.AccessoryInformation)
      ?.getCharacteristic(Characteristic.Name)?.value;
    expect(name).toBe('My Label');
  });

  it('PlatformAccessory passes its name arg to hap.Accessory so Name characteristic is set (platformAccessory.js:29)', () => {
    const acc = new PlatformAccessory('My Label', uuid.generate('platform-chain-test'));
    const name = (acc._associatedHAPAccessory ?? acc)
      .getService(Service.AccessoryInformation)
      ?.getCharacteristic(Characteristic.Name)?.value;
    expect(name).toBe('My Label');
  });
});

describe('label persistence guarantees', () => {
  it('AccessoryInformation.Name is read-only (perms=pr) — iOS cannot clear it', () => {
    // perms=['pr'] means Paired Read only. iOS can read but never write this field,
    // so it cannot be cleared or overwritten by the Home app.
    const nameChar = new Characteristic.Name();
    expect(nameChar.props.perms).toEqual(['pr']);
  });

  it('companion UUID is deterministic — same serial+suffix always produces same UUID across restarts', () => {
    const id1 = uuid.generate('MAXE-001-vswing');
    const id2 = uuid.generate('MAXE-001-vswing');
    expect(id1).toBe(id2);
  });

  it('companion UUID differs per feature — swing and fan-auto get distinct tiles', () => {
    expect(uuid.generate('MAXE-001-vswing')).not.toBe(uuid.generate('MAXE-001-fanauto'));
  });

  it('on restart, configureAccessory restores companion so registerCompanion returns the cached accessory (same UUID = iOS keeps the tile)', () => {
    const registered: typeof PlatformAccessory[] = [];
    let launchCb: (() => void) | undefined;
    const api = {
      hap: { Service, Characteristic, HAPStatus, HapStatusError, uuid },
      platformAccessory: PlatformAccessory,
      on: (_: string, cb: () => void) => { launchCb = cb; },
      registerPlatformAccessories: (_pn: string, _pl: string, accs: typeof PlatformAccessory[]) => registered.push(...accs),
      updatePlatformAccessories: () => {},
      unregisterPlatformAccessories: () => {},
    };
    const config = { platform: 'AcHttpPlatform', accessories: [{ name: 'Living Room MAXE AC', serial: 'MAXE-001', pollInterval: 0, swingVertical: { stateless: true } }] };
    const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

    // First boot — registers main + companion
    const platform1 = new AcHttpPlatform(log as never, config as never, api as never);
    launchCb!();
    const firstBoot = [...registered];
    expect(firstBoot.length).toBe(2); // main + swing companion

    // Simulate restart: Homebridge calls configureAccessory for each cached accessory
    registered.length = 0;
    launchCb = undefined;
    const platform2 = new AcHttpPlatform(log as never, config as never, api as never);
    for (const acc of firstBoot) platform2.configureAccessory(acc as never); // restore from cache
    launchCb!();

    // On restart, companions already exist in cache — registerPlatformAccessories NOT called again
    expect(registered.length).toBe(0);
  });
});

describe('platform integration — companion accessory tile labels', () => {
  const BASE_CONFIG = {
    accessories: [{
      name: 'Living Room MAXE AC',
      serial: 'MAXE-001',
      pollInterval: 0,
      swingVertical: { stateless: true },
      swingHorizontal: { stateless: true },
      currentRelativeHumidity: { get: { url: 'http://192.0.2.1/humidity' } },
      rotationSpeed: { autoSwitch: true },
    }],
  };

  it('registers the main AC accessory with correct name', () => {
    const { registered } = makeFakeApi(BASE_CONFIG);
    const main = registered.find(a => getName(a) === 'Living Room MAXE AC');
    expect(main).toBeDefined();
  });

  it('registers a Swing companion with correct AccessoryInformation.Name', () => {
    const { registered } = makeFakeApi(BASE_CONFIG);
    const swing = registered.find(a => getName(a) === 'Living Room MAXE AC Swing');
    expect(swing).toBeDefined();
    expect(getName(swing!)).toBe('Living Room MAXE AC Swing');
  });

  it('registers a Fan Auto companion with correct AccessoryInformation.Name', () => {
    const { registered } = makeFakeApi(BASE_CONFIG);
    const fa = registered.find(a => getName(a) === 'Living Room MAXE AC Fan Auto');
    expect(fa).toBeDefined();
    expect(getName(fa!)).toBe('Living Room MAXE AC Fan Auto');
  });

  it('registers an H-Swing companion with correct AccessoryInformation.Name', () => {
    const { registered } = makeFakeApi(BASE_CONFIG);
    const hs = registered.find(a => getName(a) === 'Living Room MAXE AC H-Swing');
    expect(hs).toBeDefined();
    expect(getName(hs!)).toBe('Living Room MAXE AC H-Swing');
  });

  it('registers a Humidity companion with correct AccessoryInformation.Name', () => {
    const { registered } = makeFakeApi(BASE_CONFIG);
    const hum = registered.find(a => getName(a) === 'Living Room MAXE AC Humidity');
    expect(hum).toBeDefined();
    expect(getName(hum!)).toBe('Living Room MAXE AC Humidity');
  });

  it('registers exactly 5 accessories total (1 main + 4 companions)', () => {
    const { registered } = makeFakeApi(BASE_CONFIG);
    expect(registered.length).toBe(5);
  });

  it('companion names contain the AC name as prefix', () => {
    const { registered } = makeFakeApi(BASE_CONFIG);
    const companions = registered.filter(a => getName(a) !== 'Living Room MAXE AC');
    expect(companions.length).toBe(4);
    for (const acc of companions) {
      expect(getName(acc)).toMatch(/^Living Room MAXE AC /);
    }
  });

  it('two ACs produce independent companions with correct names', () => {
    const config = {
      accessories: [
        { name: 'Living Room AC', serial: 'AC-001', pollInterval: 0, swingVertical: { stateless: true } },
        { name: 'Bedroom AC',     serial: 'AC-002', pollInterval: 0, swingVertical: { stateless: true } },
      ],
    };
    const { registered } = makeFakeApi(config);
    expect(registered.find(a => getName(a) === 'Living Room AC Swing')).toBeDefined();
    expect(registered.find(a => getName(a) === 'Bedroom AC Swing')).toBeDefined();
  });
});
