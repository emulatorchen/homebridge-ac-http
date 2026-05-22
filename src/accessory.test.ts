import { describe, it, expect, vi, beforeEach } from 'vitest';
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

// ── axios mock (module-level, hoisted) ────────────────────────────────────────
// Intercepts every sendCommand call without making real HTTP requests.
// All existing tests are unaffected: they configure pollInterval:0 and no URLs,
// so they never reach axios.
const mockAxios = vi.hoisted(() => vi.fn().mockResolvedValue({ status: 200, data: {} }));
vi.mock('axios', () => ({ default: mockAxios }));

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

// ── MAXE command: every button sends the correct payload ──────────────────────
// End-to-end handler tests: HomeKit SET → handler → sendCommand → axios.
// Three prior button-breakage bugs were only caught in production because these
// tests did not exist. Every axis of the command must be tested individually
// and in combination to prevent regressions.
//
// Axes covered:
//   active (power), mode, coolingThresholdTemperature, rotationSpeed (slider),
//   fanAuto switch, swingVertical (stateless one-shot), swingHorizontal (stateless toggle)
//
// State-isolation coverage:
//   Tapping swing must NOT carry swingVertical=1 into subsequent commands.
//   (Bug: the `finally` block only reset the UI button; it left state.swingVertical=1
//    permanently, causing every subsequent sendCommand to include swing:true, which
//    the MAXE AC rejected for all commands except power-off.)

const MAXE_AC   = 'Living Room MAXE AC';
const MAXE_URL  = 'http://maxe.local/cmd';

// Body includes swingHorizontal so hswing tests can also assert the field.
const MAXE_CFG = {
  name: MAXE_AC,
  pollInterval: 0,
  command: {
    url: MAXE_URL,
    method: 'POST' as const,
    body: '{"mode":"{mode}","temp":{temperature},"fan":{fanSpeed},"swing":{swingVertical},"hswing":{swingHorizontal},"power_off":{active}}',
    map: {
      active:          { '0': 'true',  '1': 'false' },
      mode:            { '0': 'auto',  '1': 'heat',  '2': 'cool' },
      fanSpeed:        { '0': 'auto',  '20': '1', '40': '2', '60': '3', '80': '4', '100': '5' },
      swingVertical:   { '0': 'false', '1': 'true' },
      swingHorizontal: { '0': 'false', '1': 'true' },
    },
  },
  coolingThresholdTemperature: {},
  swingVertical:   { stateless: true },
  swingHorizontal: { stateless: true },
  rotationSpeed:   { autoSwitch: true },
};

function makeMaxeAcc() {
  const hapAcc = new Accessory(MAXE_AC, uuid.generate(`maxe-cmd-${Math.random()}`));
  const mp = {
    log: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
    Service, Characteristic,
    api: { hap: { HapStatusError, HAPStatus, uuid } },
  };
  const ma = {
    context: { config: MAXE_CFG },
    getService:    (a: unknown) => hapAcc.getService(a as never),
    addService:    (...a: unknown[]) => (hapAcc.addService as never)(...a),
    removeService: (s: unknown) => hapAcc.removeService(s as Service),
    get services() { return hapAcc.services; },
  };
  new AcHttpAccessory(mp as never, ma as never);
  return hapAcc;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sh(char: unknown): (v: any) => Promise<void> {
  const h = (char as Record<string, unknown>).setHandler as ((v: unknown) => Promise<void>) | undefined;
  if (h) return h as (v: unknown) => Promise<void>;
  throw new Error('No setHandler on characteristic — handler not registered?');
}

function lastCmd(): Record<string, unknown> {
  const calls = mockAxios.mock.calls;
  if (!calls.length) throw new Error('axios was not called');
  const data = (calls[calls.length - 1][0] as { data: unknown }).data;
  return (typeof data === 'string' ? JSON.parse(data) : data) as Record<string, unknown>;
}

describe('MAXE command — every button sends the correct payload', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let hapAcc: any, heater: Service, vswing: Service, hswing: Service, fanauto: Service;

  beforeEach(() => {
    mockAxios.mockClear();
    hapAcc  = makeMaxeAcc();
    heater  = hapAcc.services.find((s: Service) => s.UUID === Service.HeaterCooler.UUID);
    vswing  = hapAcc.services.find((s: Service) => s.subtype === 'vswing');
    hswing  = hapAcc.services.find((s: Service) => s.subtype === 'hswing');
    fanauto = hapAcc.services.find((s: Service) => s.subtype === 'fanauto');
  });

  // ── Active ────────────────────────────────────────────────────────────────
  it('power OFF (active=0) → power_off:true in command', async () => {
    await sh(heater.getCharacteristic(Characteristic.Active))(0);
    expect(lastCmd().power_off).toBe(true);
  });
  it('power ON (active=1) → power_off:false in command', async () => {
    await sh(heater.getCharacteristic(Characteristic.Active))(1);
    expect(lastCmd().power_off).toBe(false);
  });

  // ── Mode ─────────────────────────────────────────────────────────────────
  it('mode auto (0) → mode:"auto"', async () => {
    await sh(heater.getCharacteristic(Characteristic.TargetHeaterCoolerState))(0);
    expect(lastCmd().mode).toBe('auto');
  });
  it('mode heat (1) → mode:"heat"', async () => {
    await sh(heater.getCharacteristic(Characteristic.TargetHeaterCoolerState))(1);
    expect(lastCmd().mode).toBe('heat');
  });
  it('mode cool (2) → mode:"cool"', async () => {
    await sh(heater.getCharacteristic(Characteristic.TargetHeaterCoolerState))(2);
    expect(lastCmd().mode).toBe('cool');
  });

  // ── Temperature ──────────────────────────────────────────────────────────
  it('temp 16°C → temp:16', async () => {
    await sh(heater.getCharacteristic(Characteristic.CoolingThresholdTemperature))(16);
    expect(lastCmd().temp).toBe(16);
  });
  it('temp 24°C → temp:24', async () => {
    await sh(heater.getCharacteristic(Characteristic.CoolingThresholdTemperature))(24);
    expect(lastCmd().temp).toBe(24);
  });
  it('temp midC → temp:30', async () => {
    await sh(heater.getCharacteristic(Characteristic.CoolingThresholdTemperature))(30);
    expect(lastCmd().temp).toBe(30);
  });

  // ── Fan speed slider (all 6 threshold values) ────────────────────────────
  const FAN_CASES: [number, string | number][] = [
    [0, 'auto'], [20, 1], [40, 2], [60, 3], [80, 4], [100, 5],
  ];
  for (const [pct, expected] of FAN_CASES) {
    it(`fan ${pct}% → fan:${expected}`, async () => {
      await sh(heater.getCharacteristic(Characteristic.RotationSpeed))(pct);
      expect(lastCmd().fan).toBe(expected);
    });
  }

  // ── Fan-auto switch ───────────────────────────────────────────────────────
  it('fan-auto ON → fan:"auto"', async () => {
    await sh(fanauto.getCharacteristic(Characteristic.On))(true);
    expect(lastCmd().fan).toBe('auto');
  });
  it('fan-auto OFF (from auto state) → fan:1 (steps out of auto)', async () => {
    await sh(fanauto.getCharacteristic(Characteristic.On))(false);
    expect(lastCmd().fan).toBe(1);
  });

  // ── Stateless vswing ─────────────────────────────────────────────────────
  it('swing tap (v=true) → swing:true in command', async () => {
    await sh(vswing.getCharacteristic(Characteristic.On))(true);
    expect(lastCmd().swing).toBe(true);
  });
  it('swing reset (v=false) → no command sent at all', async () => {
    await sh(vswing.getCharacteristic(Characteristic.On))(false);
    expect(mockAxios.mock.calls.length).toBe(0);
  });
  it('second swing tap → swing:true again (state was properly reset)', async () => {
    await sh(vswing.getCharacteristic(Characteristic.On))(true);
    mockAxios.mockClear();
    await sh(vswing.getCharacteristic(Characteristic.On))(true);
    expect(lastCmd().swing).toBe(true);
  });

  // ── REGRESSION: stateless swing must NOT poison subsequent commands ───────
  // Root cause: state.swingVertical was left at 1 after a swing tap.
  // Every subsequent sendCommand included swing:true, which the MAXE AC
  // rejected for all operations except power-off (where power_off:true is
  // accepted regardless of swing state).
  it('[REGRESSION] power-on after swing tap → swing:false', async () => {
    await sh(vswing.getCharacteristic(Characteristic.On))(true);
    mockAxios.mockClear();
    await sh(heater.getCharacteristic(Characteristic.Active))(1);
    expect(lastCmd().swing).toBe(false);
  });
  it('[REGRESSION] power-off after swing tap → swing:false', async () => {
    await sh(vswing.getCharacteristic(Characteristic.On))(true);
    mockAxios.mockClear();
    await sh(heater.getCharacteristic(Characteristic.Active))(0);
    expect(lastCmd().swing).toBe(false);
  });
  it('[REGRESSION] mode change after swing tap → swing:false', async () => {
    await sh(vswing.getCharacteristic(Characteristic.On))(true);
    mockAxios.mockClear();
    await sh(heater.getCharacteristic(Characteristic.TargetHeaterCoolerState))(2);
    expect(lastCmd().swing).toBe(false);
  });
  it('[REGRESSION] temp change after swing tap → swing:false', async () => {
    await sh(vswing.getCharacteristic(Characteristic.On))(true);
    mockAxios.mockClear();
    await sh(heater.getCharacteristic(Characteristic.CoolingThresholdTemperature))(24);
    expect(lastCmd().swing).toBe(false);
  });
  it('[REGRESSION] fan change after swing tap → swing:false', async () => {
    await sh(vswing.getCharacteristic(Characteristic.On))(true);
    mockAxios.mockClear();
    await sh(heater.getCharacteristic(Characteristic.RotationSpeed))(60);
    expect(lastCmd().swing).toBe(false);
  });
  it('[REGRESSION] fan-auto after swing tap → swing:false', async () => {
    await sh(vswing.getCharacteristic(Characteristic.On))(true);
    mockAxios.mockClear();
    await sh(fanauto.getCharacteristic(Characteristic.On))(true);
    expect(lastCmd().swing).toBe(false);
  });

  // ── Stateless hswing ─────────────────────────────────────────────────────
  it('hswing ON → hswing:true', async () => {
    await sh(hswing.getCharacteristic(Characteristic.On))(true);
    expect(lastCmd().hswing).toBe(true);
  });
  it('hswing OFF → hswing:false', async () => {
    await sh(hswing.getCharacteristic(Characteristic.On))(true);   // turn on first
    mockAxios.mockClear();
    await sh(hswing.getCharacteristic(Characteristic.On))(false);  // then off
    expect(lastCmd().hswing).toBe(false);
  });

  // ── State isolation: each button only changes its own field ───────────────
  // Catches cases where one button accidentally mutates shared state used by
  // another axis.
  it('temp change: swing stays false, hswing stays false', async () => {
    await sh(heater.getCharacteristic(Characteristic.CoolingThresholdTemperature))(22);
    expect(lastCmd()).toMatchObject({ temp: 22, swing: false, hswing: false });
  });
  it('mode change: temp stays at default (24), fan stays auto', async () => {
    await sh(heater.getCharacteristic(Characteristic.TargetHeaterCoolerState))(1);
    expect(lastCmd()).toMatchObject({ mode: 'heat', temp: 24, fan: 'auto' });
  });
  it('fan change: mode and swing are unaffected', async () => {
    await sh(heater.getCharacteristic(Characteristic.RotationSpeed))(40);
    expect(lastCmd()).toMatchObject({ fan: 2, mode: 'auto', swing: false });
  });
  it('hswing ON: vswing stays false', async () => {
    await sh(hswing.getCharacteristic(Characteristic.On))(true);
    expect(lastCmd()).toMatchObject({ hswing: true, swing: false });
  });

  // ── Pairwise: every button combination (A then B) ─────────────────────────
  // For each pair (A, B): press A, verify B still produces a correct full
  // command and that A's prior value is carried forward where expected.
  // Default initial state: active=0, mode=0, temp=24, fanSpeed=0, vswing=0, hswing=0

  it('[pair] mode=cool → temp=22: command has both mode:cool AND temp:22', async () => {
    await sh(heater.getCharacteristic(Characteristic.TargetHeaterCoolerState))(2);
    mockAxios.mockClear();
    await sh(heater.getCharacteristic(Characteristic.CoolingThresholdTemperature))(22);
    expect(lastCmd()).toMatchObject({ mode: 'cool', temp: 22, swing: false, hswing: false });
  });
  it('[pair] temp=18 → mode=heat: command has both temp:18 AND mode:heat', async () => {
    await sh(heater.getCharacteristic(Characteristic.CoolingThresholdTemperature))(18);
    mockAxios.mockClear();
    await sh(heater.getCharacteristic(Characteristic.TargetHeaterCoolerState))(1);
    expect(lastCmd()).toMatchObject({ temp: 18, mode: 'heat', swing: false });
  });
  it('[pair] fan=80% → temp=28: command has fan:4 AND temp:28', async () => {
    await sh(heater.getCharacteristic(Characteristic.RotationSpeed))(80);
    mockAxios.mockClear();
    await sh(heater.getCharacteristic(Characteristic.CoolingThresholdTemperature))(28);
    expect(lastCmd()).toMatchObject({ fan: 4, temp: 28 });
  });
  it('[pair] temp=20 → fan=40%: command has temp:20 AND fan:2', async () => {
    await sh(heater.getCharacteristic(Characteristic.CoolingThresholdTemperature))(20);
    mockAxios.mockClear();
    await sh(heater.getCharacteristic(Characteristic.RotationSpeed))(40);
    expect(lastCmd()).toMatchObject({ temp: 20, fan: 2 });
  });
  it('[pair] mode=heat → fan=100%: command has mode:heat AND fan:5', async () => {
    await sh(heater.getCharacteristic(Characteristic.TargetHeaterCoolerState))(1);
    mockAxios.mockClear();
    await sh(heater.getCharacteristic(Characteristic.RotationSpeed))(100);
    expect(lastCmd()).toMatchObject({ mode: 'heat', fan: 5 });
  });
  it('[pair] fan=60% → mode=cool: command has fan:3 AND mode:cool', async () => {
    await sh(heater.getCharacteristic(Characteristic.RotationSpeed))(60);
    mockAxios.mockClear();
    await sh(heater.getCharacteristic(Characteristic.TargetHeaterCoolerState))(2);
    expect(lastCmd()).toMatchObject({ fan: 3, mode: 'cool' });
  });
  it('[pair] active=1 → mode=cool: power_off:false AND mode:cool', async () => {
    await sh(heater.getCharacteristic(Characteristic.Active))(1);
    mockAxios.mockClear();
    await sh(heater.getCharacteristic(Characteristic.TargetHeaterCoolerState))(2);
    expect(lastCmd()).toMatchObject({ power_off: false, mode: 'cool' });
  });
  it('[pair] active=1 → temp=26: power_off:false AND temp:26', async () => {
    await sh(heater.getCharacteristic(Characteristic.Active))(1);
    mockAxios.mockClear();
    await sh(heater.getCharacteristic(Characteristic.CoolingThresholdTemperature))(26);
    expect(lastCmd()).toMatchObject({ power_off: false, temp: 26 });
  });
  it('[pair] active=1 → fan=60%: power_off:false AND fan:3', async () => {
    await sh(heater.getCharacteristic(Characteristic.Active))(1);
    mockAxios.mockClear();
    await sh(heater.getCharacteristic(Characteristic.RotationSpeed))(60);
    expect(lastCmd()).toMatchObject({ power_off: false, fan: 3 });
  });
  it('[pair] active=1 → fan-auto ON: power_off:false AND fan:auto', async () => {
    await sh(heater.getCharacteristic(Characteristic.Active))(1);
    mockAxios.mockClear();
    await sh(fanauto.getCharacteristic(Characteristic.On))(true);
    expect(lastCmd()).toMatchObject({ power_off: false, fan: 'auto' });
  });
  it('[pair] mode=heat → active=1: active carries; mode also correct', async () => {
    await sh(heater.getCharacteristic(Characteristic.TargetHeaterCoolerState))(1);
    mockAxios.mockClear();
    await sh(heater.getCharacteristic(Characteristic.Active))(1);
    expect(lastCmd()).toMatchObject({ mode: 'heat', power_off: false });
  });
  it('[pair] temp=22 → active=0: power-off includes current temp', async () => {
    await sh(heater.getCharacteristic(Characteristic.CoolingThresholdTemperature))(22);
    mockAxios.mockClear();
    await sh(heater.getCharacteristic(Characteristic.Active))(0);
    expect(lastCmd()).toMatchObject({ temp: 22, power_off: true });
  });
  it('[pair] hswing=ON → mode=cool: hswing persists in next command', async () => {
    await sh(hswing.getCharacteristic(Characteristic.On))(true);
    mockAxios.mockClear();
    await sh(heater.getCharacteristic(Characteristic.TargetHeaterCoolerState))(2);
    expect(lastCmd()).toMatchObject({ hswing: true, mode: 'cool', swing: false });
  });
  it('[pair] hswing=ON → temp=22: hswing persists in next command', async () => {
    await sh(hswing.getCharacteristic(Characteristic.On))(true);
    mockAxios.mockClear();
    await sh(heater.getCharacteristic(Characteristic.CoolingThresholdTemperature))(22);
    expect(lastCmd()).toMatchObject({ hswing: true, temp: 22, swing: false });
  });
  it('[pair] hswing=ON → fan=80%: hswing persists in next command', async () => {
    await sh(hswing.getCharacteristic(Characteristic.On))(true);
    mockAxios.mockClear();
    await sh(heater.getCharacteristic(Characteristic.RotationSpeed))(80);
    expect(lastCmd()).toMatchObject({ hswing: true, fan: 4, swing: false });
  });
  it('[pair] hswing=ON → active=1: hswing persists, power comes on', async () => {
    await sh(hswing.getCharacteristic(Characteristic.On))(true);
    mockAxios.mockClear();
    await sh(heater.getCharacteristic(Characteristic.Active))(1);
    expect(lastCmd()).toMatchObject({ hswing: true, power_off: false, swing: false });
  });
  it('[pair] hswing=ON → vswing tap: tap sends swing:true AND hswing:true', async () => {
    await sh(hswing.getCharacteristic(Characteristic.On))(true);
    mockAxios.mockClear();
    await sh(vswing.getCharacteristic(Characteristic.On))(true);
    expect(lastCmd()).toMatchObject({ swing: true, hswing: true });
  });
  it('[pair] vswing tap → hswing=ON: swing resets, hswing:true in command', async () => {
    await sh(vswing.getCharacteristic(Characteristic.On))(true);
    mockAxios.mockClear();
    await sh(hswing.getCharacteristic(Characteristic.On))(true);
    expect(lastCmd()).toMatchObject({ swing: false, hswing: true });
  });
  it('[pair] fan-auto ON → mode change: fan stays auto', async () => {
    await sh(fanauto.getCharacteristic(Characteristic.On))(true);
    mockAxios.mockClear();
    await sh(heater.getCharacteristic(Characteristic.TargetHeaterCoolerState))(1);
    expect(lastCmd()).toMatchObject({ fan: 'auto', mode: 'heat' });
  });
  it('[pair] fan-auto ON → temp change: fan stays auto', async () => {
    await sh(fanauto.getCharacteristic(Characteristic.On))(true);
    mockAxios.mockClear();
    await sh(heater.getCharacteristic(Characteristic.CoolingThresholdTemperature))(26);
    expect(lastCmd()).toMatchObject({ fan: 'auto', temp: 26 });
  });

  // ── Triple sequences ───────────────────────────────────────────────────────
  it('[seq] power-on → mode=cool → temp=22: all three fields correct', async () => {
    await sh(heater.getCharacteristic(Characteristic.Active))(1);
    await sh(heater.getCharacteristic(Characteristic.TargetHeaterCoolerState))(2);
    mockAxios.mockClear();
    await sh(heater.getCharacteristic(Characteristic.CoolingThresholdTemperature))(22);
    expect(lastCmd()).toMatchObject({ power_off: false, mode: 'cool', temp: 22, swing: false, hswing: false });
  });
  it('[seq] mode=heat → fan=80% → temp=28: all three fields correct', async () => {
    await sh(heater.getCharacteristic(Characteristic.TargetHeaterCoolerState))(1);
    await sh(heater.getCharacteristic(Characteristic.RotationSpeed))(80);
    mockAxios.mockClear();
    await sh(heater.getCharacteristic(Characteristic.CoolingThresholdTemperature))(28);
    expect(lastCmd()).toMatchObject({ mode: 'heat', fan: 4, temp: 28 });
  });
  it('[seq] hswing=ON → vswing tap → mode=auto: swing=false, hswing=true after tap', async () => {
    await sh(hswing.getCharacteristic(Characteristic.On))(true);
    await sh(vswing.getCharacteristic(Characteristic.On))(true);
    mockAxios.mockClear();
    await sh(heater.getCharacteristic(Characteristic.TargetHeaterCoolerState))(0);
    expect(lastCmd()).toMatchObject({ mode: 'auto', swing: false, hswing: true });
  });
  it('[seq] power-on → hswing=ON → swing tap → temp=24: full state correct', async () => {
    await sh(heater.getCharacteristic(Characteristic.Active))(1);
    await sh(hswing.getCharacteristic(Characteristic.On))(true);
    await sh(vswing.getCharacteristic(Characteristic.On))(true);
    mockAxios.mockClear();
    await sh(heater.getCharacteristic(Characteristic.CoolingThresholdTemperature))(24);
    expect(lastCmd()).toMatchObject({ power_off: false, hswing: true, swing: false, temp: 24 });
  });
  it('[seq] mode=cool → temp=18 → fan=100% → active=1: complete state snapshot', async () => {
    await sh(heater.getCharacteristic(Characteristic.TargetHeaterCoolerState))(2);
    await sh(heater.getCharacteristic(Characteristic.CoolingThresholdTemperature))(18);
    await sh(heater.getCharacteristic(Characteristic.RotationSpeed))(100);
    mockAxios.mockClear();
    await sh(heater.getCharacteristic(Characteristic.Active))(1);
    expect(lastCmd()).toEqual({ mode: 'cool', temp: 18, fan: 5, swing: false, hswing: false, power_off: false });
  });

  // ── Accumulated state → power off → button ────────────────────────────────
  // AC was running (cool, 26°C, fan 3); user powers off; then taps swing/hswing.
  // The accumulated state (cool/26/3) must be carried in the post-off command.
  it('[seq] active=1 → cool → 26°C → fan=60% → active=0 → swing tap: full state + power_off:true + swing:true', async () => {
    await sh(heater.getCharacteristic(Characteristic.Active))(1);
    await sh(heater.getCharacteristic(Characteristic.TargetHeaterCoolerState))(2);
    await sh(heater.getCharacteristic(Characteristic.CoolingThresholdTemperature))(26);
    await sh(heater.getCharacteristic(Characteristic.RotationSpeed))(60);
    await sh(heater.getCharacteristic(Characteristic.Active))(0);
    mockAxios.mockClear();
    await sh(vswing.getCharacteristic(Characteristic.On))(true);
    expect(lastCmd()).toEqual({ mode: 'cool', temp: 26, fan: 3, swing: true, hswing: false, power_off: true });
  });
  it('[seq] cool → 26°C → fan=60% → active=0 → swing tap → mode change: swing resets, state carries', async () => {
    await sh(heater.getCharacteristic(Characteristic.Active))(1);
    await sh(heater.getCharacteristic(Characteristic.TargetHeaterCoolerState))(2);
    await sh(heater.getCharacteristic(Characteristic.CoolingThresholdTemperature))(26);
    await sh(heater.getCharacteristic(Characteristic.RotationSpeed))(60);
    await sh(heater.getCharacteristic(Characteristic.Active))(0);
    await sh(vswing.getCharacteristic(Characteristic.On))(true);
    mockAxios.mockClear();
    await sh(heater.getCharacteristic(Characteristic.TargetHeaterCoolerState))(1);
    expect(lastCmd()).toEqual({ mode: 'heat', temp: 26, fan: 3, swing: false, hswing: false, power_off: true });
  });
  it('[seq] active=1 → cool → 26°C → fan=60% → active=0 → hswing ON: state carries + power_off:true', async () => {
    await sh(heater.getCharacteristic(Characteristic.Active))(1);
    await sh(heater.getCharacteristic(Characteristic.TargetHeaterCoolerState))(2);
    await sh(heater.getCharacteristic(Characteristic.CoolingThresholdTemperature))(26);
    await sh(heater.getCharacteristic(Characteristic.RotationSpeed))(60);
    await sh(heater.getCharacteristic(Characteristic.Active))(0);
    mockAxios.mockClear();
    await sh(hswing.getCharacteristic(Characteristic.On))(true);
    expect(lastCmd()).toEqual({ mode: 'cool', temp: 26, fan: 3, swing: false, hswing: true, power_off: true });
  });
});

// ── MAXE command: every button in power-off state (active=0) ─────────────────
// HomeKit allows changing mode/temp/fan while the AC is off.
// The plugin sends a full command for every tap regardless of power state.
// All tests start with active=0 (the default); power_off:true is expected.
// Exception: temp while off is treated as a mode pre-set by the MAXE AC
// (same command body — the AC stores it, applies on next power-on).
describe('MAXE command — each button while AC is powered off (active=0)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let hapAcc: any, heater: Service, vswing: Service, hswing: Service, fanauto: Service;

  beforeEach(() => {
    mockAxios.mockClear();
    hapAcc  = makeMaxeAcc();
    heater  = hapAcc.services.find((s: Service) => s.UUID === Service.HeaterCooler.UUID);
    vswing  = hapAcc.services.find((s: Service) => s.subtype === 'vswing');
    hswing  = hapAcc.services.find((s: Service) => s.subtype === 'hswing');
    fanauto = hapAcc.services.find((s: Service) => s.subtype === 'fanauto');
  });

  it('mode=heat while off → power_off:true + mode:heat', async () => {
    await sh(heater.getCharacteristic(Characteristic.TargetHeaterCoolerState))(1);
    expect(lastCmd()).toMatchObject({ power_off: true, mode: 'heat', swing: false, hswing: false });
  });
  it('mode=cool while off → power_off:true + mode:cool', async () => {
    await sh(heater.getCharacteristic(Characteristic.TargetHeaterCoolerState))(2);
    expect(lastCmd()).toMatchObject({ power_off: true, mode: 'cool', swing: false });
  });
  it('mode=auto while off → power_off:true + mode:auto', async () => {
    await sh(heater.getCharacteristic(Characteristic.TargetHeaterCoolerState))(0);
    expect(lastCmd()).toMatchObject({ power_off: true, mode: 'auto' });
  });
  it('temp=22 while off → power_off:true + temp:22 (pre-set, AC applies on next power-on)', async () => {
    await sh(heater.getCharacteristic(Characteristic.CoolingThresholdTemperature))(22);
    expect(lastCmd()).toMatchObject({ power_off: true, temp: 22, swing: false });
  });
  it('fan=60% while off → power_off:true + fan:3', async () => {
    await sh(heater.getCharacteristic(Characteristic.RotationSpeed))(60);
    expect(lastCmd()).toMatchObject({ power_off: true, fan: 3, swing: false });
  });
  it('fan=0% while off → power_off:true + fan:auto', async () => {
    await sh(heater.getCharacteristic(Characteristic.RotationSpeed))(0);
    expect(lastCmd()).toMatchObject({ power_off: true, fan: 'auto', swing: false });
  });
  it('fan-auto ON while off → power_off:true + fan:auto', async () => {
    await sh(fanauto.getCharacteristic(Characteristic.On))(true);
    expect(lastCmd()).toMatchObject({ power_off: true, fan: 'auto', swing: false });
  });
  it('fan-auto OFF while off → power_off:true + fan:1 (steps out of auto)', async () => {
    await sh(fanauto.getCharacteristic(Characteristic.On))(false);
    expect(lastCmd()).toMatchObject({ power_off: true, fan: 1, swing: false });
  });
  it('swing tap while off → power_off:true + swing:true (one-shot fires even when off)', async () => {
    await sh(vswing.getCharacteristic(Characteristic.On))(true);
    expect(lastCmd()).toMatchObject({ power_off: true, swing: true });
  });
  it('hswing ON while off → power_off:true + hswing:true', async () => {
    await sh(hswing.getCharacteristic(Characteristic.On))(true);
    expect(lastCmd()).toMatchObject({ power_off: true, hswing: true, swing: false });
  });
  it('hswing OFF while off (stateless: no dedup) → power_off:true + hswing:false', async () => {
    await sh(hswing.getCharacteristic(Characteristic.On))(false);
    expect(lastCmd()).toMatchObject({ power_off: true, hswing: false, swing: false });
  });

  // After each button tap while off, the state carried forward to power-on must be correct.
  it('[off→on] mode=heat while off → power-on: mode:heat + power_off:false', async () => {
    await sh(heater.getCharacteristic(Characteristic.TargetHeaterCoolerState))(1);
    mockAxios.mockClear();
    await sh(heater.getCharacteristic(Characteristic.Active))(1);
    expect(lastCmd()).toMatchObject({ power_off: false, mode: 'heat', swing: false });
  });
  it('[off→on] temp=26 while off → power-on: temp:26 + power_off:false', async () => {
    await sh(heater.getCharacteristic(Characteristic.CoolingThresholdTemperature))(26);
    mockAxios.mockClear();
    await sh(heater.getCharacteristic(Characteristic.Active))(1);
    expect(lastCmd()).toMatchObject({ power_off: false, temp: 26, swing: false });
  });
  it('[off→on] fan=80% while off → power-on: fan:4 + power_off:false', async () => {
    await sh(heater.getCharacteristic(Characteristic.RotationSpeed))(80);
    mockAxios.mockClear();
    await sh(heater.getCharacteristic(Characteristic.Active))(1);
    expect(lastCmd()).toMatchObject({ power_off: false, fan: 4, swing: false });
  });
  it('[off→on] hswing ON while off → power-on: hswing:true + power_off:false', async () => {
    await sh(hswing.getCharacteristic(Characteristic.On))(true);
    mockAxios.mockClear();
    await sh(heater.getCharacteristic(Characteristic.Active))(1);
    expect(lastCmd()).toMatchObject({ power_off: false, hswing: true, swing: false });
  });
});

// ── MAXE command: every button while AC is powered ON (active=1) ─────────────
// Mirror of the power-off suite: same button types, active=1 set first,
// every command must have power_off:false.
// Most critical: swing tap while ON — this is exactly the scenario the bug caused.
describe('MAXE command — each button while AC is powered on (active=1)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let hapAcc: any, heater: Service, vswing: Service, hswing: Service, fanauto: Service;

  beforeEach(async () => {
    mockAxios.mockClear();
    hapAcc  = makeMaxeAcc();
    heater  = hapAcc.services.find((s: Service) => s.UUID === Service.HeaterCooler.UUID);
    vswing  = hapAcc.services.find((s: Service) => s.subtype === 'vswing');
    hswing  = hapAcc.services.find((s: Service) => s.subtype === 'hswing');
    fanauto = hapAcc.services.find((s: Service) => s.subtype === 'fanauto');
    // Power on first — all tests in this suite start with active=1
    await sh(heater.getCharacteristic(Characteristic.Active))(1);
    mockAxios.mockClear();
  });

  it('mode=auto while ON → power_off:false + mode:auto', async () => {
    await sh(heater.getCharacteristic(Characteristic.TargetHeaterCoolerState))(0);
    expect(lastCmd()).toMatchObject({ power_off: false, mode: 'auto', swing: false, hswing: false });
  });
  it('mode=heat while ON → power_off:false + mode:heat', async () => {
    await sh(heater.getCharacteristic(Characteristic.TargetHeaterCoolerState))(1);
    expect(lastCmd()).toMatchObject({ power_off: false, mode: 'heat', swing: false });
  });
  it('mode=cool while ON → power_off:false + mode:cool', async () => {
    await sh(heater.getCharacteristic(Characteristic.TargetHeaterCoolerState))(2);
    expect(lastCmd()).toMatchObject({ power_off: false, mode: 'cool', swing: false });
  });
  it('temp=22 while ON → power_off:false + temp:22', async () => {
    await sh(heater.getCharacteristic(Characteristic.CoolingThresholdTemperature))(22);
    expect(lastCmd()).toMatchObject({ power_off: false, temp: 22, swing: false });
  });
  it('temp=16 (min) while ON → power_off:false + temp:16', async () => {
    await sh(heater.getCharacteristic(Characteristic.CoolingThresholdTemperature))(16);
    expect(lastCmd()).toMatchObject({ power_off: false, temp: 16 });
  });
  it('temp=30 (max) while ON → power_off:false + temp:30', async () => {
    await sh(heater.getCharacteristic(Characteristic.CoolingThresholdTemperature))(30);
    expect(lastCmd()).toMatchObject({ power_off: false, temp: 30 });
  });

  // All 6 fan-speed thresholds while powered ON
  const FAN_ON_CASES: [number, string | number][] = [
    [0, 'auto'], [20, 1], [40, 2], [60, 3], [80, 4], [100, 5],
  ];
  for (const [pct, expected] of FAN_ON_CASES) {
    it(`fan ${pct}% while ON → power_off:false + fan:${expected}`, async () => {
      await sh(heater.getCharacteristic(Characteristic.RotationSpeed))(pct);
      expect(lastCmd()).toMatchObject({ power_off: false, fan: expected, swing: false });
    });
  }

  it('fan-auto ON while ON → power_off:false + fan:auto', async () => {
    await sh(fanauto.getCharacteristic(Characteristic.On))(true);
    expect(lastCmd()).toMatchObject({ power_off: false, fan: 'auto', swing: false });
  });
  it('fan-auto OFF while ON → power_off:false + fan:1', async () => {
    await sh(fanauto.getCharacteristic(Characteristic.On))(false);
    expect(lastCmd()).toMatchObject({ power_off: false, fan: 1, swing: false });
  });

  // ── Critical: swing tap while ON ────────────────────────────────────────────
  // This is the exact scenario from the bug: swing tap while AC is running.
  // The command must have swing:true AND power_off:false.
  it('swing tap while ON → power_off:false + swing:true (one-shot)', async () => {
    await sh(vswing.getCharacteristic(Characteristic.On))(true);
    expect(lastCmd()).toMatchObject({ power_off: false, swing: true });
  });
  it('swing reset (v=false) while ON → no command sent', async () => {
    await sh(vswing.getCharacteristic(Characteristic.On))(false);
    expect(mockAxios.mock.calls.length).toBe(0);
  });
  it('[REGRESSION] swing tap while ON then mode change → swing:false + power_off:false', async () => {
    await sh(vswing.getCharacteristic(Characteristic.On))(true);
    mockAxios.mockClear();
    await sh(heater.getCharacteristic(Characteristic.TargetHeaterCoolerState))(2);
    expect(lastCmd()).toMatchObject({ swing: false, power_off: false, mode: 'cool' });
  });
  it('[REGRESSION] swing tap while ON then fan change → swing:false + power_off:false', async () => {
    await sh(vswing.getCharacteristic(Characteristic.On))(true);
    mockAxios.mockClear();
    await sh(heater.getCharacteristic(Characteristic.RotationSpeed))(60);
    expect(lastCmd()).toMatchObject({ swing: false, power_off: false, fan: 3 });
  });

  // ── hswing while ON ──────────────────────────────────────────────────────────
  it('hswing ON while ON → power_off:false + hswing:true', async () => {
    await sh(hswing.getCharacteristic(Characteristic.On))(true);
    expect(lastCmd()).toMatchObject({ power_off: false, hswing: true, swing: false });
  });
  it('hswing OFF while ON (stateless: always fires) → power_off:false + hswing:false', async () => {
    await sh(hswing.getCharacteristic(Characteristic.On))(false);
    expect(lastCmd()).toMatchObject({ power_off: false, hswing: false, swing: false });
  });
  it('hswing ON then OFF while ON → hswing:false + power_off:false', async () => {
    await sh(hswing.getCharacteristic(Characteristic.On))(true);
    mockAxios.mockClear();
    await sh(hswing.getCharacteristic(Characteristic.On))(false);
    expect(lastCmd()).toMatchObject({ power_off: false, hswing: false, swing: false });
  });
});

// ── Stateful vswing and hswing (no stateless:true) ────────────────────────────
// Stateful swing persists in state so subsequent commands carry the last set
// value — this is intentionally different from stateless (one-shot) swing.
// Dedup protection: same-value sets are silently dropped (no HTTP call).

const STATEFUL_SWING_CFG = {
  name: MAXE_AC,
  pollInterval: 0,
  command: {
    url: MAXE_URL,
    method: 'POST' as const,
    body: '{"mode":"{mode}","temp":{temperature},"fan":{fanSpeed},"swing":{swingVertical},"hswing":{swingHorizontal},"power_off":{active}}',
    map: {
      active:          { '0': 'true',  '1': 'false' },
      mode:            { '0': 'auto',  '1': 'heat',  '2': 'cool' },
      fanSpeed:        { '0': 'auto',  '20': '1', '40': '2', '60': '3', '80': '4', '100': '5' },
      swingVertical:   { '0': 'false', '1': 'true' },
      swingHorizontal: { '0': 'false', '1': 'true' },
    },
  },
  coolingThresholdTemperature: {},
  // NOTE: no stateless:true — these are stateful (persistent) switches
  swingVertical:   {},
  swingHorizontal: {},
};

function makeStatefulSwingAcc() {
  const hapAcc = new Accessory(MAXE_AC, uuid.generate(`sf-swing-${Math.random()}`));
  const mp = {
    log: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
    Service, Characteristic,
    api: { hap: { HapStatusError, HAPStatus, uuid } },
  };
  const ma = {
    context: { config: STATEFUL_SWING_CFG },
    getService:    (a: unknown) => hapAcc.getService(a as never),
    addService:    (...a: unknown[]) => (hapAcc.addService as never)(...a),
    removeService: (s: unknown) => hapAcc.removeService(s as Service),
    get services() { return hapAcc.services; },
  };
  new AcHttpAccessory(mp as never, ma as never);
  return hapAcc;
}

describe('stateful vswing / hswing — persistent state and dedup', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let hapAcc: any, heater: Service, vswing: Service, hswing: Service;

  beforeEach(() => {
    mockAxios.mockClear();
    hapAcc  = makeStatefulSwingAcc();
    heater  = hapAcc.services.find((s: Service) => s.UUID === Service.HeaterCooler.UUID);
    vswing  = hapAcc.services.find((s: Service) => s.subtype === 'vswing');
    hswing  = hapAcc.services.find((s: Service) => s.subtype === 'hswing');
  });

  // ── Stateful vswing ───────────────────────────────────────────────────────
  it('vswing ON (0→1) → swing:true', async () => {
    await sh(vswing.getCharacteristic(Characteristic.On))(true);
    expect(lastCmd().swing).toBe(true);
  });
  it('vswing OFF (1→0) → swing:false', async () => {
    await sh(vswing.getCharacteristic(Characteristic.On))(true);   // ON first
    mockAxios.mockClear();
    await sh(vswing.getCharacteristic(Characteristic.On))(false);  // then OFF
    expect(lastCmd().swing).toBe(false);
  });
  it('vswing dedup: same value (false→false) → no command sent', async () => {
    // state starts at 0 (false); setting false again is deduped
    await sh(vswing.getCharacteristic(Characteristic.On))(false);
    expect(mockAxios.mock.calls.length).toBe(0);
  });
  it('vswing dedup: same value (true→true) → no command sent', async () => {
    await sh(vswing.getCharacteristic(Characteristic.On))(true);   // set to true
    mockAxios.mockClear();
    await sh(vswing.getCharacteristic(Characteristic.On))(true);   // same value
    expect(mockAxios.mock.calls.length).toBe(0);
  });
  it('stateful vswing ON persists: subsequent temp change carries swing:true', async () => {
    await sh(vswing.getCharacteristic(Characteristic.On))(true);
    mockAxios.mockClear();
    await sh(heater.getCharacteristic(Characteristic.CoolingThresholdTemperature))(24);
    // Intentional: stateful swing should persist (unlike stateless which resets)
    expect(lastCmd()).toMatchObject({ swing: true, temp: 24 });
  });
  it('stateful vswing OFF resets: subsequent temp change carries swing:false', async () => {
    await sh(vswing.getCharacteristic(Characteristic.On))(true);
    await sh(vswing.getCharacteristic(Characteristic.On))(false);
    mockAxios.mockClear();
    await sh(heater.getCharacteristic(Characteristic.CoolingThresholdTemperature))(24);
    expect(lastCmd()).toMatchObject({ swing: false, temp: 24 });
  });

  // ── Stateful hswing ───────────────────────────────────────────────────────
  it('hswing ON (0→1) → hswing:true', async () => {
    await sh(hswing.getCharacteristic(Characteristic.On))(true);
    expect(lastCmd().hswing).toBe(true);
  });
  it('hswing OFF (1→0) → hswing:false', async () => {
    await sh(hswing.getCharacteristic(Characteristic.On))(true);
    mockAxios.mockClear();
    await sh(hswing.getCharacteristic(Characteristic.On))(false);
    expect(lastCmd().hswing).toBe(false);
  });
  it('hswing dedup: same value (false→false) → no command sent', async () => {
    await sh(hswing.getCharacteristic(Characteristic.On))(false);
    expect(mockAxios.mock.calls.length).toBe(0);
  });
  it('hswing dedup: same value (true→true) → no command sent', async () => {
    await sh(hswing.getCharacteristic(Characteristic.On))(true);
    mockAxios.mockClear();
    await sh(hswing.getCharacteristic(Characteristic.On))(true);
    expect(mockAxios.mock.calls.length).toBe(0);
  });
  it('stateful hswing ON persists: subsequent mode change carries hswing:true', async () => {
    await sh(hswing.getCharacteristic(Characteristic.On))(true);
    mockAxios.mockClear();
    await sh(heater.getCharacteristic(Characteristic.TargetHeaterCoolerState))(2);
    expect(lastCmd()).toMatchObject({ hswing: true, mode: 'cool' });
  });

  // ── Stateful vswing + hswing together ────────────────────────────────────
  it('vswing ON + hswing ON: both carried in subsequent command', async () => {
    await sh(vswing.getCharacteristic(Characteristic.On))(true);
    await sh(hswing.getCharacteristic(Characteristic.On))(true);
    mockAxios.mockClear();
    await sh(heater.getCharacteristic(Characteristic.CoolingThresholdTemperature))(22);
    expect(lastCmd()).toMatchObject({ swing: true, hswing: true, temp: 22 });
  });
  it('vswing ON then OFF: hswing unaffected', async () => {
    await sh(vswing.getCharacteristic(Characteristic.On))(true);
    await sh(hswing.getCharacteristic(Characteristic.On))(true);
    await sh(vswing.getCharacteristic(Characteristic.On))(false);
    mockAxios.mockClear();
    await sh(heater.getCharacteristic(Characteristic.CoolingThresholdTemperature))(24);
    expect(lastCmd()).toMatchObject({ swing: false, hswing: true });
  });
});

// ── Swing modes (stateless + discrete positions via radio switches) ───────────
// Swing modes represent named positions (e.g. "Off", "mid", "wide").
// Tapping a mode sends that index as swingVertical in the command and deselects
// the others (radio button behaviour). Tapping the selected mode does nothing.

const SWING_MODES_CFG = {
  name: MAXE_AC,
  pollInterval: 0,
  command: {
    url: MAXE_URL,
    method: 'POST' as const,
    body: '{"mode":"{mode}","temp":{temperature},"fan":{fanSpeed},"swing":{swingVertical},"hswing":{swingHorizontal},"power_off":{active}}',
    map: {
      active:          { '0': 'true',  '1': 'false' },
      mode:            { '0': 'auto',  '1': 'heat',  '2': 'cool' },
      fanSpeed:        { '0': 'auto',  '20': '1', '40': '2', '60': '3', '80': '4', '100': '5' },
      swingVertical:   { '0': 'off', '1': 'mid', '2': 'wide' },
      swingHorizontal: { '0': 'false', '1': 'true' },
    },
  },
  coolingThresholdTemperature: {},
  swingVertical:   { stateless: true, modes: ['Off', 'mid', 'wide'] },
  swingHorizontal: { stateless: true },
};

function makeSwingModesAcc() {
  const hapAcc = new Accessory(MAXE_AC, uuid.generate(`sm-${Math.random()}`));
  const mp = {
    log: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
    Service, Characteristic,
    api: { hap: { HapStatusError, HAPStatus, uuid } },
  };
  const ma = {
    context: { config: SWING_MODES_CFG },
    getService:    (a: unknown) => hapAcc.getService(a as never),
    addService:    (...a: unknown[]) => (hapAcc.addService as never)(...a),
    removeService: (s: unknown) => hapAcc.removeService(s as Service),
    get services() { return hapAcc.services; },
  };
  new AcHttpAccessory(mp as never, ma as never);
  return hapAcc;
}

describe('swing modes (stateless radio buttons) — each mode sends correct swing value', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let hapAcc: any, heater: Service, mode0: Service, mode1: Service, mode2: Service;

  beforeEach(() => {
    mockAxios.mockClear();
    hapAcc = makeSwingModesAcc();
    heater = hapAcc.services.find((s: Service) => s.UUID === Service.HeaterCooler.UUID);
    mode0  = hapAcc.services.find((s: Service) => s.subtype === 'swing-mode-0');
    mode1  = hapAcc.services.find((s: Service) => s.subtype === 'swing-mode-1');
    mode2  = hapAcc.services.find((s: Service) => s.subtype === 'swing-mode-2');
  });

  it('all three swing-mode services registered', () => {
    expect(mode0).toBeDefined();
    expect(mode1).toBeDefined();
    expect(mode2).toBeDefined();
  });
  it('mode 0 (Off) tap → swing:"off" in command', async () => {
    // State starts at 0, so select mode 1 first to change state, then select mode 0
    await sh(mode1.getCharacteristic(Characteristic.On))(true);
    mockAxios.mockClear();
    await sh(mode0.getCharacteristic(Characteristic.On))(true);
    expect(lastCmd().swing).toBe('off');
  });
  it('mode 1 (mid) tap → swing:"mid" in command', async () => {
    await sh(mode1.getCharacteristic(Characteristic.On))(true);
    expect(lastCmd().swing).toBe('mid');
  });
  it('mode 2 (wide) tap → swing:"wide" in command', async () => {
    await sh(mode2.getCharacteristic(Characteristic.On))(true);
    expect(lastCmd().swing).toBe('wide');
  });
  it('radio deselect (v=false) → no command, snaps back', async () => {
    await sh(mode1.getCharacteristic(Characteristic.On))(true);  // select 1
    mockAxios.mockClear();
    await sh(mode1.getCharacteristic(Characteristic.On))(false); // deselect → snap back
    expect(mockAxios.mock.calls.length).toBe(0);
  });
  it('mode 1 → mode 2: command has swing:"wide"', async () => {
    await sh(mode1.getCharacteristic(Characteristic.On))(true);
    mockAxios.mockClear();
    await sh(mode2.getCharacteristic(Characteristic.On))(true);
    expect(lastCmd().swing).toBe('wide');
  });
  it('mode selection persists: after mode 2, temp change carries swing:"wide"', async () => {
    await sh(mode2.getCharacteristic(Characteristic.On))(true);
    mockAxios.mockClear();
    await sh(heater.getCharacteristic(Characteristic.CoolingThresholdTemperature))(24);
    // Modes (radio buttons) persist like stateful swing — the selected mode stays
    expect(lastCmd()).toMatchObject({ swing: 'wide', temp: 24 });
  });
  it('mode 2 → mode 0: subsequent temp change has swing:"off"', async () => {
    await sh(mode2.getCharacteristic(Characteristic.On))(true);
    await sh(mode0.getCharacteristic(Characteristic.On))(true);
    mockAxios.mockClear();
    await sh(heater.getCharacteristic(Characteristic.CoolingThresholdTemperature))(24);
    expect(lastCmd()).toMatchObject({ swing: 'off', temp: 24 });
  });
});
