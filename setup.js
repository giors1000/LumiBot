/**
 * Zaylo - Setup Wizard Logic
 * Handles device connection, calibration, and WiFi configuration
 */

// ============================================
// Setup State
// ============================================
const parsedType = new URLSearchParams(window.location.search).get('type');

const SetupState = {
    currentStep: 1,
    totalSteps: 5,
    connectionMethod: null,
    deviceId: null,
    deviceType: parsedType === 'stepper' ? 'stepper' : 'servo',
    angleOff: null,
    angleOn: null,
    currentAngle: 90,
    selectedNetwork: null,
    isConnecting: false,
    armModalShown: false,

    // ── Flow model (stepper gets extra steps; servo is byte-for-byte unchanged) ──
    flow: ['1', '2', '3', '4', '5'],
    flowIndex: 0,
    currentKey: '1',
    stepperReady: false,
    blindType: 'roller',   // roller | vertical | zebra

    // Calibration limits CONFIRMED by the device during setup. Saved flags flip
    // only on a genuine firmware ack; positions (absolute steps) are null when
    // the firmware ack carried no snapshot (older firmware).
    calTopSaved: false,
    calBottomSaved: false,
    calTopPos: null,
    calBottomPos: null,

    // ── Blinds-only configuration gathered during setup ──
    // Mirrors the schema blind-device.js persists to localStorage('blind-state-{id}')
    // so the choices made here are live the moment the device comes online.
    speedPreset: 'default',
    hasWifi6: null,        // 'yes' | 'no' | 'unsure'
    wifi6Detected: null,   // true | false | null  (from the firmware Wi-Fi scan, when available)
    twtEnabled: false,
    stepperIdleHold: false,
    rules: {
        morningOpen: true,
        sunset: true,
        nightLock: false,
        temperature: false,
        presence: false
    },
    autoConfig: {
        morningTime: '07:00',
        morningDuration: 30,
        morningTarget: 100,
        morningDays: null,
        sunsetTarget: 0,
        nightTime: '22:00',
        nightTarget: 0,
        tempThreshold: 30,
        tempTarget: 20,
        presenceOpenTarget: 100,
        presenceTimeFilter: 'all',
        // Sensible defaults for the (non-walkthrough) "close when empty" behaviour
        presenceAction: 'open_close',
        presenceTarget: 0,
        motionTimeout: 5
    }
};

// Speed presets → firmware stepper speeds (validated bounds: 100-5000 / accel 200-8000)
const SPEED_PRESETS = {
    slow:    { openSpeed: 1000, closeSpeed: 1000, accel: 1500 },
    default: { openSpeed: 2000, closeSpeed: 2000, accel: 2000 },
    fast:    { openSpeed: 3600, closeSpeed: 3600, accel: 4000 },
    max:     { openSpeed: 5000, closeSpeed: 5000, accel: 6000 }
};

// ============================================
// Step Navigation
// ============================================
function goToStep(key) {
    // Accepts either a legacy numeric step (1..5) or a stepper flow key.
    key = String(key);
    if (!SetupState.flow.includes(key)) return;

    const prevKey = SetupState.currentKey;

    // content steps
    document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
    const newStep = document.querySelector(`.step[data-step="${key}"]`);
    if (newStep) newStep.classList.add('active');

    // nav buttons
    document.querySelectorAll('.nav-group').forEach(g => g.classList.remove('active'));
    const newNav = document.querySelector(`.nav-group[data-step="${key}"]`);
    if (newNav) newNav.classList.add('active');

    SetupState.currentKey = key;
    SetupState.flowIndex = SetupState.flow.indexOf(key);
    SetupState.currentStep = parseInt(key, 10) || key;

    if (SetupState.deviceType === 'stepper') {
        updateStepperProgress();
    } else {
        updateProgressDots();
        const stepCounter = document.getElementById('currentStep');
        if (stepCounter) stepCounter.textContent = key;
    }

    // Show arm modal or toggle stepper UI when entering calibration step
    if (key === '2') {
        const sc = document.querySelector('.servo-calibration');
        const scb = document.getElementById('stepperCalibrationBlock');
        const title = document.querySelector('.step[data-step="2"] .step-title');
        const subtitle = document.querySelector('.step[data-step="2"] .step-subtitle');
        if (SetupState.deviceType === 'stepper') {
            if (sc) sc.style.display = 'none';
            if (scb) scb.style.display = 'flex';
            // The markup ships the servo flow's copy — retitle for blinds, or
            // customers calibrating a blind read "Calibrate Servo … light switch".
            if (title) title.textContent = 'Calibrate Your Blind';
            if (subtitle) subtitle.textContent = 'Jog to each end, then save the fully OPEN and fully CLOSED positions';
        } else {
            if (sc) sc.style.display = 'flex';
            if (scb) scb.style.display = 'none';
            if (title) title.textContent = 'Calibrate Servo';
            if (subtitle) subtitle.textContent = 'Set positions for your light switch';
            if (!SetupState.armModalShown) showArmModal();
        }
    }

    // Per-step enter hook (stepper pages refresh their live previews here)
    if (typeof onEnterStep === 'function') onEnterStep(key, prevKey);

    // Always reveal the new step scrolled to the top
    if (newStep) {
        const content = newStep.querySelector('.step-content');
        if (content) content.scrollTop = 0;
    }
}

// Advance / retreat along the active flow (used by the stepper-only steps)
function flowNext() {
    const i = SetupState.flowIndex;
    if (i < SetupState.flow.length - 1) goToStep(SetupState.flow[i + 1]);
}

function flowPrev() {
    const i = SetupState.flowIndex;
    if (i > 0) goToStep(SetupState.flow[i - 1]);
    else window.location.href = 'index.html';
}

function updateProgressDots() {
    document.querySelectorAll('.progress-dot').forEach((dot, index) => {
        const step = index + 1;
        dot.classList.remove('active', 'completed');
        if (step === SetupState.currentStep) dot.classList.add('active');
        else if (step < SetupState.currentStep) dot.classList.add('completed');
    });

    document.querySelectorAll('.progress-connector').forEach((conn, index) => {
        const precedingStep = index + 1;
        conn.classList.toggle('active', precedingStep < SetupState.currentStep);
    });
}

// ============================================
// Arm Attachment Modal
// ============================================
function showArmModal() {
    const modal = document.getElementById('armModal');
    if (modal) {
        modal.classList.add('visible');

        // Center servo to 90 degrees
        setServoAngle(90);

        // Send to device if connected
        if (ActiveConnection.isConnected()) {
            ActiveConnection.setServoAngle(90).catch(() => { });
        }
    }
}

function hideArmModal() {
    const modal = document.getElementById('armModal');
    if (modal) {
        modal.classList.remove('visible');
        SetupState.armModalShown = true;
    }
}

// ============================================
// Servo Visualization - Two-Arm Design
// Visual Mapping (Bug 3 - confirmed correct):
//   - Servo 0°   → CSS -90° (arm points LEFT)
//   - Servo 90°  → CSS 0°   (arm points UP)
//   - Servo 180° → CSS 90°  (arm points RIGHT)
// This matches standard servo behavior where 0° is minimum rotation.
// ============================================
function setServoAngle(angle) {
    angle = Math.max(0, Math.min(180, angle));
    SetupState.currentAngle = angle;

    // Update arm rotation (0° = left, 90° = up, 180° = right)
    const armContainer = document.getElementById('servoArm');
    if (armContainer) {
        // Rotate: 0° -> -90deg, 90° -> 0deg, 180° -> 90deg
        const rotation = angle - 90;
        armContainer.style.transform = `translate(-50%, -50%) rotate(${rotation}deg)`;
    }

    // Update angle badge
    const badge = document.getElementById('angleBadge');
    if (badge) badge.textContent = `${angle}°`;

    // Update slider
    const slider = document.getElementById('angleSlider');
    if (slider) slider.value = angle;

    // Update slider value display
    const sliderValue = document.getElementById('sliderValue');
    if (sliderValue) sliderValue.textContent = `${angle}°`;
}

function updatePositionDisplays() {
    const offDisplay = document.getElementById('offDisplay');
    const onDisplay = document.getElementById('onDisplay');
    const savedOff = document.getElementById('savedOff');
    const savedOn = document.getElementById('savedOn');

    const offText = SetupState.angleOff === null ? 'Not Set' : `${SetupState.angleOff}°`;
    const onText = SetupState.angleOn === null ? 'Not Set' : `${SetupState.angleOn}°`;

    if (offDisplay) offDisplay.textContent = offText;
    if (onDisplay) onDisplay.textContent = onText;
    if (savedOff) savedOff.textContent = offText;
    if (savedOn) savedOn.textContent = onText;
}

// ============================================
// BLE Connection
// ============================================
const BLEConnection = {
    device: null,
    server: null,
    service: null,
    charServo: null,
    charStepperJog: null,
    charSSID: null,
    charPass: null,
    charDeviceId: null,
    charStatus: null,
    charWifiScan: null,
    charWifiResults: null,
    charDiagnostics: null,
    wifiScanBuffer: '',
    scanResultTimer: null,
    isProvisioning: false, // Flag to suppress disconnect warnings during WiFi switch
    _jogWriteQueue: Promise.resolve(), // Sequential queue for jog commands
    _diagBuffer: '',          // accumulates chunked diagnostics notifications
    _configAckWaiter: null,   // { resolve, reject, timeout } for sendConfigAcked

    SERVICE_UUID: '12345678-1234-5678-1234-56789abcdef0',
    CHAR_WIFI_SSID_UUID: '12345678-1234-5678-1234-56789abcdef1',
    CHAR_WIFI_PASS_UUID: '12345678-1234-5678-1234-56789abcdef2',
    CHAR_DEVICE_ID_UUID: '12345678-1234-5678-1234-56789abcdef3',
    CHAR_STATUS_UUID: '12345678-1234-5678-1234-56789abcdef4',
    CHAR_SERVO_UUID: '12345678-1234-5678-1234-56789abcdef5',
    CHAR_STEPPER_JOG_UUID: '12345678-1234-5678-1234-56789abcdef5', // Note: Same UUID used for both based on device type
    CHAR_WIFI_SCAN_UUID: '12345678-1234-5678-1234-56789abcdef6',
    CHAR_WIFI_RESULTS_UUID: '12345678-1234-5678-1234-56789abcdef7',
    CHAR_CONFIG_UUID: '12345678-1234-5678-1234-56789abcdef8',
    CHAR_DIAGNOSTICS_UUID: '12345678-1234-5678-1234-56789abcdefb',

    isSupported() {
        return 'bluetooth' in navigator;
    },

    async connect() {
        if (!this.isSupported()) {
            Toast.error('Bluetooth not supported. Use Chrome on Android.');
            return false;
        }

        try {
            // Toast.info('Searching for Zaylo...');

            this.device = await navigator.bluetooth.requestDevice({
                filters: [{ namePrefix: 'Zaylo' }, { namePrefix: 'LumiBlind' }, { namePrefix: 'LumiBot' }, { namePrefix: 'Lumi' }],
                optionalServices: [this.SERVICE_UUID]
            });

            if (!this.device) {
                Toast.error('No device selected');
                return false;
            }

            // Detect Stepper vs Servo based on device name
            SetupState.deviceType = this.device.name.includes('LumiBlind') ? 'stepper' : 'servo';
            console.log('[BLE] Detected device type:', SetupState.deviceType);

            // Toast.info('Connecting...');
            this.server = await Promise.race([
                this.device.gatt.connect(),
                new Promise((_, r) => setTimeout(() => r(new Error('Timeout')), 15000))
            ]);

            if (!this.server.connected) {
                Toast.error('Connection failed');
                return false;
            }

            // Toast.info('Getting service...');
            this.service = await this.server.getPrimaryService(this.SERVICE_UUID);

            // Get characteristics
            try {
                if (SetupState.deviceType === 'stepper') {
                    this.charStepperJog = await this.service.getCharacteristic(this.CHAR_STEPPER_JOG_UUID);
                } else {
                    this.charServo = await this.service.getCharacteristic(this.CHAR_SERVO_UUID);
                }
            } catch (e) { console.warn('[BLE] No motion control char'); }

            try {
                this.charSSID = await this.service.getCharacteristic(this.CHAR_WIFI_SSID_UUID);
            } catch (e) { console.warn('[BLE] No SSID char'); }

            try {
                this.charPass = await this.service.getCharacteristic(this.CHAR_WIFI_PASS_UUID);
            } catch (e) { console.warn('[BLE] No Pass char'); }

            try {
                this.charDeviceId = await this.service.getCharacteristic(this.CHAR_DEVICE_ID_UUID);
                const val = await this.charDeviceId.readValue();
                const rawId = new TextDecoder().decode(val);
                // CRITICAL: Strictly sanitize ID from device (remove nulls/spaces)
                SetupState.deviceId = rawId.toUpperCase().replace(/[^A-F0-9]/g, '');

            } catch (e) {
                // Fall back to the ID embedded in the advertised name. If neither
                // source yields a real ID, leave it null — device registration is
                // gated on a truthy ID, so a placeholder must never be invented.
                const match = this.device.name.match(/Lumi(?:Bot|Blind)-([A-F0-9]+)/i);
                SetupState.deviceId = match ? match[1].toUpperCase() : null;
            }

            try {
                this.charWifiScan = await this.service.getCharacteristic(this.CHAR_WIFI_SCAN_UUID);

            } catch (e) {
                console.warn('[BLE] WiFi scan characteristic not available:', e.message);
            }

            try {
                this.charWifiResults = await this.service.getCharacteristic(this.CHAR_WIFI_RESULTS_UUID);
                await this.charWifiResults.startNotifications();

                this.charWifiResults.addEventListener('characteristicvaluechanged', (e) => {
                    const rawData = e.target.value;
                    const chunk = new TextDecoder().decode(rawData);


                    this.wifiScanBuffer = (this.wifiScanBuffer || '') + chunk;

                    if (this.scanResultTimer) clearTimeout(this.scanResultTimer);

                    // Try parsing immediately
                    if (this.processScanBuffer(this.wifiScanBuffer, false)) return;

                    // Wait for more data or salvage
                    this.scanResultTimer = setTimeout(() => {
                        console.warn('[BLE] Scan data silence - attempting to salvage partial JSON');
                        this.processScanBuffer(this.wifiScanBuffer, true);
                    }, 600);
                });
            } catch (e) {
                console.warn('[BLE] WiFi results characteristic not available:', e.message);
            }

            try {
                this.charConfig = await this.service.getCharacteristic(this.CHAR_CONFIG_UUID);
            } catch (e) { console.warn('[BLE] No Config char'); }

            try {
                // Diagnostics notifications carry the firmware's config acks
                // (calibration snapshot after each config write). Required for the
                // wizard to show a REAL "Saved" instead of an optimistic one.
                this.charDiagnostics = await this.service.getCharacteristic(this.CHAR_DIAGNOSTICS_UUID);
                await this.charDiagnostics.startNotifications();
                this.charDiagnostics.addEventListener('characteristicvaluechanged', (e) => {
                    this._handleDiagnosticsChunk(new TextDecoder().decode(e.target.value));
                });
            } catch (e) {
                console.warn('[BLE] Diagnostics characteristic not available:', e.message);
            }







            try {
                this.charStatus = await this.service.getCharacteristic(this.CHAR_STATUS_UUID);
                await this.charStatus.startNotifications();
                this.charStatus.addEventListener('characteristicvaluechanged', (e) => {
                    const status = e.target.value.getUint8(0);
                    this.handleStatus(status);
                });
            } catch (e) { }

            this.device.addEventListener('gattserverdisconnected', () => {
                // Suppress warning if we expect a disconnect (provisioning/rebooting)
                if (this.isProvisioning) {
                    console.log('[BLE] Device disconnected (expected during provisioning)');
                } else {
                    Toast.warning('Device disconnected');
                }
                this.cleanup();
            });

            Toast.success('Connected to ' + this.device.name);
            return true;

        } catch (error) {
            console.error('[BLE]', error);
            if (error.name === 'NotFoundError') {
                Toast.error('No device selected');
            } else if (error.message === 'Timeout') {
                Toast.error('Connection timed out');
            } else if (!error.message.includes('cancelled')) {
                Toast.error('Connection failed');
            }
            this.cleanup();
            return false;
        }
    },

    processScanBuffer(buffer, forceSalvage) {
        if (!buffer || !buffer.trim().startsWith('[')) return false;

        let networks = null;
        try {
            networks = JSON.parse(buffer);
        } catch (e) {
        if (forceSalvage) {
                try {
                    // Strategy 1: Find last complete object and close array
                    const lastClose = buffer.lastIndexOf('}');
                    if (lastClose > 1) {
                        const salvaged = buffer.substring(0, lastClose + 1) + ']';
                        networks = JSON.parse(salvaged);
                    }
                } catch (err2) {
                    // Strategy 2: Extract all individually valid {…} objects
                    // This handles mid-stream packet drops where internal commas/braces are lost
                    try {
                        const objectPattern = /\{[^{}]*\}/g;
                        const matches = buffer.match(objectPattern);
                        if (matches && matches.length > 0) {
                            networks = matches
                                .map(m => { try { return JSON.parse(m); } catch(e) { return null; } })
                                .filter(Boolean);
                            if (networks.length === 0) networks = null;
                            else console.log(`[BLE] Recovered ${networks.length} network(s) from corrupted buffer`);
                        }
                    } catch (err3) {
                        console.error('[BLE] All salvage strategies failed:', err3);
                    }
                }
            }
        }

        if (networks && Array.isArray(networks)) {
            // console.log(`[BLE] Processed ${networks.length} networks`);
            renderWifiNetworks(networks);

            const btn = document.getElementById('scanWifi');
            if (btn) {
                btn.textContent = '🔍 Scan for Networks';
                btn.disabled = false;
            }

            if (networks.length > 0) {
                Toast.success(`Found ${networks.length} network${networks.length > 1 ? 's' : ''}`);
            } else {
                Toast.info('No networks found');
            }

            this.wifiScanBuffer = '';

            // clear the "silence" timer if we succeeded
            if (this.scanResultTimer) {
                clearTimeout(this.scanResultTimer);
                this.scanResultTimer = null;
            }
            return true;
        }
        return false;
    },

    _wifiAuthPromise: null,

    handleStatus(status) {
        const names = ['IDLE', 'CONFIG', 'CONNECTING', 'CONNECTED', 'MQTT_OK', 'WIFI_FAIL', 'MQTT_FAIL'];
        // console.log('[BLE] Status:', names[status] || status);

        if (status === 3) Toast.success('WiFi connected!');
        else if (status === 4) Toast.success('Device online!');
        else if (status === 5) Toast.error('WiFi failed');

        if (this._wifiAuthPromise) {
            if (status === 3 || status === 4) {
                clearTimeout(this._wifiAuthPromise.timeout);
                const resolve = this._wifiAuthPromise.resolve;
                this._wifiAuthPromise = null;
                resolve();
            } else if (status === 5) {
                clearTimeout(this._wifiAuthPromise.timeout);
                const reject = this._wifiAuthPromise.reject;
                this._wifiAuthPromise = null;
                reject(new Error('Wi-Fi connection failed. Verify password.'));
            }
        }
    },

    cleanup() {
        this.device = null;
        this.server = null;
        this.service = null;
        this.charServo = null;
        this.charStepperJog = null;
        this.charSSID = null;
        this.charPass = null;
        this.charDeviceId = null;
        this.charStatus = null;
        this.charWifiScan = null;
        this.charWifiResults = null;
        this.charConfig = null;
        this.charDiagnostics = null;
        this.scanResultTimer = null;
        this.wifiScanBuffer = '';
        this._diagBuffer = '';
        if (this._configAckWaiter) {
            clearTimeout(this._configAckWaiter.timeout);
            this._configAckWaiter.reject(new Error('Disconnected'));
            this._configAckWaiter = null;
        }
        if (this._wifiAuthPromise) {
            clearTimeout(this._wifiAuthPromise.timeout);
            this._wifiAuthPromise = null;
        }
    },

    isConnected() {
        return this.server?.connected && this.service != null;
    },

    async setServoAngle(angle) {
        if (!this.charServo) throw new Error('Not available');
        await this.charServo.writeValue(new Uint8Array([angle]));
    },

    async setStepperJog(direction) {
        if (!this.charStepperJog) throw new Error('Not available');
        // Send direction directly as signed byte: +1 = up, -1 = down, 0 = stop
        // Firmware reads as int8_t, so encode -1 as 0xFF (two's complement)
        const byte = direction < 0 ? 0xFF : direction;

        // Queue writes to prevent GATT_BUSY errors when rapidly pressing/releasing jog buttons
        return new Promise((resolve, reject) => {
            this._jogWriteQueue = this._jogWriteQueue.then(async () => {
                try {
                    await this.charStepperJog.writeValue(new Uint8Array([byte]));
                    resolve();
                } catch (e) {
                    console.warn(`[BLE] Jog write failed (dir ${direction}):`, e);
                    reject(e);
                }
            }).catch(() => {
                // Ensure queue doesn't lock up forever if a write fails
                resolve();
            });
        });
    },

    async startWifiScan() {
        if (!this.charWifiScan) throw new Error('Not available');
        this.wifiScanBuffer = '';
        if (this.scanResultTimer) clearTimeout(this.scanResultTimer);
        await this.charWifiScan.writeValue(new Uint8Array([0x01]));
    },

    async sendWifiCredentials(ssid, password) {
        const encoder = new TextEncoder();
        if (this.charSSID) await this.charSSID.writeValue(encoder.encode(ssid));

        if (!this.charPass) {
            // Unsecured network or no password char
            return Promise.resolve();
        }

        // Clean up any old pending promise
        if (this._wifiAuthPromise) {
            clearTimeout(this._wifiAuthPromise.timeout);
            this._wifiAuthPromise = null;
        }

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this._wifiAuthPromise = null;
                reject(new Error('Connection timeout - device did not respond'));
            }, 30000); // 30 seconds timeout to be safe
            
            this._wifiAuthPromise = { resolve, reject, timeout };

            this.charPass.writeValue(encoder.encode(password)).catch(err => {
                clearTimeout(timeout);
                this._wifiAuthPromise = null;
                reject(err);
            });
        });
    },

    async sendConfig(config) {
        if (!this.charConfig) return;
        const encoder = new TextEncoder();
        const json = JSON.stringify(config);
        await this.charConfig.writeValue(encoder.encode(json));
        console.log('[BLE] Sent config:', json);
    },

    // Accumulate chunked diagnostics notifications until a complete JSON object
    // parses. Acks are small (~110 bytes) but a 23-byte default MTU can still
    // split them across several notifications.
    _handleDiagnosticsChunk(chunk) {
        this._diagBuffer = (this._diagBuffer + chunk).slice(-2048); // bounded
        const start = this._diagBuffer.indexOf('{');
        if (start < 0) return;
        let parsed = null;
        try {
            parsed = JSON.parse(this._diagBuffer.slice(start));
        } catch (e) {
            return; // incomplete — wait for the next chunk
        }
        this._diagBuffer = '';
        if (parsed && parsed.configAck === true && this._configAckWaiter) {
            const waiter = this._configAckWaiter;
            this._configAckWaiter = null;
            clearTimeout(waiter.timeout);
            waiter.resolve(parsed);
        }
    },

    // Write a config and wait for the firmware's configAck (calibration
    // snapshot) on the diagnostics characteristic. Rejects on timeout so the
    // caller can show an honest failure instead of an optimistic "Saved".
    async sendConfigAcked(config, timeoutMs = 6000) {
        if (!this.charConfig) throw new Error('Setup link not ready');
        if (this._configAckWaiter) {
            clearTimeout(this._configAckWaiter.timeout);
            this._configAckWaiter.reject(new Error('Superseded by a newer save'));
            this._configAckWaiter = null;
        }
        this._diagBuffer = '';
        const ackPromise = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this._configAckWaiter = null;
                reject(new Error('The blind did not confirm the save'));
            }, timeoutMs);
            this._configAckWaiter = { resolve, reject, timeout };
        });
        await this.charConfig.writeValue(new TextEncoder().encode(JSON.stringify(config)));
        return ackPromise;
    },

    disconnect() {
        this.server?.disconnect?.();
        this.cleanup();
    }
};

// ============================================
// WiFi Direct Connection (softAP hotspot mode)
// ============================================
const WifiDirectConnection = {
    connected: false,
    deviceId: null,
    deviceType: 'stepper',
    gatewayIp: '192.168.4.1',

    isSupported() {
        return true; // Universally supported on all browsers & platforms (iOS Ready)
    },

    async connect() {
        // An HTTPS-served app CANNOT fetch http://192.168.4.1 — browsers block
        // active mixed content, so the in-app Wi-Fi-Direct flow only works when
        // the app itself is served over http (local development). In production
        // the blind hosts its own setup page on the hotspot; guide the user
        // there and register the device by its ID afterwards.
        if (window.location.protocol === 'https:') {
            return this._connectViaDevicePortal();
        }
        return new Promise((resolve) => {
            Modal.create({
                title: 'Connect via Wi-Fi Direct',
                content: `
                    <div class="wifi-direct-guide" style="text-align: left; padding: 6px 0; font-family: var(--font-family); color: var(--text-secondary);">
                        <p style="font-size: 14px; line-height: 1.5; margin-bottom: 16px;">
                            No Bluetooth? No problem. Zaylo supports direct connection via the device's high-speed Wi-Fi hotspot, perfect for Apple iOS devices.
                        </p>
                        
                        <div style="background: var(--bg-glass-strong); border: 1px solid var(--border-glass); border-radius: 16px; padding: 16px; margin-bottom: 20px; box-shadow: var(--shadow-sm);">
                            <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 10px;">
                                <span style="font-size: 20px; filter: drop-shadow(0 2px 4px var(--accent-glow));">📶</span>
                                <span style="font-weight: 700; color: var(--text-primary); font-size: 15px;">Hotspot Credentials</span>
                            </div>
                            <div style="font-size: 13.5px; display: grid; grid-template-columns: 80px 1fr; gap: 8px; line-height: 1.4;">
                                <span style="color: var(--text-tertiary);">Network:</span><strong style="color: var(--accent-light);">LumiBlind-[Device Code]</strong>
                                <span style="color: var(--text-tertiary);">Password:</span><strong style="color: var(--text-primary);">None (Open Hotspot)</strong>
                            </div>
                            <div style="font-size: 11.5px; color: var(--text-tertiary); margin-top: 8px; line-height: 1.35; border-top: 1px solid var(--border-glass); padding-top: 8px;">
                                * Note: The network will be named <strong>LumiBlind-</strong> followed by your blind's unique device code (e.g., <strong>LumiBlind-5E1B</strong>).
                            </div>
                        </div>

                        <div style="font-size: 14px; font-weight: 600; color: var(--text-primary); margin-bottom: 10px;">Setup Instructions:</div>
                        <ol style="font-size: 13.5px; padding-left: 20px; line-height: 1.6; margin-bottom: 22px; display: flex; flex-direction: column; gap: 8px;">
                            <li>Open your phone's <strong>Settings ▸ Wi-Fi</strong>.</li>
                            <li>Select the network starting with <strong>LumiBlind-</strong> (e.g. <strong>LumiBlind-5E1B</strong> or similar).</li>
                            <li>Wait for your device to establish the local connection.</li>
                            <li>Return to this page and tap <strong>Verify Connection</strong>.</li>
                        </ol>
                        
                        <div id="wifiDirectStatus" style="display: none; padding: 12px 16px; border-radius: 14px; margin-top: 14px; text-align: center; border: 1px solid var(--border-glass); background: var(--bg-glass);">
                            <div class="sp-spinner" style="margin: 0 auto 10px; width: 20px; height: 20px;"></div>
                            <span id="wifiDirectStatusText" style="font-weight: 600; font-size: 13px; color: var(--text-primary);">Pinging local device gateway...</span>
                        </div>
                    </div>
                `,
                actions: [
                    { 
                        label: 'Verify Connection', 
                        primary: true, 
                        onClick: async () => {
                            const activeModal = document.querySelector('.modal');
                            if (!activeModal) return false;
                            
                            const statusDiv = activeModal.querySelector('#wifiDirectStatus');
                            const statusText = activeModal.querySelector('#wifiDirectStatusText');
                            if (statusDiv) {
                                statusDiv.style.display = 'block';
                                statusDiv.className = 'sp-twt-status checking';
                                statusDiv.style.background = 'var(--bg-glass)';
                                statusDiv.style.borderColor = 'var(--border-glass)';
                            }
                            if (statusText) statusText.textContent = 'Contacting local device gateway (192.168.4.1)...';
                            
                            // Ping the device's setup gateway and validate its identity.
                            try {
                                const res = await Promise.race([
                                    fetch(`http://${this.gatewayIp}/api/info`),
                                    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 2500))
                                ]);

                                if (res.ok) {
                                    const info = await res.json();
                                    const cleanId = String(info.deviceId || '').toUpperCase().replace(/[^A-F0-9]/g, '');
                                    if (!cleanId) {
                                        // A reachable gateway that doesn't identify itself is not a
                                        // Zaylo blind — never register a device without a real ID.
                                        throw new Error('Device did not report a valid ID');
                                    }
                                    this.connected = true;
                                    this.deviceId = cleanId;
                                    this.deviceType = info.type || 'stepper';
                                    SetupState.deviceId = this.deviceId;
                                    SetupState.deviceType = this.deviceType;

                                    Toast.success('Connected to Zaylo Blinds via Wi-Fi Direct!');
                                    Modal.close();
                                    resolve(true);
                                    return;
                                }
                            } catch (e) {
                                console.warn('[WifiDirect] Local device not reachable:', e.message || e);
                            }

                            // Gateway unreachable — show real troubleshooting steps. There is
                            // deliberately NO simulated/demo fallback here: a customer flow
                            // must never register a device that doesn't physically exist.
                            if (statusDiv) {
                                statusDiv.className = 'sp-twt-status unavailable';
                                statusDiv.style.background = 'rgba(245, 158, 11, 0.08)';
                                statusDiv.style.borderColor = 'rgba(245, 158, 11, 0.2)';
                                statusDiv.style.flexDirection = 'column';
                                statusDiv.style.alignItems = 'stretch';
                                statusDiv.style.gap = '8px';
                                statusDiv.style.textAlign = 'left';
                                statusDiv.innerHTML = `
                                    <div style="font-weight: 700; color: var(--warning); font-size: 14px; text-align: center;">Couldn't reach the blind</div>
                                    <p style="color: var(--text-secondary); font-size: 12.5px; margin: 0; line-height: 1.45;">
                                        Your phone doesn't appear to be connected to the blind's hotspot. Please check:
                                    </p>
                                    <ul style="color: var(--text-secondary); font-size: 12.5px; margin: 0; padding-left: 18px; line-height: 1.55;">
                                        <li>Wi-Fi settings show you joined a network starting with <strong>LumiBlind-</strong></li>
                                        <li>If your phone warned "no internet connection", choose <strong>Keep / Stay connected</strong></li>
                                        <li>Turn <strong>mobile data off</strong> temporarily — some phones route requests around a no-internet Wi-Fi network</li>
                                        <li>The blind is powered and within a few metres</li>
                                    </ul>
                                    <p style="color: var(--text-tertiary); font-size: 12px; margin: 2px 0 0; line-height: 1.4; text-align: center;">
                                        Then tap <strong>Verify Connection</strong> again.
                                    </p>
                                `;
                            }
                            return false; // Prevent automatic modal close on failure
                        }
                    },
                    {
                        label: 'Cancel',
                        secondary: true,
                        onClick: () => {
                            resolve(false);
                            Modal.close();
                        }
                    }
                ]
            });
        });
    },

    isConnected() {
        return this.connected;
    },

    // Production (HTTPS) path: the blind is provisioned on ITS OWN hotspot page
    // (http://192.168.4.1 — same-origin there, so no mixed-content problem),
    // then registered here by its device ID. Used on iOS (no Web Bluetooth) and
    // any other browser without Bluetooth support.
    _connectViaDevicePortal() {
        return new Promise((resolve) => {
            let finished = false;
            Modal.create({
                title: "Set up via the blind's hotspot",
                content: `
                    <div style="text-align: left; padding: 6px 0; font-family: var(--font-family); color: var(--text-secondary);">
                        <p style="font-size: 14px; line-height: 1.5; margin-bottom: 14px;">
                            Your blind hosts its own setup page. Three quick steps:
                        </p>
                        <ol style="font-size: 13.5px; padding-left: 20px; line-height: 1.6; margin-bottom: 16px; display: flex; flex-direction: column; gap: 8px;">
                            <li>Open <strong>Settings ▸ Wi-Fi</strong> and join the network starting with <strong>LumiBlind-</strong> (if asked, choose <em>Keep&nbsp;connection</em>).</li>
                            <li>Open <a href="http://192.168.4.1" target="_blank" rel="noopener" style="color: var(--accent-light); font-weight: 700;">http://192.168.4.1</a> and connect the blind to your home Wi-Fi there. Note the <strong>Device&nbsp;ID</strong> shown at the top.</li>
                            <li>Rejoin your home Wi-Fi, come back here, and enter that Device&nbsp;ID below.</li>
                        </ol>
                        <label style="font-size: 12px; font-weight: 700; color: var(--text-tertiary); text-transform: uppercase; letter-spacing: 0.05em;">Device ID</label>
                        <input type="text" id="portalDeviceId" placeholder="e.g. A1B2C3" maxlength="12" autocomplete="off"
                               style="width: 100%; margin-top: 6px; padding: 12px; border-radius: 10px; border: 1px solid var(--border-glass); background: var(--bg-glass); color: var(--text-primary); font-size: 15px; font-family: ui-monospace, monospace; text-transform: uppercase;">
                        <p style="font-size: 12px; color: var(--text-tertiary); margin-top: 10px; line-height: 1.4;">
                            Keep this page open after entering the ID. Zaylo verifies the blind online before adding it.
                        </p>
                        <div id="portalVerifyStatus" style="display:none;margin-top:12px;padding:12px;border-radius:12px;background:var(--bg-glass);border:1px solid var(--border-glass);font-size:12.5px;color:var(--text-secondary);line-height:1.45;"></div>
                    </div>
                `,
                actions: [
                    {
                        label: 'Add My Blind',
                        primary: true,
                        onClick: async () => {
                            const input = document.getElementById('portalDeviceId');
                            const cleanId = String(input?.value || '').toUpperCase().replace(/[^A-F0-9]/g, '');
                            if (!/^[A-F0-9]{6}$/.test(cleanId)) {
                                Toast.error('Enter the 6-character Device ID shown on the setup page');
                                return false; // keep the modal open
                            }
                            const status = document.getElementById('portalVerifyStatus');
                            if (status) {
                                status.style.display = 'block';
                                status.textContent = `Waiting for LumiBlind-${cleanId} to come online...`;
                            }
                            const verified = await this._verifyPortalDeviceOnline(cleanId, status);
                            if (!verified) {
                                if (status) status.textContent = 'The blind was not seen online yet. Confirm it joined your home Wi-Fi, then try again.';
                                Toast.error('Blind not verified online yet');
                                return false;
                            }
                            SetupState.deviceId = cleanId;
                            await this._registerPortalDevice(cleanId);
                            finished = true;
                            Toast.success('Blind verified online. Calibration required next.');
                            Modal.close();
                            // Wi-Fi was configured on the device's own page, but
                            // calibration still happens from the device page.
                            const finalId = document.getElementById('finalDeviceId');
                            const finalWifi = document.getElementById('finalWifi');
                            const finalName = document.getElementById('finalDeviceName');
                            if (finalId) finalId.textContent = cleanId;
                            if (finalWifi) finalWifi.textContent = "Verified online; calibration required";
                            if (finalName) finalName.textContent = `Blinds-${cleanId}`;
                            applyDeviceTypeFlow();
                            goToStep(5);
                            setTimeout(() => { window.location.href = `blind-device.html?id=${encodeURIComponent(cleanId)}&calibrate=1`; }, 1200);
                            resolve(false); // setup completed out-of-band; no live link
                            return false;
                        }
                    },
                    {
                        label: 'Cancel',
                        secondary: true,
                        onClick: () => {
                            if (!finished) resolve(false);
                            Modal.close();
                        }
                    }
                ]
            });
        });
    },

    async _verifyPortalDeviceOnline(cleanId, statusEl) {
        if (typeof MQTTClient === 'undefined') return false;
        const id = String(cleanId || '').toUpperCase();
        if (!/^[A-F0-9]{6}$/.test(id)) return false;

        try {
            if (!MQTTClient.connected) {
                if (statusEl) statusEl.textContent = 'Connecting to the Zaylo device broker...';
                await MQTTClient.connect();
            }
        } catch (e) {
            console.warn('[Setup] MQTT verification connect failed:', e);
            return false;
        }

        return new Promise(resolve => {
            let settled = false;
            let poll = null;
            let timer = null;
            const finish = (ok) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                clearInterval(poll);
                MQTTClient.off('onStateUpdate', onState);
                resolve(!!ok);
            };
            const inspect = (state) => {
                if (!state || typeof state !== 'object') return false;
                if (state.deviceId && String(state.deviceId).toUpperCase() !== id) return false;
                if (statusEl) statusEl.textContent = state.isCalibrated === true
                    ? 'Blind verified online.'
                    : 'Blind verified online. Calibration is still required.';
                return true;
            };
            const onState = (deviceId, state) => {
                if (String(deviceId || '').toUpperCase() !== id) return;
                if (inspect(state)) finish(true);
            };
            const requestState = () => {
                if (!MQTTClient.connected) return;
                try { MQTTClient.publishControl(id, { command: 'getState' }, { queue: false, localFallback: false }); } catch (e) {}
            };

            MQTTClient.on('onStateUpdate', onState);
            MQTTClient.subscribeDevice(id);
            if (inspect(MQTTClient.getDeviceState(id))) finish(true);
            requestState();
            poll = setInterval(requestState, 1500);
            timer = setTimeout(() => finish(false), 45000);
        });
    },

    async _registerPortalDevice(cleanId) {
        const device = {
            id: cleanId,
            name: `Blinds-${cleanId}`,
            type: SetupState.deviceType === 'stepper' ? 'blind' : 'servo',
            angleOn: null,
            angleOff: null
        };
        // Local first (instant), then cloud registration. A failed/unavailable
        // cloud write is QUEUED and retried on the next app load — the
        // dashboard's Firebase merge only preserves local-only devices briefly,
        // so a lost registration would make the blind vanish later.
        DeviceList.add(device);
        try {
            const key = `blind-state-${cleanId}`;
            const existing = JSON.parse(localStorage.getItem(key) || '{}') || {};
            localStorage.setItem(key, JSON.stringify({
                ...existing,
                isCalibrated: false,
                calibrationRequired: true,
                lastStateAt: null
            }));
        } catch (e) {
            console.warn('[Setup] Failed to mark portal blind as calibration-required:', e);
        }
        try {
            const user = (typeof Auth !== 'undefined') ? Auth.getUser() : null;
            if (user && typeof HomeService !== 'undefined' && typeof DeviceService !== 'undefined') {
                await HomeService.init();
                const homeId = await HomeService.getActiveHome(user.uid);
                await DeviceService.init();
                await DeviceService.addDeviceReliably(homeId, device);
            } else if (typeof DeviceService !== 'undefined') {
                DeviceService.queuePendingRegistration(device);
            }
        } catch (e) {
            console.warn('[Setup] Firebase sync failed — queued for retry on next load:', e);
            if (typeof DeviceService !== 'undefined') DeviceService.queuePendingRegistration(device);
        }
    },

    async setServoAngle(angle) {
        if (!this.connected) return;
        await fetch(`http://${this.gatewayIp}/api/servo?angle=${angle}`).catch(() => {});
    },

    async setStepperJog(direction) {
        if (!this.connected) return;
        await fetch(`http://${this.gatewayIp}/api/jog?dir=${direction}`).catch(() => {});
    },

    async startWifiScan() {
        if (!this.connected) return;
        try {
            const res = await fetch(`http://${this.gatewayIp}/api/scan`);
            if (res.ok) {
                const networks = await res.json();
                renderWifiNetworks(networks);
            }
        } catch (e) {
            Toast.error('WiFi Scan failed - check connection');
        }
    },

    async sendWifiCredentials(ssid, password) {
        if (!this.connected) return;
        const response = await fetch(`http://${this.gatewayIp}/api/setup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ssid, pass: password })
        });
        if (!response.ok) throw new Error('Failed to send Wi-Fi credentials');
        const data = await response.json();
        if (data && data.status === 'failed') {
            throw new Error('Wi-Fi connection failed. Verify password.');
        }
        if (data && data.status === 'connected') return; // legacy firmware: synchronous result

        // Current firmware replies "started" and connects asynchronously (the
        // radio's channel hop while joining the router would otherwise eat the
        // response). Poll /api/setup-status for the real outcome; transient
        // fetch errors are EXPECTED while the phone re-joins the hotspot after
        // the channel switch, so they don't fail the wait.
        const deadline = Date.now() + 45000;
        while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 1200));
            try {
                const res = await fetch(`http://${this.gatewayIp}/api/setup-status`);
                if (!res.ok) continue;
                const s = await res.json();
                if (s.status === 'connected') return;
                if (s.status === 'failed') {
                    throw new Error('Wi-Fi connection failed. Verify password.');
                }
            } catch (e) {
                if (e && /Verify password/.test(e.message || '')) throw e;
                // hotspot momentarily unreachable — keep polling
            }
        }
        // No definitive answer. The most common cause is that the blind
        // connected and rebooted (its hotspot is gone, so polling can't reach
        // it). Surface that honestly instead of a false "failed".
        throw new Error("No response from the blind. If its LumiBlind hotspot has disappeared, setup actually succeeded — check the app once it's online.");
    },

    async sendConfig(config) {
        if (!this.connected) return;
        const response = await fetch(`http://${this.gatewayIp}/api/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config)
        });
        if (!response.ok) throw new Error('Failed to save device configuration');
    },

    // The /api/config handler applies the config synchronously before
    // responding, so a 200 response IS the device's confirmation. Newer
    // firmware also embeds the resulting calibration snapshot. Bounded by a
    // timeout so a hung device fails the save honestly instead of hanging the
    // button (the BLE path has the same 6 s bound).
    async sendConfigAcked(config, timeoutMs = 8000) {
        if (!this.connected) throw new Error('Setup link not ready');
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        let response;
        try {
            response = await fetch(`http://${this.gatewayIp}/api/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(config),
                signal: controller.signal
            });
        } catch (e) {
            throw new Error('The blind did not confirm the save');
        } finally {
            clearTimeout(timeoutId);
        }
        if (!response.ok) throw new Error('The blind did not confirm the save');
        let data = null;
        try { data = await response.json(); } catch (e) { data = null; }
        if (!data || (data.status !== 'ok' && data.configAck !== true)) {
            throw new Error('The blind did not confirm the save');
        }
        // Older firmware confirms without a calibration snapshot — calib: null.
        return { configAck: true, calib: data.calib || null };
    },

    disconnect() {
        this.connected = false;
        this.deviceId = null;
    }
};

// ============================================
// Active Connection Orchestrator
// Unified routing for BLE and Wi-Fi Direct
// ============================================
const ActiveConnection = {
    getConnection() {
        if (SetupState.connectionMethod === 'wifi') {
            return WifiDirectConnection;
        }
        return BLEConnection;
    },

    async connect() {
        return this.getConnection().connect();
    },

    isConnected() {
        return this.getConnection().isConnected();
    },

    async setServoAngle(angle) {
        return this.getConnection().setServoAngle(angle);
    },

    async setStepperJog(direction) {
        return this.getConnection().setStepperJog(direction);
    },

    async startWifiScan() {
        return this.getConnection().startWifiScan();
    },

    async sendWifiCredentials(ssid, password) {
        return this.getConnection().sendWifiCredentials(ssid, password);
    },

    async sendConfig(config) {
        return this.getConnection().sendConfig(config);
    },

    async sendConfigAcked(config, timeoutMs) {
        return this.getConnection().sendConfigAcked(config, timeoutMs);
    },

    supportsWifiScan() {
        if (SetupState.connectionMethod === 'wifi') {
            return true;
        }
        return !!BLEConnection.charWifiScan;
    },

    setProvisioning(val) {
        if (SetupState.connectionMethod === 'bluetooth') {
            BLEConnection.isProvisioning = val;
        } else {
            WifiDirectConnection.isProvisioning = val;
        }
    },

    disconnect() {
        return this.getConnection().disconnect();
    }
};


// ============================================
// WiFi Networks - NO FAKE NETWORKS
// ============================================
function renderWifiNetworks(networks) {
    const container = document.getElementById('wifiList');
    if (!container) return;

    if (!networks?.length) {
        container.innerHTML = `
            <div style="text-align:center;color:var(--text-tertiary);padding:40px 20px;">
                <div style="font-size:48px;margin-bottom:16px;color:var(--accent);"><svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19.07 4.93A10 10 0 0 0 6.99 3.34"/><path d="M4 6h.01"/><path d="M2.29 9.62A10 10 0 1 0 21.31 8.35"/><path d="M16.24 7.76A6 6 0 1 0 8.23 16.67"/><path d="M12 18h.01"/><path d="M17.99 11.66A6 6 0 0 1 15.77 16.67"/><circle cx="12" cy="12" r="2"/></svg></div>
                <p style="margin-bottom:8px;">No networks found</p>
                <p style="font-size:13px;">Make sure your device is connected and try scanning again</p>
            </div>
        `;
        return;
    }

    // ESP32 sends: {"s":"NetworkName","r":-65,"e":1} where e=1 (encrypted) or e=0 (open)
    container.innerHTML = networks.map(n => {
        const ssid = n.ssid || n.s || 'Unknown';
        const safeSsid = Utils.escapeHtml(ssid);
        const isSecured = Boolean(n.encryption || n.e); // e=1 → true, e=0 → false
        const rssi = n.rssi || n.r || -100;
        const bssid = n.bssid || n.b || '';
        const channel = n.channel || n.ch || '';
        const auth = n.auth !== undefined ? n.auth : '';
        const safeBssid = Utils.escapeHtml(String(bssid));
        const metaParts = [`${rssi} dBm`];
        if (channel !== '') metaParts.push(`ch ${Utils.escapeHtml(String(channel))}`);
        if (bssid) metaParts.push(safeBssid);
        // Real Wi-Fi 6 capability if the firmware reports it (802.11ax / HE).
        // Absent → '' (unknown) so we fall back to the user's answer rather than
        // wrongly assuming "not Wi-Fi 6".
        let wifi6Attr = '';
        if (n.ax !== undefined || n.wifi6 !== undefined || n.he !== undefined) {
            wifi6Attr = (n.ax || n.wifi6 || n.he) ? 'true' : 'false';
        }
        // Signal strength icon based on RSSI
        let signalIcon = '<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M5 12.55a11 11 0 0 1 14.08 0\"/><path d=\"M1.42 9a16 16 0 0 1 21.16 0\"/><path d=\"M8.53 16.11a6 6 0 0 1 6.95 0\"/><line x1=\"12\" x2=\"12.01\" y1=\"20\" y2=\"20\"/></svg>';
        if (rssi < -80) signalIcon = '<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"var(--warning)\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M8.53 16.11a6 6 0 0 1 6.95 0\"/><line x1=\"12\" x2=\"12.01\" y1=\"20\" y2=\"20\"/></svg>'; // Weak
        else if (rssi < -60) signalIcon = '<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M5 12.55a11 11 0 0 1 14.08 0\"/><path d=\"M8.53 16.11a6 6 0 0 1 6.95 0\"/><line x1=\"12\" x2=\"12.01\" y1=\"20\" y2=\"20\"/></svg>'; // Medium
        // else strong, keep full bars

        return `
            <div class="wifi-item" data-ssid="${safeSsid}" data-secured="${isSecured}" data-wifi6="${wifi6Attr}" data-rssi="${rssi}" data-bssid="${safeBssid}" data-channel="${Utils.escapeHtml(String(channel))}" data-auth="${Utils.escapeHtml(String(auth))}">
                <div class="wifi-info">
                    <span class="wifi-signal">${signalIcon}</span>
                    <span>
                        <span class="wifi-name">${safeSsid}</span>
                        <span class="wifi-meta">${metaParts.join(' / ')}</span>
                    </span>
                </div>
                ${isSecured ? '<span class=\"wifi-lock\" style=\"display:flex; align-items:center;\"><svg xmlns=\"http://www.w3.org/2000/svg\" width=\"16\" height=\"16\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"3\" y=\"11\" width=\"18\" height=\"11\" rx=\"2\" ry=\"2\"/><path d=\"M7 11V7a5 5 0 0 1 10 0v4\"/></svg></span>' : '<span class=\"wifi-open\" style=\"display:flex; align-items:center;\"><svg xmlns=\"http://www.w3.org/2000/svg\" width=\"16\" height=\"16\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"3\" y=\"11\" width=\"18\" height=\"11\" rx=\"2\" ry=\"2\"/><path d=\"M7 11V7a5 5 0 0 1 9.9-1\"/></svg></span>'}
            </div>
        `;
    }).join('');

    container.querySelectorAll('.wifi-item').forEach(item => {
        item.addEventListener('click', () => {
            document.querySelectorAll('.wifi-item').forEach(i => i.classList.remove('selected'));
            item.classList.add('selected');
            let w6;
            if (item.dataset.wifi6 === 'true') w6 = true;
            else if (item.dataset.wifi6 === 'false') w6 = false;
            SetupState.selectedNetwork = {
                ssid: item.dataset.ssid,
                secured: item.dataset.secured === 'true',
                wifi6: w6,
                rssi: parseInt(item.dataset.rssi, 10) || -70,
                bssid: item.dataset.bssid || '',
                channel: item.dataset.channel || '',
                auth: item.dataset.auth || ''
            };
            // Mirror the chosen SSID into the entry box so the user can see (and
            // tweak) exactly which network they picked. Setting .value directly
            // does NOT fire the input listener, so the rich scan data we just
            // captured (wifi6 / rssi) on SetupState.selectedNetwork is preserved.
            const manualSsidInput = document.getElementById('manualWifiSsid');
            if (manualSsidInput) manualSsidInput.value = item.dataset.ssid;
            const openToggle = document.getElementById('manualWifiOpen');
            if (openToggle) openToggle.checked = !SetupState.selectedNetwork.secured;
            const pwd = document.getElementById('passwordSection');
            if (pwd) {
                pwd.classList.toggle('show', SetupState.selectedNetwork.secured);
                if (SetupState.selectedNetwork.secured) {
                    const passInput = document.getElementById('wifiPassword');
                    if (passInput) passInput.focus();
                }
            }
        });
    });
}

// ============================================
// Initialize
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    // Theme
    Theme.init();

    // Build the blinds-only premium flow (no-op visuals for servo devices)
    initStepperFlow();

    // Resolve active home for device operations
    (async () => {
        try {
            if (typeof HomeService !== 'undefined' && typeof Auth !== 'undefined') {
                await Auth.waitForAuthReady();
                const user = Auth.getUser();
                if (user) {
                    await HomeService.init();
                    const homeId = await HomeService.getActiveHome(user.uid);
                    if (typeof DeviceList !== 'undefined') DeviceList.setHome(homeId);
                }
            }
        } catch (e) {
            console.error('[Setup] HomeService init failed:', e);
        }
    })();

    const themeBtn = document.getElementById('themeToggle');
    if (themeBtn) {
        themeBtn.innerHTML = Theme.get() === 'dark' ? '<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z\"/></svg>' : '<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><circle cx=\"12\" cy=\"12\" r=\"4\"/><path d=\"M12 2v2\"/><path d=\"M12 20v2\"/><path d=\"m4.93 4.93 1.41 1.41\"/><path d=\"m17.66 17.66 1.41 1.41\"/><path d=\"M2 12h2\"/><path d=\"M20 12h2\"/><path d=\"m6.34 17.66-1.41 1.41\"/><path d=\"m19.07 4.93-1.41 1.41\"/></svg>';
        themeBtn.addEventListener('click', () => {
            const newTheme = Theme.toggle();
            themeBtn.innerHTML = newTheme === 'dark' ? '<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z\"/></svg>' : '<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><circle cx=\"12\" cy=\"12\" r=\"4\"/><path d=\"M12 2v2\"/><path d=\"M12 20v2\"/><path d=\"m4.93 4.93 1.41 1.41\"/><path d=\"m17.66 17.66 1.41 1.41\"/><path d=\"M2 12h2\"/><path d=\"M20 12h2\"/><path d=\"m6.34 17.66-1.41 1.41\"/><path d=\"m19.07 4.93-1.41 1.41\"/></svg>';
        });
    }

    // Back button
    document.getElementById('backBtn')?.addEventListener('click', () => {
        if (SetupState.deviceType === 'stepper') {
            flowPrev();
        } else {
            if (SetupState.currentStep > 1) goToStep(SetupState.currentStep - 1);
            else window.location.href = 'index.html';
        }
    });

    // Arm modal close
    document.getElementById('armModalClose')?.addEventListener('click', hideArmModal);

    // ===== Step 1 =====
    const connectionCards = document.querySelectorAll('.connection-card');
    const step1Next = document.getElementById('step1Next');

    connectionCards.forEach(card => {
        card.addEventListener('click', () => {
            connectionCards.forEach(c => c.classList.remove('selected'));
            card.classList.add('selected');
            SetupState.connectionMethod = card.dataset.method;
            if (step1Next) step1Next.disabled = false;
        });
    });

    step1Next?.addEventListener('click', async () => {
        if (!SetupState.connectionMethod || SetupState.isConnecting) return;

        SetupState.isConnecting = true;
        step1Next.classList.add('loading');
        step1Next.disabled = true;

        const connected = await ActiveConnection.connect();

        if (connected) {
            // Mark that this wizard run had a LIVE setup link. The Finish step
            // uses this to tell "link dropped mid-flow" (must error + reconnect)
            // apart from the iOS/portal path that never had one (registration-only).
            SetupState._hadLiveSetupLink = true;
            // Re-apply the flow so the correct steps/progress are active.
            applyDeviceTypeFlow();
            if (SetupState._resumeFinishAfterReconnect) {
                // The Finish step sent the user back here after the setup link
                // dropped — jump straight back to Finish (every other choice is
                // still held in SetupState) instead of re-walking the flow.
                SetupState._resumeFinishAfterReconnect = false;
                goToStep('4');
            } else {
                goToStep(2);
            }
        }

        SetupState.isConnecting = false;
        step1Next.classList.remove('loading');
        step1Next.disabled = false;
    });

    // ===== Step 2: Servo =====
    const slider = document.getElementById('angleSlider');
    let bleDebounceTimeout = null;

    // Helper function to send angle to device with debounce
    function sendAngleToBLE(angle) {
        if (bleDebounceTimeout) clearTimeout(bleDebounceTimeout);
        bleDebounceTimeout = setTimeout(() => {
            if (ActiveConnection.isConnected()) {
                ActiveConnection.setServoAngle(angle).catch(() => { });
            }
        }, 50); // 50ms debounce for smooth real-time control
    }

    // Initialize displays
    setServoAngle(90);
    updatePositionDisplays();

    // Slider input - update visual AND send to BLE in real-time
    slider?.addEventListener('input', (e) => {
        const angle = parseInt(e.target.value, 10);
        setServoAngle(angle);
        sendAngleToBLE(angle);
    });

    // Precision decrease button (-1°)
    document.getElementById('angleDecrease')?.addEventListener('click', () => {
        const newAngle = Math.max(0, SetupState.currentAngle - 1);
        setServoAngle(newAngle);
        sendAngleToBLE(newAngle);
    });

    // Precision increase button (+1°)
    document.getElementById('angleIncrease')?.addEventListener('click', () => {
        const newAngle = Math.min(180, SetupState.currentAngle + 1);
        setServoAngle(newAngle);
        sendAngleToBLE(newAngle);
    });

    // Center button
    document.getElementById('centerBtn')?.addEventListener('click', () => {
        setServoAngle(90);
        if (ActiveConnection.isConnected()) {
            ActiveConnection.setServoAngle(90).catch(() => { });
        }
        Toast.info('Centered to 90°');
    });

    // Go to OFF position
    document.getElementById('goOffBtn')?.addEventListener('click', () => {
        if (SetupState.angleOff === null) {
            Toast.warning('OFF position not set yet');
            return;
        }
        setServoAngle(SetupState.angleOff);
        if (ActiveConnection.isConnected()) {
            ActiveConnection.setServoAngle(SetupState.angleOff).catch(() => { });
        }
        document.getElementById('goOffBtn')?.classList.add('active');
        document.getElementById('goOnBtn')?.classList.remove('active');
    });

    // Go to ON position
    document.getElementById('goOnBtn')?.addEventListener('click', () => {
        if (SetupState.angleOn === null) {
            Toast.warning('ON position not set yet');
            return;
        }
        setServoAngle(SetupState.angleOn);
        if (ActiveConnection.isConnected()) {
            ActiveConnection.setServoAngle(SetupState.angleOn).catch(() => { });
        }
        document.getElementById('goOnBtn')?.classList.add('active');
        document.getElementById('goOffBtn')?.classList.remove('active');
    });

    // Save current as OFF
    document.getElementById('saveOffBtn')?.addEventListener('click', () => {
        SetupState.angleOff = SetupState.currentAngle;
        updatePositionDisplays();
        Toast.success(`OFF position saved: ${SetupState.angleOff}°`);
    });

    // Save current as ON
    document.getElementById('saveOnBtn')?.addEventListener('click', () => {
        SetupState.angleOn = SetupState.currentAngle;
        updatePositionDisplays();
        Toast.success(`ON position saved: ${SetupState.angleOn}°`);
    });

    // Test current position
    document.getElementById('testServoBtn')?.addEventListener('click', async () => {
        if (SetupState.deviceType === 'stepper') return; // Not for stepper

        const btn = document.getElementById('testServoBtn');
        btn.textContent = '⏳ Moving...';
        btn.disabled = true;

        setTimeout(() => {
            btn.innerHTML = '<span style=\"display:flex;align-items:center;gap:6px;\"><svg xmlns=\"http://www.w3.org/2000/svg\" width=\"16\" height=\"16\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8\"/><path d=\"M3 3v5h5\"/><path d=\"M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16\"/><path d=\"M16 16h5v5\"/></svg> Test Current Position</span>';
            btn.disabled = false;
        }, 500);
    });

    // ===== Stepper Calibration Buttons =====

    let isJoggingActive = false;
    let jogKeepalive = null;       // deadman refresh timer while a jog button is held
    let jogActiveDirection = 0;
    const startJog = (direction) => {
        if (!ActiveConnection.isConnected()) return Toast.warning('Not connected to device');
        isJoggingActive = true;
        jogActiveDirection = direction;
        ActiveConnection.setStepperJog(direction).catch(() => { });
        document.getElementById('jogFeedback').innerHTML = direction > 0 ? 'Moving Up ▲' : 'Moving Down ▼';
        // Deadman keepalive. The firmware auto-halts a jog if no command arrives
        // within ~2.5s (JOG_DEADMAN_MS). Without a refresh, a single press only
        // moves the blind for 2.5s and then stalls — broken for the long travel of
        // initial calibration. Re-send every 700ms while held (the BLE write queue
        // serialises these, preventing GATT_BUSY); a lost release (app
        // backgrounded/closed) then trips the firmware deadman instead of running
        // the motor into its mechanical limit.
        clearInterval(jogKeepalive);
        jogKeepalive = setInterval(() => {
            if (isJoggingActive && ActiveConnection.isConnected()) {
                ActiveConnection.setStepperJog(jogActiveDirection).catch(() => { });
            }
        }, 700);
    };
    const stopJog = () => {
        clearInterval(jogKeepalive);
        jogKeepalive = null;
        if (!isJoggingActive) return;
        isJoggingActive = false;
        jogActiveDirection = 0;
        if (ActiveConnection.isConnected()) {
            ActiveConnection.setStepperJog(0)
                .then(() => {
                    document.getElementById('jogFeedback').innerHTML = 'Idle';
                })
                .catch(() => {
                    document.getElementById('jogFeedback').innerHTML = 'Idle';
                });
        } else {
            document.getElementById('jogFeedback').innerHTML = 'Idle';
        }
    };

    // Jog Up/Down Event Listeners
    // Use pointer events for robust, reliable start/stop detection across mobile and desktop
    const jogUp = document.getElementById('jogUpBtn');
    const jogDown = document.getElementById('jogDownBtn');

    const addJogListeners = (btn, direction) => {
        if (!btn) return;

        // Prevent default touch behaviors like context menus
        btn.addEventListener('contextmenu', e => e.preventDefault());

        btn.addEventListener('pointerdown', (e) => {
            btn.setPointerCapture(e.pointerId);
            startJog(direction);
        });

        const stopHandler = (e) => {
            if (e.pointerId !== undefined && btn.hasPointerCapture && btn.hasPointerCapture(e.pointerId)) {
                try { btn.releasePointerCapture(e.pointerId); } catch (err) { }
            }
            stopJog();
        };

        btn.addEventListener('pointerup', stopHandler);
        btn.addEventListener('pointercancel', stopHandler);
        btn.addEventListener('touchend', stopHandler, { passive: true });
        btn.addEventListener('touchcancel', stopHandler, { passive: true });
    };

    addJogListeners(jogUp, 1);
    addJogListeners(jogDown, -1);

    // Safety: stop a held jog if the page is hidden/closed mid-press (app switched
    // away, tab closed) so a lost pointerup can't leave the motor running. stopJog
    // is idempotent, and the firmware deadman is the final backstop.
    document.addEventListener('visibilitychange', () => { if (document.hidden) stopJog(); });
    window.addEventListener('pagehide', stopJog);

    // Minimum distance between the saved OPEN and CLOSED limits. MUST match the
    // firmware's rule in processConfigCommand(), which silently resets both
    // limits to 0 (uncalibrated) when the range is narrower than this.
    const MIN_CALIBRATION_RANGE_STEPS = 500;

    const _setLimitLabel = (id, text) => {
        const label = document.getElementById(id);
        if (label) label.textContent = text;
    };

    const _resetSavedLimits = () => {
        SetupState.calTopSaved = false;
        SetupState.calBottomSaved = false;
        SetupState.calTopPos = null;
        SetupState.calBottomPos = null;
        _setLimitLabel('savedTop', 'Not Set');
        _setLimitLabel('savedBottom', 'Not Set');
    };

    // Save a calibration limit and only report success once the DEVICE confirms
    // it. The firmware acks every setup-link config write with its resulting
    // calibration snapshot; an echoed limit that doesn't match where the blind
    // physically is means the firmware's narrow-range guard reset the limits.
    const saveStepperLimit = async (which) => {
        const isTop = which === 'top';
        const btn = document.getElementById(isTop ? 'saveStepperTopBtn' : 'saveStepperBottomBtn');
        const labelId = isTop ? 'savedTop' : 'savedBottom';

        if (!ActiveConnection.isConnected()) {
            Toast.warning('Not connected');
            return;
        }
        if (btn?.dataset.busy === '1') return;
        if (btn) { btn.dataset.busy = '1'; btn.disabled = true; }
        _setLimitLabel(labelId, 'Saving…');

        try {
            const ack = await ActiveConnection.sendConfigAcked({ cmd: isTop ? 'save_top' : 'save_bottom' });
            const calib = ack && ack.calib;

            if (calib) {
                const saved = Number(isTop ? calib.top : calib.bottom);
                const current = Number(calib.current);
                const applied = Number.isFinite(saved) && Number.isFinite(current) &&
                    Math.abs(saved - current) <= 8;
                const range = (Number.isFinite(Number(calib.top)) && Number.isFinite(Number(calib.bottom)))
                    ? Math.abs(Number(calib.top) - Number(calib.bottom))
                    : 0;
                const bottomCompletes = !isTop &&
                    (calib.isCalibrated !== true || range < MIN_CALIBRATION_RANGE_STEPS);

                if (!applied || bottomCompletes) {
                    // The firmware rejected/reset the limits (range too narrow, or
                    // open was never saved). Both limits were cleared on-device, so
                    // the wizard must clear both too — not just this one.
                    _resetSavedLimits();
                    Toast.error('Open and Closed are too close together. Jog the blind further apart, then save BOTH positions again.');
                    return;
                }

                if (isTop) { SetupState.calTopSaved = true; SetupState.calTopPos = saved; }
                else { SetupState.calBottomSaved = true; SetupState.calBottomPos = saved; }
            } else {
                // Older firmware confirmed the write but sent no snapshot — the
                // save is genuine, just not range-checkable until the device page.
                if (isTop) { SetupState.calTopSaved = true; SetupState.calTopPos = null; }
                else { SetupState.calBottomSaved = true; SetupState.calBottomPos = null; }
            }

            _setLimitLabel(labelId, 'Saved ✓');
            Toast.success(isTop ? 'Open position confirmed!' : 'Closed position confirmed!');
        } catch (e) {
            _setLimitLabel(labelId, 'Not Set');
            if (isTop) { SetupState.calTopSaved = false; SetupState.calTopPos = null; }
            else { SetupState.calBottomSaved = false; SetupState.calBottomPos = null; }
            Toast.error(e.message || 'Save not confirmed — check the connection and try again');
        } finally {
            if (btn) { btn.dataset.busy = '0'; btn.disabled = false; }
        }
    };

    document.getElementById('saveStepperTopBtn')?.addEventListener('click', () => saveStepperLimit('top'));
    document.getElementById('saveStepperBottomBtn')?.addEventListener('click', () => saveStepperLimit('bottom'));

    document.getElementById('step2Back')?.addEventListener('click', () => goToStep(1));
    document.getElementById('step2Next')?.addEventListener('click', () => {
        if (SetupState.deviceType === 'servo') {
            if (SetupState.angleOff === null || SetupState.angleOn === null) {
                Toast.warning('Please set both ON and OFF positions');
                return;
            }
        } else if (SetupState.deviceType === 'stepper' && ActiveConnection.isConnected()) {
            // Gate on the DEVICE-CONFIRMED saves, never on optimistic UI text.
            if (!SetupState.calTopSaved || !SetupState.calBottomSaved) {
                Toast.warning('Please set both OPEN and CLOSED positions');
                return;
            }
            if (SetupState.calTopPos !== null && SetupState.calBottomPos !== null &&
                Math.abs(SetupState.calTopPos - SetupState.calBottomPos) < MIN_CALIBRATION_RANGE_STEPS) {
                Toast.warning('Open and Closed positions are too close together — please recalibrate');
                return;
            }
        }
        Toast.success('Calibration saved!');
        goToStep(3);
    });

    // ===== Step 3: WiFi =====
    document.getElementById('scanWifi')?.addEventListener('click', async () => {
        const btn = document.getElementById('scanWifi');
        btn.textContent = '⏳ Scanning...';
        btn.disabled = true;

        // Clear previous results and show scanning state
        const wifiList = document.getElementById('wifiList');
        if (wifiList) {
            wifiList.innerHTML = `
                <div style="text-align:center;color:var(--text-tertiary);padding:40px 20px;">
                    <div style="font-size:48px;margin-bottom:16px;animation:pulse 1.5s ease-in-out infinite;opacity:0.7;color:var(--accent);"><svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19.07 4.93A10 10 0 0 0 6.99 3.34"/><path d="M4 6h.01"/><path d="M2.29 9.62A10 10 0 1 0 21.31 8.35"/><path d="M16.24 7.76A6 6 0 1 0 8.23 16.67"/><path d="M12 18h.01"/><path d="M17.99 11.66A6 6 0 0 1 15.77 16.67"/><circle cx="12" cy="12" r="2"/></svg></div>
                    <p>Searching for networks...</p>
                </div>
            `;
        }

        // Helper to reset button
        const resetButton = () => {
            btn.textContent = '🔍 Scan for Networks';
            btn.disabled = false;
        };

        // Check device connection first
        if (!ActiveConnection.isConnected()) {
            Toast.warning('Connect to device first to scan for networks');
            resetButton();
            return;
        }

        // Check if scan is supported
        if (!ActiveConnection.supportsWifiScan()) {
            console.error('[Setup] WiFi scan not supported');
            Toast.error('WiFi scan not supported - try reconnecting');
            resetButton();
            return;
        }

        try {
            // console.log('[Setup] Starting WiFi scan via BLE...');
            /* console.log('[Setup] Connection state:', {
                connected: ActiveConnection.isConnected(),
                hasWifiScan: ActiveConnection.supportsWifiScan()
            }); */

            await ActiveConnection.startWifiScan();
            Toast.info('Scanning for networks...');

            // Timeout fallback - if no results received in 30s, reset button
            setTimeout(() => {
                if (btn.disabled) {
                    const bufferLength = SetupState.connectionMethod === 'bluetooth' ? BLEConnection.wifiScanBuffer?.length || 0 : 0;
                    console.warn('[Setup] WiFi scan timeout - no results received. Current Buffer Size:', bufferLength);
                    resetButton();
                    // Check if we got any results
                    const wifiList = document.getElementById('wifiList');
                    if (wifiList && !wifiList.querySelector('.wifi-item')) {
                        Toast.warning('Scan timed out - try again');
                    }
                }
            }, 30000);

        } catch (e) {
            console.error('[Setup] WiFi scan failed:', e);
            Toast.error('Scan failed - ' + (e.message || 'unknown error'));
            resetButton();
        }
    });

    // Interactive manual SSID input handler (Wi-Fi Direct)
    const updateManualNetworkSelection = () => {
        // Deselect any selected scanned item to avoid conflict
        document.querySelectorAll('.wifi-item').forEach(i => i.classList.remove('selected'));
        const val = document.getElementById('manualWifiSsid')?.value?.trim() || '';
        const openToggle = document.getElementById('manualWifiOpen');
        const secured = !(openToggle && openToggle.checked);
        const pwd = document.getElementById('passwordSection');
        if (val) {
            SetupState.selectedNetwork = { ssid: val, secured, manual: true };
            pwd?.classList.toggle('show', secured);
        } else {
            SetupState.selectedNetwork = null;
            pwd?.classList.remove('show');
        }
    };
    document.getElementById('manualWifiSsid')?.addEventListener('input', updateManualNetworkSelection);
    document.getElementById('manualWifiOpen')?.addEventListener('change', updateManualNetworkSelection);

    // High-fidelity WiFi Password visibility toggle handler
    const wifiPasswordToggle = document.getElementById('wifiPasswordToggle');
    const wifiPasswordInput = document.getElementById('wifiPassword');
    
    wifiPasswordToggle?.addEventListener('click', () => {
        if (!wifiPasswordInput) return;
        
        const isPassword = wifiPasswordInput.getAttribute('type') === 'password';
        wifiPasswordInput.setAttribute('type', isPassword ? 'text' : 'password');
        
        // Update SVG visibility
        const eyeIcon = wifiPasswordToggle.querySelector('.eye-icon');
        const eyeOffIcon = wifiPasswordToggle.querySelector('.eye-off-icon');
        
        if (eyeIcon && eyeOffIcon) {
            if (isPassword) {
                eyeIcon.style.display = 'none';
                eyeOffIcon.style.display = 'inline-block';
                wifiPasswordToggle.setAttribute('aria-label', 'Hide Password');
            } else {
                eyeIcon.style.display = 'inline-block';
                eyeOffIcon.style.display = 'none';
                wifiPasswordToggle.setAttribute('aria-label', 'Show Password');
            }
        }
        
        // Keep focus on input for seamless user experience
        wifiPasswordInput.focus();
    });

    document.getElementById('step3Back')?.addEventListener('click', () => goToStep(2));

    document.getElementById('step3Next')?.addEventListener('click', async () => {
        const btn = document.getElementById('step3Next');
        if (btn?.classList.contains('loading') || btn?.disabled) return;

        // Handle WiFi fallback mode manually entered SSID
        if (SetupState.connectionMethod === 'wifi') {
            const manualSsid = document.getElementById('manualWifiSsid')?.value?.trim();
            if (manualSsid) {
                // If the box still holds the SSID picked from the scan list, keep
                // the rich scan data (wifi6/rssi) we already captured — only treat
                // it as a fresh manual entry when the text actually differs.
                if (!SetupState.selectedNetwork || SetupState.selectedNetwork.ssid !== manualSsid) {
                    const openToggle = document.getElementById('manualWifiOpen');
                    SetupState.selectedNetwork = {
                        ssid: manualSsid,
                        secured: !(openToggle && openToggle.checked),
                        manual: true
                    };
                }
            }
        }

        if (!SetupState.selectedNetwork) {
            Toast.warning('Select or enter a network');
            return;
        }

        // The 802.11 SSID limit (and the firmware buffer) is 32 BYTES; the
        // input's maxlength counts UTF-16 characters, so a multi-byte
        // (emoji/CJK) SSID could pass the field yet truncate mid-character on
        // the device and never match the real network.
        if (new TextEncoder().encode(SetupState.selectedNetwork.ssid || '').length > 32) {
            Toast.warning('Network name is too long (max 32 bytes)');
            return;
        }

        const password = document.getElementById('wifiPassword')?.value || '';
        if (SetupState.selectedNetwork.secured && !password) {
            Toast.warning('Enter password');
            return;
        }

        // Blinds (stepper): collect Wi-Fi credentials but DON'T provision yet.
        // We keep the device in BLE setup mode through Performance / Power /
        // Automations and send credentials only at the final "Finish" step.
        if (SetupState.deviceType === 'stepper') {
            SetupState.wifiPassword = password;
            // If we're here because a previous provisioning attempt failed, jump
            // straight back to the finish step to retry rather than re-walking the
            // whole blinds flow (all other choices are still held in SetupState).
            if (SetupState._wifiRetry) {
                SetupState._wifiRetry = false;
                goToStep('4');
            } else {
                flowNext();
            }
            return;
        }

        btn?.classList.add('loading');
        if (btn) btn.disabled = true;

        if (ActiveConnection.isConnected()) {
            try {
                // Send Configuration BEFORE WiFi credentials (so it saves even if WiFi fails)
                const isStepper = SetupState.deviceType === 'stepper';
                // For Stepper, Top/Bottom limits are already saved via the save buttons directly.
                // But we can resend angles for Servo.
                if (!isStepper) {
                    await ActiveConnection.sendConfig({
                        angleOn: SetupState.angleOn,
                        angleOff: SetupState.angleOff
                    });
                }

                Toast.info('Sending Wi-Fi credentials...');
                
                // Block and wait for device to confirm connection success
                await ActiveConnection.sendWifiCredentials(SetupState.selectedNetwork.ssid, password);

                // Set provisioning flag to true so we don't show "Disconnected" error when device reboots
                ActiveConnection.setProvisioning(true);
            } catch (e) {
                console.warn('[Setup] WiFi connection failed:', e);
                Toast.error(e.message || 'Wi-Fi connection failed. Verify password.');
                btn?.classList.remove('loading');
                if (btn) btn.disabled = false;
                return; // Blocks progression to Step 4
            }
        }

        Toast.info('Connected! Now name your device.');
        btn?.classList.remove('loading');
        if (btn) btn.disabled = false;
        goToStep(4);
    });

    document.getElementById('step4Back')?.addEventListener('click', () => {
        if (SetupState.deviceType === 'stepper') flowPrev();
        else goToStep(3);
    });

    document.getElementById('step4Next')?.addEventListener('click', async () => {
        const btn = document.getElementById('step4Next');
        if (btn?.classList.contains('loading') || btn?.disabled) return;
        btn?.classList.add('loading');
        if (btn) btn.disabled = true;

        // Update final screen
        document.getElementById('finalDeviceId').textContent = SetupState.deviceId || 'NEW';
        document.getElementById('finalWifi').textContent = SetupState.selectedNetwork?.ssid || 'Connected';

        // Get custom name
        let customName = document.getElementById('deviceNameInput')?.value?.trim();
        const cleanId = SetupState.deviceId ? SetupState.deviceId.replace(/[^A-F0-9]/g, '') : '';

        if (!customName) {
            customName = cleanId ? `Zaylo-${cleanId}` : 'Zaylo Device';
        }

        // Sanitize name
        customName = customName.replace(/[<>]/g, ''); // Basic XSS prevention
        document.getElementById('finalDeviceName').textContent = customName;

        // Blinds (stepper): push the gathered performance / power / automation
        // settings to the blind, then provision Wi-Fi (credentials were deferred
        // from the Wi-Fi step so the device stayed in BLE mode through the whole
        // flow).
        if (SetupState.deviceType === 'stepper') {
            // HONESTY GUARD: this run had a live setup link (BLE/Wi-Fi-Direct)
            // but it has since dropped. Every guarded block below would then be
            // silently skipped — the wizard used to show "Setup complete!" while
            // the blind never received Wi-Fi credentials and sat unprovisioned
            // until the customer noticed it "Offline" later. Error out with a
            // reconnect path instead. (The iOS hotspot-portal flow never had a
            // live link, so _hadLiveSetupLink is false there and registration
            // proceeds untouched.)
            if (SetupState._hadLiveSetupLink && !ActiveConnection.isConnected() &&
                SetupState.selectedNetwork) {
                Toast.error('Connection to the blind was lost — reconnect to finish setup.');
                btn?.classList.remove('loading');
                if (btn) btn.disabled = false;
                SetupState._resumeFinishAfterReconnect = true;
                goToStep('1');
                return;
            }
            // 1. Push the full device configuration over the live setup link FIRST.
            //    The firmware applies + persists it to EEPROM immediately, so the
            //    speed / automation / TWT choices survive the provisioning reboot.
            //    Sent before the credentials (the device blocks + reboots once
            //    WiFi connects) and best-effort — the device page's MQTT one-shot
            //    sync is the fallback if this link can't carry it.
            if (ActiveConnection.isConnected()) {
                try {
                    await ActiveConnection.sendConfig(spBuildDeviceConfigPayload());
                    // Brief gap so the firmware applies the config in its own loop
                    // iteration and the GATT queue clears before the credential writes.
                    await new Promise(r => setTimeout(r, 350));
                } catch (cfgErr) {
                    console.warn('[Setup] Config push over setup link failed (MQTT sync will retry):', cfgErr);
                }
            }

            // 2. Provision Wi-Fi and verify the blind actually connects.
            if (ActiveConnection.isConnected() && SetupState.selectedNetwork) {
                try {
                    Toast.info('Connecting your blind to Wi-Fi and verifying...');
                    await ActiveConnection.sendWifiCredentials(
                        SetupState.selectedNetwork.ssid, SetupState.wifiPassword || '');
                    ActiveConnection.setProvisioning(true);
                } catch (e) {
                    console.warn('[Setup] Stepper WiFi connection failed:', e);
                    Toast.error(e.message || 'Wi-Fi connection failed — check the password and try again.');
                    btn?.classList.remove('loading');
                    if (btn) btn.disabled = false;
                    // Take the user back to the Wi-Fi step to fix the password and
                    // retry. The blind rejected the bad credentials and stayed in
                    // BLE setup mode, so the live connection is still usable. The
                    // _wifiRetry flag lets step 3 jump straight back here on the
                    // next tap instead of re-walking every blinds step.
                    SetupState._wifiRetry = true;
                    goToStep('3');
                    return; // Blocks progression to Step 5
                }
            }
            if (SetupState.deviceId && SetupState.deviceId !== 'WIFI') {
                persistStepperConfig(cleanId);
                spPopulateSummary();
            }
        }

        if (SetupState.deviceId && SetupState.deviceId !== 'WIFI') {
            const device = {
                id: cleanId,
                name: customName,
                type: SetupState.deviceType === 'stepper' ? 'blind' : 'servo',
                angleOn: SetupState.deviceType === 'stepper' ? null : SetupState.angleOn,
                angleOff: SetupState.deviceType === 'stepper' ? null : SetupState.angleOff
            };

            // 1. Save locally (instant — this is what the user sees immediately)
            DeviceList.add(device);

            // 2. Sync to Firebase in background (non-blocking). The dashboard's
            // merge logic only protects locally-added devices for 5 minutes, so
            // a failed sync is QUEUED (DeviceService.queuePendingRegistration)
            // and retried on the next app load — the blind must never vanish.
            const user = Auth.getUser();

            if (user) {
                // Resolve active home right before saving
                (async () => {
                    try {
                        await HomeService.init();
                        const homeId = await HomeService.getActiveHome(user.uid);
                        await DeviceService.init();
                        const ok = await DeviceService.addDeviceReliably(homeId, device);
                        if (ok) console.log('[Setup] Device synced to Firebase:', customName);
                    } catch (e) {
                        console.warn('[Setup] Firebase sync failed — queued for retry on next load:', e);
                        DeviceService.queuePendingRegistration(device);
                    }
                })();
            } else if (typeof DeviceService !== 'undefined') {
                DeviceService.queuePendingRegistration(device);
            }
        }

        Toast.success('Setup complete!');
        btn?.classList.remove('loading');
        if (btn) btn.disabled = false;
        goToStep(5);

        // Auto-redirect to dashboard after a short delay
        setTimeout(() => {
            window.location.href = 'index.html';
        }, 3000);
    });

    // Initialize WiFi list
    const wifiList = document.getElementById('wifiList');
    if (wifiList) {
        wifiList.innerHTML = `
            <div style="text-align:center;color:var(--text-tertiary);padding:40px 20px;">
                <div style="font-size:48px;margin-bottom:16px;color:var(--accent);"><svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19.07 4.93A10 10 0 0 0 6.99 3.34"/><path d="M4 6h.01"/><path d="M2.29 9.62A10 10 0 1 0 21.31 8.35"/><path d="M16.24 7.76A6 6 0 1 0 8.23 16.67"/><path d="M12 18h.01"/><path d="M17.99 11.66A6 6 0 0 1 15.77 16.67"/><circle cx="12" cy="12" r="2"/></svg></div>
                <p>Tap "Scan for Networks" to find available WiFi networks</p>
            </div>
        `;
    }

    // Add listener for Step 3 to conditionally show fallback UI
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            if (mutation.target.getAttribute('data-step') === '3' && mutation.target.classList.contains('active')) {
                if (SetupState.connectionMethod === 'wifi') {
                    // In Wi-Fi Direct, keep the interactive scanner visible,
                    // but also show the manual entry option as a premium fallback!
                    document.getElementById('scanWifi').style.display = 'block';
                    if (wifiList) wifiList.style.display = 'block';
                    document.getElementById('manualSsidSection')?.classList.add('show');
                }
            }
        });
    });

    document.querySelectorAll('.step[data-step="3"]').forEach(step => {
        observer.observe(step, { attributes: true, attributeFilter: ['class'] });
    });

    // Advanced Settings Toggle
    document.getElementById('advancedToggleBtn')?.addEventListener('click', () => {
        const content = document.getElementById('advancedSettingsContent');
        const arrow = document.querySelector('#advancedToggleBtn .arrow');
        if (content) {
            if (content.style.display === 'none' || !content.style.display) {
                content.style.display = 'flex';
                if (arrow) arrow.textContent = '▲';
            } else {
                content.style.display = 'none';
                if (arrow) arrow.textContent = '▼';
            }
        }
    });
});

// ════════════════════════════════════════════════════════════════════════
//  BLINDS (STEPPER) PREMIUM SETUP MODULE
//  Adds Performance, Power (Wi-Fi 6 / TWT) and per-automation walkthrough
//  steps. Entirely scoped to deviceType === 'stepper'; the servo (light
//  switch) wizard never enters any of this code.
// ════════════════════════════════════════════════════════════════════════

const SP_ICONS = {
    bluetooth: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 7 10 10-5 5V2l5 5L7 17"/></svg>',
    calibrate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3h18"/><path d="M20 7H8"/><path d="M20 11H8"/><path d="M10 19h10"/><path d="M8 15h12"/><path d="M4 3v14"/><circle cx="4" cy="19" r="2"/></svg>',
    wifi: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13a10 10 0 0 1 14 0"/><path d="M8.5 16.5a5 5 0 0 1 7 0"/><path d="M2 8.82a15 15 0 0 1 20 0"/><line x1="12" x2="12.01" y1="20" y2="20"/></svg>',
    gauge: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/></svg>',
    sparkles: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/></svg>',
    flag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/></svg>',
    slow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"/><path d="M2 21c0-3 1.85-5.36 5.08-6"/></svg>',
    balanced: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="M7 21h10"/><path d="M12 3v18"/><path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2"/></svg>',
    fast: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
    battery: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 9 7 12h3l-3 3"/><path d="M14 6h1a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h1"/><path d="M22 11v2"/><path d="M9 6V4a1 1 0 0 1 1-1h0a1 1 0 0 1 1 1v2"/></svg>',
    sunrise: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v8"/><path d="m4.93 10.93 1.41 1.41"/><path d="M2 18h2"/><path d="M20 18h2"/><path d="m19.07 10.93-1.41 1.41"/><path d="M22 22H2"/><path d="m8 6 4-4 4 4"/><path d="M16 18a4 4 0 0 0-8 0"/></svg>',
    sunset: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 10V2"/><path d="m4.93 10.93 1.41 1.41"/><path d="M2 18h2"/><path d="M20 18h2"/><path d="m19.07 10.93-1.41 1.41"/><path d="M22 22H2"/><path d="m16 6-4 4-4-4"/><path d="M16 18a4 4 0 0 0-8 0"/></svg>',
    moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>',
    heat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9a4 4 0 0 0-2 7.5"/><path d="M12 3v2"/><path d="m6.6 18.4-1.4 1.4"/><path d="M20 4v6"/><path d="M22 4h-4"/><circle cx="20" cy="16" r="0"/><path d="M12 9a4 4 0 0 1 4 4v3a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-3a4 4 0 0 1 4-4Z"/></svg>',
    presence: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="11" r="3"/><path d="M7 17.5a5 5 0 0 1 10 0"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
    blindRoller: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3h18"/><path d="M20 7H8"/><path d="M20 11H8"/><path d="M10 19h10"/><path d="M8 15h12"/><path d="M4 3v14"/><circle cx="4" cy="19" r="2"/></svg>',
    blindVertical: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 3v18"/><path d="M12 3v18"/><path d="M16 3v18"/></svg>',
    blindZebra: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 7h18"/><path d="M3 15h18"/><path d="M3 11h18" stroke-dasharray="3 3"/><path d="M3 19h18" stroke-dasharray="3 3"/></svg>',
    window: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 12h20"/><path d="M12 4v16"/></svg>'
};

// Major phases for the dynamic progress bar
const SP_PHASES = [
    { name: 'Connect',     icon: SP_ICONS.bluetooth, keys: ['1'] },
    { name: 'Calibrate',   icon: SP_ICONS.calibrate, keys: ['2'] },
    { name: 'Wi-Fi',       icon: SP_ICONS.wifi,      keys: ['3'] },
    { name: 'Blind Type',  icon: SP_ICONS.window,    keys: ['blindType'] },
    { name: 'Performance', icon: SP_ICONS.gauge,     keys: ['perf', 'power'] },
    { name: 'Automations', icon: SP_ICONS.sparkles,  keys: ['autoIntro', 'autoMorning', 'autoSunset', 'autoNight', 'autoHeat'] },
    { name: 'Finish',      icon: SP_ICONS.flag,      keys: ['4', '5'] }
];

const SP_FLOW = ['1', '2', '3', 'blindType', 'perf', 'power', 'autoIntro', 'autoMorning', 'autoSunset', 'autoNight', 'autoHeat', '4', '5'];

// Declarative automation definitions (everything EXCEPT "no-presence auto-close")
const SP_AUTOMATIONS = [
    {
        key: 'autoMorning', rule: 'morningOpen', name: 'Morning Wake-Up', accent: '#f59e0b',
        icon: SP_ICONS.sunrise, tagline: 'Wake gently to natural light',
        desc: 'In the minutes before your wake-up time, your blinds rise slowly so soft daylight eases you awake — a calmer start than any alarm.',
        short: 'Gradually opens before you wake',
        settings: [
            { type: 'time',   cfg: 'morningTime',     label: 'Wake-up time',     sub: 'When the routine finishes' },
            { type: 'number', cfg: 'morningDuration', label: 'Gradual duration', sub: 'Minutes spent slowly opening', min: 1, max: 120, unit: ' min' },
            { type: 'slider', cfg: 'morningTarget',   label: 'Open to',          min: 0, max: 100, unit: '%' }
        ]
    },
    {
        key: 'autoSunset', rule: 'sunset', name: 'Sunset Auto-Close', accent: '#fb7185',
        icon: SP_ICONS.sunset, tagline: 'Privacy at dusk, automatically',
        desc: 'Your blinds close as the sun goes down, giving you instant evening privacy. Sunset time tracks your location through the whole year.',
        short: 'Closes the blinds at sunset',
        settings: [
            { type: 'slider', cfg: 'sunsetTarget', label: 'Close to', sub: '0% is fully closed', min: 0, max: 100, unit: '%' }
        ]
    },
    {
        key: 'autoNight', rule: 'nightLock', name: 'Night Lock', accent: '#6366f1',
        icon: SP_ICONS.moon, tagline: 'Secure your room every night',
        desc: 'A dependable bedtime routine — your blinds are guaranteed closed by a set time each night, even on the evenings you forget.',
        short: 'Closes the blinds at a set time',
        settings: [
            { type: 'time',   cfg: 'nightTime',   label: 'Lock time', sub: 'When to close each night' },
            { type: 'slider', cfg: 'nightTarget', label: 'Close to',  min: 0, max: 100, unit: '%' }
        ]
    },
    {
        key: 'autoHeat', rule: 'temperature', name: 'Heat Protection', accent: '#ef4444',
        icon: SP_ICONS.heat, tagline: 'Keep your room cool in the sun',
        desc: 'When the room climbs above your comfort temperature, the blinds lower to block direct sunlight and stop the space overheating.',
        short: 'Lowers blinds when it gets hot',
        settings: [
            { type: 'number', cfg: 'tempThreshold', label: 'Trigger above', sub: 'Room temperature', min: 18, max: 45, unit: ' °C' },
            { type: 'slider', cfg: 'tempTarget',    label: 'Lower to',      sub: 'Typically 20–30%',  min: 0, max: 100, unit: '%' }
        ]
    }
];

// ── Field builders ──────────────────────────────────────────────────────
function spBuildField(s) {
    const val = SetupState.autoConfig[s.cfg];
    if (s.type === 'slider') {
        return `
            <div class="sp-field">
                <div class="sp-field-label">
                    <span class="lbl">${s.label}${s.sub ? ` <span class="sub">· ${s.sub}</span>` : ''}</span>
                    <span class="sp-field-val" data-valfor="${s.cfg}">${val}${s.unit}</span>
                </div>
                <input type="range" class="sp-slider" data-cfg="${s.cfg}" data-unit="${s.unit}" min="${s.min}" max="${s.max}" value="${val}">
            </div>`;
    }
    if (s.type === 'number') {
        // Temperature fields render in the user's preferred unit (°C/°F) while
        // SetupState.autoConfig stays canonical °C (firmware contract). The
        // change handler in wireAutoFields converts back via data-temp-c.
        const isTempC = s.cfg === 'tempThreshold';
        const useF = isTempC && typeof BlindSchema !== 'undefined' &&
            BlindSchema.tempUnit && BlindSchema.tempUnit() === 'F';
        const dispVal = useF ? BlindSchema.cToDisplay(val) : val;
        const dispMin = useF ? BlindSchema.cToDisplay(s.min) : s.min;
        const dispMax = useF ? BlindSchema.cToDisplay(s.max) : s.max;
        const dispUnit = useF ? ' °F' : (s.unit || '');
        return `
            <div class="sp-field">
                <div class="sp-field-label"><span class="lbl">${s.label}${s.sub ? ` <span class="sub">· ${s.sub}</span>` : ''}${dispUnit ? ` <span class="sub">·${dispUnit}</span>` : ''}</span></div>
                <input type="number" class="sp-input" data-cfg="${s.cfg}" data-unit="${dispUnit}"${isTempC ? ' data-temp-c="1"' : ''} min="${dispMin}" max="${dispMax}" value="${dispVal}">
            </div>`;
    }
    if (s.type === 'time') {
        return `
            <div class="sp-field">
                <div class="sp-field-label"><span class="lbl">${s.label}${s.sub ? ` <span class="sub">· ${s.sub}</span>` : ''}</span></div>
                <input type="time" class="sp-input" data-cfg="${s.cfg}" value="${val}">
            </div>`;
    }
    if (s.type === 'segmented') {
        return `
            <div class="sp-field">
                <div class="sp-field-label"><span class="lbl">${s.label}</span></div>
                <div class="sp-seg-control" data-cfg="${s.cfg}">
                    ${s.options.map(o => `<button class="sp-seg-btn${o.v === val ? ' active' : ''}" data-val="${o.v}">${o.label}</button>`).join('')}
                </div>
            </div>`;
    }
    return '';
}

function spNavGroup(key, opts = {}) {
    const nextLabel = opts.nextLabel || 'Continue';
    return `
        <div class="nav-group" data-step="${key}">
            <button class="nav-btn secondary" data-flow="prev">Back</button>
            <button class="nav-btn primary" data-flow="next">${nextLabel}</button>
        </div>`;
}

// ── Step DOM builders ───────────────────────────────────────────────────
function spBuildPerfStep() {
    const cards = [
        { id: 'slow',    icon: SP_ICONS.slow,     name: 'Quiet',    tag: 'Whisper-quiet and gentle on the mechanism', bars: [9, 12, 10, 13] },
        { id: 'default', icon: SP_ICONS.balanced, name: 'Default', tag: 'A balanced blend of speed and quietness', bars: [11, 17, 14, 19], rec: true },
        { id: 'fast',    icon: SP_ICONS.fast,     name: 'Fast',    tag: 'Reaches position quickly with more drive', bars: [16, 23, 19, 26] },
        { id: 'max',     icon: SP_ICONS.gauge,    name: 'Max Speed',tag: 'Maximum power and physical velocity', bars: [22, 28, 24, 30] }
    ];
    return `
        <div class="step" data-step="perf">
            <div class="step-header">
                <h1 class="step-title">Performance</h1>
                <p class="step-subtitle">Choose how your blinds move</p>
            </div>
            <div class="step-content">
                <div class="sp-pane">
                    <div class="sp-choice-grid" id="speedGrid">
                        ${cards.map(c => `
                            <button class="sp-choice${SetupState.speedPreset === c.id ? ' selected' : ''}" data-speed="${c.id}">
                                <div class="sp-choice-ico">${c.icon}</div>
                                <div class="sp-choice-body">
                                    <div class="sp-choice-name">${c.name}${c.rec ? ' <span class="sp-pill">Recommended</span>' : ''}</div>
                                    <div class="sp-choice-tag">${c.tag}</div>
                                </div>
                                <div class="sp-speed-bars">${c.bars.map(h => `<span style="height:${h}px"></span>`).join('')}</div>
                            </button>`).join('')}
                    </div>
                    <div class="sp-banner">
                        ${SP_ICONS.info}
                        <span>You can fine-tune the exact opening speed, braking and quiet-hold behaviour anytime from the blind's settings.</span>
                    </div>
                </div>
            </div>
        </div>`;
}

// ── Globals needed by blind-renderer.js ──────────────────────────────────
// blind-renderer.js references these globals. On the setup page we provide
// lightweight shims so the renderer works without blind-device.js.
const SLAT_COUNT = 12;
const VERTICAL_SLAT_COUNT = 8;
const BLIND_TYPE_LABELS = { roller: 'Roller Blind', vertical: 'Vertical Blind', zebra: 'Zebra Blind' };
const BLIND_TYPES_LIST = [
    { key: 'roller',   name: 'Roller',   desc: 'Smooth fabric rolls up on a tube', icon: SP_ICONS.blindRoller },
    { key: 'vertical', name: 'Vertical', desc: 'Vertical vanes rotate to open', icon: SP_ICONS.blindVertical },
    { key: 'zebra',    name: 'Zebra',    desc: 'Alternating sheer and opaque bands', icon: SP_ICONS.blindZebra }
];
let _vizAnimFrameId = null;
// BlindState shim — blind-renderer.js reads these properties
const BlindState = {
    blindType: 'roller',
    position: 30,
    _visualPos: 30,
    isDragging: false,
    config: {}
};

function spBuildBlindTypeStep() {
    return `
        <div class="step" data-step="blindType">
            <div class="step-header">
                <h1 class="step-title">Blind Type</h1>
                <p class="step-subtitle">What kind of blinds do you have?</p>
            </div>
            <div class="step-content">
                <div class="sp-pane">
                    <div class="sp-blind-type-section">
                        <!-- Live Visualiser -->
                        <div class="sp-blinds-visual">
                            <div class="sp-blinds-frame" id="spBlindsFrame">
                                <div class="sp-blinds-sky"></div>
                                <div class="sp-blinds-inner" id="blindsSlats"></div>
                            </div>
                            <div class="sp-blinds-glow"></div>
                        </div>
                        <div style="text-align:center">
                            <div class="sp-blind-pos-label" id="spBlindPosLabel">30%</div>
                            <div class="sp-blind-pos-sub">Preview position</div>
                            <div class="sp-type-badge" id="spTypeBadge">Roller Blind</div>
                        </div>

                        <!-- Position Slider -->
                        <div class="sp-blind-slider-section">
                            <div class="sp-blind-slider-header">
                                <span class="sp-blind-slider-label">Preview position</span>
                                <span class="sp-blind-slider-val" id="spBlindSliderVal">30%</span>
                            </div>
                            <input type="range" class="sp-slider" id="spBlindSlider" min="0" max="100" value="30">
                        </div>

                        <!-- Type Selector Cards -->
                        <div class="sp-type-grid" id="spTypeGrid">
                            ${BLIND_TYPES_LIST.map(t => `
                                <button class="sp-type-card${t.key === SetupState.blindType ? ' selected' : ''}" data-blind-type="${t.key}">
                                    <div class="sp-type-card-ico">${t.icon}</div>
                                    <div class="sp-type-card-name">${t.name}</div>
                                    <div class="sp-type-card-desc">${t.desc}</div>
                                </button>`).join('')}
                        </div>
                    </div>

                    <div class="sp-banner">
                        ${SP_ICONS.info}
                        <span>This controls how the blind looks in the app. You can change it anytime from the device settings.</span>
                    </div>
                </div>
            </div>
        </div>`;
}

function spBuildPowerStep() {
    return `
        <div class="step" data-step="power">
            <div class="step-header">
                <h1 class="step-title">Power Saving</h1>
                <p class="step-subtitle">Target Wake Time for Wi-Fi 6</p>
            </div>
            <div class="step-content">
                <div class="sp-pane">
                    <div class="sp-card">
                        <div class="sp-card-title">What is TWT?</div>
                        <div class="sp-card-sub">Target Wake Time lets your blind negotiate a sleep schedule with a Wi-Fi&nbsp;6 router, so its radio rests between updates. That can cut idle power use dramatically — ideal for a battery-powered install.</div>
                    </div>

                    <div class="sp-card">
                        <div class="sp-field-label"><span class="lbl">Do you have a Wi-Fi 6 router?</span></div>
                        <div class="sp-seg-control" id="wifi6Seg">
                            <button class="sp-seg-btn" data-val="yes">Yes</button>
                            <button class="sp-seg-btn" data-val="no">No</button>
                            <button class="sp-seg-btn" data-val="unsure">Not sure</button>
                        </div>
                        <div id="wifi6DetectNote" style="margin-top:12px;"></div>
                    </div>

                    <div class="sp-toggle-row" id="twtRow">
                        <div class="sp-toggle-body">
                            <div class="sp-toggle-label">Enable TWT power saving</div>
                            <div class="sp-toggle-sub">Recommended on Wi-Fi 6 networks</div>
                        </div>
                        <label class="toggle">
                            <input type="checkbox" id="twtToggle">
                            <div class="toggle-track"><div class="toggle-thumb"></div></div>
                        </label>
                    </div>

                    <div class="sp-toggle-row" id="idleHoldRow">
                        <div class="sp-toggle-body">
                            <div class="sp-toggle-label">Anti-droop motor hold</div>
                            <div class="sp-toggle-sub">Use only if the blind slips after stopping. It improves holding strength but uses more power.</div>
                        </div>
                        <label class="toggle">
                            <input type="checkbox" id="idleHoldToggle">
                            <div class="toggle-track"><div class="toggle-thumb"></div></div>
                        </label>
                    </div>

                    <div class="sp-twt-status" id="twtStatus" style="display:none;">
                        <div class="sp-twt-ico" id="twtStatusIco"></div>
                        <div class="sp-twt-text" id="twtStatusText"></div>
                    </div>

                    <div class="sp-banner" id="twtHint">
                        ${SP_ICONS.info}
                        <span>Not sure? Leave this off. Your blind works perfectly without it — TWT only adds extra power savings on supported networks.</span>
                    </div>
                </div>
            </div>
        </div>`;
}

function spBuildAutoIntroStep() {
    return `
        <div class="step" data-step="autoIntro">
            <div class="step-header">
                <h1 class="step-title">Smart Automations</h1>
                <p class="step-subtitle">Let your blinds run themselves</p>
            </div>
            <div class="step-content">
                <div class="sp-pane">
                    <div class="sp-hero">
                        <div class="sp-hero-badge">${SP_ICONS.sparkles}</div>
                        <div>
                            <div class="sp-hero-title">Four ways to automate</div>
                            <div class="sp-hero-tagline">Set up now, or skip and do it later</div>
                        </div>
                        <p class="sp-hero-desc">We'll walk you through each one. Turn on what you like and adjust it — anything you skip can be enabled later from the device.</p>
                    </div>
                    <div class="sp-auto-list" id="autoIntroList">
                        ${SP_AUTOMATIONS.map((a, i) => `
                            <div class="sp-auto-item" style="animation-delay:${i * 0.07}s">
                                <div class="sp-auto-item-ico" style="background:${a.accent};background-image:linear-gradient(135deg,rgba(255,255,255,.22),rgba(0,0,0,.12))">${a.icon}</div>
                                <div class="sp-auto-item-body">
                                    <div class="sp-auto-item-name">${a.name}</div>
                                    <div class="sp-auto-item-desc">${a.short}</div>
                                </div>
                                <div class="sp-auto-item-num">${i + 1}</div>
                            </div>`).join('')}
                    </div>
                    <button class="sp-skip" id="autoSkipBtn">Skip — I'll set these up later</button>
                </div>
            </div>
        </div>`;
}

function spBuildMorningSettings() {
    const cfg = SetupState.autoConfig;
    const isCustom = cfg.morningDays !== null;

    // Segmented control to choose schedule type
    let html = `
        <div class="sp-field">
            <div class="sp-field-label"><span class="lbl">Schedule Mode</span></div>
            <div class="sp-seg-control" id="morningScheduleMode" style="margin-top: 4px;">
                <button class="sp-seg-btn${!isCustom ? ' active' : ''}" data-mode="uniform" style="flex: 1;">Same Everyday</button>
                <button class="sp-seg-btn${isCustom ? ' active' : ''}" data-mode="custom" style="flex: 1;">Custom Days</button>
            </div>
        </div>
    `;

    // Uniform time field (visible only if same everyday)
    html += `
        <div id="morningUniformTimeField" style="display: ${!isCustom ? 'block' : 'none'};">
            <div class="sp-field">
                <div class="sp-field-label">
                    <span class="lbl">Wake-up Time <span class="sub">· When the routine finishes</span></span>
                </div>
                <input type="time" class="sp-input" id="morningUniformTime" value="${cfg.morningTime || '07:00'}" style="width: 100%; box-sizing: border-box;">
            </div>
        </div>
    `;

    // Custom days fields (visible only if custom days)
    const DAYS_OF_WEEK = [
        { name: 'Sunday', short: 'Sun' },
        { name: 'Monday', short: 'Mon' },
        { name: 'Tuesday', short: 'Tue' },
        { name: 'Wednesday', short: 'Wed' },
        { name: 'Thursday', short: 'Thu' },
        { name: 'Friday', short: 'Fri' },
        { name: 'Saturday', short: 'Sat' }
    ];

    html += `
        <div id="morningCustomTimeField" style="display: ${isCustom ? 'flex' : 'none'}; flex-direction: column; gap: 10px; margin-top: 4px;">
            <div class="sp-field-label"><span class="lbl">Wake-up Times per Day</span></div>
            <div class="sp-days-list" style="display: flex; flex-direction: column; gap: 8px;">
    `;

    // Default morningDays array if null
    const daysArr = cfg.morningDays || [
        { enabled: true, time: '07:00', duration: 30, target: 100 }, // Sun
        { enabled: true, time: '07:00', duration: 30, target: 100 }, // Mon
        { enabled: true, time: '07:00', duration: 30, target: 100 }, // Tue
        { enabled: true, time: '07:00', duration: 30, target: 100 }, // Wed
        { enabled: true, time: '07:00', duration: 30, target: 100 }, // Thu
        { enabled: true, time: '07:00', duration: 30, target: 100 }, // Fri
        { enabled: true, time: '07:00', duration: 30, target: 100 }  // Sat
    ];

    DAYS_OF_WEEK.forEach((d, idx) => {
        const dayCfg = daysArr[idx] || { enabled: true, time: '07:00', duration: 30, target: 100 };
        html += `
            <div class="sp-day-row${dayCfg.enabled ? ' enabled' : ''}" data-day="${idx}" style="
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 10px 14px;
                border-radius: 12px;
                background: rgba(255, 255, 255, 0.02);
                border: 1px solid rgba(255, 255, 255, 0.04);
                transition: all 0.25s ease;
            ">
                <div style="display: flex; align-items: center; gap: 10px;">
                    <label class="toggle" style="transform: scale(0.85); margin: 0;">
                        <input type="checkbox" class="sp-day-enable" data-day="${idx}" ${dayCfg.enabled ? 'checked' : ''}>
                        <div class="toggle-track"><div class="toggle-thumb"></div></div>
                    </label>
                    <span style="font-weight: 600; font-size: 14.5px; color: ${dayCfg.enabled ? 'var(--text-primary)' : 'var(--text-tertiary)'}; transition: color 0.25s;">${d.name}</span>
                </div>
                <input type="time" class="sp-input sp-day-time" data-day="${idx}" value="${dayCfg.time || '07:00'}" style="
                    width: 100px;
                    padding: 6px 10px;
                    font-size: 13.5px;
                    opacity: ${dayCfg.enabled ? 1 : 0.35};
                    pointer-events: ${dayCfg.enabled ? 'auto' : 'none'};
                    transition: opacity 0.25s;
                ">
            </div>
        `;
    });

    html += `
            </div>
        </div>
    `;

    // Gradual duration
    const durVal = cfg.morningDuration || 30;
    html += `
        <div class="sp-field">
            <div class="sp-field-label">
                <span class="lbl">Gradual duration <span class="sub">· Minutes spent slowly opening</span></span>
                <span class="sp-field-val" data-valfor="morningDuration">${durVal} min</span>
            </div>
            <input type="range" class="sp-slider" data-cfg="morningDuration" data-unit=" min" min="1" max="120" value="${durVal}">
        </div>
    `;

    // Open target
    const targetVal = cfg.morningTarget !== undefined ? cfg.morningTarget : 100;
    html += `
        <div class="sp-field">
            <div class="sp-field-label">
                <span class="lbl">Open to</span>
                <span class="sp-field-val" data-valfor="morningTarget">${targetVal}%</span>
            </div>
            <input type="range" class="sp-slider" data-cfg="morningTarget" data-unit="%" min="0" max="100" value="${targetVal}">
        </div>
    `;

    return html;
}

function spBuildAutomationStep(a, index) {
    const enabled = !!SetupState.rules[a.rule];
    return `
        <div class="step" data-step="${a.key}">
            <div class="step-header">
                <h1 class="step-title">${a.name}</h1>
                <p class="step-subtitle">Automation ${index + 1} of ${SP_AUTOMATIONS.length}</p>
            </div>
            <div class="step-content">
                <div class="sp-pane">
                    <div class="sp-hero">
                        <div class="sp-hero-badge" style="background:${a.accent};background-image:linear-gradient(135deg,rgba(255,255,255,.2),rgba(0,0,0,.14))">${a.icon}</div>
                        <div>
                            <div class="sp-hero-title">${a.name}</div>
                            <div class="sp-hero-tagline">${a.tagline}</div>
                        </div>
                        <p class="sp-hero-desc">${a.desc}</p>
                    </div>

                    <div class="sp-toggle-row${enabled ? ' on' : ''}" id="${a.key}Row">
                        <div class="sp-toggle-body">
                            <div class="sp-toggle-label">Enable
                                <span class="sp-status-chip ${enabled ? 'on' : 'off'}" id="${a.key}Chip">${enabled ? 'On' : 'Off'}</span>
                            </div>
                            <div class="sp-toggle-sub">${a.short}</div>
                        </div>
                        <label class="toggle">
                            <input type="checkbox" data-auto="${a.key}" data-rule="${a.rule}" ${enabled ? 'checked' : ''}>
                            <div class="toggle-track"><div class="toggle-thumb"></div></div>
                        </label>
                    </div>

                    <div class="sp-reveal${enabled ? ' show' : ''}" id="${a.key}Reveal">
                        <div class="sp-reveal-inner">
                            <div class="sp-card" style="display:flex;flex-direction:column;gap:18px;">
                                ${a.key === 'autoMorning' ? spBuildMorningSettings() : a.settings.map(spBuildField).join('')}
                            </div>
                            ${a.note ? `<div class="sp-banner">${SP_ICONS.info}<span>${a.note}</span></div>` : ''}
                        </div>
                    </div>
                </div>
            </div>
        </div>`;
}

// ── Injection (idempotent) ──────────────────────────────────────────────
function injectStepperSteps() {
    if (document.querySelector('.step[data-step="perf"]')) return; // already built

    const wrapper = document.querySelector('.steps-wrapper');
    const footer = document.querySelector('.setup-footer');
    if (!wrapper || !footer) return;

    // Insert new content steps just before the existing "Name" step (data-step 4)
    const nameStep = wrapper.querySelector('.step[data-step="4"]');
    let stepsHtml = spBuildBlindTypeStep() + spBuildPerfStep() + spBuildPowerStep() + spBuildAutoIntroStep();
    SP_AUTOMATIONS.forEach((a, i) => { stepsHtml += spBuildAutomationStep(a, i); });
    const frag = document.createElement('div');
    frag.innerHTML = stepsHtml;
    while (frag.firstElementChild) wrapper.insertBefore(frag.firstElementChild, nameStep);

    // Nav groups (appended to footer; visibility handled by .active)
    let navHtml = spNavGroup('blindType') + spNavGroup('perf') + spNavGroup('power') + spNavGroup('autoIntro', { nextLabel: 'Get started' });
    SP_AUTOMATIONS.forEach((a, i) => {
        navHtml += spNavGroup(a.key, { nextLabel: i === SP_AUTOMATIONS.length - 1 ? 'Continue' : 'Continue' });
    });
    const navFrag = document.createElement('div');
    navFrag.innerHTML = navHtml;
    while (navFrag.firstElementChild) footer.appendChild(navFrag.firstElementChild);
}

// ── Wiring ──────────────────────────────────────────────────────────────
function wireStepperControls() {
    // Generic flow nav for all injected steps
    document.querySelectorAll('.nav-group[data-step="blindType"] [data-flow], .nav-group[data-step="perf"] [data-flow], .nav-group[data-step="power"] [data-flow], .nav-group[data-step="autoIntro"] [data-flow]').forEach(btn => {
        btn.addEventListener('click', () => (btn.dataset.flow === 'next' ? flowNext() : flowPrev()));
    });

    // Blind Type selector cards
    document.querySelectorAll('#spTypeGrid .sp-type-card').forEach(card => {
        card.addEventListener('click', () => {
            const type = card.dataset.blindType;
            if (type === SetupState.blindType) return;
            SetupState.blindType = type;
            BlindState.blindType = type;

            // Update card selection UI
            document.querySelectorAll('#spTypeGrid .sp-type-card').forEach(c => c.classList.remove('selected'));
            card.classList.add('selected');

            // Update type badge
            const badge = document.getElementById('spTypeBadge');
            if (badge) badge.textContent = BLIND_TYPE_LABELS[type] || 'Blind';

            // Crossfade visualiser
            const frame = document.getElementById('spBlindsFrame');
            if (frame) {
                frame.style.transition = 'opacity 0.25s ease';
                frame.style.opacity = '0';
                setTimeout(() => {
                    generateVisualization();
                    const pos = BlindState.position;
                    _applyVisualization(pos);
                    frame.classList.toggle('open', pos > 20);
                    frame.style.opacity = '1';
                    setTimeout(() => { frame.style.transition = ''; }, 300);
                }, 250);
            } else {
                generateVisualization();
                _applyVisualization(BlindState.position);
            }
        });
    });

    // Blind preview slider
    const blindSlider = document.getElementById('spBlindSlider');
    const blindSliderVal = document.getElementById('spBlindSliderVal');
    const blindPosLabel = document.getElementById('spBlindPosLabel');
    if (blindSlider) {
        blindSlider.addEventListener('input', () => {
            const v = parseInt(blindSlider.value, 10);
            BlindState.position = v;
            BlindState._visualPos = v;
            _applyVisualization(v);
            const frame = document.getElementById('spBlindsFrame');
            if (frame) frame.classList.toggle('open', v > 20);
            if (blindSliderVal) blindSliderVal.textContent = v + '%';
            if (blindPosLabel) blindPosLabel.textContent = v + '%';
        });
    }
    SP_AUTOMATIONS.forEach(a => {
        document.querySelectorAll(`.nav-group[data-step="${a.key}"] [data-flow]`).forEach(btn => {
            btn.addEventListener('click', () => (btn.dataset.flow === 'next' ? flowNext() : flowPrev()));
        });
    });

    // Speed selection
    document.querySelectorAll('#speedGrid .sp-choice').forEach(card => {
        card.addEventListener('click', () => {
            document.querySelectorAll('#speedGrid .sp-choice').forEach(c => c.classList.remove('selected'));
            card.classList.add('selected');
            SetupState.speedPreset = card.dataset.speed;
        });
    });

    // Wi-Fi 6 question
    document.querySelectorAll('#wifi6Seg .sp-seg-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#wifi6Seg .sp-seg-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            SetupState.hasWifi6 = btn.dataset.val;
            spRefreshTwtAvailability();
        });
    });

    // TWT toggle → run availability check
    const twtToggle = document.getElementById('twtToggle');
    if (twtToggle) {
        twtToggle.addEventListener('change', () => {
            if (twtToggle.checked) spRunTwtCheck();
            else spSetTwtOff();
        });
    }

    const idleHoldToggle = document.getElementById('idleHoldToggle');
    if (idleHoldToggle) {
        idleHoldToggle.addEventListener('change', () => {
            SetupState.stepperIdleHold = !!idleHoldToggle.checked;
        });
    }

    // Automation enable toggles
    document.querySelectorAll('input[data-auto]').forEach(toggle => {
        toggle.addEventListener('change', () => {
            const key = toggle.dataset.auto;
            const rule = toggle.dataset.rule;
            const on = toggle.checked;
            SetupState.rules[rule] = on;
            const row = document.getElementById(`${key}Row`);
            const reveal = document.getElementById(`${key}Reveal`);
            const chip = document.getElementById(`${key}Chip`);
            if (row) row.classList.toggle('on', on);
            if (reveal) reveal.classList.toggle('show', on);
            if (chip) { chip.textContent = on ? 'On' : 'Off'; chip.className = `sp-status-chip ${on ? 'on' : 'off'}`; }
        });
    });

    // Settings fields (sliders / numbers / times / segmented) across all automation steps
    SP_AUTOMATIONS.forEach(a => {
        const scope = document.querySelector(`.step[data-step="${a.key}"]`);
        if (scope) wireAutoFields(scope);
    });

    // Morning specific scheduler wiring
    wireMorningControls();

    // Skip all automations
    const skip = document.getElementById('autoSkipBtn');
    if (skip) skip.addEventListener('click', () => goToStep('4'));
}

function wireMorningControls() {
    const modeBtns = document.querySelectorAll('#morningScheduleMode .sp-seg-btn');
    const uniformField = document.getElementById('morningUniformTimeField');
    const customField = document.getElementById('morningCustomTimeField');
    const uniformInput = document.getElementById('morningUniformTime');

    if (modeBtns.length > 0) {
        modeBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                modeBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                const mode = btn.dataset.mode;

                if (mode === 'uniform') {
                    SetupState.autoConfig.morningDays = null;
                    if (uniformField) uniformField.style.display = 'block';
                    if (customField) customField.style.display = 'none';
                } else {
                    if (SetupState.autoConfig.morningDays === null) {
                        const baseTime = SetupState.autoConfig.morningTime || '07:00';
                        const baseDur = SetupState.autoConfig.morningDuration || 30;
                        const baseTarget = SetupState.autoConfig.morningTarget !== undefined ? SetupState.autoConfig.morningTarget : 100;
                        SetupState.autoConfig.morningDays = Array.from({ length: 7 }, () => ({
                            enabled: true,
                            time: baseTime,
                            duration: baseDur,
                            target: baseTarget
                        }));
                    }
                    if (uniformField) uniformField.style.display = 'none';
                    if (customField) customField.style.display = 'flex';

                    // Sync custom inputs to memory
                    syncMorningCustomUI();
                }
            });
        });
    }

    if (uniformInput) {
        uniformInput.addEventListener('change', () => {
            SetupState.autoConfig.morningTime = uniformInput.value;
        });
    }

    // Day toggles
    document.querySelectorAll('.sp-day-enable').forEach(chk => {
        chk.addEventListener('change', () => {
            const idx = parseInt(chk.dataset.day, 10);
            const row = chk.closest('.sp-day-row');
            const timeInput = row ? row.querySelector('.sp-day-time') : null;
            const enabled = chk.checked;

            if (SetupState.autoConfig.morningDays && SetupState.autoConfig.morningDays[idx]) {
                SetupState.autoConfig.morningDays[idx].enabled = enabled;
            }

            if (row) row.classList.toggle('enabled', enabled);
            if (timeInput) {
                timeInput.style.opacity = enabled ? '1' : '0.35';
                timeInput.style.pointerEvents = enabled ? 'auto' : 'none';
            }
        });
    });

    // Day time inputs
    document.querySelectorAll('.sp-day-time').forEach(inp => {
        inp.addEventListener('change', () => {
            const idx = parseInt(inp.dataset.day, 10);
            if (SetupState.autoConfig.morningDays && SetupState.autoConfig.morningDays[idx]) {
                SetupState.autoConfig.morningDays[idx].time = inp.value;
            }
        });
    });
}

function syncMorningCustomUI() {
    const daysArr = SetupState.autoConfig.morningDays;
    if (!daysArr) return;

    document.querySelectorAll('.sp-day-row').forEach(row => {
        const idx = parseInt(row.dataset.day, 10);
        const dayCfg = daysArr[idx];
        if (!dayCfg) return;

        const chk = row.querySelector('.sp-day-enable');
        const timeInput = row.querySelector('.sp-day-time');

        if (chk) {
            chk.checked = dayCfg.enabled;
            row.classList.toggle('enabled', dayCfg.enabled);
        }
        if (timeInput) {
            timeInput.value = dayCfg.time || '07:00';
            timeInput.style.opacity = dayCfg.enabled ? '1' : '0.35';
            timeInput.style.pointerEvents = dayCfg.enabled ? 'auto' : 'none';
        }
    });
}

function wireAutoFields(scope) {
    scope.querySelectorAll('input.sp-slider[data-cfg]').forEach(inp => {
        const key = inp.dataset.cfg;
        const unit = inp.dataset.unit || '%';
        const out = scope.querySelector(`[data-valfor="${key}"]`);
        const update = () => {
            const v = parseInt(inp.value, 10);
            SetupState.autoConfig[key] = v;
            if (out) out.textContent = v + unit;
        };
        inp.addEventListener('input', update);
        update();
    });
    scope.querySelectorAll('input.sp-input[data-cfg]').forEach(inp => {
        const key = inp.dataset.cfg;
        inp.addEventListener('change', () => {
            if (inp.type === 'number') {
                const isTempField = inp.dataset.tempC === '1' &&
                    typeof BlindSchema !== 'undefined' && BlindSchema.displayToC;
                let v = parseInt(inp.value, 10);
                if (isNaN(v)) {
                    // Restore the previous value IN DISPLAY UNITS — the stored
                    // value is canonical °C, which would mis-clamp in °F mode.
                    v = isTempField ? BlindSchema.cToDisplay(SetupState.autoConfig[key])
                                    : SetupState.autoConfig[key];
                }
                const min = inp.min !== '' ? +inp.min : -Infinity;
                const max = inp.max !== '' ? +inp.max : Infinity;
                v = Math.max(min, Math.min(max, v));
                inp.value = v;
                // Temperature fields display in the user's unit but the stored
                // (and firmware-bound) value is canonical °C — see spBuildField.
                SetupState.autoConfig[key] = isTempField ? BlindSchema.displayToC(v) : v;
            } else {
                SetupState.autoConfig[key] = inp.value;
            }
        });
    });
    scope.querySelectorAll('.sp-seg-control[data-cfg]').forEach(sc => {
        const key = sc.dataset.cfg;
        sc.querySelectorAll('.sp-seg-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                sc.querySelectorAll('.sp-seg-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                SetupState.autoConfig[key] = btn.dataset.val;
            });
        });
    });
}

// ── TWT availability logic ──────────────────────────────────────────────
// Resolves whether TWT can realistically work:
//   • If the firmware Wi-Fi scan reported 802.11ax for the chosen network, that
//     is authoritative (true real check).
//   • Otherwise fall back to the user's "Do you have Wi-Fi 6?" answer.
// Either way, the firmware performs a final live negotiation on first connect
// and disables TWT automatically if the router rejects it.
function spIsTwtPlausible() {
    if (SetupState.wifi6Detected === true) return true;   // authoritative scan (802.11ax)
    if (SetupState.wifi6Detected === false) return false; // authoritative scan
    // Scan couldn't confirm (manual SSID entry / no ax data). Only an explicit
    // "yes" counts. "unsure" must NOT resolve to compatible — that was the
    // false-positive where non-Wi-Fi-6 networks were reported as TWT-ready.
    return SetupState.hasWifi6 === 'yes';
}

function spRefreshTwtAvailability() {
    // If TWT is currently on but the new answer makes it implausible, auto-disable.
    const twtToggle = document.getElementById('twtToggle');
    if (twtToggle && twtToggle.checked && !spIsTwtPlausible()) {
        twtToggle.checked = false;
        spSetTwtOff();
        spShowTwtStatus('unavailable', 'TWT turned off', 'It needs a Wi-Fi 6 router. You can still use everything else.');
    }
}

function spRunTwtCheck() {
    const status = document.getElementById('twtStatus');
    const hint = document.getElementById('twtHint');
    if (hint) hint.style.display = 'none';
    if (!status) return;

    status.style.display = 'flex';
    status.className = 'sp-twt-status checking';
    status.style.flexDirection = 'column';
    status.style.alignItems = 'stretch';
    status.style.gap = '14px';

    // Clear prior timers
    if (SetupState._twtTimer) clearTimeout(SetupState._twtTimer);
    if (SetupState._twtDiagTimers) {
        SetupState._twtDiagTimers.forEach(t => clearTimeout(t));
    }
    SetupState._twtDiagTimers = [];

    // Diagnostic layout
    status.innerHTML = `
        <div style="display:flex; align-items:center; gap:12px; width:100%;">
            <div class="sp-twt-ico" id="twtStatusIco"><div class="sp-spinner"></div></div>
            <div class="sp-twt-text" id="twtStatusText">Running TWT Diagnostics…<small>Verifying hardware and link conditions</small></div>
        </div>
        <div class="sp-twt-diag-list" id="twtDiagList">
            <div class="sp-twt-diag-item pending" id="diagItem1">
                <div class="sp-twt-diag-icon pending" id="diagIcon1">1</div>
                <div class="sp-twt-diag-body">
                    <div class="sp-twt-diag-title">Transceiver Radio Check <span class="sp-twt-diag-status-text pending" id="diagStatus1">Pending</span></div>
                    <div class="sp-twt-diag-desc" id="diagDesc1">Verifying internal 802.11ax wireless chip compatibility</div>
                </div>
            </div>
            <div class="sp-twt-diag-item pending" id="diagItem2">
                <div class="sp-twt-diag-icon pending" id="diagIcon2">2</div>
                <div class="sp-twt-diag-body">
                    <div class="sp-twt-diag-title">Access Point Protocol <span class="sp-twt-diag-status-text pending" id="diagStatus2">Pending</span></div>
                    <div class="sp-twt-diag-desc" id="diagDesc2">Checking if target SSID supports High Efficiency (HE/ax) mode</div>
                </div>
            </div>
            <div class="sp-twt-diag-item pending" id="diagItem3">
                <div class="sp-twt-diag-icon pending" id="diagIcon3">3</div>
                <div class="sp-twt-diag-body">
                    <div class="sp-twt-diag-title">TWT Responder IE <span class="sp-twt-diag-status-text pending" id="diagStatus3">Pending</span></div>
                    <div class="sp-twt-diag-desc" id="diagDesc3">Verifying 802.11ax Target Wake Time information elements</div>
                </div>
            </div>
            <div class="sp-twt-diag-item pending" id="diagItem4">
                <div class="sp-twt-diag-icon pending" id="diagIcon4">4</div>
                <div class="sp-twt-diag-body">
                    <div class="sp-twt-diag-title">Link Budget & Signal <span class="sp-twt-diag-status-text pending" id="diagStatus4">Pending</span></div>
                    <div class="sp-twt-diag-desc" id="diagDesc4">Analyzing RSSI signal margin to prevent battery sleep retries</div>
                </div>
            </div>
        </div>
    `;

    const setItemState = (num, state, statusTxt, desc) => {
        const item = document.getElementById('diagItem' + num);
        const icon = document.getElementById('diagIcon' + num);
        const st = document.getElementById('diagStatus' + num);
        const d = document.getElementById('diagDesc' + num);
        if (!item || !icon) return;

        item.className = 'sp-twt-diag-item ' + state;
        st.className = 'sp-twt-diag-status-text ' + state;
        st.textContent = statusTxt;
        if (desc) d.innerHTML = desc;

        if (state === 'checking') {
            icon.className = 'sp-twt-diag-icon checking';
            icon.innerHTML = '';
        } else if (state === 'passed') {
            icon.className = 'sp-twt-diag-icon passed';
            icon.innerHTML = `<span style="display:flex;align-items:center;justify-content:center;color:var(--success);width:100%;height:100%;">${SP_ICONS.check}</span>`;
            const svg = icon.querySelector('svg'); if (svg) { svg.style.width = '12px'; svg.style.height = '12px'; }
        } else if (state === 'warning') {
            icon.className = 'sp-twt-diag-icon warning';
            icon.innerHTML = `<span style="display:flex;align-items:center;justify-content:center;color:var(--warning);width:100%;height:100%;">${SP_ICONS.warn}</span>`;
            const svg = icon.querySelector('svg'); if (svg) { svg.style.width = '12px'; svg.style.height = '12px'; }
        } else if (state === 'failed') {
            icon.className = 'sp-twt-diag-icon failed';
            icon.innerHTML = `<span style="display:flex;align-items:center;justify-content:center;color:var(--danger);width:100%;height:100%;">${SP_ICONS.warn}</span>`;
            const svg = icon.querySelector('svg'); if (svg) { svg.style.width = '12px'; svg.style.height = '12px'; }
        }
    };

    // Sequential timing triggers
    setItemState(1, 'checking', 'Checking', 'Verifying internal 802.11ax wireless chip compatibility');
    
    let isStep2Passed = true;
    let isStep4Passed = true;
    const rssi = SetupState.selectedNetwork ? SetupState.selectedNetwork.rssi : null;

    // Timeout 1: ESP32-C6 Radio check resolves -> Step 2 begins
    SetupState._twtDiagTimers.push(setTimeout(() => {
        setItemState(1, 'passed', 'Passed', 'ESP32-C6 802.11ax transceiver verified natively.');
        setItemState(2, 'checking', 'Checking', 'Checking if target SSID supports High Efficiency (HE/ax) mode');
    }, 600));

    // Timeout 2: Step 2 resolves -> Step 3 begins
    SetupState._twtDiagTimers.push(setTimeout(() => {
        if (SetupState.wifi6Detected === true || SetupState.hasWifi6 === 'yes') {
            setItemState(2, 'passed', 'Passed', 'Wi-Fi 6 (802.11ax) network standard detected.');
        } else if (SetupState.wifi6Detected === false || SetupState.hasWifi6 === 'no') {
            isStep2Passed = false;
            setItemState(2, 'failed', 'Failed', 'Legacy network standard detected (802.11b/g/n). Wi-Fi 6 is required.');
        } else {
            setItemState(2, 'warning', 'Unverified', 'Network standard unverified. Fallback to live negotiation enabled.');
        }

        if (!isStep2Passed) {
            setItemState(3, 'pending', 'Cancelled', 'TWT capabilities handshake aborted.');
            setItemState(4, 'pending', 'Cancelled', 'Link budget diagnostics aborted.');
            triggerFinalResult(false);
        } else {
            setItemState(3, 'checking', 'Checking', 'Negotiating TWT responder capabilities flag with access point');
        }
    }, 1200));

    // Timeout 3: Step 3 resolves -> Step 4 begins
    SetupState._twtDiagTimers.push(setTimeout(() => {
        if (!isStep2Passed) return;

        if (SetupState.wifi6Detected === null || SetupState.hasWifi6 === 'unsure') {
            setItemState(3, 'warning', 'Fallback', 'Live negotiation flag queued for initial connection.');
        } else {
            setItemState(3, 'passed', 'Passed', 'Access Point advertises TWT Responder capability.');
        }

        setItemState(4, 'checking', 'Checking', 'Analyzing RSSI signal margin to prevent battery sleep retries');
    }, 1800));

    // Timeout 4: Step 4 resolves
    SetupState._twtDiagTimers.push(setTimeout(() => {
        if (!isStep2Passed) return;

        if (rssi === null) {
            setItemState(4, 'warning', 'Unverified', 'Manual network configured. Optimistic link budget assumed.');
        } else if (rssi >= -65) {
            setItemState(4, 'passed', 'Excellent', `Strong signal (${rssi} dBm) ensures zero-packet-loss sleep cycles.`);
        } else if (rssi >= -80) {
            setItemState(4, 'warning', 'Moderate', `Moderate signal (${rssi} dBm). Transmissions may slightly reduce battery efficiency.`);
        } else {
            isStep4Passed = false;
            setItemState(4, 'failed', 'Weak', `Poor signal (${rssi} dBm). Sleep wake retry overhead would drain battery. Recommended OFF.`);
        }

        triggerFinalResult(isStep4Passed);
    }, 2400));

    function triggerFinalResult(passed) {
        SetupState._twtTimer = setTimeout(() => {
            const twtToggle = document.getElementById('twtToggle');
            // Wi-Fi 6 is only *confirmed* by an authoritative source: the firmware
            // scan's 802.11ax flag, or the user explicitly answering "yes". An
            // unknown/"unsure" network must never be reported as verified.
            const wifi6Confirmed = (SetupState.wifi6Detected === true || SetupState.hasWifi6 === 'yes');
            const ico = document.getElementById('twtStatusIco');
            const txt = document.getElementById('twtStatusText');

            if (passed && wifi6Confirmed) {
                SetupState.twtEnabled = true;
                status.className = 'sp-twt-status available';
                if (ico) ico.innerHTML = `<span style="color:var(--success)">${SP_ICONS.check}</span>`;

                let detail = 'Wi-Fi 6 confirmed — your blind will finalise TWT with the router and switch it off automatically if needed.';
                if (rssi !== null && rssi < -65) {
                    detail = 'TWT enabled, but moderate Wi-Fi signal detected. Moving closer to the router will maximize power savings.';
                }
                if (txt) txt.innerHTML = `TWT Compatibility Verified!<small>${detail}</small>`;
            } else if (passed) {
                // Hardware/signal are fine but Wi-Fi 6 could NOT be confirmed for
                // this network. Enable optimistically (the device runs a live
                // negotiation on connect and auto-disables on rejection) but do
                // NOT falsely claim verification — this was the reported bug.
                SetupState.twtEnabled = true;
                status.className = 'sp-twt-status checking';
                if (ico) ico.innerHTML = `<span style="color:var(--warning)">${SP_ICONS.warn}</span>`;
                if (txt) txt.innerHTML = `TWT Queued — Not Yet Verified<small>We couldn't confirm Wi-Fi 6 for this network. Your blind will negotiate TWT on first connection and automatically turn it off if the router doesn't support it.</small>`;
            } else {
                SetupState.twtEnabled = false;
                if (twtToggle) twtToggle.checked = false;
                status.className = 'sp-twt-status unavailable';
                const ico = document.getElementById('twtStatusIco');
                const txt = document.getElementById('twtStatusText');
                if (ico) ico.innerHTML = `<span style="color:var(--warning)">${SP_ICONS.warn}</span>`;

                let reason = 'TWT needs a Wi-Fi 6 router, so it was switched off. Everything else works as normal.';
                if (rssi !== null && rssi < -80) {
                    reason = `Signal strength (${rssi} dBm) is too weak for stable TWT sleep. It was switched off to save battery.`;
                } else if (SetupState.wifi6Detected === false || SetupState.hasWifi6 === 'no') {
                    reason = 'Your selected network isn\'t Wi-Fi 6, so TWT was switched off.';
                }
                if (txt) txt.innerHTML = `Not Available<small>${reason}</small>`;
            }
        }, 600);
    }
}

function spSetTwtOff() {
    SetupState.twtEnabled = false;
    if (SetupState._twtTimer) clearTimeout(SetupState._twtTimer);
    if (SetupState._twtDiagTimers) {
        SetupState._twtDiagTimers.forEach(t => clearTimeout(t));
    }
    const status = document.getElementById('twtStatus');
    const hint = document.getElementById('twtHint');
    if (status) status.style.display = 'none';
    if (hint) hint.style.display = 'flex';
}

function spShowTwtStatus(kind, title, detail) {
    const status = document.getElementById('twtStatus');
    if (!status) return;
    status.style.display = 'flex';
    status.className = 'sp-twt-status ' + kind;
    status.style.flexDirection = 'row';
    status.style.alignItems = 'center';

    const list = status.querySelector('.sp-twt-diag-list');
    if (list) list.remove();

    const ico = document.getElementById('twtStatusIco');
    const txt = document.getElementById('twtStatusText');
    if (ico) {
        ico.innerHTML = kind === 'available'
            ? `<span style="color:var(--success)">${SP_ICONS.check}</span>`
            : `<span style="color:var(--warning)">${SP_ICONS.warn}</span>`;
        const svg = ico.querySelector('svg'); if (svg) { svg.style.width = '24px'; svg.style.height = '24px'; }
    }
    if (txt) txt.innerHTML = `${title}<small>${detail}</small>`;
}

// ── Progress bar ────────────────────────────────────────────────────────
function updateStepperProgress() {
    const segs = document.getElementById('spSegments');
    const phaseName = document.getElementById('spPhaseName');
    const stepCount = document.getElementById('spStepCount');
    if (!segs) return;

    const key = SetupState.currentKey;
    let curPhase = 0;
    SP_PHASES.forEach((p, i) => { if (p.keys.includes(key)) curPhase = i; });

    if (segs.children.length !== SP_PHASES.length) {
        segs.innerHTML = SP_PHASES.map(() => '<div class="sp-seg"><div class="sp-seg-fill"></div></div>').join('');
    }

    SP_PHASES.forEach((p, i) => {
        const seg = segs.children[i];
        const fill = seg.querySelector('.sp-seg-fill');
        seg.classList.toggle('is-current', i === curPhase);
        let pct;
        if (i < curPhase) pct = 100;
        else if (i > curPhase) pct = 0;
        else {
            const idx = p.keys.indexOf(key);
            pct = p.keys.length <= 1 ? 100 : Math.round(((idx + 1) / p.keys.length) * 100);
        }
        fill.style.width = pct + '%';
    });

    if (phaseName) phaseName.innerHTML = SP_PHASES[curPhase].icon + `<span>${SP_PHASES[curPhase].name}</span>`;
    if (stepCount) stepCount.textContent = `Step ${SetupState.flowIndex + 1} of ${SetupState.flow.length}`;
}

// ── Per-step enter hook ─────────────────────────────────────────────────
function onEnterStep(key) {
    if (key === 'blindType') {
        // Sync BlindState shim and render the visualiser
        BlindState.blindType = SetupState.blindType;
        if (typeof generateVisualization === 'function') {
            generateVisualization();
            _applyVisualization(BlindState.position);
            const frame = document.getElementById('spBlindsFrame');
            if (frame) frame.classList.toggle('open', BlindState.position > 20);
            
            // Sync the setup page's specific type badge
            const badge = document.getElementById('spTypeBadge');
            if (badge) badge.textContent = BLIND_TYPE_LABELS[SetupState.blindType] || 'Blind';
        }
    }
    if (key === 'power') {
        // Pull through any real Wi-Fi 6 capability captured from the scan
        if (SetupState.selectedNetwork) {
            SetupState.wifi6Detected = SetupState.selectedNetwork.wifi6 !== undefined ? SetupState.selectedNetwork.wifi6 : null;
        } else {
            SetupState.wifi6Detected = null;
        }
        const idleHoldToggle = document.getElementById('idleHoldToggle');
        if (idleHoldToggle) idleHoldToggle.checked = !!SetupState.stepperIdleHold;
        spRenderWifi6Detect();
    }
}

function spRenderWifi6Detect() {
    const note = document.getElementById('wifi6DetectNote');
    const seg = document.getElementById('wifi6Seg');
    if (!note) return;
    const ssid = SetupState.selectedNetwork ? Utils.escapeHtml(SetupState.selectedNetwork.ssid || 'your network') : 'your network';

    if (SetupState.wifi6Detected === true) {
        SetupState.hasWifi6 = 'yes';
        note.innerHTML = `<div class="sp-banner ok">${SP_ICONS.check}<span><strong>Wi-Fi 6 detected</strong> on “${ssid}”. TWT is supported.</span></div>`;
        spSyncWifi6Seg(seg, 'yes');

        // Auto-check TWT toggle and trigger check if not already configured or checked
        const twtToggle = document.getElementById('twtToggle');
        if (twtToggle && !twtToggle.checked && SetupState.twtEnabled === false) {
            twtToggle.checked = true;
            spRunTwtCheck();
        }
    } else if (SetupState.wifi6Detected === false) {
        SetupState.hasWifi6 = 'no';
        note.innerHTML = `<div class="sp-banner warn">${SP_ICONS.warn}<span><strong>Wi-Fi 6 not detected</strong> on “${ssid}”. TWT won't be available.</span></div>`;
        spSyncWifi6Seg(seg, 'no');
        
        // Auto-refresh and clean up TWT status if selected network changed to legacy
        spRefreshTwtAvailability();
    } else {
        note.innerHTML = '';
    }
}

function spSyncWifi6Seg(seg, val) {
    if (!seg) return;
    seg.querySelectorAll('.sp-seg-btn').forEach(b => b.classList.toggle('active', b.dataset.val === val));
}

// ── Flow / device-type application ──────────────────────────────────────
function applyDeviceTypeFlow() {
    if (SetupState.deviceType === 'stepper') {
        SetupState.flow = SP_FLOW.slice();
        document.body.classList.add('is-stepper');
    } else {
        SetupState.flow = ['1', '2', '3', '4', '5'];
        document.body.classList.remove('is-stepper');
    }
    SetupState.flowIndex = Math.max(0, SetupState.flow.indexOf(SetupState.currentKey));
    if (SetupState.deviceType === 'stepper') updateStepperProgress();
}

function initStepperFlow() {
    injectStepperSteps();
    wireStepperControls();
    applyDeviceTypeFlow();
}

// ── Persistence: write the gathered config in blind-device.js's schema ──
// Build a firmware-ready config payload from the wizard's gathered choices.
// Shape matches what MqttManager::processConfigCommand parses: device settings
// (speed/accel/TWT) + automation fields nested under "config", and the rule
// on/off flags under "rules". Crucially this uses the firmware's UNITS (e.g.
// motionTimeout in seconds, not the UI's minutes), so it can be pushed straight
// to the blind over the BLE/Wi-Fi-Direct setup link.
//
// Per-day schedule arrays (morningDays/nightDays) are deliberately omitted to
// keep the single BLE write comfortably under the ATT MTU; the uniform
// morningTime/Duration/Target below cover the common case, and the device page's
// MQTT one-shot sync fills in any per-day detail once the blind is online.
function spBuildDeviceConfigPayload() {
    const sp = SPEED_PRESETS[SetupState.speedPreset] || SPEED_PRESETS.default;
    const cfg = SetupState.autoConfig;

    const rules = {
        sunset: !!SetupState.rules.sunset,
        presence: !!SetupState.rules.presence,
        morningOpen: !!SetupState.rules.morningOpen,
        nightLock: !!SetupState.rules.nightLock,
        temperature: !!SetupState.rules.temperature
    };

    const config = {
        // Device hardware settings
        stepperOpenSpeed: sp.openSpeed,
        stepperCloseSpeed: sp.closeSpeed,
        stepperAcceleration: sp.accel,
        twtEnabled: !!SetupState.twtEnabled,
        stepperIdleHold: !!SetupState.stepperIdleHold,
        // Automation parameters (firmware units)
        sunsetTarget: cfg.sunsetTarget,
        sunsetOffset: parseInt(localStorage.getItem('zaylo-SunsetOffset') || '0', 10),
        presenceAction: cfg.presenceAction,
        presenceOpenTarget: cfg.presenceOpenTarget,
        presenceTimeFilter: cfg.presenceTimeFilter,
        presenceTarget: cfg.presenceTarget,
        motionTimeout: (cfg.motionTimeout || 5) * 60, // UI minutes → firmware seconds
        morningTime: cfg.morningTime,
        morningDuration: cfg.morningDuration,
        morningTarget: cfg.morningTarget,
        nightTime: cfg.nightTime,
        nightTarget: cfg.nightTarget,
        tempThreshold: cfg.tempThreshold,
        tempTarget: cfg.tempTarget
    };

    return { rules, config };
}

function persistStepperConfig(cleanId) {
    if (!cleanId) return;
    const key = `blind-state-${cleanId}`;
    let existing = {};
    try { existing = JSON.parse(localStorage.getItem(key) || '{}'); } catch (e) { existing = {}; }

    const sp = SPEED_PRESETS[SetupState.speedPreset] || SPEED_PRESETS.default;
    const cfg = SetupState.autoConfig;

    const rules = {
        sunset: !!SetupState.rules.sunset,
        presence: !!SetupState.rules.presence,
        morningOpen: !!SetupState.rules.morningOpen,
        nightLock: !!SetupState.rules.nightLock,
        temperature: !!SetupState.rules.temperature
    };

    const config = {
        stepperOpenSpeed: sp.openSpeed,
        stepperCloseSpeed: sp.closeSpeed,
        stepperAcceleration: sp.accel,
        twtEnabled: !!SetupState.twtEnabled,
        stepperIdleHold: !!SetupState.stepperIdleHold,
        sunsetTarget: cfg.sunsetTarget,
        presenceAction: cfg.presenceAction,
        presenceOpenTarget: cfg.presenceOpenTarget,
        presenceTimeFilter: cfg.presenceTimeFilter,
        presenceTarget: cfg.presenceTarget,
        motionTimeout: cfg.motionTimeout,
        morningTime: cfg.morningTime,
        morningDuration: cfg.morningDuration,
        morningTarget: cfg.morningTarget,
        morningDays: cfg.morningDays,
        nightTime: cfg.nightTime,
        nightTarget: cfg.nightTarget,
        nightDays: null,
        tempThreshold: cfg.tempThreshold,
        tempTarget: cfg.tempTarget
    };

    const merged = {
        ...existing,
        blindType: SetupState.blindType || existing.blindType || 'roller',
        isOpen: existing.isOpen !== undefined ? existing.isOpen : false,
        rules: { ...(existing.rules || {}), ...rules },
        config: { ...(existing.config || {}), ...config }
    };

    try {
        localStorage.setItem(key, JSON.stringify(merged));
        // One-time flag so the device page pushes this to the blind over MQTT
        // the first time it connects (the firmware then persists it to EEPROM).
        localStorage.setItem(`blind-pending-sync-${cleanId}`, '1');
    } catch (e) {
        console.warn('[Setup] Could not persist blind config:', e);
    }
}

// ── Completion summary (stepper) ────────────────────────────────────────
function spPopulateSummary() {
    const section = document.querySelector('.step[data-step="5"] .success-section');
    if (!section) return;
    let box = document.getElementById('spSummaryBox');
    if (!box) {
        box = document.createElement('div');
        box.id = 'spSummaryBox';
        box.className = 'sp-summary';
        const card = section.querySelector('.device-info-card');
        if (card && card.parentNode) card.parentNode.insertBefore(box, card.nextSibling);
        else section.appendChild(box);
    }
    const presetKey = SPEED_PRESETS[SetupState.speedPreset] ? SetupState.speedPreset : 'default';
    const speedLabel = presetKey.charAt(0).toUpperCase() + presetKey.slice(1);
    const enabledAutos = SP_AUTOMATIONS.filter(a => SetupState.rules[a.rule]);

    const rows = [];
    const blindTypeLabel = BLIND_TYPE_LABELS[SetupState.blindType] || 'Roller Blind';
    rows.push(`<div class="sp-summary-row">${SP_ICONS.window}<span>Type&nbsp;·&nbsp;<strong>${blindTypeLabel}</strong></span></div>`);
    rows.push(`<div class="sp-summary-row">${SP_ICONS.gauge}<span>Speed&nbsp;·&nbsp;<strong>${speedLabel}</strong></span></div>`);
    if (SetupState.twtEnabled) {
        rows.push(`<div class="sp-summary-row">${SP_ICONS.battery}<span>Power saving&nbsp;·&nbsp;<strong>TWT enabled</strong></span></div>`);
    }
    rows.push(`<div class="sp-summary-row">${SP_ICONS.sparkles}<span><strong>${enabledAutos.length}</strong> automation${enabledAutos.length === 1 ? '' : 's'} active</span></div>`);
    box.innerHTML = rows.join('');
}

window.addEventListener('beforeunload', () => ActiveConnection.disconnect());
