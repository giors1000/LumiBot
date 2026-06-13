/**
 * Shared blinds schema helpers.
 *
 * This file is intentionally small and dependency-light so both the dashboard
 * and the dedicated blind page can build the same firmware payloads without
 * drifting on defaults, units, or config-sync bookkeeping.
 */
(function (global) {
    'use strict';

    const DEFAULT_RULES = Object.freeze({
        sunset: true,
        presence: true,
        morningOpen: true,
        nightLock: false,
        temperature: false
    });

    const DEFAULT_CONFIG = Object.freeze({
        sunsetOffset: null, // null = inherit the home-wide global ('zaylo-SunsetOffset'); a number = per-device override
        sunsetTarget: 0,
        motionTimeout: 5, // UI minutes; firmware seconds
        presenceTarget: 0,
        presenceOpenTarget: 100,
        presenceAction: 'close_only',
        presenceTimeFilter: 'all',
        morningTime: '07:00',
        morningDuration: 30,
        morningTarget: 100,
        morningDays: null,
        nightTime: '22:00',
        nightTarget: 0,
        nightDays: null,
        tempThreshold: 30,
        tempTarget: 20,
        tempReopenEnabled: false, // heat-protection auto-reopen (hysteresis)
        tempReopenThreshold: 25,  // °C: reopen once the outdoor temp falls to/below this
        tempReopenTarget: 100,    // % to move to when reopening
        lat: null,
        lon: null,
        city: null,
        stepperOpenSpeed: 2000,
        stepperCloseSpeed: 2000,
        stepperRelaxSteps: 128,
        stepperStopDelay: 3000,
        stepperAcceleration: 2000,
        stepperIdleHold: false,
        twtEnabled: false
    });

    const CFG_REV_MAX = 0x7ffffffe;

    function cleanId(deviceId) {
        return String(deviceId || '').trim().toUpperCase();
    }

    function clone(obj) {
        return JSON.parse(JSON.stringify(obj || {}));
    }

    function pendingKey(deviceId) {
        return `blind-cfgsync-${cleanId(deviceId) || 'unknown'}`;
    }

    function revKey(deviceId) {
        return `blind-cfgsync-rev-${cleanId(deviceId) || 'unknown'}`;
    }

    function readSavedState(deviceId) {
        try {
            return JSON.parse(localStorage.getItem(`blind-state-${cleanId(deviceId)}`) || '{}');
        } catch (e) {
            return {};
        }
    }

    function nextRevision(deviceId) {
        let last = 0;
        try {
            last = parseInt(localStorage.getItem(revKey(deviceId)) || '0', 10);
        } catch (e) {
            last = 0;
        }

        let next = Number.isFinite(last) ? last + 1 : 1;
        if (next < 1 || next > CFG_REV_MAX) next = 1;

        try {
            localStorage.setItem(revKey(deviceId), String(next));
        } catch (e) {
            // Keep going; the in-memory value still makes this push ackable.
        }
        return next;
    }

    function normalizeDaySchedule(days, defaults, includeDuration) {
        if (!Array.isArray(days) || days.length !== 7) return days;
        return days.map((day) => {
            const src = (day && typeof day === 'object') ? day : { enabled: !!day };
            const normalized = {
                enabled: src.enabled !== false,
                time: src.time || defaults.time,
                target: src.target !== undefined ? src.target : defaults.target
            };
            if (includeDuration) {
                normalized.duration = src.duration !== undefined ? src.duration : defaults.duration;
            }
            return normalized;
        });
    }

    // `const MQTTClient` in mqtt.js is a global lexical binding, not a window
    // property, so `global.MQTTClient` alone is not a reliable handle. Prefer
    // the explicit window export, fall back to the shared lexical binding.
    function mqttClient() {
        if (global.MQTTClient) return global.MQTTClient;
        try {
            return (typeof MQTTClient !== 'undefined') ? MQTTClient : null;
        } catch (e) {
            return null;
        }
    }

    function getTimezonePayload() {
        const client = mqttClient();
        if (client && typeof client.getTimezonePayload === 'function') {
            return client.getTimezonePayload();
        }
        const now = new Date();
        return {
            gmtOffset: -now.getTimezoneOffset() * 60,
            daylightOffset: 0
        };
    }

    function toFirmwareConfig(config) {
        const cfg = { ...clone(DEFAULT_CONFIG), ...clone(config) };

        // Sunset offset is PER-DEVICE when explicitly set, otherwise inherits the
        // home-wide global ('zaylo-SunsetOffset'). A null/undefined device value
        // means "inherit"; any finite number (including 0) is an explicit
        // per-device override that wins over the global. (Previously the global
        // always overrode the per-device value, so multi-blind homes could not set
        // different offsets per blind.)
        const perDeviceOffset = Number(cfg.sunsetOffset);
        cfg.sunsetOffset = (cfg.sunsetOffset !== null && cfg.sunsetOffset !== undefined && Number.isFinite(perDeviceOffset))
            ? perDeviceOffset
            : parseInt(localStorage.getItem('zaylo-SunsetOffset') || '0', 10);

        // Location inheritance: if the device has no per-device lat/lon override,
        // fall back to the home-wide global location so the firmware always gets
        // coordinates for accurate sunset calculation.
        if (cfg.lat == null || cfg.lon == null) {
            const globalLat = localStorage.getItem('zaylo-LocationLat');
            const globalLon = localStorage.getItem('zaylo-LocationLon');
            if (globalLat && globalLon) {
                cfg.lat = parseFloat(globalLat);
                cfg.lon = parseFloat(globalLon);
            }
        }

        if (cfg.motionTimeout !== undefined) {
            const minutes = Number(cfg.motionTimeout || DEFAULT_CONFIG.motionTimeout);
            cfg.motionTimeout = Math.max(1, Math.round(minutes)) * 60;
        }

        cfg.morningDays = normalizeDaySchedule(cfg.morningDays, {
            time: cfg.morningTime || DEFAULT_CONFIG.morningTime,
            duration: cfg.morningDuration || DEFAULT_CONFIG.morningDuration,
            target: cfg.morningTarget !== undefined ? cfg.morningTarget : DEFAULT_CONFIG.morningTarget
        }, true);

        cfg.nightDays = normalizeDaySchedule(cfg.nightDays, {
            time: cfg.nightTime || DEFAULT_CONFIG.nightTime,
            target: cfg.nightTarget !== undefined ? cfg.nightTarget : DEFAULT_CONFIG.nightTarget
        }, false);

        const tz = getTimezonePayload();
        if (tz) {
            cfg.gmtOffset = tz.gmtOffset;
            cfg.daylightOffset = tz.daylightOffset;
            if (tz.tzPosix) cfg.tzPosix = tz.tzPosix;
        }

        // Strip the 'city' property — it's a UI-only label that the ESP32
        // firmware doesn't need or understand. Only lat/lon are sent.
        delete cfg.city;

        return cfg;
    }

    function buildConfigPayload(deviceId, savedState, rev) {
        const saved = savedState || readSavedState(deviceId);
        const payload = {
            config: toFirmwareConfig(saved.config || {}),
            cfgRev: rev
        };
        // Rules are included ONLY when they are explicit (wizard choices, a user
        // toggle, or rules previously confirmed by the device). For a device that
        // never went through those paths (portal-provisioned, added by ID), the
        // optimistic app defaults (sunset/presence/morning ON) used to ride along
        // with the first unrelated settings push and silently ENABLE automations
        // on a firmware whose own defaults are all OFF — blinds closing at sunset
        // the customer never asked for. The firmware parser is containsKey-guarded,
        // so omitting `rules` leaves the device's rule state completely untouched.
        if (saved.rules && typeof saved.rules === 'object') {
            payload.rules = { ...DEFAULT_RULES, ...saved.rules };
        }
        if (saved.linkedDeviceId) payload.linkedDeviceId = saved.linkedDeviceId;
        return payload;
    }

    function queueConfigSync(deviceId, savedState) {
        const id = cleanId(deviceId);
        if (!id) return null;

        if (global.BlindConfigSync && typeof global.BlindConfigSync.queue === 'function') {
            return global.BlindConfigSync.queue(id, savedState, { source: 'schema' });
        }

        const rev = nextRevision(id);
        const payload = buildConfigPayload(id, savedState, rev);
        const pending = { rev, payload, acked: false };
        try {
            localStorage.setItem(pendingKey(id), JSON.stringify(pending));
        } catch (e) {
            // Best effort; publish still proceeds when connected.
        }

        let sent = false;
        const client = mqttClient();
        if (client && client.connected) {
            sent = client.publishConfig(id, payload);
        }
        return { rev, payload, sent };
    }

    function flushPendingConfigSync(deviceId) {
        const id = cleanId(deviceId);
        const client = mqttClient();
        if (!id || !client || !client.connected) return false;

        if (global.BlindConfigSync && typeof global.BlindConfigSync.flush === 'function') {
            return global.BlindConfigSync.flush(id);
        }

        let saved;
        try {
            saved = JSON.parse(localStorage.getItem(pendingKey(id)) || 'null');
        } catch (e) {
            saved = null;
        }
        if (!saved || saved.acked || !saved.payload) return false;
        return client.publishConfig(id, saved.payload);
    }

    function flushPendingConfigSyncs(deviceIds) {
        (deviceIds || []).forEach(flushPendingConfigSync);
    }

    function handleConfigAck(deviceId, state) {
        const id = cleanId(deviceId);
        if (!id || !state) return false;

        if (global.BlindConfigSync && typeof global.BlindConfigSync.handleState === 'function') {
            return global.BlindConfigSync.handleState(id, state);
        }

        let pending;
        try {
            pending = JSON.parse(localStorage.getItem(pendingKey(id)) || 'null');
        } catch (e) {
            pending = null;
        }
        if (!pending || pending.acked || pending.rev === undefined) return false;

        let echoed = state.cfgRev;
        if (echoed === undefined && state.config) echoed = state.config.cfgRev;
        if (echoed !== undefined && Number(echoed) === Number(pending.rev)) {
            try {
                localStorage.removeItem(pendingKey(id));
            } catch (e) {}
            return true;
        }
        return false;
    }

    // ── Temperature unit helpers (shared by device page / Spaces / wizard) ──
    // Storage, firmware payloads and MQTT stay in °C everywhere; ONLY the
    // presentation converts. 'zaylo-tempUnit' = 'C' (default) | 'F'.
    function tempUnit() {
        try { return localStorage.getItem('zaylo-tempUnit') === 'F' ? 'F' : 'C'; }
        catch (e) { return 'C'; }
    }
    function setTempUnit(unit) {
        try { localStorage.setItem('zaylo-tempUnit', unit === 'F' ? 'F' : 'C'); }
        catch (e) { /* presentation-only preference; safe to drop */ }
    }
    function tempUnitSuffix() {
        return tempUnit() === 'F' ? '°F' : '°C';
    }
    // °C (canonical) → display number in the active unit.
    function cToDisplay(celsius) {
        const c = Number(celsius);
        if (!Number.isFinite(c)) return celsius;
        return tempUnit() === 'F' ? Math.round(c * 9 / 5 + 32) : Math.round(c);
    }
    // Display number in the active unit → °C (canonical, rounded to int —
    // matches the firmware's integer thresholds).
    function displayToC(value) {
        const v = Number(value);
        if (!Number.isFinite(v)) return value;
        return tempUnit() === 'F' ? Math.round((v - 32) * 5 / 9) : Math.round(v);
    }
    function formatTemp(celsius) {
        const d = cToDisplay(celsius);
        return Number.isFinite(Number(d)) ? `${d}${tempUnitSuffix()}` : `--${tempUnitSuffix()}`;
    }

    global.BlindSchema = {
        DEFAULT_RULES,
        DEFAULT_CONFIG,
        readSavedState,
        nextRevision,
        toFirmwareConfig,
        buildConfigPayload,
        queueConfigSync,
        flushPendingConfigSync,
        flushPendingConfigSyncs,
        handleConfigAck,
        tempUnit,
        setTempUnit,
        tempUnitSuffix,
        cToDisplay,
        displayToC,
        formatTemp
    };
})(window);
