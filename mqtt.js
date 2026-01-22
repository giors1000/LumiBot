/**
 * LumiBot - MQTT Communication Module
 * Handles WebSocket connection to HiveMQ broker
 * 
 * Version 2.0 - Added connection state machine for stability
 */

// Connection States
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
    maxReconnectAttempts: 10,
    reconnectDelay: 1000,
    reconnectTimer: null,
    pingInterval: null,
    connectionMutex: false,
    lastConnectAttempt: 0,
    connectDebounceMs: 3000,
    intentionalDisconnect: false,
    healthCheckInterval: null,
    lastMessageTime: 0,
    callbacks: {
        onConnect: [],
        onDisconnect: [],
        onMessage: [],
        onError: [],
        onStateUpdate: []
    },

    // Message queue for messages sent before connection
    pendingMessages: [],
    maxPendingMessages: 50,

    // Default broker config (HiveMQ Cloud)
    config: {
        broker: '1a96ebaca3d94ea882b79cb94e30da40.s1.eu.hivemq.cloud',
        port: 8884, // WebSocket Secure port
        username: 'hivemq.webclient.1769013352629',
        password: '6q>5j9LGmBAwy<J7%;Rf',
        useSSL: true
    },

    /**
     * Get connection status
     */
    get connected() {
        return this.connectionState === ConnectionState.CONNECTED;
    },

    get connecting() {
        return this.connectionState === ConnectionState.CONNECTING ||
            this.connectionState === ConnectionState.RECONNECTING;
    },

    /**
     * Initialize MQTT connection with debouncing and mutex
     */
    async connect(options = {}) {
        // ========== PAHO LIBRARY CHECK ==========
        // Ensure Paho MQTT library is loaded before attempting connection.
        // This prevents cryptic errors when the library isn't available.
        if (typeof Paho === 'undefined' || typeof Paho.MQTT === 'undefined') {
            console.error('[MQTT] Paho library not loaded! Ensure the script tag is included before mqtt.js');
            console.error('[MQTT] Expected: <script src="https://cdnjs.cloudflare.com/ajax/libs/paho-mqtt/1.0.1/mqttws31.min.js"></script>');
            return Promise.reject(new Error('MQTT library not loaded'));
        }

        // Check debounce - prevent rapid reconnection attempts
        const now = Date.now();
        if (now - this.lastConnectAttempt < this.connectDebounceMs) {
            console.log('[MQTT] Connection attempt debounced');
            return Promise.resolve(false);
        }

        // Check mutex - prevent concurrent connection attempts
        if (this.connectionMutex) {
            console.log('[MQTT] Connection mutex locked, skipping');
            return Promise.resolve(false);
        }

        // Check state - prevent connecting if already connected/connecting
        if (this.connectionState === ConnectionState.CONNECTED) {
            console.log('[MQTT] Already connected');
            return Promise.resolve(true);
        }

        if (this.connectionState === ConnectionState.CONNECTING) {
            console.log('[MQTT] Already connecting');
            return Promise.resolve(false);
        }

        // Acquire mutex
        this.connectionMutex = true;
        this.lastConnectAttempt = now;
        this.intentionalDisconnect = false;

        // Merge options with defaults
        this.config = { ...this.config, ...options };
        this._setConnectionState(ConnectionState.CONNECTING);

        // Generate unique client ID with page identifier and high-entropy random
        // This helps detect tab conflicts - each tab will have different page name
        const pageName = window.location.pathname.split('/').pop()?.replace('.html', '') || 'app';
        const timestamp = Date.now().toString(36);
        const random = Math.random().toString(36).substr(2, 8);
        this.clientId = `sm-${pageName}-${timestamp}-${random}`;

        return new Promise((resolve, reject) => {
            try {
                // Build WebSocket URL
                const protocol = this.config.useSSL ? 'wss' : 'ws';
                const url = `${protocol}://${this.config.broker}:${this.config.port}/mqtt`;

                console.log('[MQTT] Connecting to:', url);
                console.log('[MQTT] Client ID:', this.clientId);

                // Full cleanup before creating new client
                this._fullCleanup();

                // Create Paho MQTT client
                this.client = new Paho.MQTT.Client(
                    this.config.broker,
                    Number(this.config.port),
                    '/mqtt',
                    this.clientId
                );

                // Set callbacks
                this.client.onConnectionLost = (response) => {
                    this._onConnectionLost(response);
                };

                this.client.onMessageArrived = (message) => {
                    this._onMessageArrived(message);
                };

                // Connect options - keepAlive set to 60s per HiveMQ recommendations
                const connectOptions = {
                    useSSL: this.config.useSSL,
                    timeout: 10, // Reduced from 30 for faster failure detection
                    keepAliveInterval: 60, // Reduced from 120 to 60 for faster disconnect detection
                    cleanSession: true,
                    mqttVersion: 4,
                    userName: this.config.username,
                    password: this.config.password,
                    onSuccess: () => {
                        console.log('[MQTT] Connected successfully');
                        this._setConnectionState(ConnectionState.CONNECTED);
                        this.connectionMutex = false;
                        this.reconnectAttempts = 0;
                        this.reconnectDelay = 1000;
                        this.lastMessageTime = Date.now();

                        // Start connection health monitoring
                        this._startHealthCheck();

                        // Flush any pending messages
                        this._flushPendingMessages();

                        // Trigger callbacks
                        this.callbacks.onConnect.forEach(cb => {
                            try { cb(); } catch (e) { console.error('[MQTT] Callback error:', e); }
                        });

                        resolve(true);
                    },
                    onFailure: (error) => {
                        console.error('[MQTT] Connection failed:', error);
                        console.error('[MQTT] Error code:', error.errorCode);
                        console.error('[MQTT] Error message:', error.errorMessage);

                        this._setConnectionState(ConnectionState.DISCONNECTED);
                        this.connectionMutex = false;

                        // Check for auth errors - don't retry
                        if (error.errorCode === 4 || error.errorCode === 5) {
                            console.error('[MQTT] Authentication failed, not retrying');
                            this._setConnectionState(ConnectionState.FAILED);
                            this.callbacks.onError.forEach(cb => cb(error));
                            reject(error);
                            return;
                        }

                        this.callbacks.onError.forEach(cb => cb(error));
                        reject(error);
                    }
                };

                console.log('[MQTT] Connecting with keepAlive:', connectOptions.keepAliveInterval);
                this.client.connect(connectOptions);

            } catch (error) {
                console.error('[MQTT] Init error:', error);
                this._setConnectionState(ConnectionState.DISCONNECTED);
                this.connectionMutex = false;
                reject(error);
            }
        });
    },

    /**
     * Set connection state and log
     */
    _setConnectionState(newState) {
        const oldState = this.connectionState;
        this.connectionState = newState;
        console.log(`[MQTT] State: ${oldState} → ${newState}`);
    },

    /**
     * Full cleanup of all resources
     */
    _fullCleanup() {
        // Clear all intervals and timers
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
            this.healthCheckInterval = null;
        }

        // Disconnect existing client if any
        if (this.client) {
            try {
                if (this.client.isConnected && this.client.isConnected()) {
                    this.client.disconnect();
                }
            } catch (e) {
                // Ignore errors during cleanup
            }
            this.client = null;
        }
    },

    /**
     * Start health check interval
     */
    _startHealthCheck() {
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
        }

        // Check connection health every 60 seconds
        this.healthCheckInterval = setInterval(() => {
            if (this.connectionState !== ConnectionState.CONNECTED) {
                return;
            }

            // Check if we've received messages recently (within 5 minutes)
            const now = Date.now();
            const messageAge = now - this.lastMessageTime;

            if (messageAge > 5 * 60 * 1000 && this.subscriptions.size > 0) {
                console.log('[MQTT] No messages received in 5 minutes, connection may be stale');
            }

            // Check if client thinks it's connected
            if (this.client && typeof this.client.isConnected === 'function') {
                if (!this.client.isConnected()) {
                    console.warn('[MQTT] Health check: client reports disconnected');
                    this._handleUnexpectedDisconnect();
                }
            }
        }, 60000);
    },

    /**
     * Handle unexpected disconnect detected by health check
     */
    _handleUnexpectedDisconnect() {
        if (this.connectionState === ConnectionState.RECONNECTING) {
            return; // Already handling
        }

        console.log('[MQTT] Handling unexpected disconnect');
        this._setConnectionState(ConnectionState.DISCONNECTED);
        this.callbacks.onDisconnect.forEach(cb => cb({ errorCode: -1, errorMessage: 'Health check failed' }));
        this._attemptReconnect();
    },

    /**
     * Disconnect from broker intentionally
     */
    disconnect() {
        console.log('[MQTT] Intentional disconnect');
        this.intentionalDisconnect = true;
        this._fullCleanup();
        this._setConnectionState(ConnectionState.DISCONNECTED);
    },

    /**
     * Subscribe to a device's topics
     */
    subscribeDevice(deviceId) {
        if (this.connectionState !== ConnectionState.CONNECTED) {
            console.warn('[MQTT] Not connected, cannot subscribe');
            return false;
        }

        const topics = {
            state: `lumibot/${deviceId}/state`,
            availability: `lumibot/${deviceId}/availability`
        };

        console.log('[MQTT] Subscribing to device:', deviceId);

        try {
            this.client.subscribe(topics.state, {
                qos: 0,
                onSuccess: () => console.log(`[MQTT] Subscribed: ${topics.state}`),
                onFailure: (err) => console.error(`[MQTT] Subscribe failed for ${topics.state}:`, err)
            });

            this.client.subscribe(topics.availability, {
                qos: 0,
                onSuccess: () => console.log(`[MQTT] Subscribed: ${topics.availability}`),
                onFailure: (err) => console.error(`[MQTT] Subscribe failed for ${topics.availability}:`, err)
            });
        } catch (e) {
            console.error('[MQTT] Subscribe error:', e);
            return false;
        }

        this.subscriptions.set(deviceId, topics);
        return true;
    },

    /**
     * Unsubscribe from a device's topics
     */
    unsubscribeDevice(deviceId) {
        const topics = this.subscriptions.get(deviceId);
        if (!topics) return false;

        if (this.connectionState === ConnectionState.CONNECTED && this.client) {
            try {
                this.client.unsubscribe(topics.state);
                this.client.unsubscribe(topics.availability);
            } catch (e) {
                console.warn('[MQTT] Unsubscribe error:', e);
            }
        }

        this.subscriptions.delete(deviceId);
        this.deviceStates.delete(deviceId);

        return true;
    },

    /**
     * Publish control command to device
     */
    publishControl(deviceId, payload) {
        const topic = `lumibot/${deviceId}/set`;
        return this._publish(topic, payload);
    },

    /**
     * Publish config update to device
     */
    publishConfig(deviceId, payload) {
        const topic = `lumibot/${deviceId}/config/set`;
        return this._publish(topic, payload);
    },

    /**
     * Internal publish method - queues messages if not connected
     */
    _publish(topic, payload) {
        // If connected, send immediately
        if (this.connectionState === ConnectionState.CONNECTED && this.client) {
            try {
                const message = new Paho.MQTT.Message(JSON.stringify(payload));
                message.destinationName = topic;
                message.qos = 1;
                message.retained = false;

                this.client.send(message);
                console.log(`[MQTT] Published to ${topic}:`, payload);
                return true;
            } catch (error) {
                console.error('[MQTT] Publish error:', error);
                return false;
            }
        }

        // Not connected - queue the message
        console.log(`[MQTT] Not connected, queuing message for ${topic}`);

        // Add to pending queue (with limit to prevent memory issues)
        if (this.pendingMessages.length < this.maxPendingMessages) {
            this.pendingMessages.push({
                topic,
                payload,
                timestamp: Date.now()
            });
            console.log(`[MQTT] Message queued (${this.pendingMessages.length} pending)`);
        } else {
            console.warn('[MQTT] Pending message queue full, dropping oldest message');
            this.pendingMessages.shift(); // Remove oldest
            this.pendingMessages.push({ topic, payload, timestamp: Date.now() });
        }

        // If not already connecting/reconnecting, trigger reconnect
        if (this.connectionState === ConnectionState.DISCONNECTED ||
            this.connectionState === ConnectionState.FAILED) {
            console.log('[MQTT] Triggering reconnect for queued messages');
            this._attemptReconnect();
        }

        return false; // Queued, not sent yet
    },

    /**
     * Flush pending messages after connection
     */
    _flushPendingMessages() {
        if (this.pendingMessages.length === 0) return;

        console.log(`[MQTT] Flushing ${this.pendingMessages.length} pending messages`);

        const messages = [...this.pendingMessages];
        this.pendingMessages = [];

        // Send each message with a small delay to avoid overwhelming
        let delay = 100;
        messages.forEach((msg, index) => {
            setTimeout(() => {
                // Check if message is still fresh (less than 60 seconds old)
                if (Date.now() - msg.timestamp < 60000) {
                    this._publish(msg.topic, msg.payload);
                } else {
                    console.log(`[MQTT] Dropping stale queued message for ${msg.topic}`);
                }
            }, delay * index);
        });
    },

    /**
     * Wait for connection to be established
     * @param {number} timeoutMs - Maximum time to wait (default 10 seconds)
     * @returns {Promise<boolean>} - Resolves true if connected, false if timeout
     */
    waitForConnection(timeoutMs = 10000) {
        return new Promise((resolve) => {
            // Already connected
            if (this.connectionState === ConnectionState.CONNECTED) {
                resolve(true);
                return;
            }

            const startTime = Date.now();

            const checkConnection = () => {
                if (this.connectionState === ConnectionState.CONNECTED) {
                    resolve(true);
                    return;
                }

                if (Date.now() - startTime > timeoutMs) {
                    console.warn('[MQTT] Wait for connection timed out');
                    resolve(false);
                    return;
                }

                // Check again in 100ms
                setTimeout(checkConnection, 100);
            };

            checkConnection();
        });
    },

    /**
     * Get cached device state
     */
    getDeviceState(deviceId) {
        return this.deviceStates.get(deviceId) || null;
    },

    /**
     * Register callback
     */
    on(event, callback) {
        if (this.callbacks[event]) {
            this.callbacks[event].push(callback);
        }
    },

    /**
     * Remove callback
     */
    off(event, callback) {
        if (this.callbacks[event]) {
            this.callbacks[event] = this.callbacks[event].filter(cb => cb !== callback);
        }
    },

    /**
     * Clear all callbacks for an event (used when page loads to prevent accumulation)
     */
    clearCallbacks(event) {
        if (event && this.callbacks[event]) {
            this.callbacks[event] = [];
        } else if (!event) {
            // Clear all
            this.callbacks.onConnect = [];
            this.callbacks.onDisconnect = [];
            this.callbacks.onMessage = [];
            this.callbacks.onError = [];
            this.callbacks.onStateUpdate = [];
        }
    },

    /**
     * Handle connection lost - with improved logic
     */
    _onConnectionLost(response) {
        console.warn('[MQTT] Connection lost:', response.errorMessage, 'Code:', response.errorCode);

        // Was already handling disconnect
        if (this.connectionState === ConnectionState.DISCONNECTED ||
            this.connectionState === ConnectionState.RECONNECTING) {
            console.log('[MQTT] Already handling disconnect, ignoring duplicate');
            return;
        }

        this._setConnectionState(ConnectionState.DISCONNECTED);

        // Stop health check during disconnect
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
            this.healthCheckInterval = null;
        }

        // Notify callbacks
        this.callbacks.onDisconnect.forEach(cb => {
            try { cb(response); } catch (e) { console.error('[MQTT] Callback error:', e); }
        });

        // Only attempt reconnection if not intentional and not auth error
        if (!this.intentionalDisconnect && response.errorCode !== 0) {
            // Error code 8 is typically a WebSocket close
            if (response.errorCode === 8) {
                console.log('[MQTT] WebSocket closed, will attempt reconnect');
            }
            this._attemptReconnect();
        } else if (response.errorCode === 0) {
            console.log('[MQTT] Normal disconnect, not reconnecting');
        }
    },

    /**
     * Handle incoming message
     */
    _onMessageArrived(message) {
        const topic = message.destinationName;
        const payload = message.payloadString;

        // Update last message time for health check
        this.lastMessageTime = Date.now();

        console.log(`[MQTT] Message on ${topic}`);

        const match = topic.match(/lumibot\/([A-F0-9]+)\/(state|availability)/);
        if (!match) return;

        const deviceId = match[1];
        const topicType = match[2];

        if (topicType === 'state') {
            try {
                const state = JSON.parse(payload);
                // DEBUG: Log FULL state including timer values
                console.log(`[MQTT] 📩 State from ${deviceId}:`, {
                    mode: state.mode,
                    light: state.light,
                    motionTimer: state.motionTimer,
                    timerRemaining: state.timerRemaining,
                    motion: state.motion,
                    still: state.still
                });

                this.deviceStates.set(deviceId, {
                    ...state,
                    _lastUpdate: Date.now(),
                    _online: true
                });

                this.callbacks.onStateUpdate.forEach(cb => {
                    try { cb(deviceId, this.deviceStates.get(deviceId)); } catch (e) { console.error('[MQTT] Callback error:', e); }
                });
            } catch (error) {
                console.error('[MQTT] Failed to parse state:', error);
            }
        } else if (topicType === 'availability') {
            const online = payload === 'online';
            const currentState = this.deviceStates.get(deviceId) || {};

            this.deviceStates.set(deviceId, {
                ...currentState,
                _online: online,
                _lastAvailability: Date.now()
            });

            this.callbacks.onStateUpdate.forEach(cb => {
                try {
                    cb(deviceId, { _online: online, _availabilityChange: true });
                } catch (e) { console.error('[MQTT] Callback error:', e); }
            });
        }

        this.callbacks.onMessage.forEach(cb => {
            try { cb(topic, payload); } catch (e) { console.error('[MQTT] Callback error:', e); }
        });
    },

    /**
     * Attempt reconnection with debouncing and backoff
     */
    _attemptReconnect() {
        // Clear any existing reconnect timer
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        // Check if we've hit max attempts
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error('[MQTT] Max reconnection attempts reached');
            this._setConnectionState(ConnectionState.FAILED);
            this.callbacks.onError.forEach(cb => cb({ errorMessage: 'Max reconnection attempts reached' }));
            return;
        }

        // Check if already reconnecting
        if (this.connectionState === ConnectionState.RECONNECTING) {
            console.log('[MQTT] Already reconnecting, skipping');
            return;
        }

        // Check mutex
        if (this.connectionMutex) {
            console.log('[MQTT] Mutex locked, skipping reconnect');
            return;
        }

        this._setConnectionState(ConnectionState.RECONNECTING);
        this.reconnectAttempts++;

        // Calculate delay with jitter to avoid thundering herd
        const jitter = Math.random() * 1000;
        const delay = this.reconnectDelay + jitter;

        console.log(`[MQTT] Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

        this.reconnectTimer = setTimeout(async () => {
            // Full cleanup before reconnecting
            this._fullCleanup();

            // Small delay to let cleanup complete
            await new Promise(r => setTimeout(r, 100));

            try {
                await this.connect(this.config);

                // NOTE: We don't re-subscribe here anymore.
                // The onConnect callbacks registered by each page (index.js, device.js)
                // will handle subscription. This prevents double-subscription which
                // was causing Code 8 disconnects from HiveMQ.

            } catch (error) {
                console.error('[MQTT] Reconnection failed:', error);
                // Exponential backoff with max cap
                this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 30000);

                // Reset state for next attempt
                this._setConnectionState(ConnectionState.DISCONNECTED);

                // Try again if we haven't hit max
                if (this.reconnectAttempts < this.maxReconnectAttempts) {
                    this._attemptReconnect();
                }
            }
        }, delay);
    },

    /**
     * Check if device is online
     */
    isDeviceOnline(deviceId) {
        const state = this.deviceStates.get(deviceId);
        if (!state) return false;

        const now = Date.now();
        const lastUpdate = state._lastUpdate || 0;
        const stale = now - lastUpdate > 5 * 60 * 1000;

        return state._online && !stale;
    },

    /**
     * Force reconnect (for user-triggered reconnect)
     */
    async forceReconnect() {
        console.log('[MQTT] Force reconnect requested');
        this.intentionalDisconnect = false;
        this.reconnectAttempts = 0;
        this.reconnectDelay = 1000;
        this._fullCleanup();
        this._setConnectionState(ConnectionState.DISCONNECTED);

        // Clear mutex to allow reconnection
        this.connectionMutex = false;

        await new Promise(r => setTimeout(r, 200));
        return this.connect(this.config);
    }
};

// ============================================
// IMPORTANT: Paho MQTT Library Requirement
// ============================================
// The Paho MQTT library MUST be loaded via script tag in HTML BEFORE this file.
// Example: <script src="https://cdnjs.cloudflare.com/ajax/libs/paho-mqtt/1.0.1/mqttws31.min.js"></script>
// 
// Previously this code dynamically loaded Paho, but that caused race conditions
// where connect() was called before Paho finished loading, especially on the
// index page. The HTML script tag ensures synchronous loading.
//
// If Paho is not available at connect time, the connect() method will now
// gracefully fail with a clear error message instead of crashing.

// Export for modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { MQTTClient, ConnectionState };
}

