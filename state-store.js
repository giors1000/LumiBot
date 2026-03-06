/**
 * StateStore - Centralized Reactive Store for Device States
 * 
 * Provides a single source of truth for device states arriving from MQTT.
 * Eliminates race conditions by ensuring all UI components read from the same cached state 
 * and are notified simultaneously when data changes.
 */
const StateStore = (function () {
    const stateCache = {};
    const listeners = {};

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

            // Shallow merge the state (covers most SwitchMote payloads)
            Object.assign(stateCache[deviceId], newState);

            // If there's a nested config or rules, merge them deeply to avoid overwriting pieces missing from partial updates
            if (oldConfig || newState.config) {
                stateCache[deviceId].config = { ...(oldConfig || {}), ...(newState.config || {}) };
            }
            if (oldRules || newState.rules) {
                stateCache[deviceId].rules = { ...(oldRules || {}), ...(newState.rules || {}) };
            }

            // Notify all subscribers
            if (listeners[deviceId]) {
                listeners[deviceId].forEach(callback => callback(stateCache[deviceId]));
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

            // Immediately fire callback if we already have state
            if (stateCache[deviceId]) {
                // Use setTimeout to ensure callback is always asynchronous, preventing UI lockups on registration
                setTimeout(() => callback(stateCache[deviceId]), 0);
            }

            // Return unsubscribe function
            return () => {
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
        }
    };
})();
