/**
 * Zaylo - MQTT Communication Module
 * Handles WebSocket connection to broker
 * 
 * High-Reliability Version 6.0
 * - Fixed AMQJS0011E errors with connection guards
 * - Added race condition prevention in all async operations
 * - Proper error logging throughout
 * - Added disconnect() and unsubscribeDevice() methods
 */

// ============================================
// CONFIGURATION
// ============================================
// Default configuration is loaded from localStorage.
// To set a new broker, update localStorage keys: 'zaylo-BrokerIP', 'zaylo-BrokerPort', 'zaylo-BrokerPath'

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
    _activeSubscriptions: new Set(), // Track subscribed topics in current session to prevent double-subscribe floods
    reconnectAttempts: 0,
    maxReconnectAttempts: 15,
    reconnectDelay: 2000,
    reconnectTimer: null,
    connectionMutex: false,
    lastConnectAttempt: 0,
    connectDebounceMs: 3000,
    protocolVersion: 3, // Default to v3 (MQTT 3.1) for max compatibility
    intentionalDisconnect: false,
    _pathCycleComplete: false,  // Track if we've tried all path options
    _disconnectTimer: null,     // Debounce timer for disconnect notifications
    _lastMessageTime: 0,        // Timestamp of last received message (for health checks)
    _visibilityInitialized: false, // Track if visibility listener is set up
    _staleConnectionThreshold: 60000, // 60 seconds without message = potentially stale

    callbacks: {
        onConnect: [],
        onDisconnect: [],
        onMessage: [],
        onError: [],
        onStateUpdate: []
    },

    pendingMessages: new Map(),  // Keyed by topic — latest command per device wins
    pendingSubscriptionTimers: [],

    config: {
        // Ngrok Secure Tunnel Configuration
        // Allow runtime override via localStorage for flexibility
        get broker() { return localStorage.getItem('zaylo-BrokerIP') || 'ernesto-heptamerous-lourdes.ngrok-free.dev'; },
        get port() { return parseInt(localStorage.getItem('zaylo-BrokerPort')) || 443; },
        // WebSocket path - try /mqtt first (Mosquitto standard), fallback to / or empty
        get wsPath() { return localStorage.getItem('zaylo-BrokerPath') ?? '/mqtt'; },
        username: 'lumibot',
        password: 'GN469iors!',
        useSSL: true  // Required for WSS connection
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
        // FIX: Only merge specific credential options, don't spread entire config
        // Spreading would evaluate getters once and lose reactivity to localStorage changes
        if (options.username !== undefined) this.config.username = options.username;
        if (options.password !== undefined) this.config.password = options.password;
        this._setConnectionState(ConnectionState.CONNECTING);

        // Generate random Client ID (web_ + random string) for uniqueness
        // Each tab/session gets a unique ID to prevent disconnection conflicts
        const randomStr = Math.random().toString(36).substring(2, 10);
        this.clientId = `web_${randomStr}`;

        // Remove old blocking key if it exists
        localStorage.removeItem('mqtt_client_id');
        if (window.DEBUG) console.debug(`[MQTT] Client ID: ${this.clientId} (Proto: ${this.protocolVersion})`);

        this._fullCleanup();

        return new Promise((resolve, reject) => {
            try {
                // Log full connection details for debugging
                const wsUrl = `${this.config.useSSL ? 'wss' : 'ws'}://${this.config.broker}:${this.config.port}${this.config.wsPath}`;
                if (window.DEBUG) {
                    console.debug(`[MQTT] Connecting to: ${wsUrl}`);
                    console.debug(`[MQTT] Client ID: ${this.clientId}, Protocol: MQTT v${this.protocolVersion === 4 ? '3.1.1' : '3.1'}`);
                }

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
                        if (window.DEBUG) {
                            console.debug('Connected via Ngrok Secure Tunnel');
                            console.debug(`[MQTT] ✅ Connected using MQTT v${this.protocolVersion === 4 ? '3.1.1' : '3.1'}`);
                            console.debug(`[MQTT] ✅ Working path: ${this.config.wsPath || '(empty)'}`);
                        }

                        // Reset path cycle flag since we found a working configuration
                        this._pathCycleComplete = false;

                        setTimeout(() => {
                            this._setConnectionState(ConnectionState.CONNECTED);
                            this.connectionMutex = false;
                            this.reconnectAttempts = 0;

                            // DEBOUNCE: Check if we reconnected before disconnect notification fired
                            if (this._disconnectTimer) {
                                clearTimeout(this._disconnectTimer);
                                this._disconnectTimer = null;
                                if (window.DEBUG) console.debug('[MQTT] ⚡ Suppressed disconnect notification (quick reconnect)');
                                // Suppress onConnect too since we "never left"
                            } else {
                                this.callbacks.onConnect.forEach(cb => { try { cb(); } catch (e) { } });
                            }

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
            if (window.DEBUG) console.debug(`[MQTT] State: ${this.connectionState} → ${newState}`);
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

        // DEBOUNCE: Delay disconnect notification by 1500ms
        if (this._disconnectTimer) clearTimeout(this._disconnectTimer);
        this._disconnectTimer = setTimeout(() => {
            if (!this.connected) {
                this.callbacks.onDisconnect.forEach(cb => { try { cb(response); } catch (e) { } });
            }
            this._disconnectTimer = null;
        }, 1500);

        if (response.errorCode === 8) {
            // Code 8 = Socket closed - Common causes:
            // 1. Ngrok tunnel not running
            // 2. Wrong WebSocket path
            // 3. SSL/TLS mismatch
            console.error('[MQTT] Socket closed (Code 8). Possible causes:');
            console.error('  1. Ngrok tunnel not running or expired');
            console.error('  2. Wrong WebSocket path (current:', this.config.wsPath + ')');
            console.error('  3. Broker not accepting WSS connections on port', this.config.port);

            // Cycle through path options: /mqtt -> / -> '' -> /mqtt
            const currentPath = this.config.wsPath;
            const pathCycle = ['/mqtt', '/', ''];
            const currentIndex = pathCycle.indexOf(currentPath);
            const nextIndex = (currentIndex + 1) % pathCycle.length;
            const nextPath = pathCycle[nextIndex];

            // Only try fallback if we haven't cycled through all options
            if (!this._pathCycleComplete) {
                if (currentIndex === pathCycle.length - 1) {
                    // We've tried all paths, mark cycle complete to prevent infinite loop
                    this._pathCycleComplete = true;
                    console.warn('[MQTT] ⚠️ Tried all path options, will stop cycling');
                } else {
                    console.warn(`[MQTT] Trying path fallback: "${nextPath}" instead of "${currentPath}"`);
                    localStorage.setItem('zaylo-BrokerPath', nextPath);
                }
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

    publishStepperControl(deviceId, payload) {
        return this._publish(`lumibot/${deviceId.toUpperCase()}/stepper/set_position`, payload);
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

        // Queue message for later if not connected — deduplicates by topic
        // so pressing On→Off while offline only sends the final Off command
        this.pendingMessages.set(topic, { payload, ts: Date.now() });
        if (window.DEBUG) console.debug(`[MQTT] Message queued for ${topic} (${this.pendingMessages.size} unique pending)`);
        
        // Trigger Offline Local LAN Fallback Control
        this._triggerLocalHttpFallback(topic, payload);
        
        return false;
    },

    _flushPendingMessages() {
        if (!this.connected) {
            console.debug('[MQTT] Cannot flush pending messages - not connected');
            return;
        }

        const msgs = [...this.pendingMessages.entries()];
        this.pendingMessages.clear();

        if (msgs.length > 0 && window.DEBUG) {
            console.debug(`[MQTT] Flushing ${msgs.length} deduplicated pending message(s)`);
        }

        msgs.forEach(([topic, m], i) => {
            // Only send messages that are less than 60 seconds old
            if (Date.now() - m.ts < 60000) {
                setTimeout(() => {
                    // Re-check connection before sending
                    if (this.connected) {
                        this._publish(topic, m.payload);
                    }
                }, i * 100);
            }
        });
    },

    subscribeDevice(deviceId) {
        const id = deviceId.toUpperCase();
        const topics = {
            state: `lumibot/${id}/state`,
            availability: `lumibot/${id}/availability`,
            // FIX Issue #5: also follow config-export and import-ack topics
            // so the device's one-shot backup envelope reaches the UI.
            configExport: `lumibot/${id}/config-export`,
            configImportAck: `lumibot/${id}/config-import-ack`
        };
        this.subscriptions.set(id, topics);
        if (this.connected) this._performSubscription(topics);
    },

    // FIX Issue #5 — register/clear a one-shot listener for the next
    // config-export envelope on any subscribed device. Pass null to clear.
    _configExportHandler: null,
    onConfigExport(handler) {
        this._configExportHandler = handler;
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
                // Remove from active tracking so re-subscribe works
                this._activeSubscriptions.delete(topics.state);
                if (window.DEBUG) console.debug(`[MQTT] Unsubscribed from device: ${id}`);
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

        // CRITICAL: Prevent double subscription floods
        // This can happen when onConnect callback subscribes devices AND _restoreSubscriptions also runs
        const subKey = topics.state;
        if (this._activeSubscriptions.has(subKey)) {
            if (window.DEBUG) console.debug(`[MQTT] Skipping duplicate subscription: ${subKey}`);
            return;
        }
        this._activeSubscriptions.add(subKey);

        try {
            // Subscribe to BOTH topics immediately for fast online detection
            // State topic uses QoS 0 (fire and forget - frequent updates)
            this.client.subscribe(topics.state, { qos: 0 });
            // Availability topic uses QoS 1 to ensure retained LWT messages are delivered
            this.client.subscribe(topics.availability, { qos: 1 });
            // FIX Issue #5: backup/restore topics.
            if (topics.configExport) {
                this.client.subscribe(topics.configExport, { qos: 1 });
            }
            if (topics.configImportAck) {
                this.client.subscribe(topics.configImportAck, { qos: 1 });
            }
            if (window.DEBUG) console.debug(`[MQTT] Subscribed to: ${topics.state}, ${topics.availability}, ${topics.configExport || '-'}`);
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

        // DEBOUNCE: Clear disconnect timer
        if (this._disconnectTimer) {
            clearTimeout(this._disconnectTimer);
            this._disconnectTimer = null;
        }

        // Clear any pending subscription timers to prevent AMQJS0011E errors
        this._clearPendingSubscriptionTimers();

        // Clear active subscriptions tracking so reconnection can resubscribe
        this._activeSubscriptions.clear();

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
        if (window.DEBUG) console.debug('[MQTT] Intentional disconnect requested');
        this.intentionalDisconnect = true;
        this._fullCleanup();
        this._setConnectionState(ConnectionState.DISCONNECTED);
    },

    /**
     * Force a fresh reconnection - used when PWA is reopened or connection is stale
     * This bypasses debounce and ensures a clean reconnect
     */
    forceReconnect() {
        console.debug('[MQTT] 🔄 Force reconnect requested (PWA resume or stale connection)');

        // Clear all blocking state
        this.connectionMutex = false;
        this.lastConnectAttempt = 0;
        this.reconnectAttempts = 0;
        this.intentionalDisconnect = false;
        this._pathCycleComplete = false;
        this._lastMessageTime = 0; // Reset to prevent false stale detection after reconnect

        // Full cleanup of existing connection
        this._fullCleanup();
        this._setConnectionState(ConnectionState.DISCONNECTED);

        // Add a small delay to ensure cleanup handles sockets before reconnecting
        setTimeout(() => {
            if (!this.intentionalDisconnect) {
                this.connect(this.config).catch(e => {
                    console.warn('[MQTT] Force reconnect failed, will retry:', e);
                    this._attemptReconnect();
                });
            }
        }, 100);
    },

    /**
     * Check if the connection is healthy
     * Returns true if connection seems healthy, false if it might be stale
     */
    checkConnectionHealth() {
        // If not connected according to state, definitely unhealthy
        if (!this.connected) {
            return false;
        }

        // If we haven't received any messages and we're supposedly connected,
        // the connection might be stale
        if (this._lastMessageTime > 0) {
            const timeSinceLastMessage = Date.now() - this._lastMessageTime;
            if (timeSinceLastMessage > this._staleConnectionThreshold) {
                console.warn(`[MQTT] ⚠️ Connection may be stale (no messages in ${Math.round(timeSinceLastMessage / 1000)}s)`);
                return false;
            }
        }

        return true;
    },

    /**
     * Handle visibility change events for PWA scenarios
     * Called when the page becomes visible again after being hidden
     */
    handleVisibilityChange() {
        if (document.visibilityState === 'visible') {
            if (window.DEBUG) console.debug('[MQTT] 👁️ Page became visible - checking connection health');

            // Reset reconnect attempts since this is a fresh user interaction
            this.reconnectAttempts = 0;

            // Check if we need to reconnect
            if (!this.connected) {
                console.debug('[MQTT] Not connected - initiating reconnect');
                this.forceReconnect();
            } else if (!this.checkConnectionHealth()) {
                if (window.DEBUG) console.debug('[MQTT] Connection appears stale - forcing reconnect');
                this.forceReconnect();
            } else {
                if (window.DEBUG) console.debug('[MQTT] Connection appears healthy');
                // Even if healthy, reset last message time to give benefit of doubt
                // The subscriptions will receive messages soon if truly connected
                this._lastMessageTime = Date.now();
            }
        }
    },

    /**
     * Initialize the visibility change listener for PWA support
     * Should be called once when the app starts
     */
    initVisibilityHandler() {
        if (this._visibilityInitialized) {
            return;
        }

        document.addEventListener('visibilitychange', () => {
            this.handleVisibilityChange();
        });

        // Also handle the 'resume' event for mobile browsers
        window.addEventListener('focus', () => {
            // Slight delay to avoid firing alongside visibilitychange
            setTimeout(() => {
                if (document.visibilityState === 'visible') {
                    if (window.DEBUG) console.debug('[MQTT] 📱 Window focused - verifying connection');
                    if (!this.connected || !this.checkConnectionHealth()) {
                        this.forceReconnect();
                    }
                }
            }, 100);
        });

        // Handle online/offline network events
        window.addEventListener('online', () => {
            if (window.DEBUG) console.debug('[MQTT] 🌐 Network came online - reconnecting');
            this.forceReconnect();
        });

        this._visibilityInitialized = true;
        if (window.DEBUG) console.debug('[MQTT] ✅ Visibility and network handlers initialized');
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
                if (window.DEBUG) console.debug(`[MQTT] Removed listener for ${event}`);
            }
        }
    },

    clearCallbacks() { Object.keys(this.callbacks).forEach(k => this.callbacks[k] = []); },
    getDeviceState(id) { return this.deviceStates.get(id.toUpperCase()) || null; },
    _onMessageArrived(message) {
        // Track last message time for connection health checks
        this._lastMessageTime = Date.now();

        const topic = message.destinationName;
        const payload = message.payloadString;

        // DEBUG: Log everything if debug mode is on
        if (window.DEBUG) {
            console.debug(`[MQTT] 📨 Received: ${topic}`, payload.substring(0, 50));
        }

        // FIX Issue #5 — Route config-export / config-import-ack first;
        // they are not part of the regular state stream.
        {
            const m = topic.match(/lumibot\/([A-Fa-f0-9]+)\/(config-export|config-import-ack)/i);
            if (m) {
                const did = m[1].toUpperCase();
                const kind = m[2];
                try {
                    const data = JSON.parse(payload);
                    if (kind.toLowerCase() === 'config-export') {
                        if (typeof this._configExportHandler === 'function') {
                            try { this._configExportHandler(data); } catch (e) {
                                console.warn('[MQTT] configExport handler threw', e);
                            }
                            // One-shot: clear after dispatch.
                            this._configExportHandler = null;
                        }
                    } else {
                        // import-ack — surface as a toast-style event if anyone is listening.
                        this.callbacks.onMessage.forEach(cb => {
                            try { cb(topic, data); } catch (e) { }
                        });
                    }
                } catch (e) {
                    console.warn('[MQTT] Backup payload parse error:', e.message || e);
                }
                return;
            }
        }

        // CRITICAL: Case-insensitive match to be robust, but prefer upper
        const match = topic.match(/lumibot\/([A-Fa-f0-9]+)\/(state|availability)/i);
        if (!match) return;
        const deviceId = match[1].toUpperCase();
        const type = match[2];
        // Initialize with explicit _online: false to avoid undefined
        let state = this.deviceStates.get(deviceId) || { _online: false };
        if (type === 'state') {
            try {
                Object.assign(state, JSON.parse(payload));
                // CRITICAL FIX: If we receive ANY live (non-retained) state message from a device, it is DEFINITELY online.
                // We ignore retained messages for this check because a retained state might arrive after a retained
                // offline availability message during the initial connection sequence, falsely marking it online.
                if (!message.retained) {
                    state._online = true;
                }
            } catch (e) {
                console.warn('[MQTT] Failed to parse state payload:', e.message || e);
            }
        } else {
            // Availability topic: explicit online/offline status from LWT
            const isOnline = (payload === 'online');
            // Log status change if it's different or meaningful
            if (state._online !== isOnline) {
                if (window.DEBUG) console.info(`[MQTT] ⚠️ Device ${deviceId} is now ${isOnline ? 'ONLINE' : 'OFFLINE'} (LWT/Availability)`);
            }
            state._online = isOnline;
        }

        // Feed into Centralized State Store instead of just local maps
        this.deviceStates.set(deviceId, state);
        if (typeof StateStore !== 'undefined') {
            StateStore.update(deviceId, state);
        }

        this.callbacks.onStateUpdate.forEach(cb => { try { cb(deviceId, state); } catch (e) { } });
        this.callbacks.onMessage.forEach(cb => { try { cb(topic, payload); } catch (e) { } });
    },

    /**
     * Calculate the correct timezone payload for the specified region setting.
     * Uses the browser's Intl.DateTimeFormat to precisely calculate GMT/DST offsets
     * for any timezone, ensuring the ESP32 accurately tracks local time.
     *
     * Returns { gmtOffset, daylightOffset } in SECONDS, matching the firmware's
     * expected format in processConfigCommand() and configTime().
     */
    getTimezonePayload() {
        const savedTz = localStorage.getItem('zaylo-timezone') || 'auto';
        let currentOffsetMinutes;
        let posixTzString = '';
        
        const now = new Date();

        // IANA timezone → POSIX TZ string lookup table
        // POSIX format: STDoffset[DST[offset],start[/time],end[/time]]
        // These encode the exact DST transition rules so the ESP32 can handle
        // DST changes autonomously without needing the PWA to push updates.
        const POSIX_TZ_MAP = {
            'Europe/London':      'GMT0BST,M3.5.0/1,M10.5.0/2',
            'Europe/Paris':       'CET-1CEST,M3.5.0,M10.5.0/3',
            'Europe/Berlin':      'CET-1CEST,M3.5.0,M10.5.0/3',
            'Europe/Athens':      'EET-2EEST,M3.5.0/3,M10.5.0/4',
            'America/New_York':   'EST5EDT,M3.2.0,M11.1.0',
            'America/Chicago':    'CST6CDT,M3.2.0,M11.1.0',
            'America/Denver':     'MST7MDT,M3.2.0,M11.1.0',
            'America/Los_Angeles':'PST8PDT,M3.2.0,M11.1.0',
            'Australia/Sydney':   'AEST-10AEDT,M10.1.0,M4.1.0/3',
            'Asia/Tokyo':         'JST-9',
            'Asia/Dubai':         'GST-4',
        };

        if (savedTz === 'auto') {
            // Use browser's local offset for auto mode
            currentOffsetMinutes = -now.getTimezoneOffset();
            
            // Try to detect the browser's IANA timezone for the POSIX string
            try {
                const detectedTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
                if (detectedTz && POSIX_TZ_MAP[detectedTz]) {
                    posixTzString = POSIX_TZ_MAP[detectedTz];
                }
            } catch (e) {
                // Intl API not available — fall back to offset-only
            }
        } else {
            // Calculate precise offset for a specific IANA timezone
            const getOffsetMinutes = (date, tz) => {
                try {
                    const str = new Intl.DateTimeFormat('en-US', {
                        timeZone: tz,
                        timeZoneName: 'longOffset',
                        year: 'numeric', month: 'numeric', day: 'numeric',
                        hour: 'numeric', minute: 'numeric', second: 'numeric'
                    }).format(date);
                    
                    const match = str.match(/GMT([+-])(\d{2}):(\d{2})/);
                    if (!match) return 0;
                    const sign = match[1] === '+' ? 1 : -1;
                    return sign * (parseInt(match[2], 10) * 60 + parseInt(match[3], 10));
                } catch (e) {
                    // Fallback to local browser offset if the timezone is somehow invalid
                    return -date.getTimezoneOffset();
                }
            };
            
            currentOffsetMinutes = getOffsetMinutes(now, savedTz);
            
            // Look up the POSIX string for this timezone
            if (POSIX_TZ_MAP[savedTz]) {
                posixTzString = POSIX_TZ_MAP[savedTz];
            }
        }

        // Send the total current offset as gmtOffset with dstOffset=0.
        // This provides an immediate "correct right now" value.
        // The POSIX TZ string (if available) provides long-term DST autonomy.
        const result = {
            gmtOffset: currentOffsetMinutes * 60,
            daylightOffset: 0
        };

        // Include POSIX TZ string if we have one — this is the key fix
        // that lets the ESP32 handle DST transitions autonomously
        if (posixTzString) {
            result.tzPosix = posixTzString;
        }

        return result;
    },

    /**
     * Send the current browser timezone to a specific device.
     * Should be called on every MQTT connect to ensure devices stay in sync
     * after DST transitions.
     * @param {string} deviceId - Device ID to sync timezone to
     */
    syncTimezoneToDevice(deviceId) {
        if (!this.connected || !deviceId) return false;
        const tz = this.getTimezonePayload();
        const cfgPayload = {
            gmtOffset: tz.gmtOffset,
            daylightOffset: tz.daylightOffset
        };
        if (tz.tzPosix) cfgPayload.tzPosix = tz.tzPosix;
        return this.publishConfig(deviceId, { config: cfgPayload });
    },

    /**
     * Broadcast the current browser timezone to ALL registered devices.
     * Called from the dashboard (index.js) on MQTT connect.
     */
    syncTimezoneToAllDevices(devices) {
        if (!this.connected || !devices || devices.length === 0) return;
        const tz = this.getTimezonePayload();
        const cfgPayload = {
            gmtOffset: tz.gmtOffset,
            daylightOffset: tz.daylightOffset
        };
        if (tz.tzPosix) cfgPayload.tzPosix = tz.tzPosix;
        const payload = { config: cfgPayload };
        devices.forEach(d => {
            if (d && d.id) {
                this.publishConfig(d.id, payload);
            }
        });
        if (window.DEBUG) {
            console.debug(`[MQTT] Timezone synced to ${devices.length} device(s): GMT${tz.gmtOffset >= 0 ? '+' : ''}${tz.gmtOffset}s, DST=${tz.daylightOffset}s${tz.tzPosix ? ', TZ=' + tz.tzPosix : ''}`);
        }
    },

    _triggerLocalHttpFallback(topic, payload) {
        // Match blinds control: lumibot/XXXXXX/stepper/set_position
        const stepperMatch = topic.match(/lumibot\/([A-Fa-f0-9]+)\/stepper\/set_position/i);
        // Match Zaylo switch control: lumibot/XXXXXX/set
        const switchMatch = topic.match(/lumibot\/([A-Fa-f0-9]+)\/set/i);
        
        let deviceId = '';
        let localUrl = '';
        
        if (stepperMatch) {
            deviceId = stepperMatch[1].toUpperCase();
            localUrl = `http://StepperMote-${deviceId}.local/api/local-control`;
        } else if (switchMatch) {
            deviceId = switchMatch[1].toUpperCase();
            localUrl = `http://Zaylo-${deviceId}.local/api/control`;
        } else {
            return; // Not a control topic, skip local fallback
        }
        
        if (window.DEBUG) {
            console.debug(`[Local HTTP Fallback] Attempting direct LAN control of ${deviceId} at ${localUrl}`);
        }
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 1800); // 1.8s timeout
        
        fetch(localUrl, {
            method: 'POST',
            mode: 'cors',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload),
            signal: controller.signal
        })
        .then(res => {
            clearTimeout(timeoutId);
            if (res.ok) {
                if (window.DEBUG) {
                    console.info(`[Local HTTP Fallback] ✅ Direct LAN control succeeded for ${deviceId}`);
                }
            } else {
                console.warn(`[Local HTTP Fallback] ⚠️ Direct LAN control failed for ${deviceId}: HTTP ${res.status}`);
            }
        })
        .catch(err => {
            clearTimeout(timeoutId);
            if (window.DEBUG) {
                console.debug(`[Local HTTP Fallback] Device ${deviceId} unreachable on local LAN:`, err.message || err);
            }
        });
    }
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { MQTTClient, ConnectionState };
}
