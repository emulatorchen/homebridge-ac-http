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
  stateUrl?: string;
  pollInterval?: number;
  setterDelay?: number;
  minTemp?: number;
  maxTemp?: number;
  command?: CommandConfig;
  active?:                      { get?: EndpointConfig; set?: EndpointConfig };
  targetHeaterCoolerState?:     { get?: EndpointConfig; set?: EndpointConfig };
  currentTemperature?:          { get?: EndpointConfig };
  currentRelativeHumidity?:     { get?: EndpointConfig };
  coolingThresholdTemperature?: { get?: EndpointConfig; set?: EndpointConfig };
  heatingThresholdTemperature?: { get?: EndpointConfig; set?: EndpointConfig };
  swingVertical?:               SwingConfig;
  swingHorizontal?:             SwingConfig;
  rotationSpeed?:               { get?: EndpointConfig; set?: EndpointConfig; fanSpeedMap?: FanSpeedConfig };
}

export type AcTemplateConfig = Omit<AcDeviceConfig, 'name' | 'serial' | 'model' | 'template' | 'host' | 'port'>;
export interface AcTemplateEntry extends AcTemplateConfig { name: string; }

export interface AcHttpPlatformConfig {
  platform: string;
  templates?: AcTemplateEntry[] | Record<string, AcTemplateConfig>;
  accessories: AcDeviceConfig[];
}
