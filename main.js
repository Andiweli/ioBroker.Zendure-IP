"use strict";

const utils = require("@iobroker/adapter-core");
const http = require("http");

const DEFAULT_INTERVAL_SEC = 10;
const STALE_AFTER_SEC = 45;
const ZERO_POWER_AFTER_SEC = 60;
const WATCHDOG_MS = 5000;
const HTTP_TIMEOUT_MS = 6000;
const HEMS_DEADBAND_W = 30;
const PV_NOISE_W = 5;
const PRO_FULL_SOC_PCT = 99;

class ZendureIpAdapter extends utils.Adapter {
    constructor(options = {}) {
        super({
            ...options,
            name: "zendure-ip",
        });

        this.pollTimers = new Map();
        this.watchdogTimer = null;
        this.devices = [];
        this.objectCache = new Set();
        this.energyLastTs = Date.now();

        this.on("ready", this.onReady.bind(this));
        this.on("unload", this.onUnload.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
    }

    sanitizeName(name, fallback) {
        const src = String(name || fallback || "device").trim();
        const withDashes = src.replace(/\s+/g, "-");
        const cleaned = withDashes.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
        return cleaned || fallback || "device";
    }

    uniqueDeviceIds(devices) {
        const used = new Set();
        return devices.map((device, index) => {
            const baseId = this.sanitizeName(device.name, `device-${index + 1}`);
            let candidate = baseId;
            let n = 2;
            while (used.has(candidate)) candidate = `${baseId}-${n++}`;
            used.add(candidate);
            return candidate;
        });
    }

    safeNum(v, fallback = 0) {
        const n = Number(v);
        return Number.isFinite(n) ? n : fallback;
    }

    safeStr(v, fallback = "") {
        if (v === undefined || v === null) return fallback;
        return String(v);
    }

    toPctScaledBy10(raw) {
        return Math.round((this.safeNum(raw, 0) / 10) * 10) / 10;
    }

    clipRaw(obj, maxLen = 4000) {
        try {
            const s = JSON.stringify(obj);
            return s.length > maxLen ? s.slice(0, maxLen) + "…" : s;
        } catch {
            return "";
        }
    }

    todayStr() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }

    stateNum(val, fallback = 0) {
        const n = Number(val);
        return Number.isFinite(n) ? n : fallback;
    }

    roundWh(value) {
        return Math.round(this.safeNum(value, 0) * 100) / 100;
    }

    roundKWhFromWh(valueWh) {
        return Math.round((this.safeNum(valueWh, 0) / 1000) * 1000) / 1000;
    }

    async getStateNum(id, fallback = 0) {
        return this.stateNum((await this.getStateAsync(id))?.val, fallback);
    }

    async setNumericState(id, value) {
        await this.setStateChangedAsync(id, { val: this.safeNum(value, 0), ack: true });
    }

    async addWhAndUpdateKWh(whId, kwhId, addWh) {
        const curWh = await this.getStateNum(whId, 0);
        const nextWhRounded = this.roundWh(curWh + this.safeNum(addWh, 0));
        await this.setStateChangedAsync(whId, { val: nextWhRounded, ack: true });
        await this.setStateChangedAsync(kwhId, { val: this.roundKWhFromWh(nextWhRounded), ack: true });
    }

    async onReady() {
        this.log.info("Starting zendure-ip adapter");

        await this.ensureControlObjects();
        this.subscribeStates("control.resetToday");

        const configured = Array.isArray(this.config.devices) ? this.config.devices.slice(0, 10) : [];
        const devices = configured.filter(d => d && d.ip && String(d.ip).trim());

        if (!devices.length) {
            this.log.warn("No devices configured.");
            return;
        }

        const ids = this.uniqueDeviceIds(devices);
        this.devices = devices.map((device, index) => ({
            id: ids[index],
            name: String(device.name || ids[index]).trim(),
            ip: String(device.ip).trim(),
            intervalSec: Number(device.intervalSec) > 0 ? Number(device.intervalSec) : DEFAULT_INTERVAL_SEC,
            isInHems: !!device.isInHems,
            inFlight: false,
            type: "ac",
            capKWh: 2.4,
        }));

        for (const dev of this.devices) {
            await this.ensureDeviceObjects(dev);
            await this.ensureFlowObjects(dev.id);
            await this.ensureDeviceTodayObjects(dev.id);
        }

        await this.ensureTotalObjects();

        if (this.devices.some(d => d.isInHems)) {
            await this.ensureHemsObjects();
            await this.ensureHemsFlowObjects();
            await this.ensureHemsTodayObjects();
        }

        // Initial poll first so pro-specific capability/capacity and states exist early.
        for (const dev of this.devices) {
            await this.pollDevice(dev);
        }

        await this.maybeResetTodayCounters();

        for (const dev of this.devices) {
            const pollFn = async () => this.pollDevice(dev);
            const timer = this.setInterval(() => void pollFn(), dev.intervalSec * 1000);
            this.pollTimers.set(dev.id, timer);
        }

        this.energyLastTs = Date.now();

        this.watchdogTimer = this.setInterval(async () => {
            await this.runWatchdogAndHems();
        }, WATCHDOG_MS);

        await this.runWatchdogAndHems();
    }

    async onUnload(callback) {
        try {
            for (const timer of this.pollTimers.values()) this.clearInterval(timer);
            this.pollTimers.clear();
            if (this.watchdogTimer) {
                this.clearInterval(this.watchdogTimer);
                this.watchdogTimer = null;
            }
            callback();
        } catch {
            callback();
        }
    }

    async onStateChange(id, state) {
        if (!state || state.ack) return;
        if (id !== `${this.namespace}.control.resetToday` && id !== "control.resetToday") return;
        if (state.val !== true) return;

        try {
            await this.resetAllTodayCounters(this.todayStr());
            await this.setStateAsync("control.resetToday", { val: false, ack: true });
            this.log.info("All daily counters were reset manually.");
        } catch (err) {
            const msg = err && err.message ? err.message : String(err);
            this.log.warn(`Manual reset failed: ${msg}`);
        }
    }

    fetchJson(ip) {
        return new Promise((resolve, reject) => {
            const req = http.request({
                host: ip,
                port: 80,
                path: "/properties/report",
                method: "GET",
                headers: { Accept: "application/json" },
                timeout: HTTP_TIMEOUT_MS,
            }, res => {
                let data = "";
                res.setEncoding("utf8");
                res.on("data", chunk => data += chunk);
                res.on("end", () => {
                    if (res.statusCode && res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
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

    inferIsPro(product, packNum) {
        return /2400\s*pro/i.test(String(product || "")) || /2400pro/i.test(String(product || "")) || this.safeNum(packNum, 0) > 1;
    }

    inferCapacityKWh(product, packNum, packData, isPro) {
        const productLc = String(product || "").toLowerCase();
        const packs = this.safeNum(packNum, 0);

        if (isPro) {
            // Current user setup: SolarFlow 2400 Pro + three packs ~= 7.4 kWh.
            if (packs > 1) return 7.4;

            const packType = this.safeNum((Array.isArray(packData) && packData[0] && packData[0].packType) || 0, 0);
            if (packType === 300 || productLc.includes("1600")) return 2.0;
            return 2.4;
        }

        if (productLc.includes("1600")) return 2.0;
        if (productLc.includes("2400")) return 2.4;
        return 2.4;
    }

    async pollDevice(dev) {
        if (dev.inFlight) return;
        dev.inFlight = true;

        try {
            const json = await this.fetchJson(dev.ip);
            const p = json.properties || {};
            const now = Date.now();
            const product = this.safeStr(json.product || p.product || "");
            const packNum = this.safeNum(p.packNum, 0);
            const isPro = this.inferIsPro(product, packNum);

            dev.type = isPro ? "pro" : "ac";
            dev.capKWh = this.inferCapacityKWh(product, packNum, json.packData, isPro);

            const gridInputPower = this.safeNum(p.gridInputPower, 0);
            const outputHomePower = this.safeNum(p.outputHomePower, 0);
            const smartMode = this.safeNum(p.smartMode, 0);
            const minSocRaw = this.safeNum(p.minSoc, 0);
            const socSetRaw = this.safeNum(p.socSet, 0);

            const mapped = {
                product,
                serial: this.safeStr(json.serial || json.sn || p.serial || p.sn || ""),
                messageId: this.safeStr(json.messageId || json.msgId || p.messageId || p.msgId || ""),
                timestamp: this.safeNum(json.timestamp || p.timestamp || p.ts || 0, 0),

                soc: this.safeNum(p.electricLevel, 0),
                acChargingW: gridInputPower,
                acDischargingW: outputHomePower,
                acDirectionW: outputHomePower - gridInputPower,
                acPowerW: Math.max(gridInputPower, outputHomePower),

                outputHomePower,
                gridInputPower,

                solarInputPower: this.safeNum(p.solarInputPower, 0),
                solarPower1: this.safeNum(p.solarPower1, 0),
                solarPower2: this.safeNum(p.solarPower2, 0),
                solarPower3: this.safeNum(p.solarPower3, 0),
                solarPower4: this.safeNum(p.solarPower4, 0),

                outputPackPower: this.safeNum(p.outputPackPower, 0),
                packInputPower: this.safeNum(p.packInputPower, 0),

                minSocRaw,
                minSocPct: this.toPctScaledBy10(minSocRaw),
                socSetRaw,
                socSetPct: this.toPctScaledBy10(socSetRaw),
                socLimit: this.safeNum(p.socLimit, 0),
                smartMode,
                inHems: smartMode === 1,
                deviceIsInHems: !!dev.isInHems,
                packNum,
                capacityKWh: dev.capKWh,
                deviceType: dev.type,

                rssi: this.safeNum(p.rssi, 0),
                online: true,
                lastUpdate: now,
                ageSec: 0,
                stale: false,
                lastError: "",
                rawJson: this.clipRaw(json),
            };

            for (const [key, val] of Object.entries(mapped)) {
                await this.setStateChangedAsync(`${dev.id}.${key}`, { val, ack: true });
            }
        } catch (err) {
            const msg = err && err.message ? err.message : String(err);
            this.log.warn(`Device ${dev.id} (${dev.ip}) poll failed: ${msg}`);
            await this.setStateChangedAsync(`${dev.id}.online`, { val: false, ack: true });
            await this.setStateChangedAsync(`${dev.id}.lastError`, { val: msg, ack: true });
        } finally {
            dev.inFlight = false;
        }
    }

    async runWatchdogAndHems() {
        const now = Date.now();
        let dtSec = (now - this.energyLastTs) / 1000;
        if (!Number.isFinite(dtSec) || dtSec <= 0) dtSec = WATCHDOG_MS / 1000;
        if (dtSec > 60) dtSec = WATCHDOG_MS / 1000;
        this.energyLastTs = now;

        await this.maybeResetTodayCounters();

        for (const dev of this.devices) {
            const base = dev.id;
            const last = this.safeNum((await this.getStateAsync(`${base}.lastUpdate`))?.val, 0);
            const ageSec = last ? Math.floor((now - last) / 1000) : 999999;
            const stale = ageSec >= STALE_AFTER_SEC;

            await this.setStateChangedAsync(`${base}.ageSec`, { val: ageSec, ack: true });
            await this.setStateChangedAsync(`${base}.stale`, { val: stale, ack: true });

            if (ageSec >= ZERO_POWER_AFTER_SEC) {
                const zeroStates = [
                    "acChargingW", "acDischargingW", "acDirectionW", "acPowerW",
                    "outputHomePower", "gridInputPower",
                    "solarInputPower", "solarPower1", "solarPower2", "solarPower3", "solarPower4",
                    "outputPackPower", "packInputPower"
                ];
                for (const state of zeroStates) {
                    await this.setStateChangedAsync(`${base}.${state}`, { val: 0, ack: true });
                }
            }
        }

        const snapshots = await this.collectDeviceSnapshots();
        await this.updateFlowsAndTodayCounters(dtSec, snapshots);
        await this.updateHems(snapshots);
    }

    async collectDeviceSnapshots() {
        const out = [];
        for (const dev of this.devices) {
            const base = dev.id;
            const online = !!(await this.getStateAsync(`${base}.online`))?.val;
            const stale = !!(await this.getStateAsync(`${base}.stale`))?.val;
            const active = online && !stale;
            const type = String((await this.getStateAsync(`${base}.deviceType`))?.val || dev.type || "ac");
            const capKWh = await this.getStateNum(`${base}.capacityKWh`, Number(dev.capKWh) > 0 ? Number(dev.capKWh) : (type === "pro" ? 7.4 : 2.4));
            const wearLevelPct = Math.min(100, Math.max(0, await this.getStateNum(`${base}.wearLevelPct`, 100) || 100));

            out.push({
                id: dev.id,
                name: dev.name,
                type,
                capKWh,
                isInHems: !!dev.isInHems,
                online,
                stale,
                active,
                lastUpdate: await this.getStateNum(`${base}.lastUpdate`, 0),
                soc: await this.getStateNum(`${base}.soc`, 0),
                wearLevelPct,
                acChargingW: active ? Math.max(0, await this.getStateNum(`${base}.acChargingW`, 0)) : 0,
                acDischargingW: active ? Math.max(0, await this.getStateNum(`${base}.acDischargingW`, 0)) : 0,
                acDirectionW: active ? await this.getStateNum(`${base}.acDirectionW`, 0) : 0,
                acPowerW: active ? Math.max(0, await this.getStateNum(`${base}.acPowerW`, 0)) : 0,
                outputHomePower: active ? Math.max(0, await this.getStateNum(`${base}.outputHomePower`, 0)) : 0,
                gridInputPower: active ? Math.max(0, await this.getStateNum(`${base}.gridInputPower`, 0)) : 0,
                solarInputPower: active ? Math.max(0, await this.getStateNum(`${base}.solarInputPower`, 0)) : 0,
                outputPackPower: active ? Math.max(0, await this.getStateNum(`${base}.outputPackPower`, 0)) : 0,
                packInputPower: active ? Math.max(0, await this.getStateNum(`${base}.packInputPower`, 0)) : 0,
                minSocPct: await this.getStateNum(`${base}.minSocPct`, 0),
                socSetPct: await this.getStateNum(`${base}.socSetPct`, 0),
                smartMode: await this.getStateNum(`${base}.smartMode`, 0),
            });
        }
        return out;
    }

    computeDeviceFlows(d) {
        const outputHomePower = Math.max(0, d.outputHomePower || d.acDischargingW || 0);
        const gridInputPower = Math.max(0, d.gridInputPower || d.acChargingW || 0);
        const solarInputPower = Math.max(0, d.solarInputPower || 0);
        const packChargeW = Math.max(0, d.outputPackPower || 0);
        const packDischargeW = Math.max(0, d.packInputPower || 0);

        if (d.type === "pro") {
            const pvToBatteryW = solarInputPower > PV_NOISE_W ? Math.min(packChargeW, solarInputPower) : 0;
            return {
                acOutTotalW: outputHomePower,
                acOutFromBatteryW: packDischargeW,
                acOutFromPvDirectW: Math.max(0, outputHomePower - packDischargeW),
                batteryChargeW: packChargeW,
                batteryDischargeW: packDischargeW,
                acChargeToBatteryW: gridInputPower,
                pvInW: solarInputPower,
                pvToBatteryW,
            };
        }

        return {
            acOutTotalW: outputHomePower,
            acOutFromBatteryW: outputHomePower,
            acOutFromPvDirectW: 0,
            batteryChargeW: gridInputPower,
            batteryDischargeW: outputHomePower,
            acChargeToBatteryW: gridInputPower,
            pvInW: 0,
            pvToBatteryW: 0,
        };
    }

    emptyFlows() {
        return {
            acOutTotalW: 0,
            acOutFromBatteryW: 0,
            acOutFromPvDirectW: 0,
            batteryChargeW: 0,
            batteryDischargeW: 0,
            acChargeToBatteryW: 0,
            pvInW: 0,
            pvToBatteryW: 0,
        };
    }

    addFlows(target, add) {
        for (const key of Object.keys(target)) target[key] += this.safeNum(add[key], 0);
    }

    async writeFlows(prefix, flows, active = true) {
        const vals = { ...this.emptyFlows(), ...flows };
        for (const [key, val] of Object.entries(vals)) {
            await this.setStateChangedAsync(`${prefix}.${key}`, { val: Math.round(this.safeNum(val, 0) * 100) / 100, ack: true });
        }
        await this.setStateChangedAsync(`${prefix}.meta.isActive`, { val: !!active, ack: true });
    }

    async updateEnergyDayCounters(prefix, flows, dtSec) {
        const factor = dtSec / 3600;
        await this.addWhAndUpdateKWh(`${prefix}.acOutTotalWh`, `${prefix}.acOutTotalKWh`, flows.acOutTotalW * factor);
        await this.addWhAndUpdateKWh(`${prefix}.acOutFromBatteryWh`, `${prefix}.acOutFromBatteryKWh`, flows.acOutFromBatteryW * factor);
        await this.addWhAndUpdateKWh(`${prefix}.acOutFromPvDirectWh`, `${prefix}.acOutFromPvDirectKWh`, flows.acOutFromPvDirectW * factor);
        await this.addWhAndUpdateKWh(`${prefix}.batteryChargeWh`, `${prefix}.batteryChargeKWh`, flows.batteryChargeW * factor);
        await this.addWhAndUpdateKWh(`${prefix}.batteryDischargeWh`, `${prefix}.batteryDischargeKWh`, flows.batteryDischargeW * factor);
        await this.addWhAndUpdateKWh(`${prefix}.acChargeToBatteryWh`, `${prefix}.acChargeToBatteryKWh`, flows.acChargeToBatteryW * factor);
        await this.addWhAndUpdateKWh(`${prefix}.pvInWh`, `${prefix}.pvInKWh`, flows.pvInW * factor);
        await this.addWhAndUpdateKWh(`${prefix}.pvToBatteryTodayWh`, `${prefix}.pvToBatteryTodayKWh`, flows.pvToBatteryW * factor);
    }

    async updateFlowsAndTodayCounters(dtSec, snapshots) {
        const totalFlows = this.emptyFlows();
        const hemsFlows = this.emptyFlows();

        let totalImportWhAdd = 0;
        let totalExportWhAdd = 0;
        let totalPvWhAdd = 0;
        let hemsGrossImportWhAdd = 0;
        let hemsGrossExportWhAdd = 0;
        let hemsPvWhAdd = 0;
        let hemsProExportFullW = 0;
        let hemsImportOthersW = 0;

        const whFactor = dtSec / 3600;

        for (const d of snapshots) {
            const flows = d.active ? this.computeDeviceFlows(d) : this.emptyFlows();
            await this.writeFlows(`${d.id}.flows`, flows, d.active);
            await this.updateEnergyDayCounters(`${d.id}.today`, flows, dtSec);

            const addImportWh = d.acChargingW * whFactor;
            const addExportWh = d.acDischargingW * whFactor;
            const addPvWh = d.solarInputPower * whFactor;
            await this.addWhAndUpdateKWh(`${d.id}.today.acImportTodayWh`, `${d.id}.today.acImportTodayKWh`, addImportWh);
            await this.addWhAndUpdateKWh(`${d.id}.today.acExportTodayWh`, `${d.id}.today.acExportTodayKWh`, addExportWh);
            await this.addWhAndUpdateKWh(`${d.id}.today.pvTodayWh`, `${d.id}.today.pvTodayKWh`, addPvWh);

            this.addFlows(totalFlows, flows);
            totalImportWhAdd += addImportWh;
            totalExportWhAdd += addExportWh;
            totalPvWhAdd += addPvWh;
            if (d.isInHems) {
                this.addFlows(hemsFlows, flows);
                hemsGrossImportWhAdd += addImportWh;
                hemsGrossExportWhAdd += addExportWh;
                hemsPvWhAdd += addPvWh;
                if (d.type === "pro" && d.soc >= PRO_FULL_SOC_PCT) hemsProExportFullW += d.acDischargingW;
                if (d.type !== "pro") hemsImportOthersW += d.acChargingW;
            }
        }

        await this.writeFlows("TOTAL.flows", totalFlows, snapshots.some(d => d.active));
        await this.updateEnergyDayCounters("TOTAL.today", totalFlows, dtSec);
        await this.addWhAndUpdateKWh("TOTAL.today.acImportTodayWh", "TOTAL.today.acImportTodayKWh", totalImportWhAdd);
        await this.addWhAndUpdateKWh("TOTAL.today.acExportTodayWh", "TOTAL.today.acExportTodayKWh", totalExportWhAdd);
        await this.addWhAndUpdateKWh("TOTAL.today.pvTodayWh", "TOTAL.today.pvTodayKWh", totalPvWhAdd);

        if (this.devices.some(d => d.isInHems)) {
            await this.writeFlows("HEMS.flows", hemsFlows, snapshots.some(d => d.isInHems && d.active));
            await this.updateEnergyDayCounters("HEMS.today", hemsFlows, dtSec);
            await this.addWhAndUpdateKWh("HEMS.today.pvTodayWh", "HEMS.today.pvTodayKWh", hemsPvWhAdd);

            await this.updateHemsLoopAwareToday(hemsGrossImportWhAdd, hemsGrossExportWhAdd, hemsProExportFullW, hemsImportOthersW, dtSec);
        }
    }

    async updateHemsLoopAwareToday(grossImportWhAdd, grossExportWhAdd, proExportFullW, importOthersW, dtSec) {
        await this.addWhAndUpdateKWh("HEMS.today.acImportGrossTodayWh", "HEMS.today.acImportGrossTodayKWh", grossImportWhAdd);
        await this.addWhAndUpdateKWh("HEMS.today.acExportGrossTodayWh", "HEMS.today.acExportGrossTodayKWh", grossExportWhAdd);

        const loopW = (proExportFullW > 0 && importOthersW > 0) ? Math.min(proExportFullW, importOthersW) : 0;
        const loopWhAdd = loopW * (dtSec / 3600);
        await this.addWhAndUpdateKWh("HEMS.today.internalLoopTodayWh", "HEMS.today.internalLoopTodayKWh", loopWhAdd);

        const effectiveImportWhAdd = Math.max(0, grossImportWhAdd - loopWhAdd);
        const effectiveExportWhAdd = Math.max(0, grossExportWhAdd - loopWhAdd);
        const netImportWhAdd = Math.max(0, effectiveImportWhAdd - effectiveExportWhAdd);
        const netExportWhAdd = Math.max(0, effectiveExportWhAdd - effectiveImportWhAdd);

        await this.addWhAndUpdateKWh("HEMS.today.acImportTodayWh", "HEMS.today.acImportTodayKWh", netImportWhAdd);
        await this.addWhAndUpdateKWh("HEMS.today.acExportTodayWh", "HEMS.today.acExportTodayKWh", netExportWhAdd);
    }

    async maybeResetTodayCounters() {
        const today = this.todayStr();

        for (const dev of this.devices) {
            const base = `${dev.id}.today`;
            const lastReset = String((await this.getStateAsync(`${base}.lastResetDate`))?.val || "");
            if (lastReset !== today) {
                await this.resetDeviceToday(dev.id, today);
            }
        }

        const totalLastReset = String((await this.getStateAsync("TOTAL.today.lastResetDate"))?.val || "");
        if (totalLastReset !== today) {
            await this.resetTotalToday(today);
        }

        if (this.devices.some(d => d.isInHems)) {
            const lastReset = String((await this.getStateAsync("HEMS.today.lastResetDate"))?.val || "");
            if (lastReset !== today) {
                await this.resetHemsToday(today);
            }
        }
    }

    async resetAllTodayCounters(today) {
        for (const dev of this.devices) {
            await this.resetDeviceToday(dev.id, today);
        }
        await this.resetTotalToday(today);
        if (this.devices.some(d => d.isInHems)) {
            await this.resetHemsToday(today);
        }
    }

    todayZeroStates() {
        return [
            "acImportTodayWh", "acImportTodayKWh",
            "acExportTodayWh", "acExportTodayKWh",
            "acImportGrossTodayWh", "acImportGrossTodayKWh",
            "acExportGrossTodayWh", "acExportGrossTodayKWh",
            "internalLoopTodayWh", "internalLoopTodayKWh",
            "pvTodayWh", "pvTodayKWh",
            "pvToBatteryTodayWh", "pvToBatteryTodayKWh",
            "acOutTotalWh", "acOutTotalKWh",
            "acOutFromBatteryWh", "acOutFromBatteryKWh",
            "acOutFromPvDirectWh", "acOutFromPvDirectKWh",
            "batteryChargeWh", "batteryChargeKWh",
            "batteryDischargeWh", "batteryDischargeKWh",
            "acChargeToBatteryWh", "acChargeToBatteryKWh",
            "pvInWh", "pvInKWh",
        ];
    }

    async resetTodayPrefix(prefix, today) {
        for (const state of this.todayZeroStates()) {
            if (this.objectCache.has(`state:${prefix}.${state}`)) {
                await this.setStateChangedAsync(`${prefix}.${state}`, { val: 0, ack: true });
            }
        }
        await this.setStateChangedAsync(`${prefix}.lastResetDate`, { val: today, ack: true });
    }

    async resetDeviceToday(deviceId, today) {
        await this.resetTodayPrefix(`${deviceId}.today`, today);
    }

    async resetTotalToday(today) {
        await this.resetTodayPrefix("TOTAL.today", today);
    }

    async resetHemsToday(today) {
        await this.resetTodayPrefix("HEMS.today", today);
    }

    async updateHems(snapshots) {
        const hemsDevices = snapshots.filter(d => d.isInHems);
        if (!hemsDevices.length) return;

        await this.ensureHemsObjects();
        await this.ensureHemsFlowObjects();
        await this.ensureHemsTodayObjects();

        const devicesConfigured = hemsDevices.length;
        const devicesActive = hemsDevices.filter(d => d.online && !d.stale).length;
        const onlineAll = hemsDevices.every(d => d.online);
        const onlineAny = hemsDevices.some(d => d.online);
        const staleAll = hemsDevices.every(d => d.stale);
        const staleAny = hemsDevices.some(d => d.stale);
        const times = hemsDevices.map(d => d.lastUpdate).filter(v => v > 0);
        const lastUpdateMin = times.length ? Math.min(...times) : 0;
        const lastUpdateMax = times.length ? Math.max(...times) : 0;

        const active = hemsDevices.filter(d => d.online && !d.stale);

        if (!active.length) {
            const zeroStates = {
                devicesConfigured,
                devicesActive: 0,
                onlineAll,
                onlineAny,
                staleAll,
                staleAny,
                lastUpdateMin,
                lastUpdateMax,
                socAvg: 0,
                socWeighted: 0,
                socCapWeightedWearPct: 0,
                energyRemainingKWh: 0,
                energyUsableKWh: 0,
                acChargingW: 0,
                acDischargingW: 0,
                acDirectionW: 0,
                acPowerW: 0,
                solarInputPower: 0,
                batteryChargeTotalW: 0,
                batteryDischargeTotalW: 0,
                batteryNetPowerW: 0,
                batteryNetModeText: "idle",
                minSocPct: 0,
                socSetPct: 0,
            };
            for (const [key, val] of Object.entries(zeroStates)) {
                await this.setStateChangedAsync(`HEMS.${key}`, { val, ack: true });
            }
            return;
        }

        const socAvg = Math.round((active.reduce((a, d) => a + d.soc, 0) / active.length) * 10) / 10;

        let capSum = 0;
        let socCapSum = 0;
        let effCapSum = 0;
        let socEffCapSum = 0;
        let energyRemainingKWh = 0;
        let energyUsableKWh = 0;

        const minSocVals = active.map(d => d.minSocPct).filter(v => v > 0);
        const socSetVals = active.map(d => d.socSetPct).filter(v => v > 0);
        const minSocPct = minSocVals.length ? Math.max(...minSocVals) : 0;
        const socSetPct = socSetVals.length ? Math.min(...socSetVals) : 0;

        for (const d of active) {
            const cap = Number(d.capKWh) > 0 ? Number(d.capKWh) : (d.type === "pro" ? 7.4 : 2.4);
            const wear = Math.min(100, Math.max(0, d.wearLevelPct || 100)) / 100;
            const effCap = cap * wear;

            capSum += cap;
            socCapSum += d.soc * cap;
            effCapSum += effCap;
            socEffCapSum += d.soc * effCap;

            energyRemainingKWh += (Math.max(0, d.soc) / 100) * effCap;
            energyUsableKWh += Math.max(0, d.soc - minSocPct) / 100 * effCap;
        }

        const socWeighted = capSum > 0 ? Math.round((socCapSum / capSum) * 10) / 10 : socAvg;
        const socCapWeightedWearPct = effCapSum > 0 ? Math.round((socEffCapSum / effCapSum) * 10) / 10 : socWeighted;

        const acChargingW = active.reduce((a, d) => a + Math.max(0, d.acChargingW), 0);
        const acDischargingW = active.reduce((a, d) => a + Math.max(0, d.acDischargingW), 0);
        const acDirectionW = active.reduce((a, d) => a + d.acDirectionW, 0);
        const acPowerW = active.reduce((a, d) => a + d.acPowerW, 0);
        const solarInputPower = active.reduce((a, d) => a + Math.max(0, d.solarInputPower), 0);

        const batteryChargeTotalW = active.reduce((sum, d) => {
            if (d.type === "pro") return sum + Math.max(0, d.outputPackPower);
            return sum + Math.max(0, d.acChargingW);
        }, 0);

        const batteryDischargeTotalW = active.reduce((sum, d) => {
            if (d.type === "pro") return sum + Math.max(0, d.packInputPower);
            return sum + Math.max(0, d.acDischargingW);
        }, 0);

        const rawBatteryNetPowerW = batteryDischargeTotalW - batteryChargeTotalW;
        const batteryNetPowerW = Math.abs(rawBatteryNetPowerW) <= HEMS_DEADBAND_W ? 0 : rawBatteryNetPowerW;

        let batteryNetModeText = "idle";
        if (batteryNetPowerW > 0) batteryNetModeText = "entlädt";
        else if (batteryNetPowerW < 0) batteryNetModeText = "lädt";

        const hemsStates = {
            devicesConfigured,
            devicesActive,
            onlineAll,
            onlineAny,
            staleAll,
            staleAny,
            lastUpdateMin,
            lastUpdateMax,
            socAvg,
            socWeighted,
            socCapWeightedWearPct,
            energyRemainingKWh: Math.round(energyRemainingKWh * 100) / 100,
            energyUsableKWh: Math.round(energyUsableKWh * 100) / 100,
            acChargingW,
            acDischargingW,
            acDirectionW,
            acPowerW,
            solarInputPower,
            batteryChargeTotalW,
            batteryDischargeTotalW,
            batteryNetPowerW,
            batteryNetModeText,
            minSocPct,
            socSetPct,
        };

        for (const [key, val] of Object.entries(hemsStates)) {
            await this.setStateChangedAsync(`HEMS.${key}`, { val, ack: true });
        }
    }

    async ensureChannel(id, name = null) {
        const key = `channel:${id}`;
        if (this.objectCache.has(key)) return;
        await this.extendObjectAsync(id, {
            type: "channel",
            common: { name: name || id.split(".").slice(-1)[0] },
            native: {}
        });
        this.objectCache.add(key);
    }

    async ensureState(id, type, role, def, unit = "", write = false, name = null) {
        const key = `state:${id}`;
        if (this.objectCache.has(key)) return;
        await this.extendObjectAsync(id, {
            type: "state",
            common: {
                name: name || id.split(".").slice(-1)[0],
                type,
                role,
                read: true,
                write: !!write,
                def,
                unit,
            },
            native: {}
        });
        this.objectCache.add(key);
    }

    async ensureControlObjects() {
        await this.ensureChannel("control", "Control");
        await this.ensureState("control.resetToday", "boolean", "button", false, "", true, "Reset all daily counters");
    }

    async ensureDeviceObjects(dev) {
        await this.ensureChannel(dev.id, dev.name || dev.id);

        const defs = [
            ["product", "string", "text", ""],
            ["serial", "string", "text", ""],
            ["messageId", "string", "text", ""],
            ["timestamp", "number", "value.time", 0, "ms"],
            ["deviceType", "string", "text", "ac"],
            ["capacityKWh", "number", "value.energy", 2.4, "kWh"],
            ["deviceIsInHems", "boolean", "indicator", !!dev.isInHems],

            ["soc", "number", "value.battery", 0, "%"],
            ["acPowerW", "number", "value.power", 0, "W"],
            ["acDirectionW", "number", "value.power", 0, "W"],
            ["acChargingW", "number", "value.power", 0, "W"],
            ["acDischargingW", "number", "value.power", 0, "W"],
            ["outputHomePower", "number", "value.power", 0, "W"],
            ["gridInputPower", "number", "value.power", 0, "W"],

            ["solarInputPower", "number", "value.power", 0, "W"],
            ["solarPower1", "number", "value.power", 0, "W"],
            ["solarPower2", "number", "value.power", 0, "W"],
            ["solarPower3", "number", "value.power", 0, "W"],
            ["solarPower4", "number", "value.power", 0, "W"],

            ["outputPackPower", "number", "value.power", 0, "W"],
            ["packInputPower", "number", "value.power", 0, "W"],

            ["minSocRaw", "number", "value", 0],
            ["minSocPct", "number", "value.battery", 0, "%"],
            ["socSetRaw", "number", "value", 0],
            ["socSetPct", "number", "value.battery", 0, "%"],
            ["socLimit", "number", "value", 0],
            ["smartMode", "number", "value", 0],
            ["inHems", "boolean", "indicator", false],
            ["packNum", "number", "value", 0],
            ["wearLevelPct", "number", "level", 100, "%", true, "Battery wear level"],

            ["online", "boolean", "indicator.reachable", false],
            ["lastUpdate", "number", "value.time", 0, "ms"],
            ["ageSec", "number", "value.interval", 0, "s"],
            ["stale", "boolean", "indicator.maintenance", false],
            ["rssi", "number", "value", 0, "dBm"],
            ["lastError", "string", "text", ""],
            ["rawJson", "string", "json", ""],
        ];
        for (const [name, type, role, def, unit, write, label] of defs) {
            await this.ensureState(`${dev.id}.${name}`, type, role, def, unit || "", !!write, label || null);
        }
    }

    async ensureFlowObjects(prefix) {
        await this.ensureChannel(`${prefix}.flows`, "Flows");
        await this.ensureChannel(`${prefix}.flows.meta`, "Meta");
        const defs = [
            ["acOutTotalW", "AC output total"],
            ["acOutFromBatteryW", "AC output from battery"],
            ["acOutFromPvDirectW", "AC output from PV direct estimated"],
            ["batteryChargeW", "Battery charge"],
            ["batteryDischargeW", "Battery discharge"],
            ["acChargeToBatteryW", "AC charge to battery"],
            ["pvInW", "PV input"],
            ["pvToBatteryW", "PV to battery"],
        ];
        for (const [name, label] of defs) {
            await this.ensureState(`${prefix}.flows.${name}`, "number", "value.power", 0, "W", false, label);
        }
        await this.ensureState(`${prefix}.flows.meta.isActive`, "boolean", "indicator", false, "", false, "Active online and not stale");
    }

    async ensureEnergyDayTodayObjects(prefix) {
        const defs = [
            ["acOutTotalWh", "AC output total today", "Wh"],
            ["acOutTotalKWh", "AC output total today", "kWh"],
            ["acOutFromBatteryWh", "AC output from battery today", "Wh"],
            ["acOutFromBatteryKWh", "AC output from battery today", "kWh"],
            ["acOutFromPvDirectWh", "AC output from PV direct today estimated", "Wh"],
            ["acOutFromPvDirectKWh", "AC output from PV direct today estimated", "kWh"],
            ["batteryChargeWh", "Battery charge today", "Wh"],
            ["batteryChargeKWh", "Battery charge today", "kWh"],
            ["batteryDischargeWh", "Battery discharge today", "Wh"],
            ["batteryDischargeKWh", "Battery discharge today", "kWh"],
            ["acChargeToBatteryWh", "AC charge to battery today", "Wh"],
            ["acChargeToBatteryKWh", "AC charge to battery today", "kWh"],
            ["pvInWh", "PV input today", "Wh"],
            ["pvInKWh", "PV input today", "kWh"],
            ["pvToBatteryTodayWh", "PV to battery today", "Wh"],
            ["pvToBatteryTodayKWh", "PV to battery today", "kWh"],
        ];
        for (const [name, label, unit] of defs) {
            await this.ensureState(`${prefix}.${name}`, "number", "value.energy", 0, unit, false, label);
        }
    }

    async ensureDeviceTodayObjects(deviceId) {
        await this.ensureChannel(`${deviceId}.today`, "Today");
        const defs = [
            ["acImportTodayWh", "AC import/charging today", "Wh"],
            ["acImportTodayKWh", "AC import/charging today", "kWh"],
            ["acExportTodayWh", "AC export/discharging today", "Wh"],
            ["acExportTodayKWh", "AC export/discharging today", "kWh"],
            ["pvTodayWh", "PV input today", "Wh"],
            ["pvTodayKWh", "PV input today", "kWh"],
        ];

        for (const [name, label, unit] of defs) {
            await this.ensureState(`${deviceId}.today.${name}`, "number", "value.energy", 0, unit, false, label);
        }
        await this.ensureEnergyDayTodayObjects(`${deviceId}.today`);
        await this.ensureState(`${deviceId}.today.lastResetDate`, "string", "text", "", "", false, "Last reset date");
    }

    async ensureTotalObjects() {
        await this.ensureChannel("TOTAL", "TOTAL");
        await this.ensureFlowObjects("TOTAL");
        await this.ensureChannel("TOTAL.today", "Today");
        const defs = [
            ["acImportTodayWh", "TOTAL AC import today", "Wh"],
            ["acImportTodayKWh", "TOTAL AC import today", "kWh"],
            ["acExportTodayWh", "TOTAL AC export today", "Wh"],
            ["acExportTodayKWh", "TOTAL AC export today", "kWh"],
            ["pvTodayWh", "TOTAL PV input today", "Wh"],
            ["pvTodayKWh", "TOTAL PV input today", "kWh"],
        ];
        for (const [name, label, unit] of defs) {
            await this.ensureState(`TOTAL.today.${name}`, "number", "value.energy", 0, unit, false, label);
        }
        await this.ensureEnergyDayTodayObjects("TOTAL.today");
        await this.ensureState("TOTAL.today.lastResetDate", "string", "text", "", "", false, "Last reset date");
    }

    async ensureHemsObjects() {
        await this.ensureChannel("HEMS", "HEMS");
        const defs = [
            ["devicesConfigured", "number", "value", 0],
            ["devicesActive", "number", "value", 0],
            ["onlineAll", "boolean", "indicator.reachable", false],
            ["onlineAny", "boolean", "indicator.reachable", false],
            ["staleAll", "boolean", "indicator.maintenance", false],
            ["staleAny", "boolean", "indicator.maintenance", false],
            ["lastUpdateMin", "number", "value.time", 0, "ms"],
            ["lastUpdateMax", "number", "value.time", 0, "ms"],
            ["socAvg", "number", "value.battery", 0, "%"],
            ["socWeighted", "number", "value.battery", 0, "%"],
            ["socCapWeightedWearPct", "number", "value.battery", 0, "%"],
            ["energyRemainingKWh", "number", "value.energy", 0, "kWh"],
            ["energyUsableKWh", "number", "value.energy", 0, "kWh"],
            ["acChargingW", "number", "value.power", 0, "W"],
            ["acDischargingW", "number", "value.power", 0, "W"],
            ["acDirectionW", "number", "value.power", 0, "W"],
            ["acPowerW", "number", "value.power", 0, "W"],
            ["solarInputPower", "number", "value.power", 0, "W"],
            ["batteryChargeTotalW", "number", "value.power", 0, "W"],
            ["batteryDischargeTotalW", "number", "value.power", 0, "W"],
            ["batteryNetPowerW", "number", "value.power", 0, "W"],
            ["batteryNetModeText", "string", "text", "idle"],
            ["minSocPct", "number", "value.battery", 0, "%"],
            ["socSetPct", "number", "value.battery", 0, "%"],
        ];
        for (const [name, type, role, def, unit] of defs) {
            await this.ensureState(`HEMS.${name}`, type, role, def, unit || "");
        }
    }

    async ensureHemsFlowObjects() {
        await this.ensureFlowObjects("HEMS");
    }

    async ensureHemsTodayObjects() {
        await this.ensureChannel("HEMS.today", "Today");
        const defs = [
            ["acImportTodayWh", "HEMS AC import today NET", "Wh"],
            ["acImportTodayKWh", "HEMS AC import today NET", "kWh"],
            ["acExportTodayWh", "HEMS AC export today NET", "Wh"],
            ["acExportTodayKWh", "HEMS AC export today NET", "kWh"],
            ["acImportGrossTodayWh", "HEMS AC import today GROSS debug", "Wh"],
            ["acImportGrossTodayKWh", "HEMS AC import today GROSS debug", "kWh"],
            ["acExportGrossTodayWh", "HEMS AC export today GROSS debug", "Wh"],
            ["acExportGrossTodayKWh", "HEMS AC export today GROSS debug", "kWh"],
            ["internalLoopTodayWh", "HEMS internal transfer today loop", "Wh"],
            ["internalLoopTodayKWh", "HEMS internal transfer today loop", "kWh"],
            ["pvTodayWh", "HEMS PV input today", "Wh"],
            ["pvTodayKWh", "HEMS PV input today", "kWh"],
        ];
        for (const [name, label, unit] of defs) {
            await this.ensureState(`HEMS.today.${name}`, "number", "value.energy", 0, unit, false, label);
        }
        await this.ensureEnergyDayTodayObjects("HEMS.today");
        await this.ensureState("HEMS.today.lastResetDate", "string", "text", "", "", false, "Last reset date");
    }
}

if (require.main !== module) {
    module.exports = options => new ZendureIpAdapter(options);
} else {
    (() => new ZendureIpAdapter())();
}
