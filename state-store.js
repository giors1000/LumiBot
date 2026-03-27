/**
 * StateStore - Centralized Reactive Store for Device States
 * Version: 2.0.0
 * 
 * Provides a single source of truth for device states arriving from MQTT.
 * Eliminates race conditions by ensuring all UI components read from the same cached state 
 * and are notified simultaneously when data changes.
 * 
 * v2.0: Adds sessionStorage persistence so state survives page refreshes
 *       without waiting for MQTT to re-deliver retained messages.
 */
const StateStore = (function () {
    const STORAGE_KEY = 'zaylo-state-store';
    let stateCache = {};
    const listeners = {};

    // ── Persistence Layer ──────────────────────────────────────
    function _persist() {
        try {
            sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stateCache));
        } catch (e) {
            // sessionStorage full or unavailable — silently degrade
        }
    }

    function _restore() {
        try {
            const saved = sessionStorage.getItem(STORAGE_KEY);
            if (saved) {
                stateCache = JSON.parse(saved);
                console.info('[StateStore] Restored', Object.keys(stateCache).length, 'device state(s) from session');
            }
        } catch (e) {
            stateCache = {};
        }
    }

    // Restore on module load
    _restore();

    return {
        /**
         * Update the state for a specific device.
         * Merges new properties with existing ones.
         * @param {string} deviceId 
         * @param {object} newState 
         */
        update: function (deviceId, newState) {
            if (!deviceId || !newState) return;

            if (!stateCache[deviceId]) {
                stateCache[deviceId] = {};
            }

            // Preserve old nested objects before shallow merge
            const oldConfig = stateCache[deviceId].config ? { ...stateCache[deviceId].config } : null;
            const oldRules = stateCache[deviceId].rules ? { ...stateCache[deviceId].rules } : null;

            // Shallow merge the state (covers most Zaylo payloads)
            Object.assign(stateCache[deviceId], newState);

            // If there's a nested config or rules, merge them deeply to avoid overwriting pieces missing from partial updates
            if (oldConfig || newState.config) {
                stateCache[deviceId].config = { ...(oldConfig || {}), ...(newState.config || {}) };
            }
            if (oldRules || newState.rules) {
                stateCache[deviceId].rules = { ...(oldRules || {}), ...(newState.rules || {}) };
            }

            // Persist to sessionStorage
            _persist();

            // Notify all subscribers
            if (listeners[deviceId]) {
                listeners[deviceId].forEach(callback => callback(stateCache[deviceId]));
            }

            // --- Trigger Automation Engine Reactively ---
            // Guard: Only schedule evaluation if the engine has active rules
            // (Zaylo Slide V6 firmware handles automations natively, so client-side is often a no-op)
            if (typeof AutomationEngine !== 'undefined' && AutomationEngine.evaluate) {
                const shouldEvaluate = typeof AutomationEngine.hasActiveRules === 'function'
                    ? AutomationEngine.hasActiveRules()
                    : true; // Fallback: always evaluate if method doesn't exist

                if (shouldEvaluate && !StateStore._evalTimer) {
                    StateStore._evalTimer = setTimeout(() => {
                        AutomationEngine.evaluate();
                        StateStore._evalTimer = null;
                    }, 100);
                }
            }
        },

        /**
         * Subscribe to state changes for a device.
         * @param {string} deviceId 
         * @param {function} callback - Called with the state object when it updates
         * @returns {function} Unsubscribe function
         */
        subscribe: function (deviceId, callback) {
            if (!deviceId || typeof callback !== 'function') return () => { };

            if (!listeners[deviceId]) {
                listeners[deviceId] = [];
            }
            listeners[deviceId].push(callback);

            let timerId = null;

            // Immediately fire callback if we already have state
            if (stateCache[deviceId]) {
                // Use setTimeout to ensure callback is always asynchronous, preventing UI lockups on registration
                timerId = setTimeout(() => callback(stateCache[deviceId]), 0);
            }

            // Return unsubscribe function
            return () => {
                if (timerId) clearTimeout(timerId);
                listeners[deviceId] = listeners[deviceId].filter(cb => cb !== callback);
            };
        },

        /**
         * Get the current state synchronously.
         * @param {string} deviceId 
         * @returns {object|null}
         */
        get: function (deviceId) {
            return stateCache[deviceId] || null;
        },

        /**
         * Clear all state and listeners (for logout/reset)
         */
        clear: function () {
            Object.keys(stateCache).forEach(k => delete stateCache[k]);
            Object.keys(listeners).forEach(k => delete listeners[k]);
            try { sessionStorage.removeItem(STORAGE_KEY); } catch (e) {}
        }
    };
})();
