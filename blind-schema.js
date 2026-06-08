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

    function getTimezonePayload() {
        if (global.MQTTClient && typeof global.MQTTClient.getTimezonePayload === 'function') {
            return global.MQTTClient.getTimezonePayload();
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

        return cfg;
    }

    function buildConfigPayload(deviceId, savedState, rev) {
        const saved = savedState || readSavedState(deviceId);
        const payload = {
            rules: { ...DEFAULT_RULES, ...(saved.rules || {}) },
            config: toFirmwareConfig(saved.config || {}),
            cfgRev: rev
        };
        if (saved.linkedDeviceId) payload.linkedDeviceId = saved.linkedDeviceId;
        return payload;
    }

    function queueConfigSync(deviceId, savedState) {
        const id = cleanId(deviceId);
        if (!id) return null;

        const rev = nextRevision(id);
        const payload = buildConfigPayload(id, savedState, rev);
        const pending = { rev, payload, acked: false };
        try {
            localStorage.setItem(pendingKey(id), JSON.stringify(pending));
        } catch (e) {
            // Best effort; publish still proceeds when connected.
        }

        let sent = false;
        if (global.MQTTClient && global.MQTTClient.connected) {
            sent = global.MQTTClient.publishConfig(id, payload);
        }
        return { rev, payload, sent };
    }

    function flushPendingConfigSync(deviceId) {
        const id = cleanId(deviceId);
        if (!id || !global.MQTTClient || !global.MQTTClient.connected) return false;

        let saved;
        try {
            saved = JSON.parse(localStorage.getItem(pendingKey(id)) || 'null');
        } catch (e) {
            saved = null;
        }
        if (!saved || saved.acked || !saved.payload) return false;
        return global.MQTTClient.publishConfig(id, saved.payload);
    }

    function flushPendingConfigSyncs(deviceIds) {
        (deviceIds || []).forEach(flushPendingConfigSync);
    }

    function handleConfigAck(deviceId, state) {
        const id = cleanId(deviceId);
        if (!id || !state) return false;

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
        handleConfigAck
    };
})(window);
