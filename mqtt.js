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
    reconnectDelay: 2000,
    reconnectTimer: null,
    connectionMutex: false,
    lastConnectAttempt: 0,
    connectDebounceMs: 3000,
    protocolVersion: 3, // Default to v3 (MQTT 3.1) for max compatibility
    intentionalDisconnect: false,
    _pathCycleComplete: false,  // Track if we've tried all path options
    _pathOverride: null,        // In-memory ws-path fallback being TRIED; only persisted after a successful connect
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

    // ── Broker configuration ────────────────────────────────────────────────
    // Default broker for the current deployment. Every value remains
    // overridable through localStorage during fleet rollout or support.
    //
    // Every value is overridable at runtime via localStorage so a deployed app
    // can be repointed without a code change:
    //   zaylo-BrokerIP / zaylo-BrokerPort / zaylo-BrokerPath
    //   zaylo-BrokerUser / zaylo-BrokerPass
    BROKER_DEFAULTS: {
        broker: 'ernesto-heptamerous-lourdes.ngrok-free.dev',
        port: 443,
        wsPath: '/mqtt', // Mosquitto websockets default
        username: 'lumibot',
        password: 'GN469iors!'
    },

    _defaultBrokerHost() {
        const host = window.location && window.location.hostname ? window.location.hostname : '';
        if (!host || host === '127.0.0.1' || host === '::1') return 'localhost';
        return host;
    },

    config: {
        get broker() { return localStorage.getItem('zaylo-BrokerIP') || MQTTClient.BROKER_DEFAULTS.broker || MQTTClient._defaultBrokerHost(); },
        get port() { return parseInt(localStorage.getItem('zaylo-BrokerPort')) || MQTTClient.BROKER_DEFAULTS.port; },
        get wsPath() { return localStorage.getItem('zaylo-BrokerPath') ?? MQTTClient.BROKER_DEFAULTS.wsPath; },
        // Credentials: connect(options) overrides win, then localStorage, then
        // the defaults. Setters preserve the existing connect({username, password})
        // contract.
        _usernameOverride: undefined,
        _passwordOverride: undefined,
        get username() {
            if (this._usernameOverride !== undefined) return this._usernameOverride;
            return localStorage.getItem('zaylo-BrokerUser') || MQTTClient.BROKER_DEFAULTS.username;
        },
        set username(v) { this._usernameOverride = v; },
        get password() {
            if (this._passwordOverride !== undefined) return this._passwordOverride;
            return localStorage.getItem('zaylo-BrokerPass') || MQTTClient.BROKER_DEFAULTS.password;
        },
        set password(v) { this._passwordOverride = v; },
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
                // Effective ws path: a fallback being trialled (after a code-8
                // socket failure) wins for THIS attempt only; the saved setting is
                // untouched until the fallback actually connects.
                const wsPath = this._pathOverride !== null ? this._pathOverride : this.config.wsPath;

                // Log full connection details for debugging
                const wsUrl = `${this.config.useSSL ? 'wss' : 'ws'}://${this.config.broker}:${this.config.port}${wsPath}`;
                if (window.DEBUG) {
                    console.debug(`[MQTT] Connecting to: ${wsUrl}`);
                    console.debug(`[MQTT] Client ID: ${this.clientId}, Protocol: MQTT v${this.protocolVersion === 4 ? '3.1.1' : '3.1'}`);
                }

                this.client = new PahoLib.Client(
                    this.config.broker,
                    Number(this.config.port),
                    wsPath,  // Use configurable path (default: /mqtt)
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
                            console.debug(`[MQTT] ✅ Connected using MQTT v${this.protocolVersion === 4 ? '3.1.1' : '3.1'}`);
                            console.debug(`[MQTT] ✅ Working path: ${wsPath || '(empty)'}`);
                        }

                        // A trialled path fallback PROVED itself — only now is it
                        // persisted as the saved setting. (Persisting before the
                        // connect succeeded used to let a transient code-8 drop
                        // permanently overwrite a working configuration.)
                        if (this._pathOverride !== null) {
                            try { localStorage.setItem('zaylo-BrokerPath', this._pathOverride); } catch (e) {}
                            this._pathOverride = null;
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
                            this.lastConnectAttempt = 0;
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
            // 1. MQTT websocket service not reachable
            // 2. Wrong WebSocket path
            // 3. SSL/TLS mismatch
            console.error('[MQTT] Socket closed (Code 8). Possible causes:');
            console.error('  1. MQTT websocket service not reachable');
            console.error('  2. Wrong WebSocket path (current:', this.config.wsPath + ')');
            console.error('  3. Broker not accepting WSS connections on port', this.config.port);

            // Cycle through path options: /mqtt -> / -> '' -> /mqtt
            // IN MEMORY ONLY — the fallback is trialled via _pathOverride and the
            // saved zaylo-BrokerPath is rewritten only once a fallback actually
            // connects (see onSuccess). A transient code-8 (e.g. the broker
            // restarting) can no longer corrupt a previously-working setting.
            const currentPath = this._pathOverride !== null ? this._pathOverride : this.config.wsPath;
            const pathCycle = ['/mqtt', '/', ''];
            const currentIndex = pathCycle.indexOf(currentPath);
            const nextIndex = (currentIndex + 1) % pathCycle.length;
            const nextPath = pathCycle[nextIndex];

            // Only try fallback if we haven't cycled through all options
            if (!this._pathCycleComplete) {
                if (currentIndex === pathCycle.length - 1) {
                    // We've tried all paths, mark cycle complete to prevent infinite loop
                    this._pathCycleComplete = true;
                    this._pathOverride = null; // back to the saved setting
                    console.warn('[MQTT] ⚠️ Tried all path options, will stop cycling');
                } else {
                    console.warn(`[MQTT] Trying path fallback: "${nextPath}" instead of "${currentPath}"`);
                    this._pathOverride = nextPath;
                }
            }
        }

        if (!this.intentionalDisconnect) this._attemptReconnect();
    },

    _attemptReconnect() {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

        // NEVER stop retrying. The old 15-attempt cap (~5 minutes of backoff)
        // permanently stranded always-visible clients — e.g. a wall-mounted
        // tablet — as "Offline" after any longer broker outage, because the
        // visibility/focus/online events that would have kicked a reconnect
        // never fire on a screen nobody touches. Backoff still ramps up, but
        // settles at a steady retry every 60 s instead of giving up.
        this._setConnectionState(ConnectionState.RECONNECTING);
        this.reconnectAttempts++;
        const backoff = this.reconnectDelay * Math.pow(1.5, Math.min(this.reconnectAttempts, 10));
        const delay = Math.min(backoff, 60000);

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            Promise.resolve(this.connect(this.config)).catch((err) => {
                console.warn('[MQTT] Reconnect attempt failed:', err?.message || err);
                this.connectionMutex = false;
                this._setConnectionState(ConnectionState.DISCONNECTED);
                if (!this.intentionalDisconnect) this._attemptReconnect();
            });
        }, delay);
    },

    publishControl(deviceId, payload, options = {}) {
        return this._publish(`lumibot/${deviceId.toUpperCase()}/set`, payload, options);
    },

    publishStepperControl(deviceId, payload, options = {}) {
        // Use the shared control topic for blind movement commands. Current
        // StepperMote firmware listens to both this and stepper/set_position;
        // older deployed firmware may only listen here while still publishing
        // position telemetry, which made app actions sit in "pending" forever.
        return this._publish(`lumibot/${deviceId.toUpperCase()}/set`, payload, options);
    },

    publishConfig(deviceId, payload, options = {}) {
        return this._publish(`lumibot/${deviceId.toUpperCase()}/config/set`, payload, options);
    },

    _notifyLocalControlFailure(detail) {
        this.callbacks.onError.forEach(cb => {
            try { cb(detail); } catch (e) { }
        });
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
            try {
                window.dispatchEvent(new CustomEvent('zaylo:local-control-failed', { detail }));
            } catch (e) { }
        }
    },

    _notifyLocalControlSuccess(detail) {
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
            try {
                window.dispatchEvent(new CustomEvent('zaylo:local-control-success', { detail }));
            } catch (e) { }
        }
    },

    _ingestStepperLocalStatus(deviceId, status) {
        if (!deviceId || !status || typeof status !== 'object') return;
        const id = deviceId.toUpperCase();
        const existing = this.deviceStates.get(id) || {};
        const merged = {
            ...existing,
            _online: true,
            _localControl: true,
            _lastLocalStatusAt: Date.now()
        };
        if (status.position !== undefined) {
            merged.position = status.position;
            merged.blindPosition = status.position;
        }
        if (status.blindPosition !== undefined) merged.blindPosition = status.blindPosition;
        if (status.target !== undefined) merged.targetPosition = status.target;
        if (status.targetPosition !== undefined) merged.targetPosition = status.targetPosition;
        if (status.isMoving !== undefined) merged.isMoving = status.isMoving;
        if (status.isCalibrated !== undefined) merged.isCalibrated = status.isCalibrated;
        if (status.calibrationMode !== undefined) merged.calibrationMode = status.calibrationMode;
        if (status.positionConfidence !== undefined) merged.positionConfidence = status.positionConfidence;
        if (status.calibration !== undefined && status.calibration && typeof status.calibration === 'object') {
            merged.calibration = status.calibration;
        }
        const localIp = status.localIp || status.ip || (status.wifi && status.wifi.ip);
        if (localIp) {
            merged.localIp = localIp;
            try { localStorage.setItem(`zaylo-local-ip-${id}`, localIp); } catch (e) {}
        }
        this.deviceStates.set(id, merged);
        if (typeof StateStore !== 'undefined') StateStore.update(id, merged);
        this.callbacks.onStateUpdate.forEach(cb => { try { cb(id, merged); } catch (e) { } });
    },

    // True when this page cannot reach plain-http LAN endpoints: browsers block
    // active mixed content, so an HTTPS-served app's fetch() to
    // http://device.local/... fails unconditionally. Guarding here avoids
    // firing requests that can never succeed (console noise + wasted timers);
    // local HTTP control remains available when the app is served over http
    // (development) — production local control is Matter's job.
    _localHttpBlocked() {
        return typeof window !== 'undefined' && window.location.protocol === 'https:';
    },

    _pollStepperLocalStatus(deviceId, localControlUrl, delayMs = 350, options = {}) {
        if (this._localHttpBlocked()) return;
        const statusUrl = String(localControlUrl || '').replace('/api/local-control', '/api/status');
        if (!statusUrl || statusUrl === localControlUrl) return;
        const startedAt = Number.isFinite(Number(options.startedAt)) ? Number(options.startedAt) : Date.now();
        const maxMs = Number.isFinite(Number(options.maxMs)) ? Number(options.maxMs) : 120000;
        setTimeout(() => {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 1800);
            fetch(statusUrl, { method: 'GET', mode: 'cors', signal: controller.signal })
                .then(async res => {
                    clearTimeout(timeoutId);
                    if (!res.ok) return;
                    const data = await res.json();
                    this._ingestStepperLocalStatus(deviceId, data);
                    if (data && data.isMoving === true && Date.now() - startedAt < maxMs) {
                        this._pollStepperLocalStatus(deviceId, localControlUrl, 1000, { startedAt, maxMs });
                    }
                })
                .catch(() => clearTimeout(timeoutId));
        }, delayMs);
    },

    _publish(topic, payload, options = {}) {
        const opts = options || {};
        const queue = opts.queue !== false && opts.persist !== false;
        const localFallback = opts.localFallback !== false;
        if (this.connected) {
            try {
                const PahoLib = (typeof Paho !== 'undefined' && Paho.MQTT) ? Paho.MQTT : (typeof Paho !== 'undefined' ? Paho : null);
                const message = new PahoLib.Message(JSON.stringify(payload));
                message.destinationName = topic;
                // QoS 1: every app→device publish is a COMMAND or CONFIG — at
                // QoS 0 a single dropped WebSocket frame silently ate it (the UI
                // said "Stopping…" while the blind kept moving). The broker now
                // acks delivery; duplicates are harmless because the firmware
                // applies position/stop/config idempotently.
                message.qos = 1;
                this.client.send(message);
                return true;
            } catch (e) {
                console.warn('[MQTT] Publish error:', e.message || e);
                if (queue) this.pendingMessages.set(topic, { payload, ts: Date.now() });
                if (localFallback) this._triggerLocalHttpFallback(topic, payload);
                return false;
            }
        }

        // Queue message for later if not connected — deduplicates by topic
        // so pressing On→Off while offline only sends the final Off command
        if (queue) {
            this.pendingMessages.set(topic, { payload, ts: Date.now() });
            if (window.DEBUG) console.debug(`[MQTT] Message queued for ${topic} (${this.pendingMessages.size} unique pending)`);
        } else if (window.DEBUG) {
            console.debug(`[MQTT] Message not queued for ${topic} by policy`);
        }
        
        // Trigger Offline Local LAN Fallback Control
        if (localFallback) this._triggerLocalHttpFallback(topic, payload);
        
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
            diagnostics: `lumibot/${id}/diagnostics`
        };
        // config-export / config-import-ack are a Zaylo SWITCH firmware feature;
        // the blinds firmware never publishes them, so subscribing for blind
        // devices was two dead subscriptions per blind on every connect. Only
        // attach them when the device is not a blind (or its type is unknown).
        let isBlindDevice = false;
        try {
            if (typeof DeviceList !== 'undefined' && typeof DeviceList.get === 'function') {
                const d = DeviceList.get(id);
                const t = String((d && d.type) || '').toLowerCase();
                isBlindDevice = (t === 'blind' || t === 'stepper');
            }
        } catch (e) { /* unknown type → keep the topics (safe default) */ }
        if (!isBlindDevice) {
            // FIX Issue #5: follow config-export and import-ack topics so the
            // switch's one-shot backup envelope reaches the UI.
            topics.configExport = `lumibot/${id}/config-export`;
            topics.configImportAck = `lumibot/${id}/config-import-ack`;
        }
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
                Object.values(topics).forEach(topic => {
                    if (topic) {
                        this.client.unsubscribe(topic);
                        this._activeSubscriptions.delete(topic);
                    }
                });
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
            // Diagnostics is command-response style; subscribe up front so a
            // page can request a snapshot without managing its own topic setup.
            if (topics.diagnostics) {
                this.client.subscribe(topics.diagnostics, { qos: 0 });
            }
            // FIX Issue #5: backup/restore topics.
            if (topics.configExport) {
                this.client.subscribe(topics.configExport, { qos: 1 });
            }
            if (topics.configImportAck) {
                this.client.subscribe(topics.configImportAck, { qos: 1 });
            }
            if (window.DEBUG) console.debug(`[MQTT] Subscribed to: ${topics.state}, ${topics.availability}, ${topics.diagnostics || '-'}, ${topics.configExport || '-'}`);
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
        this._pathOverride = null; // restart from the saved path setting
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

    on(event, cb) {
        if (this.callbacks[event]) {
            this.callbacks[event].push(cb);
            return () => this.off(event, cb);
        }
        return () => {};
    },

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
        {
            const diagMatch = topic.match(/lumibot\/([A-Fa-f0-9]+)\/diagnostics/i);
            if (diagMatch) {
                let data = payload;
                try { data = JSON.parse(payload); } catch (e) { /* leave raw */ }
                this.callbacks.onMessage.forEach(cb => { try { cb(topic, data); } catch (e) { } });
                return;
            }
        }

        const match = topic.match(/lumibot\/([A-Fa-f0-9]+)\/(state|availability|wifi-scan|wifi-change-ack)/i);
        if (!match) return;
        const deviceId = match[1].toUpperCase();
        const type = match[2].toLowerCase();

        // Handle Wi-Fi scan and change ACK messages directly by forwarding to callbacks
        if (type === 'wifi-scan' || type === 'wifi-change-ack') {
            this.callbacks.onMessage.forEach(cb => { try { cb(topic, payload); } catch (e) { } });
            return;
        }

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
        } else if (type === 'availability') {
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

    // ── Computed POSIX TZ (any IANA zone) ───────────────────────────────────
    // The hand-verified POSIX_TZ_MAP below only covers 11 zones; everyone else
    // used to fall back to a fixed offset, so their on-device schedules drifted
    // an hour after every DST transition until the app next connected. These
    // helpers derive a full POSIX rule string (std/dst offsets + M-format
    // transition rules) for ANY zone by probing the browser's own IANA database
    // through Intl. The verified map still wins where present.
    _tzFormatterCache: {},
    _posixTzCache: {},

    _getTzOffsetFormatter(tz) {
        if (!this._tzFormatterCache[tz]) {
            this._tzFormatterCache[tz] = new Intl.DateTimeFormat('en-US', {
                timeZone: tz, timeZoneName: 'longOffset',
                year: 'numeric', month: 'numeric', day: 'numeric',
                hour: 'numeric', minute: 'numeric', second: 'numeric'
            });
        }
        return this._tzFormatterCache[tz];
    },

    // UTC offset of `tz` at `date`, in minutes east of UTC. null on failure.
    _offsetMinutesAt(date, tz) {
        try {
            const str = this._getTzOffsetFormatter(tz).format(date);
            const match = str.match(/GMT([+-])(\d{2}):(\d{2})/);
            if (match) {
                const sign = match[1] === '+' ? 1 : -1;
                return sign * (parseInt(match[2], 10) * 60 + parseInt(match[3], 10));
            }
            // Zero offset renders as a bare "GMT" with longOffset.
            return /\bGMT\b/.test(str) ? 0 : null;
        } catch (e) {
            return null;
        }
    },

    // Zone abbreviation (e.g. "EST") when it is a real POSIX-legal name;
    // otherwise null and the caller uses the <±HHMM> quoted-numeric form.
    _tzShortNameAt(date, tz) {
        try {
            const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
                .formatToParts(date);
            const p = parts.find(x => x.type === 'timeZoneName');
            const name = p && p.value;
            return (name && /^[A-Za-z]{3,5}$/.test(name)) ? name : null;
        } catch (e) {
            return null;
        }
    },

    /**
     * Compute a POSIX TZ string (e.g. "CET-1CEST,M3.5.0,M10.5.0/3") for an IANA
     * zone by locating this year's two DST transitions to minute precision.
     * Returns '' when the zone has anything other than a clean two-transition
     * yearly cycle (the firmware then falls back to the plain offset, exactly
     * the previous behaviour — never worse, usually better).
     */
    _computePosixTz(tz) {
        if (!tz) return '';
        const year = new Date().getFullYear();
        const cacheKey = `${tz}|${year}`;
        if (this._posixTzCache[cacheKey] !== undefined) return this._posixTzCache[cacheKey];

        const result = (() => {
            const off = (ms) => this._offsetMinutesAt(new Date(ms), tz);
            // POSIX offset text: west-of-UTC positive (inverted), "h[:mm]".
            const posixOffset = (mins) => {
                const total = -mins;
                const abs = Math.abs(total);
                const h = Math.floor(abs / 60), m = abs % 60;
                return `${total < 0 ? '-' : ''}${h}${m ? ':' + String(m).padStart(2, '0') : ''}`;
            };
            // <±HHMM> quoted-numeric name for zones without an abbreviation —
            // the same convention the IANA database itself uses.
            const numericName = (mins) => {
                const abs = Math.abs(mins);
                const h = String(Math.floor(abs / 60)).padStart(2, '0');
                const m = abs % 60;
                return `<${mins < 0 ? '-' : '+'}${h}${m ? String(m).padStart(2, '0') : ''}>`;
            };

            // Probe the start of each month (UTC noon avoids day-boundary noise).
            const probes = [];
            for (let m = 0; m <= 12; m++) {
                const t = Date.UTC(year, m, 1, 12, 0, 0);
                const o = off(t);
                if (o === null) return '';
                probes.push({ t, o });
            }

            const distinct = [...new Set(probes.map(p => p.o))];
            if (distinct.length === 1) {
                // No DST at all → fixed-offset rule.
                const mins = distinct[0];
                const name = this._tzShortNameAt(new Date(probes[0].t), tz) || numericName(mins);
                return `${name}${posixOffset(mins)}`;
            }
            if (distinct.length !== 2) return ''; // exotic multi-offset zone

            // DST is overwhelmingly "standard + positive shift"; treat the lower
            // offset as standard. (Zones violating that fall back safely.)
            const stdOff = Math.min(distinct[0], distinct[1]);
            const dstOff = Math.max(distinct[0], distinct[1]);

            // Locate each transition: bisect every month-span whose endpoints
            // disagree down to the minute. Expect exactly two per year.
            const transitions = [];
            for (let i = 0; i < 12; i++) {
                if (probes[i].o === probes[i + 1].o) continue;
                let lo = probes[i].t, hi = probes[i + 1].t;
                const loOff = probes[i].o;
                while (hi - lo > 60000) {
                    const mid = lo + Math.floor((hi - lo) / 2 / 60000) * 60000;
                    if (mid <= lo || mid >= hi) break;
                    if (off(mid) === loOff) lo = mid; else hi = mid;
                }
                transitions.push({ at: hi, from: probes[i].o, to: probes[i + 1].o });
            }
            if (transitions.length !== 2) return '';

            const toDst = transitions.find(x => x.to === dstOff && x.from === stdOff);
            const toStd = transitions.find(x => x.to === stdOff && x.from === dstOff);
            if (!toDst || !toStd) return '';

            // Express a transition as POSIX "Mm.w.d[/time]": wall-clock fields in
            // the OLD offset at the instant of change (POSIX semantics).
            const ruleFor = (tr) => {
                const wall = new Date(tr.at + tr.from * 60000);
                const month = wall.getUTCMonth() + 1;
                const dom = wall.getUTCDate();
                const dow = wall.getUTCDay();
                const hh = wall.getUTCHours();
                const mm = wall.getUTCMinutes();
                const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
                // Nth-weekday-of-month; the final 7 days encode as "last" (w=5),
                // matching how real-world rules are written.
                const week = dom > daysInMonth - 7 ? 5 : Math.floor((dom - 1) / 7) + 1;
                const time = (hh === 2 && mm === 0) ? '' :
                    `/${hh}${mm ? ':' + String(mm).padStart(2, '0') : ''}`;
                return `M${month}.${week}.${dow}${time}`;
            };

            const stdName = this._tzShortNameAt(new Date(toStd.at + 86400000), tz) || numericName(stdOff);
            const dstName = this._tzShortNameAt(new Date(toDst.at + 86400000), tz) || numericName(dstOff);
            // Omit the DST offset when it is the POSIX default (std + 1 h).
            const dstOffsetText = (dstOff - stdOff === 60) ? '' : posixOffset(dstOff);

            const posix = `${stdName}${posixOffset(stdOff)}${dstName}${dstOffsetText},${ruleFor(toDst)},${ruleFor(toStd)}`;
            // Firmware tz_posix buffer is 48 bytes (incl. NUL) — refuse anything
            // that would be truncated into an invalid rule.
            return posix.length < 48 ? posix : '';
        })();

        this._posixTzCache[cacheKey] = result;
        return result;
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

        // Verified map first (field-tested strings), then the computed rule for
        // every other IANA zone, then offset-only as the final fallback. This is
        // what gives non-mapped regions DST autonomy on the device instead of a
        // one-hour schedule drift after every transition.
        const lookupPosix = (zone) => {
            if (!zone) return '';
            if (POSIX_TZ_MAP[zone]) return POSIX_TZ_MAP[zone];
            return this._computePosixTz(zone) || '';
        };

        if (savedTz === 'auto') {
            // Use browser's local offset for auto mode
            currentOffsetMinutes = -now.getTimezoneOffset();

            // Try to detect the browser's IANA timezone for the POSIX string
            try {
                const detectedTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
                posixTzString = lookupPosix(detectedTz);
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

            // Verified map first, computed rule for any other zone (see above).
            posixTzString = lookupPosix(savedTz);
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

    _normalizeStepperLocalPayload(payload) {
        if (!payload || typeof payload !== 'object') return null;
        const sessionFields = payload.calibrationSession !== undefined
            ? { calibrationSession: payload.calibrationSession }
            : {};

        if (payload.position !== undefined || payload.blindPosition !== undefined) {
            const raw = payload.position !== undefined ? payload.position : payload.blindPosition;
            const position = Number(raw);
            if (!Number.isFinite(position)) return null;
            return {
                position: Math.max(0, Math.min(100, Math.round(position))),
                commandId: payload.commandId,
                ...sessionFields,
                source: 'pwa-local-fallback'
            };
        }

        if (payload.jog !== undefined || payload.dir !== undefined) {
            const raw = payload.jog !== undefined ? payload.jog : payload.dir;
            const dir = Number(raw);
            if (!Number.isFinite(dir)) return null;
            return {
                dir: dir > 0 ? 1 : (dir < 0 ? -1 : 0),
                commandId: payload.commandId,
                ...sessionFields,
                source: 'pwa-local-fallback'
            };
        }

        if (payload.command === 'stop' || payload.command === 'emergencyStop') {
            return {
                command: payload.command,
                commandId: payload.commandId,
                ...sessionFields,
                source: 'pwa-local-fallback'
            };
        }

        return null;
    },

    _triggerLocalHttpFallback(topic, payload) {
        // Mixed-content contexts can never reach http:// LAN endpoints — skip.
        if (this._localHttpBlocked()) {
            if (window.DEBUG) console.debug('[Local HTTP Fallback] Skipped: https page cannot fetch http LAN endpoints');
            const match = String(topic || '').match(/lumibot\/([A-Fa-f0-9]+)\/(?:stepper\/set_position|set)/i);
            const detail = {
                deviceId: match ? match[1].toUpperCase() : '',
                topic,
                payload,
                reason: 'mixed_content',
                message: 'Secure app cannot use HTTP LAN fallback'
            };
            if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
                try { window.dispatchEvent(new CustomEvent('zaylo:local-control-blocked', { detail })); } catch (e) {}
            }
            return;
        }
        // Match blinds control: lumibot/XXXXXX/stepper/set_position, plus the
        // shared control topic when the payload is clearly a stepper command.
        const stepperMatch = topic.match(/lumibot\/([A-Fa-f0-9]+)\/stepper\/set_position/i);
        // Match Zaylo switch control: lumibot/XXXXXX/set
        const controlMatch = topic.match(/lumibot\/([A-Fa-f0-9]+)\/set/i);
        const stepperControlPayload = this._normalizeStepperLocalPayload(payload);
        
        let deviceId = '';
        let localUrls = [];
        
        let fallbackPayload = payload;

        if (stepperMatch || (controlMatch && stepperControlPayload)) {
            deviceId = (stepperMatch ? stepperMatch[1] : controlMatch[1]).toUpperCase();
            let cachedIp = '';
            try { cachedIp = localStorage.getItem(`zaylo-local-ip-${deviceId}`) || ''; } catch (e) {}
            localUrls = [
                cachedIp ? `http://${cachedIp}/api/local-control` : null,
                `http://StepperMote-${deviceId}.local/api/local-control`
            ].filter(Boolean);
            fallbackPayload = stepperControlPayload || this._normalizeStepperLocalPayload(payload);
            if (!fallbackPayload) {
                if (window.DEBUG) console.debug('[Local HTTP Fallback] Unsupported stepper fallback payload:', payload);
                return;
            }
        } else if (controlMatch) {
            deviceId = controlMatch[1].toUpperCase();
            localUrls = [`http://Zaylo-${deviceId}.local/api/control`];
        } else {
            return; // Not a control topic, skip local fallback
        }
        
        if (window.DEBUG) {
            console.debug(`[Local HTTP Fallback] Attempting direct LAN control of ${deviceId} at ${localUrls.join(', ')}`);
        }

        const tryUrl = (index, lastFailure = null) => {
            const localUrl = localUrls[index];
            if (!localUrl) {
                if (lastFailure) this._notifyLocalControlFailure(lastFailure);
                return;
            }
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 1800); // 1.8s timeout

            fetch(localUrl, {
            method: 'POST',
            mode: 'cors',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(fallbackPayload),
            signal: controller.signal
            })
        .then(async res => {
            clearTimeout(timeoutId);
            if (res.ok) {
                let response = null;
                try { response = await res.clone().json(); } catch (e) { response = null; }
                if (window.DEBUG) {
                    console.info(`[Local HTTP Fallback] ✅ Direct LAN control succeeded for ${deviceId}`);
                }
                if (stepperMatch || stepperControlPayload) {
                    // The device executed the command locally. Surface the result to
                    // the UI (success event + immediate state ingest) and poll
                    // /api/status until the motor stops so the position keeps
                    // tracking while MQTT is unavailable. Also drop queued copies
                    // of this command — replaying it after the broker reconnects
                    // would re-execute a command the blind has already performed.
                    this.pendingMessages.delete(topic);
                    if (typeof BlindCommandQueue !== 'undefined' && typeof BlindCommandQueue.clearExecuted === 'function') {
                        BlindCommandQueue.clearExecuted(deviceId, fallbackPayload);
                    }
                    this._notifyLocalControlSuccess({ deviceId, topic, payload: fallbackPayload, response });
                    if (response) this._ingestStepperLocalStatus(deviceId, response);
                    this._pollStepperLocalStatus(deviceId, localUrl, 350, { maxMs: 120000 });
                }
            } else {
                console.warn(`[Local HTTP Fallback] ⚠️ Direct LAN control failed for ${deviceId}: HTTP ${res.status}`);
                let response = null;
                try {
                    response = await res.clone().json();
                } catch (e) {
                    try { response = { message: await res.text() }; } catch (err) { response = null; }
                }
                if (res.status === 409 && (stepperMatch || stepperControlPayload)) {
                    this.pendingMessages.delete(topic);
                }
                const failure = {
                    deviceId,
                    topic,
                    status: res.status,
                    payload: fallbackPayload,
                    response
                };
                if (index + 1 < localUrls.length) {
                    tryUrl(index + 1, failure);
                } else {
                    this._notifyLocalControlFailure(failure);
                }
            }
        })
        .catch(err => {
            clearTimeout(timeoutId);
            if (window.DEBUG) {
                console.debug(`[Local HTTP Fallback] Device ${deviceId} unreachable on local LAN:`, err.message || err);
            }
            const failure = {
                deviceId,
                topic,
                status: 0,
                payload: fallbackPayload,
                response: { message: err && err.message ? err.message : 'Local device unreachable' }
            };
            tryUrl(index + 1, failure);
        });
        };

        tryUrl(0);
    }
};

// Top-level `const` creates a global LEXICAL binding only — it is NOT a
// window property. Modules that receive `window` as their `global` (e.g.
// blind-sync.js, blind-schema.js) resolve the client as `global.MQTTClient`,
// which is undefined without this explicit export. That gap made every
// blind command/config publish silently fail ("pending" forever) while
// state ingest kept working.
if (typeof window !== 'undefined') {
    window.MQTTClient = MQTTClient;
    window.ConnectionState = ConnectionState;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { MQTTClient, ConnectionState };
}
