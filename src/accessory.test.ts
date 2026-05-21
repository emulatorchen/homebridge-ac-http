import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
import { percentToSpeed, thresholdMap, resolveCommandBody, AcHttpAccessory } from './accessory.js';
import { applyMap, reverseMap } from './http-client.js';
import { getLabels } from './i18n.js';
import { Accessory, Service, Characteristic, HAPStatus, HapStatusError, uuid } from '@homebridge/hap-nodejs';

const req = createRequire(import.meta.url);
const { PlatformAccessory: RealPlatformAccessory } = req('../node_modules/homebridge/dist/platformAccessory.js');

describe('percentToSpeed', () => {
  it('maps 0% to auto with default map', () => expect(percentToSpeed(0)).toBe('auto'));
  it('maps 20% to 1',  () => expect(percentToSpeed(20)).toBe('1'));
  it('maps 100% to 5', () => expect(percentToSpeed(100)).toBe('5'));
  it('maps 50% to the highest threshold <= 50 (2)', () => expect(percentToSpeed(50)).toBe('2'));

  it('uses custom valueToPercent map', () => {
    const map = { auto: 0, low: 30, high: 70 };
    expect(percentToSpeed(0, map)).toBe('auto');
    expect(percentToSpeed(30, map)).toBe('low');
    expect(percentToSpeed(99, map)).toBe('high');
  });
});

describe('thresholdMap', () => {
  it('returns string of value when no map', () => expect(thresholdMap(42)).toBe('42'));

  it('picks the highest key <= value', () => {
    const map = { '0': 'auto', '20': '1', '40': '2', '60': '3', '80': '4', '100': '5' };
    expect(thresholdMap(0,   map)).toBe('auto');
    expect(thresholdMap(20,  map)).toBe('1');
    expect(thresholdMap(50,  map)).toBe('2');
    expect(thresholdMap(100, map)).toBe('5');
  });
});

describe('resolveCommandBody', () => {
  const body = '{"mode":"{mode}","temp":{temperature},"fan":{fanSpeed},"swing":{swingVertical},"power_off":{active}}';

  it('substitutes all placeholders', () => {
    const result = resolveCommandBody(body, {
      mode: 'cool', temperature: '25', fanSpeed: '2', swingVertical: 'false', active: 'false',
    });
    expect(JSON.parse(result)).toEqual({ mode: 'cool', temp: 25, fan: 2, swing: false, power_off: false });
  });

  it('auto-quotes bare word fan speed (auto)', () => {
    const result = resolveCommandBody(body, {
      mode: 'auto', temperature: '24', fanSpeed: 'auto', swingVertical: 'false', active: 'false',
    });
    const parsed = JSON.parse(result);
    expect(parsed.fan).toBe('auto');
  });

  it('does not quote numbers', () => {
    const result = resolveCommandBody(body, {
      mode: 'cool', temperature: '22', fanSpeed: '3', swingVertical: 'false', active: 'false',
    });
    expect(JSON.parse(result).fan).toBe(3);
  });

  it('does not quote true/false/null', () => {
    const result = resolveCommandBody(body, {
      mode: 'cool', temperature: '22', fanSpeed: '1', swingVertical: 'true', active: 'false',
    });
    const parsed = JSON.parse(result);
    expect(parsed.swing).toBe(true);
    expect(parsed.power_off).toBe(false);
  });

  it('leaves unknown placeholders unreplaced', () => {
    const result = resolveCommandBody('{"x":{unknown}}', {});
    expect(result).toBe('{"x":{unknown}}');
  });
});

// ── applyMap ─────────────────────────────────────────────────────────────────
describe('applyMap', () => {
  const map = { '0': 'off', '1': 'on' };
  it('maps a known key', () => expect(applyMap('1', map)).toBe('on'));
  it('returns value unchanged when key not in map', () => expect(applyMap('2', map)).toBe('2'));
  it('returns value unchanged when no map provided', () => expect(applyMap('1')).toBe('1'));
});

// ── reverseMap ────────────────────────────────────────────────────────────────
describe('reverseMap', () => {
  it('swaps keys and values', () => {
    const forward = { '0': 'off', '1': 'on' };
    expect(reverseMap(forward)).toEqual({ off: '0', on: '1' });
  });
  it('handles mode map', () => {
    const forward = { '0': 'auto', '1': 'heat', '2': 'cool' };
    expect(reverseMap(forward)).toEqual({ auto: '0', heat: '1', cool: '2' });
  });
});

// ── getLabels (i18n) ──────────────────────────────────────────────────────────
describe('getLabels', () => {
  it('returns English defaults when no language given', () => {
    const l = getLabels();
    expect(l.swing).toBe('Swing');
    expect(l.hSwing).toBe('H-Swing');
    expect(l.fanAuto).toBe('Fan Auto');
    expect(l.humidity).toBe('Humidity');
  });
  it('returns Japanese labels for ja', () => {
    const l = getLabels('ja');
    expect(l.swing).toBe('スイング');
    expect(l.hSwing).toBe('水平スイング');
  });
  it('falls back to English for unknown language', () => {
    expect(getLabels('xx').swing).toBe('Swing');
  });
  it('returns correct labels for zh-CN and zh-TW', () => {
    expect(getLabels('zh-CN').swing).toBe('摆风');
    expect(getLabels('zh-TW').swing).toBe('擺風');
  });
});

// ── service subtype migration ─────────────────────────────────────────────────
// Verifies that the duplicate-subtype HAP error that killed MAXE swing is gone.
// Root cause: HAP throws when addService is called with an existing UUID+subtype.
// Fix: remove stale cached services before re-adding with new subtypes.
describe('service subtype migration', () => {
  it('addService throws on duplicate UUID+subtype (documents the root cause)', () => {
    const acc = new Accessory('Test AC', uuid.generate('test-dup'));
    acc.addService(new Service.Switch('', 'swing-trigger'));
    expect(() => acc.addService(new Service.Switch('New Label', 'swing-trigger'))).toThrow();
  });

  it('removing the stale service allows new subtype to be added cleanly', () => {
    const acc = new Accessory('Test AC', uuid.generate('test-mig'));
    const stale = acc.addService(new Service.Switch('', 'swing-trigger'));
    acc.removeService(stale);
    expect(() => acc.addService(new Service.Switch('MAXE Swing', 'vswing'))).not.toThrow();
  });

  it('services.find by subtype returns the service regardless of displayName', () => {
    const acc = new Accessory('Test AC', uuid.generate('test-find'));
    acc.addService(new Service.Switch('some old label', 'vswing'));
    const found = acc.services.find(s => s.subtype === 'vswing');
    expect(found).toBeDefined();
    expect(found!.subtype).toBe('vswing');
  });
});

// ── maxe-rc14 config integration ────────────────────────────────────────────
// Uses the exact body template and maps from the user's config.
// No real hostnames or credentials — only the map values are tested.

const MAXE_BODY = '{"mode":"{mode}","temp":{temperature},"fan":{fanSpeed},"swing":{swingVertical},"power_off":{active}}';
const MAXE_MAP = {
  active:        { '0': 'true',  '1': 'false' },
  mode:          { '0': 'auto',  '1': 'heat',  '2': 'cool' },
  fanSpeed:      { '0': 'auto',  '20': '1', '40': '2', '60': '3', '80': '4', '100': '5' },
  swingVertical: { '0': 'false', '1': 'true' },
};

function maxeVars(state: { active: number; mode: number; temp: number; fanSpeed: number; swingVertical: number }) {
  return {
    active:        MAXE_MAP.active[String(state.active) as keyof typeof MAXE_MAP.active]         ?? String(state.active),
    mode:          MAXE_MAP.mode[String(state.mode) as keyof typeof MAXE_MAP.mode]               ?? String(state.mode),
    temperature:   String(state.temp),
    fanSpeed:      thresholdMap(state.fanSpeed, MAXE_MAP.fanSpeed),
    swingVertical: MAXE_MAP.swingVertical[String(state.swingVertical) as keyof typeof MAXE_MAP.swingVertical] ?? String(state.swingVertical),
    swingHorizontal: 'false',
  };
}

describe('maxe-rc14 command body', () => {
  it('cool 24°C fan-auto swing-off power-on → valid JSON with correct types', () => {
    const body = resolveCommandBody(MAXE_BODY, maxeVars({ active: 1, mode: 2, temp: 24, fanSpeed: 0, swingVertical: 0 }));
    const parsed = JSON.parse(body);
    expect(parsed).toEqual({ mode: 'cool', temp: 24, fan: 'auto', swing: false, power_off: false });
  });

  it('heat 28°C fan-speed-3 swing-on power-on → valid JSON with correct types', () => {
    const body = resolveCommandBody(MAXE_BODY, maxeVars({ active: 1, mode: 1, temp: 28, fanSpeed: 60, swingVertical: 1 }));
    const parsed = JSON.parse(body);
    expect(parsed).toEqual({ mode: 'heat', temp: 28, fan: 3, swing: true, power_off: false });
  });

  it('power-off → power_off is true', () => {
    const body = resolveCommandBody(MAXE_BODY, maxeVars({ active: 0, mode: 0, temp: 25, fanSpeed: 0, swingVertical: 0 }));
    expect(JSON.parse(body).power_off).toBe(true);
  });

  it('all fan speeds produce correct numeric values', () => {
    const expected: Record<number, number | string> = { 0: 'auto', 20: 1, 40: 2, 60: 3, 80: 4, 100: 5 };
    for (const [pct, val] of Object.entries(expected)) {
      const body = resolveCommandBody(MAXE_BODY, maxeVars({ active: 1, mode: 2, temp: 24, fanSpeed: Number(pct), swingVertical: 0 }));
      expect(JSON.parse(body).fan).toBe(val);
    }
  });
});

// ── companion accessory label tests ───────────────────────────────────────────
// iOS tile labels come from AccessoryInformation.Name on each PlatformAccessory.
// Secondary services must be separate PlatformAccessories (not services on the
// main accessory) for labels to appear. These tests use a real PlatformAccessory
// so the AccessoryInformation.Name assertion matches what iOS actually reads.
describe('companion accessory labels', () => {
  const AC_NAME = 'Living Room MAXE AC';

  function makeCompanionMocks(id: string) {
    const hapAcc = new Accessory(AC_NAME, uuid.generate(id));
    const companions = new Map<string, typeof RealPlatformAccessory>();
    const mockLog = { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() };
    const mockPlatform = {
      log: mockLog,
      Service,
      Characteristic,
      api: { hap: { HapStatusError, HAPStatus, uuid } },
      registerCompanion: vi.fn((compUuid: string, name: string) => {
        if (!companions.has(compUuid)) companions.set(compUuid, new RealPlatformAccessory(name, compUuid));
        return companions.get(compUuid);
      }),
    };
    const mockAccessory = {
      context: { config: {
        name: AC_NAME,
        pollInterval: 0,
        swingVertical: { stateless: true },
        swingHorizontal: { stateless: true },
        currentRelativeHumidity: { get: { url: 'http://localhost/humidity' } },
        rotationSpeed: { autoSwitch: true },
      }},
      getService:    (arg: unknown) => hapAcc.getService(arg as never),
      addService:    (...args: unknown[]) => (hapAcc.addService as never)(...args),
      removeService: (svc: unknown) => hapAcc.removeService(svc as Service),
      get services() { return hapAcc.services; },
    };
    return { mockPlatform, mockAccessory, companions };
  }

  it('each secondary feature gets its own companion PlatformAccessory', () => {
    const { mockPlatform, mockAccessory, companions } = makeCompanionMocks('test-companion-count');
    new AcHttpAccessory(mockPlatform as never, mockAccessory as never);
    // swing + fan-auto + h-swing + humidity = 4 companions
    expect(companions.size).toBe(4);
  });

  it('AccessoryInformation.Name on each companion equals the tile label iOS will display', () => {
    const { mockPlatform, mockAccessory, companions } = makeCompanionMocks('test-companion-names');
    new AcHttpAccessory(mockPlatform as never, mockAccessory as never);

    for (const [, acc] of companions) {
      const infoSvc = (acc as never as Accessory).getService(Service.AccessoryInformation);
      const name = infoSvc?.getCharacteristic(Characteristic.Name)?.value as string;
      // Every companion label must start with the AC name and contain a descriptor
      expect(name).toMatch(new RegExp(`^${AC_NAME} .+`));
    }
  });

  it('swing companion label contains "Swing"', () => {
    const { mockPlatform, mockAccessory, companions } = makeCompanionMocks('test-swing-label');
    new AcHttpAccessory(mockPlatform as never, mockAccessory as never);
    const swingAcc = [...companions.values()].find(a => (a as never as { displayName: string }).displayName.includes('Swing'));
    expect(swingAcc).toBeDefined();
    const infoSvc = (swingAcc as never as Accessory).getService(Service.AccessoryInformation);
    expect(infoSvc?.getCharacteristic(Characteristic.Name)?.value).toBe(`${AC_NAME} Swing`);
  });

  it('fan-auto companion label contains "Fan Auto"', () => {
    const { mockPlatform, mockAccessory, companions } = makeCompanionMocks('test-fanauto-label');
    new AcHttpAccessory(mockPlatform as never, mockAccessory as never);
    const faAcc = [...companions.values()].find(a => (a as never as { displayName: string }).displayName.includes('Fan Auto'));
    expect(faAcc).toBeDefined();
    const infoSvc = (faAcc as never as Accessory).getService(Service.AccessoryInformation);
    expect(infoSvc?.getCharacteristic(Characteristic.Name)?.value).toBe(`${AC_NAME} Fan Auto`);
  });

  it('companion AccessoryInformation.Name is set by the same mechanism as the main AC tile that already works', () => {
    // The main AC tile (e.g. "Living Room MAXE AC") shows correctly in iOS because
    // PlatformAccessory auto-sets AccessoryInformation.Name from the constructor name arg.
    // Companions use the exact same constructor call — this test proves it.
    const mainAcc  = new RealPlatformAccessory(AC_NAME, uuid.generate('proof-main'));
    const swingAcc = new RealPlatformAccessory(`${AC_NAME} Swing`, uuid.generate('proof-swing'));
    const fanAcc   = new RealPlatformAccessory(`${AC_NAME} Fan Auto`, uuid.generate('proof-fan'));

    const getName = (acc: typeof RealPlatformAccessory) =>
      (acc as never as Accessory)
        .getService(Service.AccessoryInformation)
        ?.getCharacteristic(Characteristic.Name)?.value;

    // Main tile: if this shows in iOS, companions will too — identical mechanism
    expect(getName(mainAcc)).toBe(AC_NAME);
    expect(getName(swingAcc)).toBe(`${AC_NAME} Swing`);
    expect(getName(fanAcc)).toBe(`${AC_NAME} Fan Auto`);
  });

  it('main accessory retains only HeaterCooler + AccessoryInformation, addLinkedService never called', () => {
    const spy = vi.spyOn(Service.prototype, 'addLinkedService');
    const { mockPlatform, mockAccessory } = makeCompanionMocks('test-main-only');
    new AcHttpAccessory(mockPlatform as never, mockAccessory as never);
    expect(spy).not.toHaveBeenCalled();
    const mainUuids = (mockAccessory.services as Service[]).map(s => s.UUID);
    expect(mainUuids.every(u => u === Service.HeaterCooler.UUID || u === Service.AccessoryInformation.UUID)).toBe(true);
    spy.mockRestore();
  });
});
