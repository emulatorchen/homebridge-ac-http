import type { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig } from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { AcHttpAccessory } from './accessory.js';
import type { AcHttpPlatformConfig, AcDeviceConfig, AcTemplateConfig } from './types.js';

function substituteVars(obj: unknown, vars: Record<string, string>): unknown {
  if (typeof obj === 'string') return obj.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);
  if (Array.isArray(obj))      return obj.map(v => substituteVars(v, vars));
  if (obj && typeof obj === 'object')
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([k, v]) => [k, substituteVars(v, vars)])
    );
  return obj;
}

function resolveTemplate(cfg: AcDeviceConfig, templates: Record<string, AcTemplateConfig>): AcDeviceConfig {
  if (!cfg.template) return cfg;
  const tpl = templates[cfg.template];
  if (!tpl) return cfg;
  const merged = { ...tpl, ...cfg } as AcDeviceConfig;
  const vars: Record<string, string> = { host: cfg.host ?? '', port: String(cfg.port ?? 80) };
  return substituteVars(merged, vars) as AcDeviceConfig;
}

export class AcHttpPlatform implements DynamicPlatformPlugin {
  public readonly Service:        API['hap']['Service'];
  public readonly Characteristic: API['hap']['Characteristic'];
  public readonly api:            API;
  private readonly accessories = new Map<string, PlatformAccessory>();
  private readonly handlers    = new Map<string, AcHttpAccessory>();

  constructor(public readonly log: Logger, public readonly config: PlatformConfig, api: API) {
    this.api            = api;
    this.Service        = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.api.on('didFinishLaunching', () => this.discoverDevices());
  }

  configureAccessory(accessory: PlatformAccessory): void { this.accessories.set(accessory.UUID, accessory); }

  private discoverDevices(): void {
    const platformConfig = this.config as unknown as AcHttpPlatformConfig;
    const templates      = platformConfig.templates ?? {};
    const devices        = platformConfig.accessories ?? [];
    const seen           = new Set<string>();

    for (const rawCfg of devices) {
      const cfg  = resolveTemplate(rawCfg, templates);
      const uuid = this.api.hap.uuid.generate(cfg.serial ?? cfg.name);
      seen.add(uuid);
      const existing = this.accessories.get(uuid);
      if (existing) {
        this.log.info(`Restoring: ${cfg.name}`);
        existing.context.config = cfg;
        this.api.updatePlatformAccessories([existing]);
        this.handlers.set(uuid, new AcHttpAccessory(this, existing));
      } else {
        this.log.info(`Adding: ${cfg.name}`);
        const acc = new this.api.platformAccessory(cfg.name, uuid);
        acc.context.config = cfg;
        this.handlers.set(uuid, new AcHttpAccessory(this, acc));
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
      }
    }

    for (const [uuid, acc] of this.accessories) {
      if (!seen.has(uuid)) {
        this.log.info(`Removing: ${acc.displayName}`);
        this.handlers.get(uuid)?.onDestroy();
        this.handlers.delete(uuid);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
        this.accessories.delete(uuid);
      }
    }
  }
}
