"use strict";

const utils = require("@iobroker/adapter-core");
const http = require("http");

class ZendureIpAdapter extends utils.Adapter {
    constructor(options = {}) {
        super({
            ...options,
            name: "zendure-ip",
        });

        this.pollTimers = new Map();
        this.seenObjects = new Set();

        this.on("ready", this.onReady.bind(this));
        this.on("unload", this.onUnload.bind(this));
    }

    sanitizeName(name, fallback) {
        const src = String(name || fallback || "device").trim();
        const replaced = src.replace(/\s+/g, "-");
        const cleaned = replaced.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-");
        return cleaned || fallback || "device";
    }

    uniqueDeviceIds(devices) {
        const used = new Set();
        return devices.map((device, index) => {
            let id = this.sanitizeName(device.name, `device-${index + 1}`);
            let candidate = id;
            let n = 2;
            while (used.has(candidate)) {
                candidate = `${id}-${n++}`;
            }
            used.add(candidate);
            return candidate;
        });
    }

    async onReady() {
        this.log.info("Starting zendure-ip adapter");

        const configured = Array.isArray(this.config.devices) ? this.config.devices.slice(0, 10) : [];
        const devices = configured.filter(d => d && d.ip && String(d.ip).trim());

        if (!devices.length) {
            this.log.warn("No devices configured.");
            return;
        }

        const ids = this.uniqueDeviceIds(devices);

        for (let i = 0; i < devices.length; i++) {
            const device = devices[i];
            const deviceId = ids[i];
            const intervalSec = Number(device.intervalSec) > 0 ? Number(device.intervalSec) : 10;
            const name = String(device.name || deviceId).trim();
            const ip = String(device.ip).trim();

            await this.ensureDeviceInfoStates(deviceId);

            await this.setStateAsync(`${deviceId}.info.name`, { val: name, ack: true });
            await this.setStateAsync(`${deviceId}.info.ip`, { val: ip, ack: true });
            await this.setStateAsync(`${deviceId}.info.intervalSec`, { val: intervalSec, ack: true });

            const pollFn = async () => {
                try {
                    const json = await this.fetchJson(ip);

                    await this.setStateAsync(`${deviceId}.info.online`, { val: true, ack: true });
                    await this.setStateAsync(`${deviceId}.info.lastUpdate`, { val: Date.now(), ack: true });
                    await this.setStateAsync(`${deviceId}.info.lastError`, { val: "", ack: true });

                    const raw = JSON.stringify(json);
                    await this.setStateAsync(`${deviceId}.info.rawJson`, {
                        val: raw.length > 50000 ? raw.slice(0, 50000) + "…" : raw,
                        ack: true
                    });

                    await this.writeJsonRecursive(deviceId, "", json);
                } catch (err) {
                    const msg = err && err.message ? err.message : String(err);
                    this.log.warn(`Device ${deviceId} (${ip}) poll failed: ${msg}`);
                    await this.setStateAsync(`${deviceId}.info.online`, { val: false, ack: true });
                    await this.setStateAsync(`${deviceId}.info.lastError`, { val: msg, ack: true });
                }
            };

            await pollFn();
            const timer = this.setInterval(() => {
                void pollFn();
            }, intervalSec * 1000);
            this.pollTimers.set(deviceId, timer);
        }
    }

    async onUnload(callback) {
        try {
            for (const timer of this.pollTimers.values()) {
                this.clearInterval(timer);
            }
            this.pollTimers.clear();
            callback();
        } catch {
            callback();
        }
    }

    fetchJson(ip) {
        return new Promise((resolve, reject) => {
            const req = http.request({
                host: ip,
                port: 80,
                path: "/properties/report",
                method: "GET",
                headers: {
                    "Accept": "application/json"
                },
                timeout: 6000
            }, res => {
                let data = "";
                res.setEncoding("utf8");
                res.on("data", chunk => data += chunk);
                res.on("end", () => {
                    if (res.statusCode && res.statusCode >= 400) {
                        return reject(new Error(`HTTP ${res.statusCode}`));
                    }
                    try {
                        resolve(JSON.parse(data));
                    } catch {
                        reject(new Error("JSON parse failed"));
                    }
                });
            });

            req.on("timeout", () => req.destroy(new Error("HTTP timeout")));
            req.on("error", reject);
            req.end();
        });
    }

    async ensureDeviceInfoStates(deviceId) {
        await this.ensureChannel(deviceId, "info");
        await this.ensureState(`${deviceId}.info.name`, "string", "text", "");
        await this.ensureState(`${deviceId}.info.ip`, "string", "text", "");
        await this.ensureState(`${deviceId}.info.intervalSec`, "number", "value.interval", 10, "s");
        await this.ensureState(`${deviceId}.info.online`, "boolean", "indicator.reachable", false);
        await this.ensureState(`${deviceId}.info.lastUpdate`, "number", "value.time", 0, "ms");
        await this.ensureState(`${deviceId}.info.lastError`, "string", "text", "");
        await this.ensureState(`${deviceId}.info.rawJson`, "string", "json", "");
    }

    async ensureChannel(deviceId, path) {
        const full = path ? `${deviceId}.${path}` : deviceId;
        if (this.seenObjects.has(`channel:${full}`)) return;
        await this.extendObjectAsync(full, {
            type: "channel",
            common: {
                name: full
            },
            native: {}
        });
        this.seenObjects.add(`channel:${full}`);
    }

    inferTypeAndRole(value) {
        if (typeof value === "boolean") return { type: "boolean", role: "indicator", def: false };
        if (typeof value === "number") return { type: "number", role: "value", def: 0 };
        return { type: "string", role: "text", def: "" };
    }

    async ensureState(id, type, role, def, unit) {
        const key = `state:${id}`;
        if (this.seenObjects.has(key)) return;
        await this.extendObjectAsync(id, {
            type: "state",
            common: {
                name: id.split(".").slice(-1)[0],
                type,
                role,
                read: true,
                write: false,
                def,
                unit: unit || ""
            },
            native: {}
        });
        this.seenObjects.add(key);
    }

    async writeJsonRecursive(deviceId, parentPath, value) {
        if (value === null || value === undefined) {
            return;
        }

        if (Array.isArray(value)) {
            if (parentPath) {
                await this.ensureChannel(deviceId, parentPath);
            }
            for (let i = 0; i < value.length; i++) {
                const nextPath = parentPath ? `${parentPath}.${i}` : String(i);
                await this.writeJsonRecursive(deviceId, nextPath, value[i]);
            }
            return;
        }

        if (typeof value === "object") {
            if (parentPath) {
                await this.ensureChannel(deviceId, parentPath);
            }
            for (const [key, child] of Object.entries(value)) {
                const safeKey = String(key).replace(/[^a-zA-Z0-9._-]/g, "_");
                const nextPath = parentPath ? `${parentPath}.${safeKey}` : safeKey;
                await this.writeJsonRecursive(deviceId, nextPath, child);
            }
            return;
        }

        const id = parentPath ? `${deviceId}.${parentPath}` : deviceId;
        const parent = id.split(".").slice(0, -1).join(".");
        if (parent && parent !== deviceId) {
            const relative = parent.replace(`${deviceId}.`, "");
            await this.ensureChannel(deviceId, relative);
        }
        const meta = this.inferTypeAndRole(value);
        await this.ensureState(id, meta.type, meta.role, meta.def);
        await this.setStateAsync(id, { val: value, ack: true });
    }
}

if (require.main !== module) {
    module.exports = options => new ZendureIpAdapter(options);
} else {
    (() => new ZendureIpAdapter())();
}
