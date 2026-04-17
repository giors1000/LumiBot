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
    armModalShown: false
};

// ============================================
// Step Navigation
// ============================================
function goToStep(stepNumber) {
    if (stepNumber < 1 || stepNumber > SetupState.totalSteps) return;

    // content steps
    document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
    const newStep = document.querySelector(`.step[data-step="${stepNumber}"]`);
    if (newStep) newStep.classList.add('active');

    // nav buttons
    document.querySelectorAll('.nav-group').forEach(g => g.classList.remove('active'));
    const newNav = document.querySelector(`.nav-group[data-step="${stepNumber}"]`);
    if (newNav) newNav.classList.add('active');

    SetupState.currentStep = stepNumber;
    updateProgressDots();

    const stepCounter = document.getElementById('currentStep');
    if (stepCounter) stepCounter.textContent = stepNumber;

    // Show arm modal or toggle stepper UI when entering calibration step
    if (stepNumber === 2) {
        if (SetupState.deviceType === 'stepper') {
            document.querySelector('.servo-calibration').style.display = 'none';
            document.getElementById('stepperCalibrationBlock').style.display = 'flex';
        } else {
            document.querySelector('.servo-calibration').style.display = 'flex';
            document.getElementById('stepperCalibrationBlock').style.display = 'none';
            if (!SetupState.armModalShown) showArmModal();
        }
    }
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
        if (BLEConnection.isConnected()) {
            BLEConnection.setServoAngle(90).catch(() => { });
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
    wifiScanBuffer: '',
    scanResultTimer: null,
    isProvisioning: false, // Flag to suppress disconnect warnings during WiFi switch
    _jogWriteQueue: Promise.resolve(), // Sequential queue for jog commands

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
                const match = this.device.name.match(/Lumi(?:Bot|Blind)-([A-F0-9]+)/i);
                SetupState.deviceId = match ? match[1].toUpperCase() : 'XXXX';
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

    handleStatus(status) {
        const names = ['IDLE', 'CONFIG', 'CONNECTING', 'CONNECTED', 'MQTT_OK', 'WIFI_FAIL', 'MQTT_FAIL'];
        // console.log('[BLE] Status:', names[status] || status);

        if (status === 3) Toast.success('WiFi connected!');
        else if (status === 4) Toast.success('Device online!');
        else if (status === 5) Toast.error('WiFi failed');
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
        this.wifiScanBuffer = '';
        if (this.scanResultTimer) clearTimeout(this.scanResultTimer);
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
        if (this.charPass) await this.charPass.writeValue(encoder.encode(password));
    },

    async sendConfig(config) {
        if (!this.charConfig) return;
        const encoder = new TextEncoder();
        const json = JSON.stringify(config);
        await this.charConfig.writeValue(encoder.encode(json));
        console.log('[BLE] Sent config:', json);
    },

    disconnect() {
        this.server?.disconnect?.();
        this.cleanup();
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
        // Signal strength icon based on RSSI
        let signalIcon = '<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M5 12.55a11 11 0 0 1 14.08 0\"/><path d=\"M1.42 9a16 16 0 0 1 21.16 0\"/><path d=\"M8.53 16.11a6 6 0 0 1 6.95 0\"/><line x1=\"12\" x2=\"12.01\" y1=\"20\" y2=\"20\"/></svg>';
        if (rssi < -80) signalIcon = '<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"var(--warning)\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M8.53 16.11a6 6 0 0 1 6.95 0\"/><line x1=\"12\" x2=\"12.01\" y1=\"20\" y2=\"20\"/></svg>'; // Weak
        else if (rssi < -60) signalIcon = '<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M5 12.55a11 11 0 0 1 14.08 0\"/><path d=\"M8.53 16.11a6 6 0 0 1 6.95 0\"/><line x1=\"12\" x2=\"12.01\" y1=\"20\" y2=\"20\"/></svg>'; // Medium
        // else strong, keep full bars

        return `
            <div class="wifi-item" data-ssid="${safeSsid}" data-secured="${isSecured}">
                <div class="wifi-info">
                    <span class="wifi-signal">${signalIcon}</span>
                    <span class="wifi-name">${safeSsid}</span>
                </div>
                ${isSecured ? '<span class=\"wifi-lock\" style=\"display:flex; align-items:center;\"><svg xmlns=\"http://www.w3.org/2000/svg\" width=\"16\" height=\"16\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"3\" y=\"11\" width=\"18\" height=\"11\" rx=\"2\" ry=\"2\"/><path d=\"M7 11V7a5 5 0 0 1 10 0v4\"/></svg></span>' : '<span class=\"wifi-open\" style=\"display:flex; align-items:center;\"><svg xmlns=\"http://www.w3.org/2000/svg\" width=\"16\" height=\"16\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"3\" y=\"11\" width=\"18\" height=\"11\" rx=\"2\" ry=\"2\"/><path d=\"M7 11V7a5 5 0 0 1 9.9-1\"/></svg></span>'}
            </div>
        `;
    }).join('');

    container.querySelectorAll('.wifi-item').forEach(item => {
        item.addEventListener('click', () => {
            document.querySelectorAll('.wifi-item').forEach(i => i.classList.remove('selected'));
            item.classList.add('selected');
            SetupState.selectedNetwork = {
                ssid: item.dataset.ssid,
                secured: item.dataset.secured === 'true'
            };
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
        if (SetupState.currentStep > 1) goToStep(SetupState.currentStep - 1);
        else window.location.href = 'index.html';
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

        if (SetupState.connectionMethod === 'bluetooth') {
            SetupState.isConnecting = true;
            step1Next.classList.add('loading');
            step1Next.disabled = true;

            const connected = await BLEConnection.connect();
            if (connected) goToStep(2);

            SetupState.isConnecting = false;
            step1Next.classList.remove('loading');
            step1Next.disabled = false;
        } else {
            Modal.create({
                title: 'Connect to Device WiFi',
                content: `<ol style="color:var(--text-secondary);padding-left:20px;line-height:2;">
                    <li>Open WiFi settings</li>
                    <li>Connect to <strong>"Zaylo-Setup"</strong></li>
                    <li>Return here</li>
                </ol>`,
                actions: [
                    { label: 'Cancel', primary: false },
                    { label: 'Continue', primary: true, onClick: () => { SetupState.deviceId = 'WIFI'; goToStep(2); } }
                ]
            });
        }
    });

    // ===== Step 2: Servo =====
    const slider = document.getElementById('angleSlider');
    let bleDebounceTimeout = null;

    // Helper function to send angle to BLE with debounce
    function sendAngleToBLE(angle) {
        if (bleDebounceTimeout) clearTimeout(bleDebounceTimeout);
        bleDebounceTimeout = setTimeout(() => {
            if (BLEConnection.isConnected()) {
                BLEConnection.setServoAngle(angle).catch(() => { });
                // console.log(`[Setup] Sent angle ${angle}° to device via BLE`);
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
        if (BLEConnection.isConnected()) {
            BLEConnection.setServoAngle(90).catch(() => { });
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
        if (BLEConnection.isConnected()) {
            BLEConnection.setServoAngle(SetupState.angleOff).catch(() => { });
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
        if (BLEConnection.isConnected()) {
            BLEConnection.setServoAngle(SetupState.angleOn).catch(() => { });
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

    const startJog = (direction) => {
        if (!BLEConnection.isConnected()) return Toast.warning('Not connected to device');
        BLEConnection.setStepperJog(direction).catch(() => { });
        document.getElementById('jogFeedback').innerHTML = direction > 0 ? 'Moving Down ▼' : 'Moving Up ▲';
    };
    const stopJog = () => {
        if (BLEConnection.isConnected()) {
            BLEConnection.setStepperJog(0)
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

    addJogListeners(jogUp, -1);
    addJogListeners(jogDown, 1);

    document.getElementById('saveStepperTopBtn')?.addEventListener('click', () => {
        const configParams = { cmd: 'save_top' };
        if (BLEConnection.isConnected()) {
            BLEConnection.sendConfig(configParams).catch(() => { });
            const label = document.getElementById('savedTop');
            if (label) label.textContent = 'Saved ✓';
            Toast.success('Top Cover Position Saved!');
        } else {
            Toast.warning('Not connected');
        }
    });

    document.getElementById('saveStepperBottomBtn')?.addEventListener('click', () => {
        const configParams = { cmd: 'save_bottom' };
        if (BLEConnection.isConnected()) {
            BLEConnection.sendConfig(configParams).catch(() => { });
            const label = document.getElementById('savedBottom');
            if (label) label.textContent = 'Saved ✓';
            Toast.success('Bottom Closed Position Saved!');
        } else {
            Toast.warning('Not connected');
        }
    });

    document.getElementById('step2Back')?.addEventListener('click', () => goToStep(1));
    document.getElementById('step2Next')?.addEventListener('click', () => {
        if (SetupState.deviceType === 'servo') {
            if (SetupState.angleOff === null || SetupState.angleOn === null) {
                Toast.warning('Please set both ON and OFF positions');
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

        // Check BLE connection first
        if (!BLEConnection.isConnected()) {
            Toast.warning('Connect via Bluetooth first to scan for networks');
            resetButton();
            return;
        }

        // Check if scan characteristic is available
        if (!BLEConnection.charWifiScan) {
            console.error('[Setup] WiFi scan characteristic not available');
            Toast.error('WiFi scan not supported - try reconnecting');
            resetButton();
            return;
        }

        try {
            // console.log('[Setup] Starting WiFi scan via BLE...');
            /* console.log('[Setup] Connection state:', {
                connected: BLEConnection.isConnected(),
                hasWifiScan: !!BLEConnection.charWifiScan,
                hasWifiResults: !!BLEConnection.charWifiResults
            }); */

            await BLEConnection.startWifiScan();
            Toast.info('Scanning for networks...');

            // Timeout fallback - if no results received in 30s, reset button
            setTimeout(() => {
                if (btn.disabled) {
                    console.warn('[Setup] WiFi scan timeout - no results received. Current Buffer Size:', BLEConnection.wifiScanBuffer?.length || 0);
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

    document.getElementById('step3Back')?.addEventListener('click', () => goToStep(2));

    document.getElementById('step3Next')?.addEventListener('click', async () => {
        // Handle WiFi fallback mode manually entered SSID
        if (SetupState.connectionMethod === 'wifi') {
            const manualSsid = document.getElementById('manualWifiSsid')?.value?.trim();
            if (manualSsid) {
                SetupState.selectedNetwork = { ssid: manualSsid, secured: true };
            }
        }

        if (!SetupState.selectedNetwork) {
            Toast.warning('Select or enter a network');
            return;
        }

        const password = document.getElementById('wifiPassword')?.value || '';
        if (SetupState.selectedNetwork.secured && !password) {
            Toast.warning('Enter password');
            return;
        }

        const btn = document.getElementById('step3Next');
        btn?.classList.add('loading');

        if (BLEConnection.isConnected()) {
            try {
                // Send Configuration BEFORE WiFi credentials (so it saves even if WiFi fails)
                const isStepper = SetupState.deviceType === 'stepper';
                // For Stepper, Top/Bottom limits are already saved via the save buttons directly.
                // But we can resend angles for Servo.
                if (!isStepper) {
                    await BLEConnection.sendConfig({
                        angleOn: SetupState.angleOn,
                        angleOff: SetupState.angleOff
                    });
                }

                Toast.info('Configuration sent to device');

                await BLEConnection.sendWifiCredentials(SetupState.selectedNetwork.ssid, password);

                // Set provisioning flag to true so we don't show "Disconnected" error when device reboots
                BLEConnection.isProvisioning = true;

                Toast.info('Connecting to WiFi...');
                await new Promise(r => setTimeout(r, 6000));
            } catch (e) { }
        }

        Toast.info('Connected! Now name your device.');
        btn?.classList.remove('loading');
        goToStep(4);
    });

    document.getElementById('step4Back')?.addEventListener('click', () => goToStep(3));

    document.getElementById('step4Next')?.addEventListener('click', async () => {
        const btn = document.getElementById('step4Next');
        btn?.classList.add('loading');

        // Update final screen
        document.getElementById('finalDeviceId').textContent = SetupState.deviceId || 'NEW';
        document.getElementById('finalWifi').textContent = SetupState.selectedNetwork?.ssid || 'Connected';

        // Get custom name
        let customName = document.getElementById('deviceNameInput')?.value?.trim();
        const cleanId = SetupState.deviceId ? SetupState.deviceId.replace(/[^A-F0-9]/g, '') : 'XXXX';

        if (!customName) {
            customName = `Zaylo-${cleanId}`;
        }

        // Sanitize name
        customName = customName.replace(/[<>]/g, ''); // Basic XSS prevention
        document.getElementById('finalDeviceName').textContent = customName;

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

            // 2. Sync to Firebase in background (non-blocking)
            // The merge logic on index.html protects locally-added devices
            // for 5 minutes, so even if this sync is slow, the device won't disappear
            const user = Auth.getUser();
            
            if (user) {
                // Resolve active home right before saving
                (async () => {
                    try {
                        await HomeService.init();
                        const homeId = await HomeService.getActiveHome(user.uid);
                        if (!homeId) throw new Error("No active home resolved");
                        
                        await DeviceService.init();
                        await DeviceService.addDevice(homeId, device);
                        console.log('[Setup] Device synced to Firebase:', customName);
                    } catch (e) {
                        console.warn('[Setup] Firebase sync warning (will retry on next load):', e);
                    }
                })();
            }
        }

        Toast.success('Setup complete!');
        btn?.classList.remove('loading');
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
                    // Hide BLE scan button
                    document.getElementById('scanWifi').style.display = 'none';
                    if (wifiList) wifiList.style.display = 'none';
                    // Show manual input fields
                    document.getElementById('manualSsidSection')?.classList.add('show');
                    document.getElementById('passwordSection')?.classList.add('show');
                }
            }
        });
    });

    document.querySelectorAll('.step[data-step="3"]').forEach(step => {
        observer.observe(step, { attributes: true, attributeFilter: ['class'] });
    });
});

window.addEventListener('beforeunload', () => BLEConnection.disconnect());
