/**
 * LumiBot - MQTT Communication Module
 * Handles WebSocket connection to broker
 * 
 * High-Reliability Version 5.0
 */

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
    protocolVersion: 4, // Default to v3.1.1
    intentionalDisconnect: false,

    callbacks: {
        onConnect: [],
        onDisconnect: [],
        onMessage: [],
        onError: [],
        onStateUpdate: []
    },

    pendingMessages: [],
    maxPendingMessages: 100,

    config: {
        broker: '192.168.0.102',
        port: 9001,
        username: '',
        password: '',
        useSSL: false
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

        // Truly Unique ID - Persisted to prevent broker flooding (Code 8)
        let storedId = localStorage.getItem('mqtt_client_id');
        if (!storedId) {
            storedId = 'SWM-' + Math.random().toString(36).substring(2, 7).toUpperCase() + '-' + Date.now().toString(36).toUpperCase();
            localStorage.setItem('mqtt_client_id', storedId);
        }
        this.clientId = storedId;
        console.log(`[MQTT] Client ID: ${this.clientId} (Proto: ${this.protocolVersion})`);

        this._fullCleanup();

        return new Promise((resolve, reject) => {
            try {
                this.client = new PahoLib.Client(this.config.broker, Number(this.config.port), '/', this.clientId);
                this.client.onConnectionLost = (r) => this._onConnectionLost(r);
                this.client.onMessageArrived = (m) => this._onMessageArrived(m);

                const opts = {
                    useSSL: this.config.useSSL,
                    timeout: 20,
                    keepAliveInterval: 60,
                    cleanSession: true,
                    mqttVersion: this.protocolVersion,
                    onSuccess: () => {
                        console.log(`[MQTT] Connected successfully using v${this.protocolVersion}`);
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
        console.warn(`[MQTT] State: connected → disconnected (Code: ${response.errorCode})`);

        this._setConnectionState(ConnectionState.DISCONNECTED);
        this.callbacks.onDisconnect.forEach(cb => { try { cb(response); } catch (e) { } });

        if (response.errorCode === 8) {
            console.error('[MQTT] Broker rejected connection (Code 8).');
            if (this.protocolVersion === 4) {
                this.protocolVersion = 3;
                console.warn('[MQTT] Falling back to v3 due to Code 8');
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
        return this._publish(`lumibot/${deviceId}/set`, payload);
    },

    publishConfig(deviceId, payload) {
        return this._publish(`lumibot/${deviceId}/config/set`, payload);
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
            } catch (e) { return false; }
        }

        if (this.pendingMessages.length < this.maxPendingMessages) {
            this.pendingMessages.push({ topic, payload, ts: Date.now() });
        }
        return false;
    },

    _flushPendingMessages() {
        const msgs = [...this.pendingMessages];
        this.pendingMessages = [];
        msgs.forEach((m, i) => {
            if (Date.now() - m.ts < 60000) {
                setTimeout(() => this._publish(m.topic, m.payload), i * 100);
            }
        });
    },

    subscribeDevice(deviceId) {
        const topics = {
            state: `lumibot/${deviceId}/state`,
            availability: `lumibot/${deviceId}/availability`
        };
        this.subscriptions.set(deviceId, topics);
        if (this.connected) this._performSubscription(topics);
    },

    _performSubscription(topics) {
        try {
            this.client.subscribe(topics.state, { qos: 0 });
            setTimeout(() => this.client.subscribe(topics.availability, { qos: 0 }), 200);
        } catch (e) { }
    },

    _restoreSubscriptions() {
        this.subscriptions.forEach((t, i) => {
            setTimeout(() => this._performSubscription(t), i * 500);
        });
    },

    _fullCleanup() {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        if (this.client) {
            try {
                const old = this.client;
                this.client = null;
                old.onConnectionLost = () => { };
                if (old.isConnected()) old.disconnect();
            } catch (e) { }
        }
    },

    on(event, cb) { if (this.callbacks[event]) this.callbacks[event].push(cb); },
    clearCallbacks() { Object.keys(this.callbacks).forEach(k => this.callbacks[k] = []); },
    getDeviceState(id) { return this.deviceStates.get(id) || null; },
    _onMessageArrived(message) {
        const topic = message.destinationName;
        const payload = message.payloadString;
        const match = topic.match(/lumibot\/([A-F0-9]+)\/(state|availability)/);
        if (!match) return;
        const deviceId = match[1];
        const type = match[2];
        let state = this.deviceStates.get(deviceId) || {};
        if (type === 'state') {
            try {
                Object.assign(state, JSON.parse(payload), { _online: true });
            } catch (e) { }
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
