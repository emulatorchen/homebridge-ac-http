import type { PlatformAccessory, Service, CharacteristicValue, Logger } from 'homebridge';
import type { AcHttpPlatform } from './platform.js';
import type { AcDeviceConfig, EndpointConfig } from './types.js';
import { httpGet, httpSet, applyMap } from './http-client.js';
import { getLabels } from './i18n.js';
import axios from 'axios';

export const DEFAULT_FAN_MAP: [number, string][] = [[0,'auto'],[20,'1'],[40,'2'],[60,'3'],[80,'4'],[100,'5']];

export function percentToSpeed(pct: number, map?: Record<string, number>): string {
  if (!map) return DEFAULT_FAN_MAP.slice().reverse().find(([t]) => pct >= t)?.[1] ?? 'auto';
  const entries = Object.entries(map).map(([k,v]) => [k,v] as [string,number]).sort((a,b) => a[1]-b[1]);
  return entries.slice().reverse().find(([,v]) => pct >= v)?.[0] ?? entries[0][0];
}

export function thresholdMap(value: number, map?: Record<string, string>): string {
  if (!map) return String(value);
  const entries = Object.entries(map)
    .map(([k,v]) => [Number(k), v] as [number, string])
    .sort((a,b) => a[0]-b[0]);
  return entries.slice().reverse().find(([t]) => value >= t)?.[1] ?? entries[0]?.[1] ?? String(value);
}

export function resolveCommandBody(template: string, vars: Record<string, string>): string {
  const resolved = template.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);
  return resolved.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)([,}\]])/g,
    (_, v, t) => (v === 'true' || v === 'false' || v === 'null') ? `:${v}${t}` : `:"${v}"${t}`);
}

export class AcHttpAccessory {
  private readonly service: Service;
  private readonly log: Logger;
  private readonly cfg: AcDeviceConfig;
  private state = { active: 0, mode: 0, currTemp: 25, temp: 24, swingVertical: 0, swingHorizontal: 0, fanSpeed: 0, fanSpeedMode: 'auto', humidity: 50 };
  private pollTimer?: ReturnType<typeof setInterval>;
  private readonly setTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private humidityService?: Service;
  private swingService?: Service;
  private hSwingService?: Service;
  private fanAutoService?: Service;
  private fanSpeedServices?: Service[];
  private swingModeServices?: Service[];

  constructor(private readonly platform: AcHttpPlatform, private readonly accessory: PlatformAccessory) {
    this.log = platform.log;
    this.cfg = accessory.context.config as AcDeviceConfig;
    const minTemp = this.cfg.minTemp ?? 16;
    const maxTemp = this.cfg.maxTemp ?? 30;

    this.accessory.getService(platform.Service.AccessoryInformation)!
      .setCharacteristic(platform.Characteristic.Manufacturer, 'AC HTTP')
      .setCharacteristic(platform.Characteristic.Model,        this.cfg.model  ?? 'Generic AC')
      .setCharacteristic(platform.Characteristic.SerialNumber, this.cfg.serial ?? 'N/A');

    this.service = this.accessory.getService(platform.Service.HeaterCooler)
      ?? this.accessory.addService(platform.Service.HeaterCooler);
    this.service.setCharacteristic(platform.Characteristic.Name, this.cfg.name);
    const i18n = getLabels(this.cfg.language);

    this.service.getCharacteristic(platform.Characteristic.Active)
      .onGet(this.getActive.bind(this)).onSet(this.setActive.bind(this));
    this.service.getCharacteristic(platform.Characteristic.CurrentHeaterCoolerState)
      .onGet(this.getCurrentState.bind(this));
    this.service.getCharacteristic(platform.Characteristic.TargetHeaterCoolerState)
      .onGet(this.getTargetState.bind(this)).onSet(this.setTargetState.bind(this));
    this.service.getCharacteristic(platform.Characteristic.CurrentTemperature)
      .onGet(this.getCurrentTemp.bind(this));

    if (this.cfg.coolingThresholdTemperature)
      this.service.getCharacteristic(platform.Characteristic.CoolingThresholdTemperature)
        .setProps({ minValue: minTemp, maxValue: maxTemp, minStep: 1 })
        .onGet(this.getTemp.bind(this)).onSet(this.setTemp.bind(this));

    if (this.cfg.heatingThresholdTemperature)
      this.service.getCharacteristic(platform.Characteristic.HeatingThresholdTemperature)
        .setProps({ minValue: minTemp, maxValue: maxTemp, minStep: 1 })
        .onGet(this.getTemp.bind(this)).onSet(this.setTemp.bind(this));

    if (this.cfg.rotationSpeed) {
      if (this.cfg.rotationSpeed.speeds?.length) {
        // Discrete mode: radio button Switch services, no RotationSpeed slider
        this.fanSpeedServices = [];
        const speedOptions = this.cfg.rotationSpeed.autoSwitch
          ? ['auto', ...this.cfg.rotationSpeed.speeds]
          : [...this.cfg.rotationSpeed.speeds];
        this.state.fanSpeedMode = speedOptions[0];
        for (const opt of speedOptions) {
          const label = `${this.cfg.name} Fan ${opt}`;
          const svc = (this.accessory.services.find(s => s.subtype === `fan-${opt}`) as Service)
            ?? this.accessory.addService(platform.Service.Switch, label, `fan-${opt}`);
          svc.setCharacteristic(platform.Characteristic.Name, label);
          svc.setCharacteristic(platform.Characteristic.ConfiguredName, label);
          const captured = opt;
          svc.getCharacteristic(platform.Characteristic.On)
            .onGet(() => this.state.fanSpeedMode === captured)
            .onSet((v: CharacteristicValue) => this.setFanSpeedDiscrete(captured, v as boolean));
          this.service.addLinkedService(svc);
          this.fanSpeedServices.push(svc);
        }
      } else {
        // Slider mode
        this.service.getCharacteristic(platform.Characteristic.RotationSpeed)
          .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
          .onGet(this.getFanSpeed.bind(this)).onSet(this.setFanSpeed.bind(this));
        if (this.cfg.rotationSpeed.autoSwitch) {
          const autoLabel = this.cfg.rotationSpeed.autoSwitchLabel || i18n.fanAuto;
          const faLabel = `${this.cfg.name} ${autoLabel}`;
          this.fanAutoService = (this.accessory.services.find(s => s.subtype === 'fanauto') as Service)
            ?? this.accessory.addService(platform.Service.Switch, faLabel, 'fanauto');
          this.fanAutoService.setCharacteristic(platform.Characteristic.Name, faLabel);
          this.fanAutoService.setCharacteristic(platform.Characteristic.ConfiguredName, faLabel);
          this.fanAutoService.getCharacteristic(platform.Characteristic.On)
            .onGet(this.getFanAuto.bind(this)).onSet(this.setFanAuto.bind(this));
          this.service.addLinkedService(this.fanAutoService);
        }
      }
    }

    if (this.cfg.swingVertical) {
      if (this.cfg.swingVertical.stateless && this.cfg.swingVertical.modes?.length) {
        // Radio buttons (stateless + explicit mode list) — linked switches
        this.swingModeServices = [];
        const swingLabel = this.cfg.swingVertical.label || i18n.swing;
        for (let i = 0; i < this.cfg.swingVertical.modes.length; i++) {
          const label = `${this.cfg.name} ${swingLabel} ${this.cfg.swingVertical.modes[i]}`;
          const svc = (this.accessory.services.find(s => s.subtype === `swing-mode-${i}`) as Service)
            ?? this.accessory.addService(platform.Service.Switch, label, `swing-mode-${i}`);
          svc.setCharacteristic(platform.Characteristic.Name, label);
          svc.setCharacteristic(platform.Characteristic.ConfiguredName, label);
          const idx = i;
          svc.getCharacteristic(platform.Characteristic.On)
            .onGet(() => this.state.swingVertical === idx)
            .onSet((v: CharacteristicValue) => this.setSwingMode(idx, v as boolean));
          this.service.addLinkedService(svc);
          this.swingModeServices.push(svc);
        }
      } else if (this.cfg.swingVertical.stateless) {
        // Stateless: linked Switch — fires command on tap, resets to OFF after 300ms
        const swingLabel = this.cfg.swingVertical.label || i18n.swing;
        const swingSvc = (this.accessory.services.find(s => s.subtype === 'vswing') as Service)
          ?? this.accessory.addService(platform.Service.Switch, `${this.cfg.name} ${swingLabel}`, 'vswing');
        swingSvc.setCharacteristic(platform.Characteristic.Name, `${this.cfg.name} ${swingLabel}`);
        swingSvc.setCharacteristic(platform.Characteristic.ConfiguredName, `${this.cfg.name} ${swingLabel}`);
        swingSvc.getCharacteristic(platform.Characteristic.On)
          .onGet(() => false)
          .onSet(async (v: CharacteristicValue) => {
            if (!v) return;
            this.state.swingVertical = 1;
            try {
              if (this.cfg.command) await this.sendCommand();
              else if (this.cfg.swingVertical?.set) await this.safeSet(this.cfg.swingVertical.set, 1, 'SwingVertical');
            } finally {
              this.state.swingVertical = 0;  // one-shot: don't poison subsequent commands
              setTimeout(() => swingSvc.updateCharacteristic(this.platform.Characteristic.On, false), 300);
            }
          });
        this.service.addLinkedService(swingSvc);
      } else {
        // Stateful: linked Switch (SwingMode=0 is hidden by Home app)
        const swingLabel = this.cfg.swingVertical.label || i18n.swing;
        this.swingService = (this.accessory.services.find(s => s.subtype === 'vswing') as Service)
          ?? this.accessory.addService(platform.Service.Switch, `${this.cfg.name} ${swingLabel}`, 'vswing');
        this.swingService.setCharacteristic(platform.Characteristic.Name, `${this.cfg.name} ${swingLabel}`);
        this.swingService.setCharacteristic(platform.Characteristic.ConfiguredName, `${this.cfg.name} ${swingLabel}`);
        this.swingService.getCharacteristic(platform.Characteristic.On)
          .onGet(async () => Boolean(await this.getSwingVertical()))
          .onSet(async (v: CharacteristicValue) => this.setSwingVertical(v ? 1 : 0));
        this.service.addLinkedService(this.swingService);
      }
    }

    if (this.cfg.currentRelativeHumidity) {
      const humLabel = `${this.cfg.name} ${this.cfg.currentRelativeHumidity?.label || i18n.humidity}`;
      this.humidityService = this.accessory.getService(platform.Service.HumiditySensor)
        ?? this.accessory.addService(platform.Service.HumiditySensor, humLabel);
      this.humidityService.setCharacteristic(platform.Characteristic.Name, humLabel);
      this.humidityService.setCharacteristic(platform.Characteristic.ConfiguredName, humLabel);
      this.humidityService.getCharacteristic(platform.Characteristic.CurrentRelativeHumidity)
        .onGet(this.getHumidity.bind(this));
      this.service.addLinkedService(this.humidityService);
    }

    if (this.cfg.swingHorizontal) {
      const hLabel = `${this.cfg.name} ${this.cfg.swingHorizontal.label || i18n.hSwing}`;
      this.hSwingService = (this.accessory.services.find(s => s.subtype === 'hswing') as Service)
        ?? this.accessory.addService(platform.Service.Switch, hLabel, 'hswing');
      this.hSwingService.setCharacteristic(platform.Characteristic.Name, hLabel);
      this.hSwingService.setCharacteristic(platform.Characteristic.ConfiguredName, hLabel);
      this.hSwingService.getCharacteristic(platform.Characteristic.On)
        .onGet(this.getSwingHorizontal.bind(this)).onSet(this.setSwingHorizontal.bind(this));
      this.service.addLinkedService(this.hSwingService);
    }

    const interval = this.cfg.pollInterval ?? 30;
    if (interval > 0) {
      this.pollTimer = setInterval(() => this.pollState(), interval * 1000);
      this.pollState();
    }
  }

  private async pollState(): Promise<void> {
    try {
      // Sequential — many AC controllers (ESP8266/Arduino) can only handle one TCP connection at a time
      this.state.active   = await this.safeGet(this.resolveGet(this.cfg.active),                  this.state.active);
      this.state.currTemp = await this.safeGet(this.resolveGet(this.cfg.currentTemperature),      this.state.currTemp);
      this.state.mode     = await this.safeGet(this.resolveGet(this.cfg.targetHeaterCoolerState), this.state.mode);
      const { active, currTemp, mode } = this.state;
      this.service.updateCharacteristic(this.platform.Characteristic.Active, active);
      this.service.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, currTemp);
      this.service.updateCharacteristic(this.platform.Characteristic.TargetHeaterCoolerState, mode);
      this.service.updateCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState, this.deriveCurrentState());
      if (this.cfg.currentRelativeHumidity && this.humidityService) {
        const humidity = await this.safeGet(this.resolveGet(this.cfg.currentRelativeHumidity), this.state.humidity);
        this.state.humidity = humidity;
        this.humidityService.updateCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity, humidity);
      }
    } catch (err) {
      this.log.warn(`[${this.cfg.name}] Poll failed:`, (err as Error).message);
    }
  }

  private resolveGet(charCfg?: { get?: EndpointConfig }): EndpointConfig | null {
    if (charCfg?.get?.url) return charCfg.get;
    if (this.cfg.stateUrl && charCfg?.get) return { ...charCfg.get, url: this.cfg.stateUrl };
    return null;
  }

  private async safeGet(ep: EndpointConfig | null, fallback: number): Promise<number> {
    if (!ep) return fallback;
    try { const v = await httpGet(ep); return isNaN(v) ? fallback : v; }
    catch (err) { this.log.warn(`[${this.cfg.name}] GET failed:`, (err as Error).message); return fallback; }
  }

  private async safeSet(ep: EndpointConfig, value: CharacteristicValue, label: string): Promise<void> {
    try { await httpSet(ep, value as number | string); }
    catch (err) {
      this.log.error(`[${this.cfg.name}] SET ${label} failed:`, (err as Error).message);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  private debouncedSet(key: string, fn: () => Promise<void>): void {
    const prev = this.setTimers.get(key);
    if (prev) clearTimeout(prev);
    if (!this.cfg.setterDelay) {
      fn().catch(err => this.log.error(`[${this.cfg.name}] SET ${key}:`, (err as Error).message));
      return;
    }
    this.setTimers.set(key, setTimeout(() => {
      this.setTimers.delete(key);
      fn().catch(err => this.log.error(`[${this.cfg.name}] SET ${key}:`, (err as Error).message));
    }, this.cfg.setterDelay));
  }

  private async sendCommand(): Promise<void> {
    const cmd = this.cfg.command;
    if (!cmd) return;
    const map = cmd.map ?? {};
    const vars: Record<string, string> = {
      active:          applyMap(String(this.state.active),          map.active),
      mode:            applyMap(String(this.state.mode),            map.mode),
      temperature:     String(this.state.temp),
      fanSpeed:        this.cfg.rotationSpeed?.speeds?.length
        ? this.state.fanSpeedMode
        : (map.fanSpeed
            ? thresholdMap(this.state.fanSpeed, map.fanSpeed)
            : percentToSpeed(this.state.fanSpeed, this.cfg.rotationSpeed?.fanSpeedMap?.valueToPercent)),
      swingVertical:   applyMap(String(this.state.swingVertical),   map.swingVertical),
      swingHorizontal: applyMap(String(this.state.swingHorizontal), map.swingHorizontal),
    };
    const safeBody = resolveCommandBody(cmd.body, vars);
    let parsedBody: unknown = safeBody;
    try { parsedBody = JSON.parse(safeBody); } catch { /* send as string */ }
    try {
      await axios({ method: cmd.method ?? 'POST', url: cmd.url, data: parsedBody, headers: cmd.headers, timeout: cmd.timeout ?? 5000 });
    } catch (err) {
      this.log.error(`[${this.cfg.name}] Command failed:`, (err as Error).message);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  private deriveCurrentState(): number {
    if (!this.state.active) return 0;
    if (this.state.mode === 1) return 2;
    if (this.state.mode === 2) return 3;
    return 1;
  }

  async getActive(): Promise<CharacteristicValue> {
    return this.state.active = await this.safeGet(this.resolveGet(this.cfg.active), this.state.active);
  }
  async setActive(v: CharacteristicValue): Promise<void> {
    this.state.active = v as number;
    if (this.cfg.command) await this.sendCommand();
    else if (this.cfg.active?.set) await this.safeSet(this.cfg.active.set, v, 'Active');
  }

  async getCurrentState(): Promise<CharacteristicValue> { return this.deriveCurrentState(); }

  async getTargetState(): Promise<CharacteristicValue> {
    return this.state.mode = await this.safeGet(this.resolveGet(this.cfg.targetHeaterCoolerState), this.state.mode);
  }
  async setTargetState(v: CharacteristicValue): Promise<void> {
    this.state.mode = v as number;
    if (this.cfg.command) await this.sendCommand();
    else if (this.cfg.targetHeaterCoolerState?.set) await this.safeSet(this.cfg.targetHeaterCoolerState.set, v, 'Mode');
  }

  async getCurrentTemp(): Promise<CharacteristicValue> {
    return this.state.currTemp = await this.safeGet(this.resolveGet(this.cfg.currentTemperature), this.state.currTemp);
  }

  async getTemp(): Promise<CharacteristicValue> {
    return this.state.temp = await this.safeGet(
      this.resolveGet(this.cfg.coolingThresholdTemperature ?? this.cfg.heatingThresholdTemperature),
      this.state.temp
    );
  }
  async setTemp(v: CharacteristicValue): Promise<void> {
    this.state.temp = v as number;
    if (this.cfg.command) {
      this.debouncedSet('temp', () => this.sendCommand());
    } else {
      const targets = [this.cfg.coolingThresholdTemperature, this.cfg.heatingThresholdTemperature].filter(c => c?.set);
      this.debouncedSet('temp', async () => {
        for (const c of targets) await this.safeSet(c!.set!, v, 'Temperature');
      });
    }
  }

  async getSwingVertical(): Promise<CharacteristicValue> {
    if (this.cfg.swingVertical?.stateless) return this.state.swingVertical;
    return this.state.swingVertical = await this.safeGet(this.resolveGet(this.cfg.swingVertical), this.state.swingVertical);
  }
  async setSwingVertical(v: CharacteristicValue): Promise<void> {
    if (!this.cfg.swingVertical?.stateless && (v as number) === this.state.swingVertical) return;
    this.state.swingVertical = v as number;
    if (this.cfg.command) await this.sendCommand();
    else if (this.cfg.swingVertical?.set) await this.safeSet(this.cfg.swingVertical.set, v, 'SwingVertical');
  }

  async getSwingHorizontal(): Promise<CharacteristicValue> {
    if (this.cfg.swingHorizontal?.stateless) return Boolean(this.state.swingHorizontal);
    const val = await this.safeGet(this.resolveGet(this.cfg.swingHorizontal), this.state.swingHorizontal);
    this.state.swingHorizontal = val;
    return Boolean(val);
  }
  async setSwingHorizontal(v: CharacteristicValue): Promise<void> {
    const val = v ? 1 : 0;
    if (!this.cfg.swingHorizontal?.stateless && val === this.state.swingHorizontal) return;
    this.state.swingHorizontal = val;
    if (this.cfg.command) await this.sendCommand();
    else if (this.cfg.swingHorizontal?.set) await this.safeSet(this.cfg.swingHorizontal.set, val, 'SwingHorizontal');
  }

  async getFanSpeed(): Promise<CharacteristicValue> {
    return this.state.fanSpeed = await this.safeGet(this.resolveGet(this.cfg.rotationSpeed), this.state.fanSpeed);
  }
  async setFanSpeed(v: CharacteristicValue): Promise<void> {
    this.state.fanSpeed = v as number;
    if (this.fanAutoService)
      this.fanAutoService.updateCharacteristic(this.platform.Characteristic.On, (v as number) === 0);
    if (this.cfg.command) {
      this.debouncedSet('fanSpeed', () => this.sendCommand());
    } else if (this.cfg.rotationSpeed?.set) {
      const speed = percentToSpeed(v as number, this.cfg.rotationSpeed.fanSpeedMap?.valueToPercent);
      const val = this.cfg.rotationSpeed.set.setValueMap ? v : speed;
      const set = this.cfg.rotationSpeed.set;
      this.debouncedSet('fanSpeed', () => this.safeSet(set, val, 'FanSpeed'));
    }
  }

  async getHumidity(): Promise<CharacteristicValue> {
    return this.state.humidity = await this.safeGet(this.resolveGet(this.cfg.currentRelativeHumidity), this.state.humidity);
  }

  async setFanSpeedDiscrete(value: string, on: boolean): Promise<void> {
    if (!on) {
      // radio button: can't deselect — snap back to current selection
      const idx = this.fanSpeedServices!.findIndex((_, i) => {
        const opts = this.cfg.rotationSpeed!.autoSwitch
          ? ['auto', ...this.cfg.rotationSpeed!.speeds!]
          : this.cfg.rotationSpeed!.speeds!;
        return opts[i] === value;
      });
      if (idx >= 0) this.fanSpeedServices![idx].updateCharacteristic(this.platform.Characteristic.On, true);
      return;
    }
    this.state.fanSpeedMode = value;
    const allOptions = this.cfg.rotationSpeed!.autoSwitch
      ? ['auto', ...this.cfg.rotationSpeed!.speeds!]
      : this.cfg.rotationSpeed!.speeds!;
    for (let i = 0; i < this.fanSpeedServices!.length; i++) {
      if (allOptions[i] !== value)
        this.fanSpeedServices![i].updateCharacteristic(this.platform.Characteristic.On, false);
    }
    if (this.cfg.command) {
      this.debouncedSet('fanSpeed', () => this.sendCommand());
    } else if (this.cfg.rotationSpeed?.set) {
      const set = this.cfg.rotationSpeed.set;
      this.debouncedSet('fanSpeed', () => this.safeSet(set, value, 'FanSpeed'));
    }
  }

  async getFanAuto(): Promise<CharacteristicValue> {
    return this.state.fanSpeed === 0;
  }
  async setFanAuto(v: CharacteristicValue): Promise<void> {
    const auto = v as boolean;
    if (auto) {
      this.state.fanSpeed = 0;
      this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, 0);
    } else if (this.state.fanSpeed === 0) {
      this.state.fanSpeed = 20;
      this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, 20);
    }
    if (this.cfg.command) {
      this.debouncedSet('fanSpeed', () => this.sendCommand());
    } else if (this.cfg.rotationSpeed?.set) {
      const speed = percentToSpeed(this.state.fanSpeed, this.cfg.rotationSpeed.fanSpeedMap?.valueToPercent);
      const val = this.cfg.rotationSpeed.set.setValueMap ? this.state.fanSpeed : speed;
      const set = this.cfg.rotationSpeed.set;
      this.debouncedSet('fanSpeed', () => this.safeSet(set, val, 'FanSpeed'));
    }
  }

  async setSwingMode(index: number, on: boolean): Promise<void> {
    if (!on) {
      // radio buttons can't be deselected — snap back
      this.swingModeServices![index].updateCharacteristic(this.platform.Characteristic.On, true);
      return;
    }
    this.state.swingVertical = index;
    for (let i = 0; i < this.swingModeServices!.length; i++) {
      if (i !== index) this.swingModeServices![i].updateCharacteristic(this.platform.Characteristic.On, false);
    }
    if (this.cfg.command) await this.sendCommand();
    else if (this.cfg.swingVertical?.set) await this.safeSet(this.cfg.swingVertical.set, index, 'SwingVertical');
  }

  onDestroy(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    for (const t of this.setTimers.values()) clearTimeout(t);
    this.setTimers.clear();
  }
}
