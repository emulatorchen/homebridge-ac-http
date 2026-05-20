export interface EndpointConfig {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: string;
  jsonPath?: string;
  valueMap?: Record<string, string>;
  setValueMap?: Record<string, string>;
  headers?: Record<string, string>;
  timeout?: number;
}

export interface SwingConfig {
  get?: EndpointConfig;
  set?: EndpointConfig;
  stateless?: boolean;
  modes?: string[];  // radio-button labels (stateless only); index = state value used in command map
  label?: string;   // tile label suffix; defaults to 'Swing' / 'H-Swing'
}

export interface FanSpeedConfig {
  valueToPercent: Record<string, number>;
}

export interface CommandConfig {
  url: string;
  method?: 'POST' | 'PUT' | 'PATCH';
  headers?: Record<string, string>;
  timeout?: number;
  body: string;
  map?: {
    active?:          Record<string, string>;
    mode?:            Record<string, string>;
    fanSpeed?:        Record<string, string>;
    swingVertical?:   Record<string, string>;
    swingHorizontal?: Record<string, string>;
  };
}

export interface AcDeviceConfig {
  name: string;
  serial?: string;
  model?: string;
  host?: string;
  port?: number;
  template?: string;
  language?: string;
  stateUrl?: string;
  pollInterval?: number;
  setterDelay?: number;
  minTemp?: number;
  maxTemp?: number;
  command?: CommandConfig;
  active?:                      { get?: EndpointConfig; set?: EndpointConfig };
  targetHeaterCoolerState?:     { get?: EndpointConfig; set?: EndpointConfig };
  currentTemperature?:          { get?: EndpointConfig };
  currentRelativeHumidity?:     { get?: EndpointConfig; label?: string };
  coolingThresholdTemperature?: { get?: EndpointConfig; set?: EndpointConfig };
  heatingThresholdTemperature?: { get?: EndpointConfig; set?: EndpointConfig };
  swingVertical?:               SwingConfig;
  swingHorizontal?:             SwingConfig;
  rotationSpeed?:               { get?: EndpointConfig; set?: EndpointConfig; fanSpeedMap?: FanSpeedConfig; autoSwitch?: boolean; autoSwitchLabel?: string; speeds?: string[] };
}

export type AcTemplateConfig = Omit<AcDeviceConfig, 'name' | 'serial' | 'model' | 'template' | 'host' | 'port'>;
export interface AcTemplateEntry extends AcTemplateConfig { name: string; }

export interface AcHttpPlatformConfig {
  platform: string;
  language?: string;
  templates?: AcTemplateEntry[] | Record<string, AcTemplateConfig>;
  accessories: AcDeviceConfig[];
}
