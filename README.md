# homebridge-ac-http

**Homebridge plugin for any HTTP/REST-controlled air conditioner.** If your AC is controlled by an IR blaster, ESP8266, ESP32, Raspberry Pi, Tuya-local bridge, or any device with a REST API, this plugin exposes it as a native HomeKit Heater/Cooler accessory — supporting Homebridge 1.x and 2.0.

[![npm](https://img.shields.io/npm/v/homebridge-ac-http)](https://www.npmjs.com/package/homebridge-ac-http)
[![CI](https://github.com/emulatorchen/homebridge-ac-http/actions/workflows/ci.yml/badge.svg)](https://github.com/emulatorchen/homebridge-ac-http/actions/workflows/ci.yml)

## Features

- **IR blaster / composed command** — sends the full AC state (power + mode + temp + fan + swing) in one HTTP call, exactly how IR remotes work
- **Granular REST API** — per-characteristic endpoints for devices that support individual commands
- **Templates** — define endpoint config once per AC model, reuse across rooms with just a `host` change
- **Dual-axis swing** — vertical (HomeKit SwingMode) and horizontal (linked Switch tile)
- **Stateless swing** — IR toggle mode: fires every tap, no state polling needed
- **Fan speed mapping** — any discrete speed names mapped to/from HomeKit 0–100% slider
- **Humidity sensor** — optional `currentRelativeHumidity` linked to the AC tile
- **Custom HTTP headers** — Bearer tokens, API keys, Basic auth
- **Setter debounce** — prevents slider spam from flooding the AC controller
- **Configurable temperature range** — override the default 16–30°C for your region
- **Localised tile labels** — pick a language (`en` `ja` `zh-CN` `zh-TW` `ko` `de` `fr` `es` `it` `pt` `nl`) or set your own
- **All HTTP methods** — GET, POST, PUT, PATCH, DELETE
- **Flexible response parsing** — JSONPath extraction, bidirectional value maps

## Compatibility

| Homebridge | Node.js | Status     |
|------------|---------|------------|
| 1.x (apt-pkg ≥ 1.2.0, April 2024+) | 20 | Supported |
| 2.0.x       | 22  | Supported  |

This plugin requires **Node.js 20**. For Homebridge 1.x, that means you need a build from April 2024 or later — specifically `homebridge-apt-pkg` v1.2.0–v1.3.12, which is the version range that shipped Node 20. These builds are available as the [`legacy` tag on Docker Hub](https://hub.docker.com/r/homebridge/homebridge/tags?name=legacy). Older 1.x installs (Node 18) are not supported.

## What it looks like in HomeKit

**Single AC tile** (HeaterCooler service):
- Power on/off
- Mode selector: Auto / Heat / Cool
- Target temperature (configurable range, 1°C steps)
- Fan speed slider (0–100%, mapped to your AC's discrete speeds)
- Vertical swing toggle

**Additional tiles** (only appear when configured):
- `[name] H-Swing` — Switch tile for horizontal swing axis
- Humidity sensor tile — shows current relative humidity

All tiles belong to the same accessory and appear together in the accessory detail view.

## HomeKit Limitations

- **Fan-only and Dry modes** have no HomeKit equivalent. Map them to Auto (0) via `command.map.mode` or `setValueMap`, or use a separate Switch accessory.
- **Horizontal swing** cannot fit inside the HeaterCooler tile — it appears as a separate linked Switch.
- **Humidity** appears as a separate linked Sensor tile, not inside the HeaterCooler panel.
- **Fixed-angle swing** — HomeKit only shows on/off. Map the "on" state to your desired angle string via `swingVertical.stateless + command.map.swingVertical`.

## Install

**Homebridge UI (easiest)** — open the Homebridge web interface, go to the **Plugins** tab, search for `homebridge-ac-http`, and click Install. Restart Homebridge when prompted.

**Command line** — run this on the machine where Homebridge is installed:

```bash
sudo npm install -g homebridge-ac-http
```

Then restart Homebridge.

**Adding to your config** — after installing, go to the Homebridge UI config editor and add a platform block. The easiest way is to copy one of the examples below and fill in your AC's IP address. If you prefer to edit `config.json` directly, add the `AcHttpPlatform` block alongside any other platforms you have.

## Quick Start

Minimal config for an IR blaster:

```json
{
  "platform": "AcHttpPlatform",
  "accessories": [
    {
      "name": "Living Room AC",
      "command": {
        "url": "http://192.168.1.10/api/send",
        "method": "POST",
        "body": "{\"power\":\"{active}\",\"mode\":\"{mode}\",\"temp\":{temperature},\"fan\":\"{fanSpeed}\",\"swing\":\"{swingVertical}\"}",
        "map": {
          "active":        { "0": "off",  "1": "on"                              },
          "mode":          { "0": "auto", "1": "heat", "2": "cool"               },
          "fanSpeed":      { "0": "auto", "20": "1",  "60": "3",  "100": "5"     },
          "swingVertical": { "0": "off",  "1": "on"                              }
        }
      },
      "swingVertical": { "stateless": true }
    }
  ]
}
```

## How to Configure

### Mode A: IR Blaster / Composed Command

For IR-controlled ACs, the blaster must receive the **complete state** in every call. Use the `command` block:

```json
"command": {
  "url": "http://192.168.1.10/api/ir",
  "method": "POST",
  "body": "{\"power\":\"{active}\",\"mode\":\"{mode}\",\"temp\":{temperature},\"fan\":\"{fanSpeed}\",\"vswing\":\"{swingVertical}\",\"hswing\":\"{swingHorizontal}\"}",
  "map": {
    "active":          { "0": "off",  "1": "on"   },
    "mode":            { "0": "fan",  "1": "heat", "2": "cool" },
    "fanSpeed":        { "0": "auto", "20": "1",  "60": "3", "100": "5" },
    "swingVertical":   { "0": "off",  "1": "30deg" },
    "swingHorizontal": { "0": "off",  "1": "on"    }
  }
}
```

Body template placeholders:

| Placeholder         | HomeKit source                          |
|---------------------|-----------------------------------------|
| `{active}`          | Power on/off (mapped via `map.active`)  |
| `{mode}`            | Target mode (mapped via `map.mode`)     |
| `{temperature}`     | Target temperature (numeric, no map)    |
| `{fanSpeed}`        | Fan speed % (threshold-mapped)          |
| `{swingVertical}`   | Vertical swing 0/1 (mapped)             |
| `{swingHorizontal}` | Horizontal swing 0/1 (mapped)           |

**Fan speed map** uses threshold matching: the map key is the minimum HomeKit % that triggers that speed. Key `"0"` = auto, `"20"` = speed 1 (for 20–39%), etc.

**Numeric vs string** in body: use `{temperature}` without quotes for a number, `"{active}"` with quotes for a string.

When `command` is configured, all SET operations use it. Individual characteristic `set` endpoints are ignored (but `get` endpoints still work for state polling).

#### What the plugin actually sends

When you change something in Home — say, switching to Cool mode at 24°C — the plugin builds the full AC state from memory and sends one HTTP request:

```
PUT http://192.168.1.10/api/ir
Content-Type: application/json

{
  "power": "on",
  "mode": "cool",
  "temp": 24,
  "fan": "auto",
  "vswing": "off",
  "hswing": "off"
}
```

A `200 OK` with any body (or empty body) means success. Non-2xx responses are logged as errors in the Homebridge log.

#### What the plugin reads for state polling

If you configure `stateUrl` (or per-characteristic `get` endpoints), the plugin fetches the current state on a timer and updates HomeKit. Your device needs to return JSON that you can point a `jsonPath` at:

```
GET http://192.168.1.10/api/status

HTTP/1.1 200 OK
Content-Type: application/json

{
  "power": "on",
  "mode": "cool",
  "setpoint": 24,
  "room_temp": 26.5,
  "humidity": 62,
  "fan": "auto"
}
```

Then in config:
```json
"stateUrl": "http://192.168.1.10/api/status",
"active":                      { "get": { "jsonPath": "$.power",    "valueMap": { "on": "1", "off": "0" } } },
"targetHeaterCoolerState":     { "get": { "jsonPath": "$.mode",     "valueMap": { "auto": "0", "heat": "1", "cool": "2" } } },
"currentTemperature":          { "get": { "jsonPath": "$.room_temp" } },
"currentRelativeHumidity":     { "get": { "jsonPath": "$.humidity"  } },
"coolingThresholdTemperature": { "get": { "jsonPath": "$.setpoint"  } }
```

`jsonPath` uses dot notation starting with `$` — `$.room_temp` extracts the `room_temp` field, `$.data.temp` goes one level deeper, and so on.

### Mode B: Granular REST API

For devices that accept individual property commands:

```json
{
  "name": "Kitchen AC",
  "stateUrl": "http://192.168.1.20/api/status",
  "pollInterval": 30,
  "active": {
    "get": { "jsonPath": "$.power", "valueMap": { "ON": "1", "OFF": "0" } },
    "set": { "url": "http://192.168.1.20/api/power", "method": "POST", "body": "{\"value\":\"{value}\"}", "setValueMap": { "1": "ON", "0": "OFF" } }
  },
  "targetHeaterCoolerState": {
    "get": { "jsonPath": "$.mode", "valueMap": { "AUTO": "0", "HEAT": "1", "COOL": "2" } },
    "set": { "url": "http://192.168.1.20/api/mode", "method": "POST", "body": "{\"mode\":\"{value}\"}", "setValueMap": { "0": "AUTO", "1": "HEAT", "2": "COOL" } }
  },
  "currentTemperature":          { "get": { "jsonPath": "$.room_temp" } },
  "coolingThresholdTemperature": {
    "get": { "jsonPath": "$.setpoint" },
    "set": { "url": "http://192.168.1.20/api/setpoint", "method": "POST", "body": "{\"temp\":{value}}" }
  },
  "rotationSpeed": {
    "get": { "jsonPath": "$.fan", "valueMap": { "AUTO": "0", "LOW": "33", "HIGH": "100" } },
    "set": { "url": "http://192.168.1.20/api/fan", "method": "POST" },
    "fanSpeedMap": { "valueToPercent": { "auto": 0, "low": 33, "high": 100 } }
  }
}
```

### Same AC Model in Multiple Rooms

If you have the same AC (or IR blaster) in several rooms, you only need to write the configuration once. Put the shared settings in `templates` under a name you choose, then each room's accessory just says which template to use and supplies its own IP address.

Anywhere you write `{host}` or `{port}` in a URL inside the template, the plugin fills it in from each accessory's `host` / `port` field.

```json
{
  "platform": "AcHttpPlatform",
  "templates": [
    {
      "name": "my-ir-blaster",
      "command": {
        "url": "http://{host}/api/send",
        "method": "POST",
        "body": "{\"power\":\"{active}\",\"mode\":\"{mode}\",\"temp\":{temperature},\"fan\":\"{fanSpeed}\"}",
        "map": {
          "active": { "0": "off", "1": "on" },
          "mode":   { "0": "auto", "1": "heat", "2": "cool" },
          "fanSpeed": { "0": "auto", "20": "1", "60": "3", "100": "5" }
        }
      },
      "swingVertical": { "stateless": true },
      "minTemp": 16,
      "maxTemp": 30
    }
  ],
  "accessories": [
    { "name": "Living Room AC", "serial": "LR-001", "template": "my-ir-blaster", "host": "192.168.1.10" },
    { "name": "Bedroom AC",     "serial": "BR-001", "template": "my-ir-blaster", "host": "192.168.1.11" },
    { "name": "Office AC",      "serial": "OF-001", "template": "my-ir-blaster", "host": "192.168.1.12", "setterDelay": 500 }
  ]
}
```

Each accessory inherits everything from the template. You can override any individual field directly on the accessory — it takes priority over the template value.
```

## Full Config Reference

### Platform

| Field         | Type   | Default | Description |
|---------------|--------|---------|-------------|
| `language`    | string | `en`    | Language for tile labels. Options: `en` `ja` `zh-CN` `zh-TW` `ko` `de` `fr` `es` `it` `pt` `nl` |
| `templates`   | array  | —       | Shared AC model configs. Each entry needs a `name` field. |
| `accessories` | array  | —       | List of AC accessories. |

### Accessory

| Field          | Type    | Default | Description |
|----------------|---------|---------|-------------|
| `name`         | string  | required | HomeKit display name. |
| `serial`       | string  | —        | Stable UUID seed. Strongly recommended. |
| `model`        | string  | —        | Shown in accessory info. |
| `template`     | string  | —        | Inherit from a named template. |
| `host`         | string  | —        | IP address or hostname of this AC unit. Replaces `{host}` in template URLs. |
| `port`         | integer | 80       | Port of this AC unit. Replaces `{port}` in template URLs. |
| `stateUrl`     | string  | —        | Fallback GET URL for characteristics with no own `get.url`. |
| `pollInterval` | integer | 30       | State refresh interval in seconds. 0 = disabled. |
| `setterDelay`  | integer | 0        | Debounce ms for SET commands. Useful for sliders. |
| `minTemp`      | integer | 16       | Minimum HomeKit target temperature (°C). |
| `maxTemp`      | integer | 30       | Maximum HomeKit target temperature (°C). |
| `command`      | object  | —        | Composed command (IR mode). See above. |

### Template

Templates support the same fields as accessories **except** `name` (used as the template key), `serial`, `model`, `template`, `host`, and `port` — those belong on each AC unit. Put `{host}` and `{port}` as placeholders in URLs; each accessory supplies the real values.

### Endpoint Config (used in per-characteristic `get`/`set`)

| Field        | Type   | Default | Description |
|--------------|--------|---------|-------------|
| `url`        | string | required | Full URL. |
| `method`     | string | POST     | HTTP method: GET, POST, PUT, PATCH, DELETE. |
| `body`       | string | —        | Request body template. Use `{value}` as placeholder. |
| `jsonPath`   | string | —        | Dot-notation path to extract from JSON response, e.g. `$.data.temp`. |
| `valueMap`   | object | —        | Maps HTTP response string → HomeKit number string. Auto-reversed for SET. |
| `setValueMap`| object | —        | Maps HomeKit value → API string. Overrides reversed `valueMap`. |
| `headers`    | object | —        | Custom HTTP headers, e.g. `{ "Authorization": "Bearer token" }`. |
| `timeout`    | integer | 5000    | Request timeout in ms. |

### Swing Config (`swingVertical`, `swingHorizontal`)

| Field      | Type    | Default | Description |
|------------|---------|---------|-------------|
| `get`      | object  | —       | EndpointConfig for reading state. |
| `set`      | object  | —       | EndpointConfig for setting state (non-command mode). |
| `stateless`| boolean | false   | Momentary trigger: fires every tap, resets to OFF, no state polling needed. Use for IR toggles. |
| `modes`    | array   | —       | (Stateless only) Radio-button labels — one Switch tile per entry. |
| `label`    | string  | language default | Override the tile name suffix (e.g. `"スイング"`). |

## Local Testing

### Homebridge 1.x (existing installation)

```bash
npm install && npm run build
npm link
homebridge -D
```

### Docker (both 1.x and 2.x)

```bash
npm run build
docker compose -f docker-compose.test.yml up
```

- Homebridge 1.x UI: http://localhost:8581 — uses [`homebridge/homebridge:legacy`](https://hub.docker.com/r/homebridge/homebridge/tags?name=legacy) (Node 20, apt-pkg v1.2.0–v1.3.12)
- Homebridge 2.x UI: http://localhost:8582 — uses `homebridge/homebridge:latest`

Add your plugin config via the Homebridge UI on first run.

## Known Limitations

- IR devices have no state feedback — the REST API must maintain its own state store.
- Physical remote desync is unavoidable with IR.
- Swing state tracked in memory — resets on Homebridge restart for stateless configs.
- Fan-only and Dry modes: map to HomeKit Auto (0) via `map.mode` or document separately.

## Visual Verification with HomeKit Accessory Simulator

The CI pipeline proves tile names via the HAP protocol (the same request the iPhone makes when it pairs). For visual confirmation of how the tiles look in Apple's own rendering, there is a local script that runs the same checks inside [HomeKit Accessory Simulator](https://developer.apple.com/download/all/) (HAS) — Apple's desktop tool for testing HomeKit accessories.

**This only works on macOS and is not part of CI.**

### What it checks

The script shows each of the 5 tiles in HAS one at a time and saves a screenshot:

| Tile | Service type |
|------|-------------|
| Living Room MAXE AC | HeaterCooler |
| Living Room MAXE AC Fan Auto | Switch |
| Living Room MAXE AC Swing | Switch |
| Living Room MAXE AC H-Swing | Switch |
| Living Room MAXE AC Humidity | Humidity Sensor |

Seeing all 5 as separate items proves the companion-accessory pattern is working. If any tile is missing or shows the wrong name, you have found a regression.

### Setup

Install **Additional Tools for Xcode** from [developer.apple.com/download/all](https://developer.apple.com/download/all/) — HomeKit Accessory Simulator is inside that package. No other setup needed; the script builds its own test files from scratch.

### Run

```bash
python3 scripts/has-verify.py
```

Screenshots are saved to `docs/has-screenshots/`. Open each one and confirm the name shown in HAS matches the table above.

```bash
python3 scripts/has-verify.py /tmp/my-shots   # custom output folder
```

The script backs up your existing HAS accessories before running and restores them when it finishes.
