import { describe, it, expect } from 'vitest';
import { percentToSpeed, thresholdMap, resolveCommandBody } from './accessory.js';

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
