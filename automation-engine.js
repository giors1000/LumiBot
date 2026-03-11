/**
 * Zaylo — Client-Side Automation Engine
 * Version: 2.0.0
 * 
 * Runs automation rules (Sunset, Presence, Morning Wake-Up, Night Lock, Heat Protection)
 * entirely on the client side, since Zaylo Slide firmware lacks an RTC or direct weather access.
 * Must run on both index.html (dashboard) and blind-device.html.
 *
 * Architecture:
 *   - Reads device list from localStorage ('zaylo-devices').
 *   - Reads per-device rules & config from localStorage ('blind-state-{id}').
 *   - Uses StateStore for linked-device data (motion, cpuTemp) when available.
 *   - Publishes MQTT commands via MQTTClient when rules fire.
 */
const AutomationEngine = (function () {
    'use strict';

    const WEATHER_API_KEY = 'e20c6a9a37404d9726371c943d7da0ba';
    const CITY = 'Bristol,GB';

    // Holds fetched weather data
    let _weatherData = {
        sunrise: null,
        sunset: null,
        lastFetch: 0
    };

    let _intervalId = null;
    const CHECK_INTERVAL_MS = 60000; // Evaluate every 60 seconds

    // Cooldown tracker: prevents the same rule from firing repeatedly
    const _lastRunTimes = {};

    // Gradual movement tracker for morning wake-up
    const _activeGradualMovements = {};

    // Presence "no-motion" timers — separate from cooldowns
    const _presenceTimers = {};

    // Presence "motion-detected" debounce timers
    const _presenceEnterTimers = {};

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
     * Get the Linked Zaylo Lumibot ID for a blind device.
     * Reads from localStorage blind-state.
     */
    function getLinkedSwitchId(blindDeviceId) {
        var saved = loadBlindState(blindDeviceId) || loadBlindState(blindDeviceId.toLowerCase());
        return (saved && saved.linkedDeviceId) ? saved.linkedDeviceId : null;
    }

    /**
     * Temporarily suppress a Linked Zaylo Lumibot when a blind motor is about to move.
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

        // Try the internal Engine weather data first, fallback to config cache
        var cachedSunset = _weatherData.sunset || (config && config.cached_sunset);
        if (!cachedSunset) return;

        var sunsetDate = new Date(cachedSunset * 1000);
        // Apply the offset (minutes) natively to the Date object so negative/positive shifts wrap correctly around hours.
        sunsetDate.setTime(sunsetDate.getTime() + (offset * 60000));

        var sunsetStr = sunsetDate.getHours().toString().padStart(2, '0') + ':' +
            sunsetDate.getMinutes().toString().padStart(2, '0');

        if (isTimeNow(sunsetStr, 0)) {
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
     * Supports per-day schedules via config.morningDays (array of 7 objects).
     * Falls back to legacy config.morningTime / morningDuration / morningTarget if morningDays is absent.
     */
    function processMorningWakeUp(deviceId, rules, config) {
        if (!rules.morningOpen) {
            delete _activeGradualMovements[deviceId];
            return;
        }

        // --- Resolve today's schedule from morningDays or legacy fields ---
        var now = new Date();
        var todayIdx = now.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat

        var wakeTime, durationMins, targetPos;
        var morningDays = config && config.morningDays;

        if (morningDays && Array.isArray(morningDays) && morningDays.length === 7) {
            // First, try today's schedule
            var todaySchedule = morningDays[todayIdx];
            if (todaySchedule && todaySchedule.enabled !== false) {
                wakeTime = todaySchedule.time || '07:00';
                durationMins = todaySchedule.duration || 30;
                targetPos = todaySchedule.target !== undefined ? todaySchedule.target : 100;
            } else {
                // Today is disabled. Check if yesterday's schedule has a window
                // that could span past midnight into today (e.g. yesterday wake=01:00, dur=60m).
                // We just resolve yesterday's config values and let the time-window
                // evaluation below determine if we're actually inside that window.
                var yesterdayIdx = (todayIdx + 6) % 7;
                var yesterdaySchedule = morningDays[yesterdayIdx];
                if (yesterdaySchedule && yesterdaySchedule.enabled !== false) {
                    wakeTime = yesterdaySchedule.time || '07:00';
                    durationMins = yesterdaySchedule.duration || 30;
                    targetPos = yesterdaySchedule.target !== undefined ? yesterdaySchedule.target : 100;
                } else {
                    // Neither today nor yesterday is enabled — nothing to do
                    delete _activeGradualMovements[deviceId];
                    return;
                }
            }
        } else {
            // Legacy: uniform schedule for all days
            wakeTime = (config && config.morningTime) || '07:00';
            durationMins = (config && config.morningDuration) || 30;
            targetPos = (config && config.morningTarget !== undefined) ? config.morningTarget : 100;
        }

        var parts = wakeTime.split(':');
        var hours = parseInt(parts[0], 10);
        var minutes = parseInt(parts[1], 10);
        if (isNaN(hours) || isNaN(minutes)) return;

        // Base end time on today
        var endTime = new Date();
        endTime.setHours(hours, minutes, 0, 0);

        // If the wake time is earlier than right now, it generally means tomorrow.
        // However, if we are *currently* inside a valid wake-up window (e.g. now is 06:45, wakeTime is 07:00, duration is 30m),
        // we must process it for today.
        
        var startTime = new Date(endTime.getTime() - durationMins * 60000);

        if (now > endTime) {
            // It's past the wake time for today, so the next genuine wake up is tomorrow.
            endTime.setDate(endTime.getDate() + 1);
            startTime = new Date(endTime.getTime() - durationMins * 60000);
        } else if (now < startTime && (endTime.getTime() - now.getTime()) > 12 * 3600 * 1000) {
            // It's way before the start time (e.g. 1am, wake up is 11pm), check if it's meant for "yesterday's" window spanning midnight.
            endTime.setDate(endTime.getDate() - 1);
            startTime = new Date(endTime.getTime() - durationMins * 60000);
            if (now < startTime || now > endTime) {
                // If it still doesn't fit, revert to the future
                endTime.setDate(endTime.getDate() + 1);
                startTime = new Date(endTime.getTime() - durationMins * 60000);
            }
        }

        if (now >= startTime && now <= endTime) {
            var elapsed = now.getTime() - startTime.getTime();
            
            // Quantize elapsed time into 1-minute chunks to ensure distinct periodic movements
            var elapsedMins = Math.floor(elapsed / 60000);
            var progress = elapsedMins / durationMins; // 0.0 → 1.0
            if (progress > 1) progress = 1;
            
            var gradualState = _activeGradualMovements[deviceId];

            if (gradualState && gradualState.aborted) {
                return; // Sleep until tomorrow
            }

            var blindStateCur = typeof StateStore !== 'undefined' ? (StateStore.get(deviceId) || loadBlindState(deviceId)) : null;
            var actualPos = blindStateCur ? (blindStateCur.position !== undefined ? blindStateCur.position : (blindStateCur.targetPosition !== undefined ? blindStateCur.targetPosition : 0)) : 0;

            if (typeof gradualState !== 'object' || gradualState.startPos === undefined || gradualState.endTime !== endTime.getTime()) {
                // Initialize or re-initialize if the expected end time changed mid-flight
                gradualState = { 
                    startPos: actualPos, 
                    lastSent: -1,
                    endTime: endTime.getTime(),
                    targetPos: targetPos  // Store target so it doesn't change mid-flight
                };
                _activeGradualMovements[deviceId] = gradualState;
            }

            // Use stored target to avoid regression if config changes during execution
            var effectiveTarget = gradualState.targetPos !== undefined ? gradualState.targetPos : targetPos;

            // Smooth ideal progress based strictly on time
            var idealTarget = gradualState.startPos + (effectiveTarget - gradualState.startPos) * progress;

            // Quantize the ideal target into distinct 5% bins to ensure mechanical backlash is overcome.
            var binSize = 5;
            var currentTarget = Math.round(idealTarget / binSize) * binSize;

            // Ensure we don't overshoot the true final target
            if (progress >= 1.0) {
                currentTarget = effectiveTarget;
            }

            // Check for manual intervention during the opening sequence
            if (gradualState.lastSent !== -1 && typeof StateStore !== 'undefined') {
                // If actual position differs from what we last commanded by > 5%, assume manual override
                if (Math.abs(actualPos - gradualState.lastSent) > 5) {
                    console.info('[Automation] 🛑 Morning wake-up aborted due to manual override on ' + deviceId);
                    _activeGradualMovements[deviceId] = { aborted: true };
                    return;
                }
            }

            // Only send a command if our 5% quantized target has genuinely changed since last time
            if (currentTarget !== gradualState.lastSent) {
                gradualState.lastSent = currentTarget;
                console.info('[Automation] 🌅 Morning Gradual Open ' + deviceId + ' -> ' + currentTarget + '%');
                var linkedSwitch = getLinkedSwitchId(deviceId);
                suppressLinkedSwitch(linkedSwitch);
                if (typeof MQTTClient !== 'undefined' && MQTTClient.connected) {
                    // Use a speed of 1000 steps/s for firmness without high-speed slamming
                    MQTTClient.publishStepperControl(deviceId, { blindPosition: currentTarget, speed: 1000 });
                }
            }

        } else if (now > endTime && _activeGradualMovements[deviceId] !== undefined) {
            // The time window has safely concluded.
            // Ensure the blind arrives at the *exact* target value if we mathematically missed it by 1%.
            var gradualState = _activeGradualMovements[deviceId];
            if (!gradualState.aborted) {
                var effectiveTarget = gradualState.targetPos !== undefined ? gradualState.targetPos : targetPos;
                var lastSent = typeof gradualState === 'object' ? gradualState.lastSent : gradualState;
                if (lastSent !== effectiveTarget && lastSent !== -1) {
                    console.info('[Automation] 🌅 Morning Gradual Open FINISHED ' + deviceId + ' -> ' + effectiveTarget + '%');
                    var linkedSwitch = getLinkedSwitchId(deviceId);
                    suppressLinkedSwitch(linkedSwitch);
                    if (typeof MQTTClient !== 'undefined' && MQTTClient.connected) {
                        MQTTClient.publishStepperControl(deviceId, { blindPosition: effectiveTarget });
                    }
                    if (typeof Toast !== 'undefined') Toast.info('Morning wake-up routine complete');
                }
            }
            // Deregister the tracker so it doesn't run again until tomorrow
            delete _activeGradualMovements[deviceId];
        } else {
            // Unrelated time of day; clean up state harmlessly
            delete _activeGradualMovements[deviceId];
        }
    }

    /**
     * Presence Auto-Close — closes blinds when Linked Zaylo Lumibot's radar
     * reports no motion for longer than the configured timeout.
     * Optionally opens blinds upon entering the room.
     */
    function processPresence(deviceId, rules, config, linkedDeviceId) {
        if (!rules.presence) return;
        if (!linkedDeviceId || typeof StateStore === 'undefined') return;

        var timeoutMins = (config && config.motionTimeout !== undefined) ? config.motionTimeout : 5;
        var target = (config && config.presenceTarget !== undefined) ? config.presenceTarget : 0;
        
        var action = (config && config.presenceAction) || 'close_only';
        var openTarget = (config && config.presenceOpenTarget !== undefined) ? config.presenceOpenTarget : 100;
        
        var timeFilter = (config && config.presenceTimeFilter) || 'all';

        var timeoutMs = timeoutMins * 60000;

        var linkedState = StateStore.get(linkedDeviceId);
        if (!linkedState) return;

        // --- Time Filter Evaluation ---
        if (timeFilter !== 'all') {
            var sunrise = _weatherData.sunrise || (config && config.cached_sunrise);
            var sunset = _weatherData.sunset || (config && config.cached_sunset);
            if (sunrise && sunset) {
                var nowSec = Math.floor(Date.now() / 1000);
                
                // Construct today's sunrise/sunset by preserving only the time portion of the stored timestamps
                var nowD = new Date();
                
                var srD = new Date(sunrise * 1000);
                srD.setFullYear(nowD.getFullYear(), nowD.getMonth(), nowD.getDate());
                
                var ssD = new Date(sunset * 1000);
                ssD.setFullYear(nowD.getFullYear(), nowD.getMonth(), nowD.getDate());
                
                var isDaytime = (Date.now() >= srD.getTime() && Date.now() < ssD.getTime());

                if (timeFilter === 'day' && !isDaytime) return;
                if (timeFilter === 'night' && isDaytime) return;
            }
        }

        var presenceKey = 'presence_' + deviceId;

        // Check both moving motion AND stationary presence (still)
        // If either is true, the room is occupied.
        var hasMotion = linkedState.motion === true || linkedState.motion === 1 || linkedState.motion === '1' || linkedState.motion === 'true';
        var hasStill = linkedState.still === true || linkedState.still === 1 || linkedState.still === '1' || linkedState.still === 'true';
        var isRoomEmpty = (!hasMotion && !hasStill);

        if (isRoomEmpty) {
            // Room is empty; reset enter debounce timer
            delete _presenceEnterTimers[presenceKey];

            // Start or continue tracking no-motion duration
            if (!_presenceTimers[presenceKey]) {
                _presenceTimers[presenceKey] = Date.now();
                
                // Wake up engine precisely when the timeout finishes, plus a small buffer
                setTimeout(function() {
                    if (typeof AutomationEngine !== 'undefined' && AutomationEngine.evaluate) {
                        AutomationEngine.evaluate();
                    }
                }, timeoutMs + 200);
            }

            var elapsed = Date.now() - _presenceTimers[presenceKey];
            if (elapsed >= timeoutMs) {
                // Optimization: Don't fire and suppress switch if blind is already at target
                // ONLY use the actual hardware position, ignore targetPosition as it can be stale
                var blindState = StateStore.get(deviceId) || loadBlindState(deviceId);
                var currentPos = blindState ? blindState.position : null;
                
                if (currentPos === target) {
                    // Already at target based on confirmed hardware position, leave timer active
                    return;
                }

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
            // Motion or stationary presence detected — room is occupied
            delete _presenceTimers[presenceKey]; // Reset empty timer
            
            if (action === 'open_close') {
                // Debounce entering (e.g., must be occupied for a short period like 3 seconds to avoid false radar pings)
                if (!_presenceEnterTimers[presenceKey]) {
                    _presenceEnterTimers[presenceKey] = Date.now();
                    
                    // Wake up engine precisely when the debounce finishes
                    setTimeout(function() {
                        if (typeof AutomationEngine !== 'undefined' && AutomationEngine.evaluate) {
                            AutomationEngine.evaluate();
                        }
                    }, 2200);
                }

                var enterElapsed = Date.now() - _presenceEnterTimers[presenceKey];
                if (enterElapsed >= 2000) { // 2 second debounce
                    var blindStateEnter = StateStore.get(deviceId) || loadBlindState(deviceId);
                    var currentPosEnter = blindStateEnter ? (blindStateEnter.position !== undefined ? blindStateEnter.position : blindStateEnter.targetPosition) : null;
                    
                    if (currentPosEnter !== openTarget) {
                        if (canExecuteRule(deviceId, 'presenceAutoOpen', 2 * 60000)) { // 2 min cooldown to prevent toggling
                            console.info('[Automation] 🚶 Presence Auto Open ' + deviceId + ' -> ' + openTarget + '%');
                            suppressLinkedSwitch(linkedDeviceId);
                            if (typeof MQTTClient !== 'undefined' && MQTTClient.connected) {
                                MQTTClient.publishStepperControl(deviceId, { blindPosition: openTarget });
                            }
                            if (typeof Toast !== 'undefined') Toast.info('Presence detected — blinds opening');
                        }
                    }
                }
            }
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

    // ── Main Loop ───────────────────────────────────────────────

    function _evaluateRules() {
        if (typeof StateStore === 'undefined') return;

        // Read device list — uses the SAME key as the rest of the app
        var savedDevicesStr = localStorage.getItem('zaylo-devices');
        if (!savedDevicesStr) return;

        try {
            var savedDevices = JSON.parse(savedDevicesStr);
            if (!Array.isArray(savedDevices)) return;

            savedDevices.forEach(function (device) {
                var id = (device.id || '').toUpperCase();
                if (!id) return;

                // Zaylo Slide and Blind Devices (Servo)
                if (device.type === 'stepper' || device.type === 'blind') {
                    var saved = loadBlindState(id) || loadBlindState(id.toLowerCase());
                    if (!saved || !saved.rules) return;

                    var rules = saved.rules;
                    var config = saved.config || {};
                    var linked = (saved.linkedDeviceId || '').toUpperCase() || null;

                    // Note: As of Zaylo Slide firmware update, the ESP32 autonomously handles 
                    // ALL automations including time-based AND sensor-based. The firmware 
                    // directly subscribes to the linked device MQTT topic. Client-side rule 
                    // execution is fully disabled to prevent duplicate commands.
                    return;
                }
            });
        } catch (e) {
            console.error('[Automation] Error evaluating rules:', e);
        }
    }

    /**
     * Syncs weather data (sunrise/sunset) from available sources.
     * Priority:
     *   1. MQTT device state (any connected Zaylo Lumibot publishes sunriseTime/sunsetTime)
     *   2. localStorage cache ('zaylo-weather')
     *   3. OpenWeatherMap API (last resort fallback)
     *
     * This avoids redundant API calls since the firmware already fetches weather.
     */
    function fetchWeather() {
        // Only refresh every 60 minutes
        const now = Date.now();
        if (now - _weatherData.lastFetch < 60 * 60 * 1000 && _weatherData.sunrise && _weatherData.sunset) {
            return;
        }

        // ── Priority 1: Read from any connected Zaylo Lumibot via StateStore ──
        if (typeof StateStore !== 'undefined') {
            try {
                var savedDevicesStr = localStorage.getItem('zaylo-devices');
                if (savedDevicesStr) {
                    var devices = JSON.parse(savedDevicesStr);
                    if (Array.isArray(devices)) {
                        for (var i = 0; i < devices.length; i++) {
                            var d = devices[i];
                            // Zaylo Lumibots (type undefined or 'lumibot') publish weather data
                            if (d.type === 'stepper' || d.type === 'blind') continue;
                            var id = (d.id || '').toUpperCase();
                            if (!id) continue;
                            var state = StateStore.get(id);
                            if (state && state.sunriseTime && state.sunsetTime) {
                                _weatherData.sunrise = state.sunriseTime;
                                _weatherData.sunset = state.sunsetTime;
                                _weatherData.lastFetch = now;
                                localStorage.setItem('zaylo-weather', JSON.stringify(_weatherData));
                                console.info('[Automation] 🌤️ Weather synced from device ' + id +
                                    '. Sunrise: ' + new Date(_weatherData.sunrise * 1000).toLocaleTimeString() +
                                    ', Sunset: ' + new Date(_weatherData.sunset * 1000).toLocaleTimeString());
                                return; // Got data, no need to fetch
                            }
                        }
                    }
                }
            } catch (e) {
                // Silently continue to fallbacks
            }
        }

        // ── Priority 2: localStorage cache ──
        try {
            const cachedStr = localStorage.getItem('zaylo-weather');
            if (cachedStr) {
                const cached = JSON.parse(cachedStr);
                if (cached.sunrise && cached.sunset) {
                    _weatherData = cached;
                    _weatherData.lastFetch = now;
                    console.info('[Automation] Using cached weather data.');
                    return;
                }
            }
        } catch (e) {}

        // ── Priority 3: Direct API fetch (last resort) ──
        const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(CITY)}&appid=${WEATHER_API_KEY}&units=metric`;
        
        fetch(url)
            .then(response => {
                if (!response.ok) throw new Error('Weather API returned ' + response.status);
                return response.json();
            })
            .then(data => {
                if (data && data.sys && data.sys.sunrise && data.sys.sunset) {
                    _weatherData.sunrise = data.sys.sunrise;
                    _weatherData.sunset = data.sys.sunset;
                    _weatherData.lastFetch = now;
                    localStorage.setItem('zaylo-weather', JSON.stringify(_weatherData));
                    console.info('[Automation] 🌤️ Weather synced via API (fallback). Sunrise: ' + new Date(_weatherData.sunrise*1000).toLocaleTimeString() + ', Sunset: ' + new Date(_weatherData.sunset*1000).toLocaleTimeString());
                }
            })
            .catch(err => {
                console.warn('[Automation] Failed to fetch weather data from API:', err);
            });
    }

    // ── Public API ──────────────────────────────────────────────

    return {
        init: function () {
            if (_intervalId) clearInterval(_intervalId);

            // Load cached weather on startup
            try {
                const cachedStr = localStorage.getItem('zaylo-weather');
                if (cachedStr) {
                    const cached = JSON.parse(cachedStr);
                    if (cached.sunrise && cached.sunset) {
                        _weatherData = cached;
                    }
                }
            } catch(e) {}

            // Initial run after a brief delay so MQTTClient + StateStore are ready
            setTimeout(() => {
                if (AutomationEngine.hasActiveRules()) fetchWeather();
                _evaluateRules();
            }, 5000);
            
            _intervalId = setInterval(() => {
                if (AutomationEngine.hasActiveRules()) fetchWeather();
                _evaluateRules();
            }, CHECK_INTERVAL_MS);

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
        },

        /**
         * Returns true if any blind/stepper device has at least one active automation rule.
         * Used by StateStore to skip scheduling unnecessary evaluation timers.
         */
        hasActiveRules: function () {
            try {
                var raw = localStorage.getItem('zaylo-devices');
                if (!raw) return false;
                var devices = JSON.parse(raw);
                if (!Array.isArray(devices)) return false;

                for (var i = 0; i < devices.length; i++) {
                    var d = devices[i];
                    if (d.type !== 'blind' && d.type !== 'stepper') continue;
                    var saved = loadBlindState(d.id);
                    if (saved && saved.rules) {
                        var rules = saved.rules;
                        if (rules.sunset || rules.presence || rules.morningOpen ||
                            rules.nightLock || rules.temperature) {
                            return true;
                        }
                    }
                }
            } catch (e) {}
            return false;
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
