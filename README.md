<p align="center">
  <img src="admin/zendure-ip.png" alt="Zendure IP logo" width="120" />
</p>

<h1 align="center">Zendure IP</h1>

<p align="center">
  Local Zendure polling adapter for ioBroker with optional HEMS aggregation.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.0.15-00a17f.svg" alt="Version 0.0.15" />
  <img src="https://img.shields.io/badge/language-JavaScript-00a17f.svg?logo=javascript&logoColor=fff" alt="JavaScript" />
  <img src="https://img.shields.io/badge/license-MIT-00a17f.svg" alt="MIT License" />
</p>

> [!IMPORTANT]
> This adapter polls Zendure devices locally via `http://<ip>/properties/report` and stores a curated state set instead of dumping the full raw JSON.

> [!NOTE]
> This adapter is **read-only**. It does not control Zendure devices; it reads data and generates flow states and daily counters.  
> For full control features, the recommended adapter is [nograx' Zendure adapter](https://github.com/nograx/ioBroker.zendure-solarflow).

## <img src="icons/features.svg" width="18" alt="" /> Features

- Poll up to **10 Zendure devices** locally
- Device name becomes the folder name under the adapter namespace
- Spaces in device names are converted to `-`
- Curated device states based on the provided per-device script set
- Optional **HEMS** object tree for devices marked with **Device is in HEMS**
- Configurable battery capacity per device for correct remaining/usable kWh values
- Per-device flow states under `device-name/flows`
- Per-device daily counters under `device-name/today`
- Total flow and daily counters for all configured devices under `TOTAL`
- Aggregated flow and daily counters for selected HEMS devices under `HEMS`
- Loop-aware HEMS net import/export counters with gross debug and internal-loop tracking
- Wear-level weighted HEMS SoC and remaining/usable energy calculation
- Manual daily reset via `control.resetToday`

## <img src="icons/devices.svg" width="18" alt="" /> Device objects

Each device gets a compact state set such as:

- `product`, `serial`, `messageId`, `timestamp`
- `soc`
- `acPowerW`, `acDirectionW`, `acChargingW`, `acDischargingW`
- `outputHomePower`, `gridInputPower`
- `solarInputPower`, `solarPower1..4`
- `outputPackPower`, `packInputPower`
- `minSocRaw`, `minSocPct`, `socSetRaw`, `socSetPct`, `socLimit`
- `smartMode`, `inHems`, `deviceIsInHems`
- `packNum`, `deviceType`, `capacityKWh`, `capacitySource`, `wearLevelPct`
- `online`, `lastUpdate`, `ageSec`, `stale`, `rssi`, `lastError`, `rawJson`

`capacityKWh` is taken from the adapter configuration when set. If no capacity is configured, the adapter falls back to a best-effort automatic value. `wearLevelPct` is writable and defaults to `100`. Both values are used for the HEMS energy and wear-weighted SoC calculation.

## <img src="icons/features.svg" width="18" alt="" /> Flow objects

Under `device-name/flows`, `TOTAL/flows` and, when enabled, `HEMS/flows`:

- `acOutTotalW`
- `acOutFromBatteryW`
- `acOutFromPvDirectW`
- `batteryChargeW`
- `batteryDischargeW`
- `acChargeToBatteryW`
- `pvInW`
- `pvToBatteryW`
- `meta.isActive`

For SolarFlow 2400 Pro, `pvToBatteryW` is estimated as `min(outputPackPower, solarInputPower)` when PV input is above the noise threshold.

## <img src="icons/daily.svg" width="18" alt="" /> Daily counters

### <img src="icons/device-day.svg" width="17" alt="" /> Per device

Under `device-name/today`:

- `acImportTodayWh`, `acImportTodayKWh`
- `acExportTodayWh`, `acExportTodayKWh`
- `pvTodayWh`, `pvTodayKWh`
- `pvToBatteryTodayWh`, `pvToBatteryTodayKWh`
- `acOutTotalWh`, `acOutTotalKWh`
- `acOutFromBatteryWh`, `acOutFromBatteryKWh`
- `acOutFromPvDirectWh`, `acOutFromPvDirectKWh`
- `batteryChargeWh`, `batteryChargeKWh`
- `batteryDischargeWh`, `batteryDischargeKWh`
- `acChargeToBatteryWh`, `acChargeToBatteryKWh`
- `pvInWh`, `pvInKWh`

All daily energy counters are accumulated internally in Wh and the matching kWh values are derived from them.

### <img src="icons/hems.svg" width="17" alt="" /> TOTAL aggregate

Under `TOTAL/today`, the adapter stores the same daily counters across all configured devices.

### TOTAL vs HEMS overlap

`TOTAL.*` always contains all configured devices. `HEMS.*` contains only devices marked with **Device is in HEMS**. If all configured devices are marked as HEMS devices, many `TOTAL.*` and `HEMS.*` values are intentionally identical.

Legacy-style counters such as `pvToday*`, `acImportToday*` and `acExportToday*` are kept for compatibility. The detailed flow counters use names like `pvIn*`, `acOutTotal*`, `batteryCharge*` and `batteryDischarge*`.

### <img src="icons/hems.svg" width="17" alt="" /> HEMS aggregate

Under `HEMS/today`, the adapter stores the same daily counters for devices marked as HEMS devices.

The HEMS AC import/export daily values are **net values**. The adapter detects an internal loop when a full 2400 Pro exports while other HEMS devices import and subtracts the loop from import and export before accumulating net daily values.

Additional HEMS debug counters:

- `acImportGrossTodayWh`, `acImportGrossTodayKWh`
- `acExportGrossTodayWh`, `acExportGrossTodayKWh`
- `internalLoopTodayWh`, `internalLoopTodayKWh`

## <img src="icons/hems.svg" width="18" alt="" /> HEMS aggregation

Under `HEMS`:

- `socAvg`
- `socWeighted`
- `socCapWeightedWearPct`
- `energyRemainingKWh`
- `energyUsableKWh`
- `acChargingW`, `acDischargingW`, `acDirectionW`, `acPowerW`
- `solarInputPower`
- `batteryChargeTotalW`, `batteryDischargeTotalW`, `batteryNetPowerW`, `batteryNetModeText`
- `onlineAll`, `onlineAny`, `staleAll`, `staleAny`
- `lastUpdateMin`, `lastUpdateMax`
- `minSocPct`, `socSetPct`
- `devicesConfigured`, `devicesActive`

HEMS membership is controlled by the adapter configuration checkbox **Device is in HEMS**. `smartMode` is stored as an informational device state and is not used as the HEMS filter.

## <img src="icons/config.svg" width="18" alt="" /> Configuration

The adapter configuration page contains:

- **Device name**
- **IP address**
- **Capacity (kWh)**
- **Interval (s)**
- **Device is in HEMS**

Recommended starting values for the current setup:

- `1600AC+`: `2.0` kWh
- `2400AC+`: `2.4` kWh
- `2400 Pro` with the current three-battery setup: `7.4` kWh

`HEMS.energyRemainingKWh` is calculated as `SoC / 100 * capacityKWh * wearLevelPct / 100` for every active HEMS device and then summed. `HEMS.energyUsableKWh` uses the same capacity and wear correction, but only counts the energy above the aggregated HEMS reserve `minSocPct`.

## <img src="icons/notes.svg" width="18" alt="" /> Notes

- The adapter is designed for **local readout only**
- No write/control commands are sent to Zendure devices
- Daily counters reset automatically when the date changes
- All daily counters can be reset manually with `control.resetToday`
- For an even more detailed adapter including control of your Zendure devices, please use the [Zendure SolarFlow Adapter from nograx](https://github.com/nograx/ioBroker.zendure-solarflow).

## <img src="icons/license.svg" width="18" alt="" /> License

This project is licensed under the **MIT License**.

You may use, modify, and distribute this software in private and commercial environments, provided that the original copyright notice and license text are included in any substantial portions of the software.

The software is provided **"as is"**, without warranty of any kind.

Copyright (c) 2025 Andreas Stürmer
