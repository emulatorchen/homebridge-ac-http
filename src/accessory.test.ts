import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
import { percentToSpeed, thresholdMap, resolveCommandBody, AcHttpAccessory } from './accessory.js';
import { applyMap, reverseMap } from './http-client.js';
import { getLabels, TRANSLATIONS } from './i18n.js';
const req = createRequire(import.meta.url);
// hap-nodejs is @homebridge/hap-nodejs on HB 2.x, hap-nodejs on HB 1.x
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let hapMod: any;
try { hapMod = req('@homebridge/hap-nodejs'); } catch { hapMod = req('hap-nodejs'); }
const { Accessory, Service, Characteristic, HAPStatus, HapStatusError, uuid } = hapMod;

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

  it('falls back to English for unknown language', () => {
    const l = getLabels('xx');
    expect(l.swing).toBe('Swing');
    expect(l.hSwing).toBe('H-Swing');
    expect(l.fanAuto).toBe('Fan Auto');
    expect(l.humidity).toBe('Humidity');
  });

  // Every language must define all four keys as non-empty strings
  const fields = ['swing', 'hSwing', 'fanAuto', 'humidity'] as const;
  for (const [lang, labels] of Object.entries(TRANSLATIONS)) {
    describe(`language: ${lang}`, () => {
      for (const field of fields) {
        it(`${field} is a non-empty string`, () => {
          expect(typeof labels[field]).toBe('string');
          expect(labels[field].length).toBeGreaterThan(0);
        });
      }
      it('getLabels() returns the same object as TRANSLATIONS entry', () => {
        expect(getLabels(lang)).toStrictEqual(labels);
      });
    });
  }

  // Spot-check specific translations
  it('ja: all four labels', () => {
    const l = getLabels('ja');
    expect(l.swing).toBe('スイング');
    expect(l.hSwing).toBe('水平スイング');
    expect(l.fanAuto).toBe('自動');
    expect(l.humidity).toBe('湿度');
  });
  it('zh-CN vs zh-TW swing differ (simplified vs traditional)', () => {
    expect(getLabels('zh-CN').swing).toBe('摆风');
    expect(getLabels('zh-TW').swing).toBe('擺風');
  });
  it('ko: all four labels', () => {
    const l = getLabels('ko');
    expect(l.swing).toBe('스윙');
    expect(l.hSwing).toBe('수평 스윙');
    expect(l.fanAuto).toBe('자동');
    expect(l.humidity).toBe('습도');
  });
  it('de: all four labels', () => {
    const l = getLabels('de');
    expect(l.swing).toBe('Schwingung');
    expect(l.hSwing).toBe('H-Schwingung');
    expect(l.fanAuto).toBe('Auto');
    expect(l.humidity).toBe('Luftfeuchtigkeit');
  });
  it('fr: all four labels', () => {
    const l = getLabels('fr');
    expect(l.swing).toBe('Oscillation');
    expect(l.hSwing).toBe('Oscillation H');
    expect(l.fanAuto).toBe('Auto');
    expect(l.humidity).toBe('Humidité');
  });
  it('es: all four labels', () => {
    const l = getLabels('es');
    expect(l.swing).toBe('Oscilación');
    expect(l.hSwing).toBe('Oscilación H');
    expect(l.fanAuto).toBe('Auto');
    expect(l.humidity).toBe('Humedad');
  });
  it('it: all four labels', () => {
    const l = getLabels('it');
    expect(l.swing).toBe('Oscillazione');
    expect(l.hSwing).toBe('Oscillazione H');
    expect(l.fanAuto).toBe('Auto');
    expect(l.humidity).toBe('Umidità');
  });
  it('pt: all four labels', () => {
    const l = getLabels('pt');
    expect(l.swing).toBe('Oscilação');
    expect(l.hSwing).toBe('Oscilação H');
    expect(l.fanAuto).toBe('Auto');
    expect(l.humidity).toBe('Humidade');
  });
  it('nl: all four labels', () => {
    const l = getLabels('nl');
    expect(l.swing).toBe('Schommeling');
    expect(l.hSwing).toBe('H-Schommeling');
    expect(l.fanAuto).toBe('Auto');
    expect(l.humidity).toBe('Vochtigheid');
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

// ── linked service label tests ────────────────────────────────────────────────
// Secondary services (swing, fan-auto, h-swing, humidity) are linked to the main
// HeaterCooler service via addLinkedService so they appear inside the AC tile's
// detail panel, not as independent room tiles. Labels are set via both Name
// (read-only, perms=['pr'], iOS cannot clear it) and ConfiguredName (user-editable).
describe('linked services', () => {
  const AC_NAME = 'Living Room MAXE AC';

  function makeMock(id: string, cfg: object) {
    const hapAcc = new Accessory(AC_NAME, uuid.generate(id));
    const mockPlatform = {
      log: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
      Service, Characteristic,
      api: { hap: { HapStatusError, HAPStatus, uuid } },
    };
    const mockAccessory = {
      context: { config: { name: AC_NAME, pollInterval: 0, ...cfg } },
      getService:    (a: unknown) => hapAcc.getService(a as never),
      addService:    (...a: unknown[]) => (hapAcc.addService as never)(...a),
      removeService: (s: unknown) => hapAcc.removeService(s as Service),
      get services() { return hapAcc.services; },
    };
    return { mockPlatform, mockAccessory, hapAcc };
  }

  const FULL_CFG = {
    swingVertical: { stateless: true },
    swingHorizontal: { stateless: true },
    currentRelativeHumidity: { get: { url: 'http://localhost/humidity' } },
    rotationSpeed: { autoSwitch: true },
  };

  it('secondary services live on the main accessory, not as separate PlatformAccessories', () => {
    const { mockPlatform, mockAccessory, hapAcc } = makeMock('test-linked-on-main', FULL_CFG);
    new AcHttpAccessory(mockPlatform as never, mockAccessory as never);
    const secondary = hapAcc.services.filter(s =>
      s.UUID !== Service.HeaterCooler.UUID && s.UUID !== Service.AccessoryInformation.UUID
    );
    // swing + fan-auto + h-swing + humidity
    expect(secondary.length).toBe(4);
  });

  it('addLinkedService is called for every secondary service', () => {
    const { mockPlatform, mockAccessory } = makeMock('test-addlinked-called', FULL_CFG);
    const spy = vi.spyOn(Service.prototype, 'addLinkedService');
    new AcHttpAccessory(mockPlatform as never, mockAccessory as never);
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(4);
    spy.mockRestore();
  });

  it('swing linked service has correct Name and ConfiguredName', () => {
    const { mockPlatform, mockAccessory, hapAcc } = makeMock('test-swing-names', { swingVertical: { stateless: true } });
    new AcHttpAccessory(mockPlatform as never, mockAccessory as never);
    const svc = hapAcc.services.find(s => s.subtype === 'vswing');
    expect(svc).toBeDefined();
    expect(svc!.getCharacteristic(Characteristic.Name).value).toBe(`${AC_NAME} Swing`);
    expect(svc!.getCharacteristic(Characteristic.ConfiguredName).value).toBe(`${AC_NAME} Swing`);
  });

  it('fan-auto linked service has correct Name and ConfiguredName', () => {
    const { mockPlatform, mockAccessory, hapAcc } = makeMock('test-fanauto-names', { rotationSpeed: { autoSwitch: true } });
    new AcHttpAccessory(mockPlatform as never, mockAccessory as never);
    const svc = hapAcc.services.find(s => s.subtype === 'fanauto');
    expect(svc).toBeDefined();
    expect(svc!.getCharacteristic(Characteristic.Name).value).toBe(`${AC_NAME} Fan Auto`);
    expect(svc!.getCharacteristic(Characteristic.ConfiguredName).value).toBe(`${AC_NAME} Fan Auto`);
  });

  it('h-swing linked service has correct Name and ConfiguredName', () => {
    const { mockPlatform, mockAccessory, hapAcc } = makeMock('test-hswing-names', { swingHorizontal: { stateless: true } });
    new AcHttpAccessory(mockPlatform as never, mockAccessory as never);
    const svc = hapAcc.services.find(s => s.subtype === 'hswing');
    expect(svc).toBeDefined();
    expect(svc!.getCharacteristic(Characteristic.Name).value).toBe(`${AC_NAME} H-Swing`);
    expect(svc!.getCharacteristic(Characteristic.ConfiguredName).value).toBe(`${AC_NAME} H-Swing`);
  });

  it('humidity linked service has correct Name and ConfiguredName', () => {
    const { mockPlatform, mockAccessory, hapAcc } = makeMock('test-humidity-names',
      { currentRelativeHumidity: { get: { url: 'http://localhost/humidity' } } });
    new AcHttpAccessory(mockPlatform as never, mockAccessory as never);
    const svc = hapAcc.services.find(s => s.UUID === Service.HumiditySensor.UUID);
    expect(svc).toBeDefined();
    expect(svc!.getCharacteristic(Characteristic.Name).value).toBe(`${AC_NAME} Humidity`);
    expect(svc!.getCharacteristic(Characteristic.ConfiguredName).value).toBe(`${AC_NAME} Humidity`);
  });

  // Name characteristic is read-only — iOS cannot clear it even if it clears ConfiguredName
  it('linked service Name characteristic is read-only (perms=pr)', () => {
    expect(new Characteristic.Name().props.perms).toEqual(['pr']);
  });

  // ── SwingMode=0 hidden by Home app: swing must always be a Switch (daa10e1/0d11500) ──
  it('stateless vswing uses Switch service, not SwingMode', () => {
    const { mockPlatform, mockAccessory, hapAcc } = makeMock(
      'test-svc-type-stateless', { swingVertical: { stateless: true } }
    );
    new AcHttpAccessory(mockPlatform as never, mockAccessory as never);
    const svc = hapAcc.services.find(s => s.subtype === 'vswing');
    expect(svc).toBeDefined();
    expect(svc!.UUID).toBe(Service.Switch.UUID);
  });

  it('stateful vswing also uses Switch service, not SwingMode', () => {
    const { mockPlatform, mockAccessory, hapAcc } = makeMock(
      'test-svc-type-stateful', { swingVertical: { get: { url: 'http://localhost/swing' } } }
    );
    new AcHttpAccessory(mockPlatform as never, mockAccessory as never);
    const svc = hapAcc.services.find(s => s.subtype === 'vswing');
    expect(svc).toBeDefined();
    expect(svc!.UUID).toBe(Service.Switch.UUID);
  });

  // ── stale cached service label is refreshed on restart ────────────────────────
  it('Name and ConfiguredName are overwritten on restart even if the cached service has a stale label', () => {
    const hapAcc = new Accessory(AC_NAME, uuid.generate('test-stale-refresh'));
    // Simulate a stale vswing service from an old plugin version
    hapAcc.addService(Service.Switch, 'Old Stale Label', 'vswing');

    const mockPlatform = {
      log: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
      Service, Characteristic,
      api: { hap: { HapStatusError, HAPStatus, uuid } },
    };
    const mockAccessory = {
      context: { config: { name: AC_NAME, pollInterval: 0, swingVertical: { stateless: true } } },
      getService:    (a: unknown) => hapAcc.getService(a as never),
      addService:    (...a: unknown[]) => (hapAcc.addService as never)(...a),
      removeService: (s: unknown) => hapAcc.removeService(s as Service),
      get services() { return hapAcc.services; },
    };
    new AcHttpAccessory(mockPlatform as never, mockAccessory as never);

    const svc = hapAcc.services.find(s => s.subtype === 'vswing')!;
    expect(svc.getCharacteristic(Characteristic.Name).value).toBe(`${AC_NAME} Swing`);
    expect(svc.getCharacteristic(Characteristic.ConfiguredName).value).toBe(`${AC_NAME} Swing`);
  });

  // ── stateless swing button resets via setTimeout, not immediately (595aa6b regression) ──
  it('updateCharacteristic(On, false) is deferred via setTimeout after stateless swing tap', async () => {
    const { mockPlatform, mockAccessory, hapAcc } = makeMock(
      'test-swing-timing', { swingVertical: { stateless: true } }
    );
    new AcHttpAccessory(mockPlatform as never, mockAccessory as never);

    const swingSvc = hapAcc.services.find(s => s.subtype === 'vswing')!;
    const onChar   = swingSvc.getCharacteristic(Characteristic.On)!;

    // HAP-NodeJS v2 stores the onSet callback as `setHandler`, not an EventEmitter listener
    const handler = (onChar as never as { setHandler?: (v: boolean) => Promise<void> }).setHandler;
    expect(handler, 'onSet handler must be registered on the On characteristic').toBeDefined();

    const updateSpy     = vi.spyOn(swingSvc, 'updateCharacteristic');
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');

    await handler!(true);

    const resetCalls = setTimeoutSpy.mock.calls.filter(([, d]) => typeof d === 'number' && (d as number) >= 300);
    expect(resetCalls.length).toBeGreaterThan(0);
    expect(updateSpy).not.toHaveBeenCalledWith(Characteristic.On, false);

    (resetCalls[resetCalls.length - 1][0] as () => void)();
    expect(updateSpy).toHaveBeenCalledWith(Characteristic.On, false);

    setTimeoutSpy.mockRestore();
  });
});
