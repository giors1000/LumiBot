/**
 * LumiBot - MQTT Communication Module
 * Handles WebSocket connection to broker
 * 
 * High-Reliability Version 6.0
 * - Fixed AMQJS0011E errors with connection guards
 * - Added race condition prevention in all async operations
 * - Proper error logging throughout
 * - Added disconnect() and unsubscribeDevice() methods
 */

// ============================================
// ONE-TIME MIGRATION: Clear old cached broker settings
// This runs once per page load to ensure Ngrok config is used
// ============================================
(function migrateToNgrokConfig() {
    const cachedIP = localStorage.getItem('LumiBot-BrokerIP');
    const cachedPort = localStorage.getItem('LumiBot-BrokerPort');

    // Detect if user has old local network settings cached
    const hasOldLocalIP = cachedIP && (cachedIP.startsWith('192.168.') || cachedIP.startsWith('10.') || cachedIP.startsWith('172.'));
    const hasOldPort = cachedPort && cachedPort === '9001';

    if (hasOldLocalIP || hasOldPort) {
        console.log('[MQTT] 🔄 Migration: Clearing old local broker settings to use Ngrok tunnel');
        localStorage.removeItem('LumiBot-BrokerIP');
        localStorage.removeItem('LumiBot-BrokerPort');
        localStorage.removeItem('LumiBot-BrokerPath');
        console.log('[MQTT] ✅ Migration complete. Using Ngrok: ernesto-heptamerous-lourdes.ngrok-free.dev:443');
    }
})();

const ConnectionState = {
    DISCONNECTED: 'disconnected',
    CONNECTING: 'connecting',
    CONNECTED: 'connected',
    RECONNECTING: 'reconnecting',
    FAILED: 'failed'
};

const MQTTClient = {
    client: null,
    clientId: null,
    connectionState: ConnectionState.DISCONNECTED,
    subscriptions: new Map(),
    deviceStates: new Map(),
    reconnectAttempts: 0,
    maxReconnectAttempts: 15,
    reconnectDelay: 2000,
    reconnectTimer: null,
    connectionMutex: false,
    lastConnectAttempt: 0,
    connectDebounceMs: 3000,
    protocolVersion: 3, // Default to v3 (MQTT 3.1) for max compatibility
    intentionalDisconnect: false,
    _pathFallbackTried: false,  // Track if we've tried '/' path
    _emptyPathTried: false,     // Track if we've tried '' empty path

    callbacks: {
        onConnect: [],
        onDisconnect: [],
        onMessage: [],
        onError: [],
        onStateUpdate: []
    },

    pendingMessages: [],
    maxPendingMessages: 100,
    pendingSubscriptionTimers: [],

    config: {
        // Ngrok Secure Tunnel Configuration
        // Allow runtime override via localStorage for flexibility
        get broker() { return localStorage.getItem('LumiBot-BrokerIP') || 'ernesto-heptamerous-lourdes.ngrok-free.dev'; },
        get port() { return parseInt(localStorage.getItem('LumiBot-BrokerPort')) || 443; },
        // WebSocket path - Ngrok passes through directly, no path needed
        get wsPath() { return localStorage.getItem('LumiBot-BrokerPath') || ''; },
        username: '',
        password: '',
        useSSL: true  // Required for WSS connection via Ngrok
    },

    get connected() {
        return this.client && this.client.isConnected();
    },

    async connect(options = {}) {
        // HTTPS Check
        if (window.location.protocol === 'https:' && !this.config.useSSL && !this.config.broker.includes('localhost')) {
            console.error('[MQTT] Secure Context: Mixed content will block ws://. Use wss://.');
        }

        const PahoLib = (typeof Paho !== 'undefined' && Paho.MQTT) ? Paho.MQTT : (typeof Paho !== 'undefined' ? Paho : null);
        if (!PahoLib) return Promise.reject('Paho missing');

        const now = Date.now();
        if (now - this.lastConnectAttempt < this.connectDebounceMs) return;
        if (this.connectionMutex) return;

        this.connectionMutex = true;
        this.lastConnectAttempt = now;
        this.intentionalDisconnect = false;
        this.config = { ...this.config, ...options };
        this._setConnectionState(ConnectionState.CONNECTING);

        // Generate random Client ID (web_ + random string) for uniqueness
        // Each tab/session gets a unique ID to prevent disconnection conflicts
        const randomStr = Math.random().toString(36).substring(2, 10);
        this.clientId = `web_${randomStr}`;

        // Remove old blocking key if it exists
        localStorage.removeItem('mqtt_client_id');
        console.log(`[MQTT] Client ID: ${this.clientId} (Proto: ${this.protocolVersion})`);

        this._fullCleanup();

        return new Promise((resolve, reject) => {
            try {
                // Log full connection details for debugging
                const wsUrl = `${this.config.useSSL ? 'wss' : 'ws'}://${this.config.broker}:${this.config.port}${this.config.wsPath}`;
                console.log(`[MQTT] Connecting to: ${wsUrl}`);
                console.log(`[MQTT] Client ID: ${this.clientId}, Protocol: MQTT v${this.protocolVersion === 4 ? '3.1.1' : '3.1'}`);

                this.client = new PahoLib.Client(
                    this.config.broker,
                    Number(this.config.port),
                    this.config.wsPath,  // Use configurable path (default: /mqtt)
                    this.clientId
                );
                this.client.onConnectionLost = (r) => this._onConnectionLost(r);
                this.client.onMessageArrived = (m) => this._onMessageArrived(m);

                const opts = {
                    useSSL: this.config.useSSL,
                    timeout: 20,
                    keepAliveInterval: 60,
                    cleanSession: true,
                    mqttVersion: this.protocolVersion,
                    onSuccess: () => {
                        console.log('Connected via Ngrok Secure Tunnel');
                        console.log(`[MQTT] ✅ Connected using MQTT v${this.protocolVersion === 4 ? '3.1.1' : '3.1'}`);
                        console.log(`[MQTT] ✅ Working path: ${this.config.wsPath || '(empty)'}`);

                        // Reset path fallback flags since we found a working configuration
                        this._pathFallbackTried = false;
                        this._emptyPathTried = false;

                        setTimeout(() => {
                            this._setConnectionState(ConnectionState.CONNECTED);
                            this.connectionMutex = false;
                            this.reconnectAttempts = 0;
                            this.callbacks.onConnect.forEach(cb => { try { cb(); } catch (e) { } });
                            this._restoreSubscriptions();
                            this._flushPendingMessages();
                            resolve(true);
                        }, 500);
                    },
                    onFailure: (err) => {
                        console.error(`[MQTT] Connection failed (v${this.protocolVersion}):`, err);
                        this.connectionMutex = false;
                        this._setConnectionState(ConnectionState.DISCONNECTED);

                        if (this.protocolVersion === 4) {
                            console.warn('[MQTT] Code 8 detected on v4, attempting fallback to MQTT 3.1 (v3)...');
                            this.protocolVersion = 3;
                            this.connect(this.config).then(resolve).catch(reject);
                        } else {
                            reject(err);
                        }
                    }
                };

                if (this.config.username?.trim()) {
                    opts.userName = this.config.username;
                    opts.password = this.config.password;
                }

                this.client.connect(opts);
            } catch (e) {
                this.connectionMutex = false;
                reject(e);
            }
        });
    },

    _setConnectionState(newState) {
        if (this.connectionState !== newState) {
            console.log(`[MQTT] State: ${this.connectionState} → ${newState}`);
            this.connectionState = newState;
        }
    },

    _onConnectionLost(response) {
        if (response.errorCode === 0) return;

        const errorMessage = response.errorMessage || 'Unknown error';
        console.warn(`[MQTT] Connection lost (Code: ${response.errorCode}) - ${errorMessage}`);

        this._setConnectionState(ConnectionState.DISCONNECTED);

        // Clear any pending subscription timers immediately
        this._clearPendingSubscriptionTimers();

        this.callbacks.onDisconnect.forEach(cb => { try { cb(response); } catch (e) { } });

        if (response.errorCode === 8) {
            // Code 8 = Socket closed - Common causes:
            // 1. Ngrok tunnel not running
            // 2. Wrong WebSocket path
            // 3. SSL/TLS mismatch
            console.error('[MQTT] Socket closed (Code 8). Possible causes:');
            console.error('  1. Ngrok tunnel not running or expired');
            console.error('  2. Wrong WebSocket path (current:', this.config.wsPath + ')');
            console.error('  3. Broker not accepting WSS connections on port', this.config.port);

            // Try different path fallbacks
            const currentPath = this.config.wsPath;
            if (currentPath === '/mqtt' && !this._pathFallbackTried) {
                console.log('[MQTT] Trying path fallback: "/" instead of "/mqtt"');
                this._pathFallbackTried = true;
                localStorage.setItem('LumiBot-BrokerPath', '/');
            } else if (currentPath === '/' && this._pathFallbackTried && !this._emptyPathTried) {
                console.log('[MQTT] Trying path fallback: "" (empty) instead of "/"');
                this._emptyPathTried = true;
                localStorage.setItem('LumiBot-BrokerPath', '');
            }
        }

        if (!this.intentionalDisconnect) this._attemptReconnect();
    },

    _attemptReconnect() {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        if (this.reconnectAttempts >= this.maxReconnectAttempts) return;

        this._setConnectionState(ConnectionState.RECONNECTING);
        this.reconnectAttempts++;
        const delay = Math.min(this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts), 30000);

        this.reconnectTimer = setTimeout(() => this.connect(this.config), delay);
    },

    publishControl(deviceId, payload) {
        return this._publish(`lumibot/${deviceId.toUpperCase()}/set`, payload);
    },

    publishConfig(deviceId, payload) {
        return this._publish(`lumibot/${deviceId.toUpperCase()}/config/set`, payload);
    },

    _publish(topic, payload) {
        if (this.connected) {
            try {
                const PahoLib = (typeof Paho !== 'undefined' && Paho.MQTT) ? Paho.MQTT : (typeof Paho !== 'undefined' ? Paho : null);
                const message = new PahoLib.Message(JSON.stringify(payload));
                message.destinationName = topic;
                message.qos = 0;
                this.client.send(message);
                return true;
            } catch (e) {
                console.warn('[MQTT] Publish error:', e.message || e);
                return false;
            }
        }

        // Queue message for later if not connected
        if (this.pendingMessages.length < this.maxPendingMessages) {
            this.pendingMessages.push({ topic, payload, ts: Date.now() });
            console.log(`[MQTT] Message queued (${this.pendingMessages.length} pending)`);
        }
        return false;
    },

    _flushPendingMessages() {
        if (!this.connected) {
            console.log('[MQTT] Cannot flush pending messages - not connected');
            return;
        }

        const msgs = [...this.pendingMessages];
        this.pendingMessages = [];

        if (msgs.length > 0) {
            console.log(`[MQTT] Flushing ${msgs.length} pending message(s)`);
        }

        msgs.forEach((m, i) => {
            // Only send messages that are less than 60 seconds old
            if (Date.now() - m.ts < 60000) {
                setTimeout(() => {
                    // Re-check connection before sending
                    if (this.connected) {
                        this._publish(m.topic, m.payload);
                    }
                }, i * 100);
            }
        });
    },

    subscribeDevice(deviceId) {
        const id = deviceId.toUpperCase();
        const topics = {
            state: `lumibot/${id}/state`,
            availability: `lumibot/${id}/availability`
        };
        this.subscriptions.set(id, topics);
        if (this.connected) this._performSubscription(topics);
    },

    /**
     * Unsubscribe from a device's topics and remove from subscription list
     * @param {string} deviceId - The device ID to unsubscribe from
     */
    unsubscribeDevice(deviceId) {
        const id = deviceId.toUpperCase();
        const topics = this.subscriptions.get(id);

        if (topics && this.connected && this.client) {
            try {
                this.client.unsubscribe(topics.state);
                this.client.unsubscribe(topics.availability);
                console.log(`[MQTT] Unsubscribed from device: ${id}`);
            } catch (e) {
                console.warn('[MQTT] Unsubscribe error:', e.message || e);
            }
        }

        this.subscriptions.delete(id);
        this.deviceStates.delete(id);
    },

    _performSubscription(topics) {
        // CRITICAL: Guard against subscribing when not connected
        // This prevents AMQJS0011E "Invalid state not connected" errors
        if (!this.connected) {
            console.warn('[MQTT] Skipping subscription - not connected');
            return;
        }

        try {
            this.client.subscribe(topics.state, { qos: 0 });

            // Use tracked timer for delayed subscription so it can be cancelled on disconnect
            const timerId = setTimeout(() => {
                // Re-check connection before executing delayed subscription
                if (this.connected && this.client) {
                    try {
                        this.client.subscribe(topics.availability, { qos: 0 });
                    } catch (e) {
                        console.warn('[MQTT] Failed to subscribe to availability:', e.message || e);
                    }
                }
            }, 200);
            this.pendingSubscriptionTimers.push(timerId);

            // DEBUG: Subscribe to wildcard to see what is really happening
            if (window.DEBUG && this.connected) {
                this.client.subscribe('lumibot/#', { qos: 0 });
                console.log('[MQTT] 🕵️ DEBUG: Subscribed to lumibot/# wildcard');
            }
        } catch (e) {
            console.warn('[MQTT] Subscription error:', e.message || e);
        }
    },

    _restoreSubscriptions() {
        // Cancel any pending subscription timers from previous attempts
        this._clearPendingSubscriptionTimers();

        let index = 0;
        this.subscriptions.forEach((topics) => {
            const timerId = setTimeout(() => {
                // Re-check connection before attempting subscription
                if (this.connected) {
                    this._performSubscription(topics);
                }
            }, index * 500);
            this.pendingSubscriptionTimers.push(timerId);
            index++;
        });
    },

    _clearPendingSubscriptionTimers() {
        if (this.pendingSubscriptionTimers) {
            this.pendingSubscriptionTimers.forEach(timerId => clearTimeout(timerId));
            this.pendingSubscriptionTimers = [];
        }
    },

    _fullCleanup() {
        // Clear reconnect timer
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

        // Clear any pending subscription timers to prevent AMQJS0011E errors
        this._clearPendingSubscriptionTimers();

        // Disconnect and cleanup old client
        if (this.client) {
            try {
                const old = this.client;
                this.client = null;
                old.onConnectionLost = () => { };
                if (old.isConnected()) old.disconnect();
            } catch (e) {
                console.warn('[MQTT] Cleanup error:', e.message || e);
            }
        }
    },

    /**
     * Intentionally disconnect from the MQTT broker
     * Use this when the user logs out or navigates away
     */
    disconnect() {
        console.log('[MQTT] Intentional disconnect requested');
        this.intentionalDisconnect = true;
        this._fullCleanup();
        this._setConnectionState(ConnectionState.DISCONNECTED);
    },

    on(event, cb) { if (this.callbacks[event]) this.callbacks[event].push(cb); },

    /**
     * Remove a specific callback for an event
     * @param {string} event - Event name (e.g., 'onStateUpdate', 'onConnect')
     * @param {Function} cb - The callback function to remove
     */
    off(event, cb) {
        if (this.callbacks[event]) {
            const idx = this.callbacks[event].indexOf(cb);
            if (idx > -1) {
                this.callbacks[event].splice(idx, 1);
                console.log(`[MQTT] Removed listener for ${event}`);
            }
        }
    },

    clearCallbacks() { Object.keys(this.callbacks).forEach(k => this.callbacks[k] = []); },
    getDeviceState(id) { return this.deviceStates.get(id.toUpperCase()) || null; },
    _onMessageArrived(message) {
        const topic = message.destinationName;
        const payload = message.payloadString;

        // DEBUG: Log everything if debug mode is on
        if (window.DEBUG) {
            console.log(`[MQTT] 📨 Received: ${topic}`, payload.substring(0, 50));
        }

        // CRITICAL: Case-insensitive match to be robust, but prefer upper
        const match = topic.match(/lumibot\/([A-Fa-f0-9]+)\/(state|availability)/i);
        if (!match) return;
        const deviceId = match[1].toUpperCase();
        const type = match[2];
        let state = this.deviceStates.get(deviceId) || {};
        if (type === 'state') {
            try {
                Object.assign(state, JSON.parse(payload), { _online: true });
            } catch (e) {
                console.warn('[MQTT] Failed to parse state payload:', e.message || e);
            }
        } else {
            state._online = (payload === 'online');
        }
        this.deviceStates.set(deviceId, state);
        this.callbacks.onStateUpdate.forEach(cb => { try { cb(deviceId, state); } catch (e) { } });
        this.callbacks.onMessage.forEach(cb => { try { cb(topic, payload); } catch (e) { } });
    }
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { MQTTClient, ConnectionState };
}
