/**
 * Zaylo — Client-Side Automation Engine
 * Version: 3.0.0 (Cleaned)
 * 
 * As of Zaylo Slide firmware V6, the ESP32 handles ALL automations natively
 * (Sunset, Presence, Morning Wake-Up, Night Lock, Heat Protection).
 * 
 * This module is retained for:
 *   - Weather data syncing (sunrise/sunset) for the web UI
 *   - hasActiveRules() check used by StateStore to gate evaluation timers
 *   - Public API contract (init/stop/evaluate) consumed by other modules
 *
 * All client-side rule processing functions have been removed to prevent
 * duplicate commands with the firmware.
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

    // ── Helpers ──────────────────────────────────────────────────

    /**
     * Safely retrieve the device list, respecting home-scoped storage.
     * Uses DeviceList.getAll() if available (which reads the correct
     * 'zaylo-devices-{homeId}' key), otherwise falls back to the
     * unscoped 'zaylo-devices' key for backward compatibility.
     */
    function _getDevices() {
        if (typeof DeviceList !== 'undefined' && typeof DeviceList.getAll === 'function') {
            return DeviceList.getAll();
        }
        try {
            var raw = localStorage.getItem('zaylo-devices');
            return raw ? JSON.parse(raw) : [];
        } catch (e) { return []; }
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

    // ── Main Loop ───────────────────────────────────────────────
    // Stub: firmware handles all automations natively.
    // Kept for the public API contract (init/stop/evaluate).

    function _evaluateRules() {
        if (typeof StateStore === 'undefined') return;

        var savedDevices = _getDevices();
        if (!savedDevices || !Array.isArray(savedDevices) || savedDevices.length === 0) return;

        try {
            savedDevices.forEach(function (device) {
                var id = (device.id || '').toUpperCase();
                if (!id) return;

                // Zaylo Slide and Blind Devices (Servo)
                if (device.type === 'stepper' || device.type === 'blind') {
                    var saved = loadBlindState(id) || loadBlindState(id.toLowerCase());
                    if (!saved || !saved.rules) return;

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
                var devices = _getDevices();
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
        let url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(CITY)}&appid=${WEATHER_API_KEY}&units=metric`;
        
        // Use coordinates if available from ANY device state
        try {
            var devices = _getDevices();
            if (devices && devices.length > 0) {
                for (var d of devices) {
                    var stateRaw = localStorage.getItem('blind-state-' + d.id.toUpperCase()) || localStorage.getItem('blind-state-' + d.id.toLowerCase());
                    if (stateRaw) {
                        var state = JSON.parse(stateRaw);
                        if (state && state.config && state.config.lat && state.config.lon) {
                            url = `https://api.openweathermap.org/data/2.5/weather?lat=${state.config.lat}&lon=${state.config.lon}&appid=${WEATHER_API_KEY}&units=metric`;
                            console.info('[Automation] Using geolocation for weather fetch: ' + state.config.lat + ',' + state.config.lon);
                            break;
                        }
                    }
                }
            }
        } catch (e) {}

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
                var devices = _getDevices();
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
