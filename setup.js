/**
 * LumiBot - Setup Wizard Logic
 * Handles device connection, calibration, and WiFi configuration
 */

// ============================================
// Setup State
// ============================================
const SetupState = {
    currentStep: 1,
    totalSteps: 4,
    connectionMethod: null,
    deviceId: null,
    angleOff: 45,
    angleOn: 135,
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

    document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
    const newStep = document.querySelector(`.step[data-step="${stepNumber}"]`);
    if (newStep) newStep.classList.add('active');

    SetupState.currentStep = stepNumber;
    updateProgressDots();

    const stepCounter = document.getElementById('currentStep');
    if (stepCounter) stepCounter.textContent = stepNumber;

    // Show arm modal when entering calibration step
    if (stepNumber === 2 && !SetupState.armModalShown) {
        showArmModal();
    }
}

function updateProgressDots() {
    document.querySelectorAll('.progress-dot').forEach((dot, index) => {
        const step = index + 1;
        dot.classList.remove('active', 'completed');
        if (step === SetupState.currentStep) dot.classList.add('active');
        else if (step < SetupState.currentStep) dot.classList.add('completed');
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

    if (offDisplay) offDisplay.textContent = `${SetupState.angleOff}°`;
    if (onDisplay) onDisplay.textContent = `${SetupState.angleOn}°`;
    if (savedOff) savedOff.textContent = `${SetupState.angleOff}°`;
    if (savedOn) savedOn.textContent = `${SetupState.angleOn}°`;
}

// ============================================
// BLE Connection
// ============================================
const BLEConnection = {
    device: null,
    server: null,
    service: null,
    charServo: null,
    charSSID: null,
    charPass: null,
    charDeviceId: null,
    charStatus: null,
    charWifiScan: null,
    charWifiResults: null,
    wifiScanBuffer: '',
    scanResultTimer: null,

    SERVICE_UUID: '12345678-1234-5678-1234-56789abcdef0',
    CHAR_WIFI_SSID_UUID: '12345678-1234-5678-1234-56789abcdef1',
    CHAR_WIFI_PASS_UUID: '12345678-1234-5678-1234-56789abcdef2',
    CHAR_DEVICE_ID_UUID: '12345678-1234-5678-1234-56789abcdef3',
    CHAR_STATUS_UUID: '12345678-1234-5678-1234-56789abcdef4',
    CHAR_SERVO_UUID: '12345678-1234-5678-1234-56789abcdef5',
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
            Toast.info('Searching for LumiBot...');

            this.device = await navigator.bluetooth.requestDevice({
                filters: [{ namePrefix: 'LumiBot' }],
                optionalServices: [this.SERVICE_UUID]
            });

            if (!this.device) {
                Toast.error('No device selected');
                return false;
            }

            Toast.info('Connecting...');
            this.server = await Promise.race([
                this.device.gatt.connect(),
                new Promise((_, r) => setTimeout(() => r(new Error('Timeout')), 15000))
            ]);

            if (!this.server.connected) {
                Toast.error('Connection failed');
                return false;
            }

            Toast.info('Getting service...');
            this.service = await this.server.getPrimaryService(this.SERVICE_UUID);

            // Get characteristics
            try {
                this.charServo = await this.service.getCharacteristic(this.CHAR_SERVO_UUID);
            } catch (e) { console.warn('[BLE] No servo char'); }

            try {
                this.charSSID = await this.service.getCharacteristic(this.CHAR_WIFI_SSID_UUID);
            } catch (e) { console.warn('[BLE] No SSID char'); }

            try {
                this.charPass = await this.service.getCharacteristic(this.CHAR_WIFI_PASS_UUID);
            } catch (e) { console.warn('[BLE] No Pass char'); }

            try {
                this.charDeviceId = await this.service.getCharacteristic(this.CHAR_DEVICE_ID_UUID);
                const val = await this.charDeviceId.readValue();
                SetupState.deviceId = new TextDecoder().decode(val);
            } catch (e) {
                const match = this.device.name.match(/LumiBot-([A-F0-9]+)/i);
                SetupState.deviceId = match ? match[1] : 'XXXX';
            }

            try {
                this.charWifiScan = await this.service.getCharacteristic(this.CHAR_WIFI_SCAN_UUID);
                console.log('[BLE] WiFi scan characteristic found');
            } catch (e) {
                console.warn('[BLE] WiFi scan characteristic not available:', e.message);
            }

            try {
                this.charWifiResults = await this.service.getCharacteristic(this.CHAR_WIFI_RESULTS_UUID);
                await this.charWifiResults.startNotifications();
                console.log('[BLE] WiFi results notifications enabled');
                this.charWifiResults.addEventListener('characteristicvaluechanged', (e) => {
                    const rawData = e.target.value;
                    const chunk = new TextDecoder().decode(rawData);
                    console.log(`[BLE] WiFi chunk: ${rawData.byteLength} bytes`);

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
                Toast.warning('Device disconnected');
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
                    // Salvage: Find last '}' and close array
                    const lastClose = buffer.lastIndexOf('}');
                    if (lastClose > 1) {
                        const salvaged = buffer.substring(0, lastClose + 1) + ']';
                        console.log('[BLE] Salvaged JSON:', salvaged);
                        networks = JSON.parse(salvaged);
                    }
                } catch (err2) {
                    console.error('[BLE] Salvage failed:', err2);
                }
            }
        }

        if (networks && Array.isArray(networks)) {
            console.log(`[BLE] Processed ${networks.length} networks`);
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
        console.log('[BLE] Status:', names[status] || status);

        if (status === 3) Toast.success('WiFi connected!');
        else if (status === 4) Toast.success('Device online!');
        else if (status === 5) Toast.error('WiFi failed');
    },

    cleanup() {
        this.device = null;
        this.server = null;
        this.service = null;
        this.charServo = null;
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
                <div style="font-size:48px;margin-bottom:16px;">📡</div>
                <p style="margin-bottom:8px;">No networks found</p>
                <p style="font-size:13px;">Make sure your device is connected and try scanning again</p>
            </div>
        `;
        return;
    }

    // ESP32 sends: {"s":"NetworkName","r":-65,"e":1} where e=1 (encrypted) or e=0 (open)
    container.innerHTML = networks.map(n => {
        const ssid = n.ssid || n.s || 'Unknown';
        const isSecured = Boolean(n.encryption || n.e); // e=1 → true, e=0 → false
        const rssi = n.rssi || n.r || -100;
        // Signal strength icon based on RSSI
        let signalIcon = '📶';
        if (rssi < -80) signalIcon = '📡'; // Weak
        else if (rssi < -60) signalIcon = '📶'; // Medium
        // else strong, keep 📶

        return `
            <div class="wifi-item" data-ssid="${ssid}" data-secured="${isSecured}">
                <div class="wifi-info">
                    <span class="wifi-signal">${signalIcon}</span>
                    <span class="wifi-name">${ssid}</span>
                </div>
                ${isSecured ? '<span class="wifi-lock">🔒</span>' : '<span class="wifi-open">🔓</span>'}
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
                    setTimeout(() => document.getElementById('wifiPassword')?.focus(), 100);
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
    const themeBtn = document.getElementById('themeToggle');
    if (themeBtn) {
        themeBtn.textContent = Theme.get() === 'dark' ? '🌙' : '☀️';
        themeBtn.addEventListener('click', () => {
            const newTheme = Theme.toggle();
            themeBtn.textContent = newTheme === 'dark' ? '🌙' : '☀️';
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
                    <li>Connect to <strong>"LumiBot-Setup"</strong></li>
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
                console.log(`[Setup] Sent angle ${angle}° to device via BLE`);
            }
        }, 50); // 50ms debounce for smooth real-time control
    }

    // Initialize displays
    setServoAngle(90);
    updatePositionDisplays();

    // Slider input - update visual AND send to BLE in real-time
    slider?.addEventListener('input', (e) => {
        const angle = parseInt(e.target.value);
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
        setServoAngle(SetupState.angleOff);
        if (BLEConnection.isConnected()) {
            BLEConnection.setServoAngle(SetupState.angleOff).catch(() => { });
        }
        document.getElementById('goOffBtn')?.classList.add('active');
        document.getElementById('goOnBtn')?.classList.remove('active');
    });

    // Go to ON position
    document.getElementById('goOnBtn')?.addEventListener('click', () => {
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
        const btn = document.getElementById('testServoBtn');
        btn.textContent = '⏳ Moving...';
        btn.disabled = true;

        if (BLEConnection.isConnected()) {
            try {
                await BLEConnection.setServoAngle(SetupState.currentAngle);
                Toast.success(`Moved to ${SetupState.currentAngle}°`);
            } catch (e) {
                Toast.info('Not connected to device');
            }
        } else {
            Toast.info('Connect via Bluetooth to test on device');
        }

        setTimeout(() => {
            btn.textContent = '🔄 Test Current Position';
            btn.disabled = false;
        }, 500);
    });

    document.getElementById('step2Back')?.addEventListener('click', () => goToStep(1));
    document.getElementById('step2Next')?.addEventListener('click', () => {
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
                    <div style="font-size:48px;margin-bottom:16px;animation:pulse 1.5s ease-in-out infinite;opacity:0.7">📡</div>
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
            console.log('[Setup] Starting WiFi scan via BLE...');
            console.log('[Setup] Connection state:', {
                connected: BLEConnection.isConnected(),
                hasWifiScan: !!BLEConnection.charWifiScan,
                hasWifiResults: !!BLEConnection.charWifiResults
            });

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
        if (!SetupState.selectedNetwork) {
            Toast.warning('Select a network');
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
                // Send Servo Configuration BEFORE WiFi credentials (so it saves even if WiFi fails)
                await BLEConnection.sendConfig({
                    angleOn: SetupState.angleOn,
                    angleOff: SetupState.angleOff
                });
                Toast.info('Configuration sent to device');

                await BLEConnection.sendWifiCredentials(SetupState.selectedNetwork.ssid, password);
                Toast.info('Connecting to WiFi...');
                await new Promise(r => setTimeout(r, 6000));
            } catch (e) { }
        }

        // Update final screen
        document.getElementById('finalDeviceId').textContent = SetupState.deviceId || 'NEW';
        document.getElementById('finalWifi').textContent = SetupState.selectedNetwork.ssid;

        if (SetupState.deviceId && SetupState.deviceId !== 'WIFI') {
            const device = {
                id: SetupState.deviceId,
                name: `LumiBot-${SetupState.deviceId}`,
                angleOn: SetupState.angleOn,
                angleOff: SetupState.angleOff
            };
            DeviceList.add(device);

            // Sync to Firebase if authenticated (await with timeout to ensure it tries before redirect)
            const user = Auth.getUser();
            if (user) {
                try {
                    await DeviceService.init();
                    // Don't block indefinitely, but try to sync
                    const syncPromise = DeviceService.addDevice(user.uid, device);
                    const timeoutPromise = new Promise(resolve => setTimeout(resolve, 2000));
                    await Promise.race([syncPromise, timeoutPromise]);
                    console.log('[Setup] Device synced to Firebase');
                } catch (e) {
                    console.warn('[Setup] Firebase sync warning:', e);
                }
            }
        }

        Toast.success('Setup complete!');
        btn?.classList.remove('loading');
        goToStep(4);

        // Auto-redirect to dashboard after a short delay
        setTimeout(() => {
            window.location.href = 'index.html';
        }, 1500);
    });

    // Initialize WiFi list
    const wifiList = document.getElementById('wifiList');
    if (wifiList) {
        wifiList.innerHTML = `
            <div style="text-align:center;color:var(--text-tertiary);padding:40px 20px;">
                <div style="font-size:48px;margin-bottom:16px;">📡</div>
                <p>Tap "Scan for Networks" to find available WiFi networks</p>
            </div>
        `;
    }
});

window.addEventListener('beforeunload', () => BLEConnection.disconnect());
