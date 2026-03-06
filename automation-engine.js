/**
 * LumiBot — Client-Side Automation Engine
 * Version: 2.0.0
 * 
 * Runs automation rules (Sunset, Presence, Morning Wake-Up, Night Lock, Heat Protection)
 * entirely on the client side, since StepperMote firmware lacks an RTC or direct weather access.
 * Must run on both index.html (dashboard) and blind-device.html.
 *
 * Architecture:
 *   - Reads device list from localStorage ('LumiBot-devices').
 *   - Reads per-device rules & config from localStorage ('blind-state-{id}').
 *   - Uses StateStore for linked-device data (motion, cpuTemp) when available.
 *   - Publishes MQTT commands via MQTTClient when rules fire.
 */

const AutomationEngine = (function () {
    'use strict';

    let _intervalId = null;
    const CHECK_INTERVAL_MS = 60000; // Evaluate every 60 seconds

    // Cooldown tracker: prevents the same rule from firing repeatedly
    const _lastRunTimes = {};

    // Gradual movement tracker for morning wake-up
    const _activeGradualMovements = {};

    // Presence "no-motion" timers — separate from cooldowns
    const _presenceTimers = {};

    // Blind motor settle timers — tracks pending AUTO-mode restore timeouts
    // Key: linkedSwitchId, Value: setTimeout ID
    const _blindMotorSettleTimers = {};

    // Motor settle duration — how long to suppress the linked switch after a blind command
    const MOTOR_SETTLE_MS = 45000; // 45 seconds

    // ── Helpers ──────────────────────────────────────────────────

    /**
     * Returns true when the current time falls inside the 60-second window
     * starting at HH:MM (plus an optional offset in minutes).
     */
    function isTimeNow(timeStr, offsetMinutes) {
        if (!timeStr) return false;
        offsetMinutes = offsetMinutes || 0;

        const parts = timeStr.split(':');
        if (parts.length < 2) return false;
        const hours = parseInt(parts[0], 10);
        const minutes = parseInt(parts[1], 10);
        if (isNaN(hours) || isNaN(minutes)) return false;

        const target = new Date();
        target.setHours(hours, minutes, 0, 0);
        target.setMinutes(target.getMinutes() + offsetMinutes);

        const diff = Date.now() - target.getTime();
        return diff >= 0 && diff < CHECK_INTERVAL_MS;
    }

    /**
     * Cooldown guard — returns true only if enough time has passed since the
     * last execution of a specific rule on a specific device.
     */
    function canExecuteRule(deviceId, ruleName, cooldownMs) {
        cooldownMs = cooldownMs || CHECK_INTERVAL_MS;
        const key = deviceId + '_' + ruleName;
        const now = Date.now();
        if (!_lastRunTimes[key] || (now - _lastRunTimes[key]) > cooldownMs) {
            _lastRunTimes[key] = now;
            return true;
        }
        return false;
    }

    /**
     * Safely read the per-device saved state from localStorage.
     * Returns { rules: {…}, config: {…}, linkedDeviceId: string|null }
     */
    function loadBlindState(deviceId) {
        try {
            var raw = localStorage.getItem('blind-state-' + deviceId);
            if (!raw) return null;
            return JSON.parse(raw);
        } catch (e) {
            return null;
        }
    }

    /**
     * Get the linked SwitchMote ID for a blind device.
     * Reads from localStorage blind-state.
     */
    function getLinkedSwitchId(blindDeviceId) {
        var saved = loadBlindState(blindDeviceId) || loadBlindState(blindDeviceId.toLowerCase());
        return (saved && saved.linkedDeviceId) ? saved.linkedDeviceId : null;
    }

    /**
     * Temporarily suppress a linked SwitchMote when a blind motor is about to move.
     *
     * Sets the switch from AUTO → MANUAL mode to prevent the motor's physical
     * movement from triggering the radar (false motion → unwanted light toggle).
     * After MOTOR_SETTLE_MS the switch is restored to AUTO mode.
     *
     * Guards:
     *  - Only suppresses if switch is in AUTO mode (mode 0)
     *  - Only suppresses if switched light is OFF (if ON, motor motion is harmless)
     *  - Cancels any pending restore timer before starting a new one
     */
    function suppressLinkedSwitch(linkedSwitchId) {
        if (!linkedSwitchId) return;
        if (typeof StateStore === 'undefined' || typeof MQTTClient === 'undefined') return;
        if (!MQTTClient.connected) return;

        // Normalize to uppercase — StateStore keys are uppercased by MQTT
        linkedSwitchId = linkedSwitchId.toUpperCase();

        var switchState = StateStore.get(linkedSwitchId);
        if (!switchState) return;

        var switchMode = (switchState.mode !== undefined && switchState.mode !== null)
            ? parseInt(switchState.mode, 10) : -1;

        // Only suppress if switch is in AUTO mode with light OFF
        if (switchMode !== 0 || switchState.light === true) return;

        // Cancel any pending restore from a previous blind command
        if (_blindMotorSettleTimers[linkedSwitchId]) {
            clearTimeout(_blindMotorSettleTimers[linkedSwitchId]);
        }

        console.info('[Automation] 🔗 Suppressing switch ' + linkedSwitchId + ' (AUTO → MANUAL) during blind motor movement');
        MQTTClient.publishControl(linkedSwitchId, { mode: 1 }); // MANUAL mode

        // Schedule restore to AUTO mode after motor settles
        _blindMotorSettleTimers[linkedSwitchId] = setTimeout(function () {
            console.info('[Automation] 🔗 Restoring switch ' + linkedSwitchId + ' to AUTO mode (motor settled)');
            if (typeof MQTTClient !== 'undefined' && MQTTClient.connected) {
                MQTTClient.publishControl(linkedSwitchId, { mode: 0 }); // AUTO mode
            }
            delete _blindMotorSettleTimers[linkedSwitchId];
        }, MOTOR_SETTLE_MS);
    }

    // ── Rule Processors ─────────────────────────────────────────

    /**
     * Night Lock — closes blinds at a configured time each day.
     */
    function processNightLock(deviceId, rules, config) {
        if (!rules.nightLock) return;

        var lockTime = (config && config.nightTime) || '22:00';
        var target = (config && config.nightTarget !== undefined) ? config.nightTarget : 0;

        if (isTimeNow(lockTime)) {
            if (canExecuteRule(deviceId, 'nightLock')) {
                console.info('[Automation] 🌙 Night Lock for ' + deviceId + ' -> ' + target + '%');
                var linkedSwitch = getLinkedSwitchId(deviceId);
                suppressLinkedSwitch(linkedSwitch);
                if (typeof MQTTClient !== 'undefined' && MQTTClient.connected) {
                    MQTTClient.publishStepperControl(deviceId, { blindPosition: target });
                }
                if (typeof Toast !== 'undefined') Toast.info('Night Lock engaged');
            }
        }
    }

    /**
     * Sunset Auto-Close — closes blinds around sunset (requires cached sunset time).
     */
    function processSunset(deviceId, rules, config) {
        if (!rules.sunset) return;

        var offset = (config && config.sunsetOffset !== undefined) ? config.sunsetOffset : 15;
        var target = (config && config.sunsetTarget !== undefined) ? config.sunsetTarget : 0;

        // Need a cached sunset timestamp — could come from weather API or linked hub
        var cachedSunset = config && config.cached_sunset;
        if (!cachedSunset) return;

        var sunsetDate = new Date(cachedSunset * 1000);
        var sunsetStr = sunsetDate.getHours().toString().padStart(2, '0') + ':' +
            sunsetDate.getMinutes().toString().padStart(2, '0');

        if (isTimeNow(sunsetStr, offset)) {
            if (canExecuteRule(deviceId, 'sunset', 5 * 60000)) { // 5-min cooldown
                console.info('[Automation] 🌇 Sunset Close for ' + deviceId + ' -> ' + target + '%');
                var linkedSwitch = getLinkedSwitchId(deviceId);
                suppressLinkedSwitch(linkedSwitch);
                if (typeof MQTTClient !== 'undefined' && MQTTClient.connected) {
                    MQTTClient.publishStepperControl(deviceId, { blindPosition: target });
                }
                if (typeof Toast !== 'undefined') Toast.info('Sunset auto-close');
            }
        }
    }

    /**
     * Morning Wake-Up — gradually opens blinds over a configurable duration.
     */
    function processMorningWakeUp(deviceId, rules, config) {
        if (!rules.morningOpen) {
            delete _activeGradualMovements[deviceId];
            return;
        }

        var wakeTime = (config && config.morningTime) || '07:00';
        var durationMins = (config && config.morningDuration) || 30;
        var targetPos = (config && config.morningTarget !== undefined) ? config.morningTarget : 100;

        var parts = wakeTime.split(':');
        var hours = parseInt(parts[0], 10);
        var minutes = parseInt(parts[1], 10);
        if (isNaN(hours) || isNaN(minutes)) return;

        var now = new Date();

        var startTime = new Date();
        startTime.setHours(hours, minutes, 0, 0);

        var endTime = new Date(startTime.getTime() + durationMins * 60000);

        if (now >= startTime && now <= endTime) {
            var elapsed = now.getTime() - startTime.getTime();
            var total = endTime.getTime() - startTime.getTime();
            var progress = elapsed / total; // 0.0 → 1.0

            var currentTarget = Math.round(targetPos * progress);

            // Only send a command when the position changes by ≥ 2%
            var lastPos = _activeGradualMovements[deviceId];
            if (lastPos === undefined) lastPos = -1;

            if (Math.abs(currentTarget - lastPos) >= 2 || lastPos === -1) {
                _activeGradualMovements[deviceId] = currentTarget;
                console.info('[Automation] 🌅 Morning Gradual Open ' + deviceId + ' -> ' + currentTarget + '%');
                var linkedSwitch = getLinkedSwitchId(deviceId);
                suppressLinkedSwitch(linkedSwitch);
                if (typeof MQTTClient !== 'undefined' && MQTTClient.connected) {
                    MQTTClient.publishStepperControl(deviceId, { blindPosition: currentTarget });
                }
            }
        } else {
            delete _activeGradualMovements[deviceId];
        }
    }

    /**
     * Presence Auto-Close — closes blinds when linked SwitchMote's radar
     * reports no motion for longer than the configured timeout.
     */
    function processPresence(deviceId, rules, config, linkedDeviceId) {
        if (!rules.presence) return;
        if (!linkedDeviceId || typeof StateStore === 'undefined') return;

        var timeoutMins = (config && config.motionTimeout !== undefined) ? config.motionTimeout : 5;
        var target = (config && config.presenceTarget !== undefined) ? config.presenceTarget : 0;
        var timeoutMs = timeoutMins * 60000;

        var linkedState = StateStore.get(linkedDeviceId);
        if (!linkedState) return;

        var presenceKey = 'presence_' + deviceId;

        if (linkedState.motion === false) {
            // Start or continue tracking no-motion duration
            if (!_presenceTimers[presenceKey]) {
                _presenceTimers[presenceKey] = Date.now();
            }

            var elapsed = Date.now() - _presenceTimers[presenceKey];
            if (elapsed >= timeoutMs) {
                if (canExecuteRule(deviceId, 'presenceAutoClose', Math.max(60000, timeoutMs))) {
                    console.info('[Automation] 🚶 Presence Auto Close ' + deviceId + ' -> ' + target + '%');
                    suppressLinkedSwitch(linkedDeviceId);
                    if (typeof MQTTClient !== 'undefined' && MQTTClient.connected) {
                        MQTTClient.publishStepperControl(deviceId, { blindPosition: target });
                    }
                    if (typeof Toast !== 'undefined') Toast.info('No presence — blinds closing');
                }
            }
        } else {
            // Motion detected — reset timer
            delete _presenceTimers[presenceKey];
        }
    }

    /**
     * Heat Protection — closes blinds when linked device temperature
     * exceeds a threshold.
     */
    function processHeatProtection(deviceId, rules, config, linkedDeviceId) {
        if (!rules.temperature) return;
        if (!linkedDeviceId || typeof StateStore === 'undefined') return;

        var threshold = (config && config.tempThreshold !== undefined) ? config.tempThreshold : 30;
        var target = (config && config.tempTarget !== undefined) ? config.tempTarget : 20;

        var linkedState = StateStore.get(linkedDeviceId);
        if (!linkedState || linkedState.cpuTemp === undefined) return;

        if (linkedState.cpuTemp >= threshold) {
            if (canExecuteRule(deviceId, 'heatProtection', 15 * 60000)) { // 15-min cooldown
                console.info('[Automation] 🌡️ Heat Protection ' + deviceId + ' -> ' + target + '%');
                suppressLinkedSwitch(linkedDeviceId);
                if (typeof MQTTClient !== 'undefined' && MQTTClient.connected) {
                    MQTTClient.publishStepperControl(deviceId, { blindPosition: target });
                }
                if (typeof Toast !== 'undefined') Toast.warning('Heat protection engaged');
            }
        }
    }

    /**
     * Switch Presence Auto-Off — turns off a light switch when its own radar
     * reports no motion for longer than the configured motionTimeout.
     *
     * Unlike blind presence (which reads from a *linked* SwitchMote), a light
     * switch IS the presence sensor — so we read motion from its own StateStore.
     * The timeout comes from the device's config.motionTimeout (seconds).
     */
    function processSwitchPresence(deviceId) {
        if (typeof StateStore === 'undefined') return;

        var state = StateStore.get(deviceId);
        if (!state) return;

        // Only act when the light is currently ON
        if (state.light !== true) {
            // Light is already off — clear any pending timer
            delete _presenceTimers['switchPresence_' + deviceId];
            return;
        }

        // Only act in AUTO mode (mode 0) — manual/locked modes should not auto-off
        var mode = (state.mode !== undefined && state.mode !== null) ? parseInt(state.mode, 10) : -1;
        if (mode !== 0) {
            delete _presenceTimers['switchPresence_' + deviceId];
            return;
        }

        // Timeout from device config (in seconds, default 120s)
        var config = state.config || {};
        var timeoutSec = (config.motionTimeout !== undefined) ? parseInt(config.motionTimeout, 10) : 120;
        if (isNaN(timeoutSec) || timeoutSec <= 0) return;
        var timeoutMs = timeoutSec * 1000;

        var presenceKey = 'switchPresence_' + deviceId;

        // Check motion status from the device's own radar
        if (state.motion === false) {
            // No motion — start or continue tracking
            if (!_presenceTimers[presenceKey]) {
                _presenceTimers[presenceKey] = Date.now();
                console.info('[Automation] 🔍 Switch ' + deviceId + ' — no motion, timer started (' + timeoutSec + 's)');
            }

            var elapsed = Date.now() - _presenceTimers[presenceKey];
            if (elapsed >= timeoutMs) {
                // Cooldown: at least the timeout duration or 60s, whichever is larger
                if (canExecuteRule(deviceId, 'switchPresenceAutoOff', Math.max(60000, timeoutMs))) {
                    console.info('[Automation] 🚶 Switch Presence Auto-Off: ' + deviceId + ' — no motion for ' + timeoutSec + 's');
                    if (typeof MQTTClient !== 'undefined' && MQTTClient.connected) {
                        MQTTClient.publishControl(deviceId, { light: false });
                    }
                    if (typeof Toast !== 'undefined') Toast.info('No presence — light turned off');
                    delete _presenceTimers[presenceKey];
                }
            }
        } else {
            // Motion detected — reset timer
            if (_presenceTimers[presenceKey]) {
                console.info('[Automation] ✅ Switch ' + deviceId + ' — motion detected, timer reset');
            }
            delete _presenceTimers[presenceKey];
        }
    }

    // ── Main Loop ───────────────────────────────────────────────

    function _evaluateRules() {
        if (typeof StateStore === 'undefined') return;

        // Read device list — uses the SAME key as the rest of the app
        var savedDevicesStr = localStorage.getItem('LumiBot-devices');
        if (!savedDevicesStr) return;

        try {
            var savedDevices = JSON.parse(savedDevicesStr);
            if (!Array.isArray(savedDevices)) return;

            savedDevices.forEach(function (device) {
                var id = (device.id || '').toUpperCase();
                if (!id) return;

                // ── Blind / Stepper Devices ──
                if (device.type === 'stepper' || device.type === 'blind') {
                    var saved = loadBlindState(id) || loadBlindState(id.toLowerCase());
                    if (!saved || !saved.rules) return;

                    var rules = saved.rules;
                    var config = saved.config || {};
                    var linked = saved.linkedDeviceId || null;

                    processNightLock(id, rules, config);
                    processSunset(id, rules, config);
                    processMorningWakeUp(id, rules, config);
                    processPresence(id, rules, config, linked);
                    processHeatProtection(id, rules, config, linked);
                    return;
                }

                // ── Light Switch (SwitchMote / LumiBot) Devices ──
                if (device.type === 'lumibot' || !device.type) {
                    processSwitchPresence(id);
                }
            });
        } catch (e) {
            console.error('[Automation] Error evaluating rules:', e);
        }
    }

    // ── Public API ──────────────────────────────────────────────

    return {
        init: function () {
            if (_intervalId) clearInterval(_intervalId);

            // Initial run after a brief delay so MQTTClient + StateStore are ready
            setTimeout(_evaluateRules, 5000);
            _intervalId = setInterval(_evaluateRules, CHECK_INTERVAL_MS);

            console.info('[Automation] Engine started (interval: ' + (CHECK_INTERVAL_MS / 1000) + 's)');
        },

        stop: function () {
            if (_intervalId) {
                clearInterval(_intervalId);
                _intervalId = null;
                console.info('[Automation] Engine stopped');
            }
        },

        /** Force an immediate evaluation (useful after saving config) */
        evaluate: function () {
            _evaluateRules();
        }
    };
})();

// Auto-start in browser environment
if (typeof window !== 'undefined') {
    window.addEventListener('load', function () {
        if (typeof StateStore !== 'undefined') {
            AutomationEngine.init();
        } else {
            setTimeout(function () {
                if (typeof StateStore !== 'undefined') {
                    AutomationEngine.init();
                }
            }, 2000);
        }
    });
}
