# ioBroker.zendure-ip

Simple ioBroker adapter to poll local Zendure device JSON from `http://<ip>/properties/report`
for up to 10 devices and store the returned data as states.

## Features

- Configure up to 10 devices
- Per device:
  - name
  - IP address
  - polling interval in seconds
- Default polling interval: 10 seconds
- Device folder name is derived from the configured name
- Spaces in names are converted to `-`
- Polls all JSON data recursively into states
- Creates helper states under `info.*`:
  - `online`
  - `lastUpdate`
  - `lastError`
  - `rawJson`

## Installation

### As a local/custom adapter
- Unpack this folder
- Install it as a custom adapter in ioBroker

### Via GitHub
Put the contents into a repository named:

`ioBroker.zendure-ip`

Then install with ioBroker from GitHub / URL.

## Notes

- This adapter polls `http://<ip>/properties/report`
- It is intended for local Zendure devices that expose this JSON endpoint
- State creation is dynamic and based on the received JSON structure


## Package update

This package was refreshed to version 0.1.2 and now includes a real adapter icon.
