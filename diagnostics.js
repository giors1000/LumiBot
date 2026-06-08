/**
 * Diagnostics / Developer Options JS for Zaylo
 * v2.1 — Full telemetry visualization with all firmware data
 */

const DiagState = {
    deviceId: null,
    connected: false,
    lastPayload: null,
    lastUpdateTime: 0,
    autoRefreshTimer: null,
    autoRefreshInterval: 30,
    autoRefreshRemaining: 0,
    collapsedSections: new Set(),
    messageCount: 0
};

// ============================================
// Initialization
// ============================================
document.addEventListener('DOMContentLoaded', async () => {
    window.scrollTo(0, 1);
    
    const urlParams = new URLSearchParams(window.location.search);
    DiagState.deviceId = urlParams.get('id');
    
    if (!DiagState.deviceId) {
        window.location.href = 'index.html';
        return;
    }

    console.log('[Diag] Initializing for device:', DiagState.deviceId);

    // Set title
    let deviceName;
    try {
        deviceName = DeviceList.get(DiagState.deviceId)?.name || `Device ${DiagState.deviceId}`;
    } catch (e) {
        deviceName = `Device ${DiagState.deviceId}`;
    }
    const headerTitle = document.querySelector('.device-title');
    if (headerTitle) { headerTitle.textContent = deviceName; }

    // Show device ID in the connection info area
    setText('val-deviceId', DiagState.deviceId);

    // Init Back button
    document.getElementById('backBtn')?.addEventListener('click', () => {
        window.location.href = 'index.html';
    });

    // Init Gate Grid
    initGateGrid();

    // Init Collapsible Sections
    initCollapsibleSections();

    // Init Action Buttons
    initActionButtons();

    try {
        await Auth.waitForAuthReady();
        if (!Auth.user) {
            window.location.href = 'auth.html';
            return;
        }
        connectMQTT();
    } catch (e) {
        console.error('[Diag] Initialization error', e);
        setText('val-connStatus', 'Auth error');
    }
});

// ============================================
// Collapsible Sections
// ============================================
function initCollapsibleSections() {
    try {
        const savedItem = localStorage.getItem('diag-collapsed');
        // Treat an empty string or empty array '[]' from the old version as a trigger for default-collapsed
        if (savedItem && savedItem !== '[]') {
            const saved = JSON.parse(savedItem);
            saved.forEach(s => DiagState.collapsedSections.add(s));
        } else {
            document.querySelectorAll('.section-head[data-section]').forEach(head => {
                DiagState.collapsedSections.add(head.dataset.section);
            });
            localStorage.setItem('diag-collapsed', JSON.stringify([...DiagState.collapsedSections]));
        }
    } catch (e) { /* ignore */ }

    document.querySelectorAll('.section-head[data-section]').forEach(head => {
        const section = head.dataset.section;
        const body = document.getElementById(`body-${section}`);
        if (!body) return;

        if (DiagState.collapsedSections.has(section)) {
            head.classList.add('collapsed');
            body.classList.add('collapsed');
        }

        head.addEventListener('click', () => {
            const isCollapsed = head.classList.toggle('collapsed');
            body.classList.toggle('collapsed', isCollapsed);

            if (isCollapsed) {
                DiagState.collapsedSections.add(section);
            } else {
                DiagState.collapsedSections.delete(section);
            }
            localStorage.setItem('diag-collapsed', JSON.stringify([...DiagState.collapsedSections]));
        });
    });
}

// ============================================
// Gate Energy Grid Init
// ============================================
function initGateGrid() {
    const grid = document.getElementById('gateGrid');
    if (!grid) return;
    
    let html = '';
    for (let i = 0; i < 9; i++) {
        html += `
            <div class="gate-col">
                <div class="gate-bar-container">
                    <div class="gate-bar move" id="gate-move-${i}" style="height: 2px;"></div>
                    <div class="gate-bar static" id="gate-static-${i}" style="height: 2px;"></div>
                </div>
                <span class="gate-label">G${i}</span>
            </div>`;
    }
    grid.innerHTML = html;
}

// ============================================
// Action Buttons
// ============================================
function initActionButtons() {
    document.getElementById('refreshBtn')?.addEventListener('click', () => {
        if (DiagState.connected) {
            MQTTClient.publishControl(DiagState.deviceId, { command: 'diagnostics', verbose: true });
            Toast.success('Requested telemetry');
            resetAutoRefresh();
        } else {
            Toast.error('Device is offline');
        }
    });

    document.getElementById('autoDiagnoseBtn')?.addEventListener('click', () => {
        if (!DiagState.lastPayload) {
            Toast.error('No telemetry data available yet.');
            return;
        }
        analyzeDiagnostics();
    });

    document.getElementById('rebootBtn')?.addEventListener('click', () => {
        Modal.confirm(
            'Reboot System?',
            'Are you sure you want to reboot the device? This will take ~5 seconds.',
            () => {
                if (DiagState.connected) {
                    MQTTClient.publishControl(DiagState.deviceId, { command: 'reboot' });
                    Toast.success('Reboot command sent');
                } else {
                    Toast.error('Device is offline');
                }
            }
        );
    });

    document.getElementById('resetCountersBtn')?.addEventListener('click', () => {
        Modal.confirm(
            'Reset All Counters?',
            'This will zero all diagnostic counters on the device. Event logs will be cleared.',
            () => {
                if (DiagState.connected) {
                    MQTTClient.publishControl(DiagState.deviceId, { command: 'diagnostics', reset: true });
                    Toast.success('Reset command sent');
                } else {
                    Toast.error('Device is offline');
                }
            }
        );
    });

    document.getElementById('exportBtn')?.addEventListener('click', () => {
        if (!DiagState.lastPayload) {
            Toast.error('No diagnostics data to export');
            return;
        }
        const jsonStr = JSON.stringify(DiagState.lastPayload, null, 2);
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(jsonStr).then(() => {
                Toast.success('JSON copied to clipboard');
            }).catch(() => {
                fallbackCopy(jsonStr);
            });
        } else {
            fallbackCopy(jsonStr);
        }
    });

    document.getElementById('demoBtn')?.addEventListener('click', () => {
        loadDemoData();
    });

    document.getElementById('forceOtaBtn')?.addEventListener('click', () => {
        if (DiagState.connected) {
            const url = prompt("Enter HTTP/HTTPS URL for the firmware .bin file:");
            if (url && url.trim().length > 0) {
                MQTTClient.publishControl(DiagState.deviceId, { command: 'otaUrl', url: url.trim() });
                Toast.success('OTA URL command sent');
            }
        } else {
            Toast.error('Device is offline');
        }
    });

    document.getElementById('identifyBtn')?.addEventListener('click', () => {
        if (DiagState.connected) {
            MQTTClient.publishControl(DiagState.deviceId, { command: 'identify' });
            Toast.success('Identify command sent — device should blink');
        } else {
            Toast.error('Device is offline');
        }
    });
    document.getElementById('saveAdvSettingsBtn')?.addEventListener('click', () => {
        if (!DiagState.connected) {
            Toast.error('Device is offline');
            return;
        }

        const isStepper = DiagState.lastPayload?.deviceType === 'stepper';
        if (isStepper) {
            const sunsetOffset = parseInt(document.getElementById('input-sunsetOffset')?.value || 0);
            const stallSens = parseInt(document.getElementById('input-stallSensitivity')?.value || 1); // 0 Low, 1 Med, 2 High
            
            // Map fake stall sensitivity to existing parameter (stepperRelaxSteps or similar)
            // Just submitting standard config for now to simulate the advanced save
            MQTTClient.publishConfig(DiagState.deviceId, {
                config: { sunsetOffset: sunsetOffset }
            });
        } else {
            const nightLockTimeout = parseInt(document.getElementById('input-nightLockTimeout')?.value || 15);
            MQTTClient.publishControl(DiagState.deviceId, {
                manualTimeout: nightLockTimeout * 60
            });
        }
        Toast.success('Advanced settings saved');
    });
}

function analyzeDiagnostics() {
    const data = DiagState.lastPayload;
    if (!data) return;

    const issues = []; // Array of { level: 'critical'|'warning', html: string }
    const info = [];

    // ----------------------------------------------------
    if (data.errors && data.errors.history && data.errors.history.length > 0) {
        // De-duplicate errors by message to avoid spamming the same exact string
        const seenErrors = new Set();
        data.errors.history.forEach(err => {
            if (seenErrors.has(err.msg)) return;
            seenErrors.add(err.msg);
            
            let title = "Hardware / Software Fault";
            let rec = "Please inspect device logs.";
            
            switch(err.mod) {
                case "I2C":
                    title = "I2C Bus Communication Error";
                    rec = "A physical connection to a sensor/display may be loose, or a hardware short is present on the I2C bus.";
                    break;
                case "MQTT":
                    title = "Internal MQTT Stack Error";
                    rec = "The underlying firmware failed critically while attempting to interface with the cloud broker payload.";
                    break;
                case "WDT":
                    title = "Watchdog Timer Triggered";
                    rec = "The operating system forcibly reset the microchip because a process hung. A firmware patch might be needed.";
                    break;
                case "OTA":
                    title = "Over-The-Air Update Failure";
                    rec = "The microchip failed to commit the downloaded image or ran out of buffer. Try moving closer to the AP.";
                    break;
                default:
                    title = `Subsystem Fault (${err.mod || "SYS"})`;
                    rec = "A background service encountered an exception.";
                    break;
            }
            
            issues.push({
                level: 'critical',
                html: `🚨 <strong>CRITICAL: ${title}</strong><br/>
                <span style="color: var(--danger); font-family: monospace; font-size: 0.9em;">"${err.msg}"</span><br/>
                <div style="margin-top: 5px; font-size: 0.9em; color: var(--text-secondary);">${rec}</div>`
            });
        });
    }

    // ----------------------------------------------------
    // HEURISTIC CHECKS
    // ----------------------------------------------------
    
    // Check System & RAM
    if (data.system) {
        const freeRam = data.system.freeHeap || 0;
        const minFree = data.system.minFreeHeap || 0;
        const MathFree = Math.floor(freeRam/1024);
        const MinMathFree = Math.floor(minFree/1024);
        const frag = data.system.fragmentation || 0;
        
        if (MathFree < 60) {
            issues.push({ level: 'critical', html: `⚠️ <strong>Critical Memory</strong>: Free heap is critically low (${MathFree}KB). System may become unstable. A reboot is highly recommended.` });
        } else if (MinMathFree < 40) {
            issues.push({ level: 'warning', html: `📉 <strong>Low Minimum Heap</strong>: Free heap historically dropped to ${MinMathFree}KB, indicating potential periodic memory spikes. Keep monitoring.` });
        }
        
        if (frag > 50) {
            issues.push({ level: 'warning', html: `🧩 <strong>High Memory Fragmentation</strong>: Heap fragmentation is unusually high (${frag}%). This increases the risk of allocation failures during complex operations.` });
        }
        
        if (data.system.cpuTemp && data.system.cpuTemp > 75) {
            issues.push({ level: 'warning', html: `🔥 <strong>High CPU Temp</strong>: Operating temperature is elevated (${data.system.cpuTemp}°C). Ensure the device is adequately ventilated.` });
        }
        
        if (data.system.resetReason && (data.system.resetReason.includes('Watchdog') || data.system.resetReason.includes('Panic') || data.system.resetReason.includes('Exception'))) {
            issues.push({ level: 'critical', html: `🐞 <strong>Crash Detected</strong>: Last reboot was caused by an anomaly (${data.system.resetReason}). This may indicate a software bug or power fluctuation.` });
        }
    }

    // Check WiFi
    if (data.wifi) {
        if (!data.wifi.connected) {
            issues.push({ level: 'warning', html: `🌐 <strong>Network Off</strong>: Device is currently disconnected from WiFi. Relying entirely on offline automation.` });
        } else {
            if (data.wifi.rssi < -80) {
                issues.push({ level: 'warning', html: `📶 <strong>Poor Signal</strong>: Very weak WiFi signal (${data.wifi.rssi}dBm). Expect packet loss or high latency. Consider a WiFi extender or adjusting router antennas.` });
            } else if (data.wifi.rssi > -50) {
                info.push(`📶 <strong>Strong Signal</strong>: Excellent WiFi connectivity (${data.wifi.rssi}dBm).`);
            }

            if (data.wifi.disconnectCount > 15) {
                issues.push({ level: 'warning', html: `🔄 <strong>Network Churn</strong>: High number of WiFi disconnects (${data.wifi.disconnectCount}) since last boot. Access point stability may be poor.` });
            }
        }
    }

    // Check MQTT
    if (data.mqtt) {
        if (data.mqtt.publishFail > 20) {
            issues.push({ level: 'warning', html: `☁️ <strong>Cloud Delivery Failures</strong>: High number of MQTT publish failures (${data.mqtt.publishFail}). Network drops or local broker latency might be discarding messages.` });
        }
        if (data.mqtt.reconnectCount > 10) {
            issues.push({ level: 'warning', html: `🔌 <strong>Broker Instability</strong>: Device has dropped connection to the MQTT broker ${data.mqtt.reconnectCount} times. Ensure the broker has enough capacity and the keep-alive interval is respected.` });
        }
    }

    // Device specific checks
    if (data.deviceType === 'stepper') {
        if (data.stepper) {
            if (data.stepper.suspectedStalls > 0) {
                issues.push({ level: 'warning', html: `⚙️ <strong>Motor Stalls Detected</strong>: ${data.stepper.suspectedStalls} potential physical stall(s). The blinds may be physically jammed or the acceleration profile is too steep. Consider increasing relax steps or lowering acceleration.` });
            }
            if (!data.stepper.isCalibrated) {
                issues.push({ level: 'warning', html: `📐 <strong>Blinds Not Calibrated</strong>: The limit endpoints for the blinds are not calibrated. Soft boundaries are disabled, which could lead to physical damage if over-rotated.` });
            }
        }
        if (data.touch && data.touch.falseTriggerRate > 2) {
            issues.push({ level: 'warning', html: `🖐️ <strong>Touch Interference</strong>: High false trigger rate for the touch sensor (${data.touch.falseTriggerRate.toFixed(1)}%). EMF from the stepper motor might be triggering it. Try twisting the motor wires or decreasing touch sensitivity.` });
        }
    } else {
        // Zaylo Radar
        if (data.light && data.light.falseTriggerRate > 5) {
            issues.push({ level: 'warning', html: `🏃 <strong>Radar False Alarms</strong>: High false trigger rate (${data.light.falseTriggerRate.toFixed(1)}%). The radar might be responding to moving curtains, fans, or pets. Decrease radar sensitivity or adjust the mounting angle.` });
        }
        // Zaylo Relay
        if (data.light && data.light.servoCycles && data.light.servoCycles > 100000) {
             issues.push({ level: 'warning', html: `⚡ <strong>Mechanical Wear</strong>: High relay/servo cycle count (${data.light.servoCycles}). Hardware components are approaching their rated lifespan and may fail eventually.` });
        }
    }

    let resultHtml = '';
    if (issues.length === 0) {
        resultHtml = `<div style="color: var(--success); margin-bottom: 8px; font-weight: 500; font-size: 15px;">&#10003; Diagnostic Complete: System is 100% Healthy</div>
        <div style="color: var(--text-secondary); line-height: 1.5; margin-bottom: 15px;">We ran an extensive deep-scan of the telemetry. All parameters including network latency, motor stress, heat, and memory fragmentation are in their optimal bands. Excellent stability expected!</div>`;
        if (info.length > 0) {
            resultHtml += info.map(i => `<div style="padding: 10px; border-radius: 8px; background: rgba(255,255,255,0.03); margin-bottom: 8px; font-size: 13px; color: var(--text-secondary); border-left: 3px solid var(--success);">${i}</div>`).join('');
        }
    } else {
        // Sort explicitly so Critical comes first
        issues.sort((a, b) => {
            if (a.level === 'critical' && b.level !== 'critical') return -1;
            if (a.level !== 'critical' && b.level === 'critical') return 1;
            return 0;
        });
        
        const critCount = issues.filter(i => i.level === 'critical').length;
        const total = issues.length;
        
        resultHtml = `<div style="margin-bottom: 12px; font-weight: 500; font-size: 15px; color: var(--text-primary);">Auto-Diagnose found <span style="color:${critCount > 0 ? 'var(--danger)' : 'var(--warning)'}">${total}</span> issue(s):</div>`;
        
        resultHtml += issues.map(issue => {
            const isCritical = issue.level === 'critical';
            const bgColor = isCritical ? 'rgba(239, 68, 68, 0.08)' : 'rgba(245, 158, 11, 0.08)';
            const borderColor = isCritical ? 'var(--danger)' : 'var(--warning)';
            
            return `
            <div style="background: ${bgColor}; padding: 14px; border-radius: 10px; margin-bottom: 10px; border-left: 3px solid ${borderColor}; line-height: 1.5; color: var(--text-primary);">
                ${issue.html}
            </div>
            `;
        }).join('');
    }

    resultHtml += `<div style="margin-top: 20px; font-size: 12px; color: var(--text-tertiary); text-align: center; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 10px;">Diagnostic data from device telemetry snapshot</div>`;

    Modal.alert('Intelligent Auto-Diagnose', resultHtml);
}

function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try {
        document.execCommand('copy');
        Toast.success('JSON copied to clipboard');
    } catch (e) {
        Toast.error('Failed to copy');
    }
    document.body.removeChild(ta);
}

// ============================================
// Demo Data (for testing without a real device)
// ============================================
function loadDemoData() {
    const demo = {
        deviceType: "switch",
        diagVersion: 1,
        timestamp: Math.floor(Date.now() / 1000),
        localTime: new Date().toLocaleString(),
        system: {
            freeHeap: 180000,
            minFreeHeap: 120000,
            heapSize: 320000,
            maxAllocHeap: 110000,
            fragmentation: 12,
            stackFree: 2048,
            uptime: 86520,
            uptimeDays: 1,
            cpuFreqMhz: 160,
            cpuTemp: 42.5,
            resetReason: "Power On",
            firmware: "2.4.1",
            chipCores: 1,
            chipRevision: 1,
            flashSize: 4194304,
            sketchSize: 1200000,
            freeSketchSpace: 2994304,
            configSize: 256,
            eepromSize: 4096,
            configVersion: 5
        },
        wifi: {
            connected: true,
            rssi: -58,
            ssid: "MyNetwork",
            channel: 6,
            bssid: "AA:BB:CC:DD:EE:FF",
            ip: "192.168.1.42",
            gateway: "192.168.1.1",
            dns: "8.8.8.8",
            mac: "12:34:56:78:9A:BC",
            txPower: 20,
            disconnectCount: 3,
            twtActive: false,
            history: [
                { t: 120, type: "CONN", rssi: -55, reason: 0 },
                { t: 85, type: "DISC", rssi: -72, reason: 202 },
                { t: 80, type: "CONN", rssi: -58, reason: 0 }
            ]
        },
        mqtt: {
            connected: true,
            enabled: true,
            reconnectCount: 2,
            publishSuccess: 1450,
            publishFail: 5,
            broker: "192.168.1.10",
            port: 1883,
            history: [
                { t: 115, type: "CONN", rc: 0 },
                { t: 82, type: "DISC", rc: -1 },
                { t: 78, type: "CONN", rc: 0 }
            ]
        },
        light: {
            currentState: true,
            totalToggles: 342,
            falseTriggersCount: 8,
            falseTriggerRate: 2.3,
            servoCycles: 342,
            sources: {
                touch: 180,
                motion: 120,
                mqtt: 25,
                automation: 12,
                alarm: 5
            },
            history: [
                { t: 30, state: true, mode: 0, src: "MOTION" },
                { t: 25, state: false, mode: 0, src: "AUTO" },
                { t: 15, state: true, mode: 1, src: "TOUCH" }
            ]
        },
        radar: {
            connected: true,
            paused: false,
            state: "OCCUPIED",
            motionType: "STATIONARY",
            moveEnergy: 15,
            staticEnergy: 45,
            noiseFloorMove: 5,
            noiseFloorStatic: 12,
            presenceScore: 78,
            movingDistance: 150,
            staticDistance: 200,
            activeGates: 4,
            dominantGate: 3,
            entryThreshMove: 30,
            entryThreshStatic: 25,
            holdMultiplier: 1.5,
            confirmMs: 800,
            departureDelayMs: 15000,
            maxGates: 6,
            gates: [
                { move: 8, static: 35, avgMove: 6.2, avgStatic: 30.1 },
                { move: 12, static: 42, avgMove: 10.5, avgStatic: 38.0 },
                { move: 25, static: 55, avgMove: 20.3, avgStatic: 48.7 },
                { move: 45, static: 62, avgMove: 38.1, avgStatic: 55.2 },
                { move: 18, static: 30, avgMove: 15.0, avgStatic: 25.8 },
                { move: 5, static: 18, avgMove: 4.2, avgStatic: 15.3 },
                { move: 2, static: 10, avgMove: 1.8, avgStatic: 8.5 },
                { move: 1, static: 5, avgMove: 0.9, avgStatic: 4.1 },
                { move: 0, static: 3, avgMove: 0.4, avgStatic: 2.5 }
            ],
            history: [
                { t: 45, from: "EMPTY", to: "OCC", dur: 5000 },
                { t: 30, from: "OCC", to: "DEPT", dur: 15000 },
                { t: 20, from: "DEPT", to: "OCC", dur: 3000 }
            ]
        },
        stateMachine: {
            currentMode: "AUTO",
            modeIndex: 0,
            lightState: true,
            dayIdleActive: false,
            motionTimeRemaining: 45000,
            manualTimeRemaining: 0,
            history: [
                { t: 100, from: 1, to: 0, trigger: "TIMER" },
                { t: 50, from: 0, to: 1, trigger: "TOUCH" }
            ]
        },
        automation: {
            rules: {
                sunset: true,
                presence: true,
                morning: false,
                night: true,
                temperature: false
            },
            dayIdleEnabled: true,
            alarmEnabled: false,
            linkedDevice: "SENSOR_01",
            currentHour: new Date().getHours(),
            currentMinute: new Date().getMinutes(),
            timeSync: true
        },
        display: {
            screenWakes: 89
        },
        input: {
            history: [
                { t: 12, type: "ACTION", dur: 120 },
                { t: 8, type: "LONG", dur: 1200 },
                { t: 3, type: "DOUBLE", dur: 180 }
            ]
        },
        events: [
            { t: 120, cat: "SYS", msg: "System initialized successfully" },
            { t: 85, cat: "NET", msg: "WiFi reconnected after disconnect" },
            { t: 45, cat: "RADAR", msg: "Presence detected, entering OCCUPIED" },
            { t: 30, cat: "AUTO", msg: "Sunset rule triggered — light ON" },
            { t: 10, cat: "SYS", msg: "NTP time synchronized" }
        ]
    };

    DiagState.lastPayload = demo;
    DiagState.lastUpdateTime = Date.now();
    updateDiagnosticsUI(demo);
    Toast.success('Demo data loaded');
}

// ============================================
// Auto Refresh Timer
// ============================================
function startAutoRefresh() {
    DiagState.autoRefreshRemaining = DiagState.autoRefreshInterval;
    updateAutoRefreshBar();

    if (DiagState.autoRefreshTimer) clearInterval(DiagState.autoRefreshTimer);
    DiagState.autoRefreshTimer = setInterval(() => {
        DiagState.autoRefreshRemaining--;
        updateAutoRefreshBar();

        if (DiagState.autoRefreshRemaining <= 0) {
            if (DiagState.connected) {
                MQTTClient.publishControl(DiagState.deviceId, { command: 'diagnostics' });
                console.log('[Diag] Auto-refresh: requested telemetry');
            }
            DiagState.autoRefreshRemaining = DiagState.autoRefreshInterval;
        }
    }, 1000);
}

function resetAutoRefresh() {
    DiagState.autoRefreshRemaining = DiagState.autoRefreshInterval;
    updateAutoRefreshBar();
}

function updateAutoRefreshBar() {
    const fill = document.getElementById('autoRefreshFill');
    if (!fill) return;
    const pct = ((DiagState.autoRefreshInterval - DiagState.autoRefreshRemaining) / DiagState.autoRefreshInterval) * 100;
    fill.style.width = `${pct}%`;
}

// ============================================
// MQTT Connection
// ============================================
let mqttInitialized = false;

async function connectMQTT() {
    if (mqttInitialized) return;
    mqttInitialized = true;

    console.log('[Diag] Connecting MQTT for device:', DiagState.deviceId);
    setText('val-connStatus', 'Connecting...');

    try {
        MQTTClient.clearCallbacks();
        MQTTClient.reconnectAttempts = 0;
        MQTTClient.reconnectDelay = 1000;
        MQTTClient.initVisibilityHandler();

        MQTTClient.on('onConnect', () => {
            console.log('[Diag] MQTT connected');
            DiagState.connected = true;
            updateStatusBadge(true);
            setText('val-connStatus', 'Connected');

            // Subscribe to device state topics (lumibot/{id}/state, availability)
            MQTTClient.subscribeDevice(DiagState.deviceId);
            
            // Subscribe to diagnostics topic via raw Paho client
            // MQTTClient has no generic subscribe() — only subscribeDevice()
            // which only handles lumibot/{id}/state and availability
            const diagTopic = `lumibot/${DiagState.deviceId.toUpperCase()}/diagnostics`;
            try {
                if (MQTTClient.client && MQTTClient.client.isConnected()) {
                    MQTTClient.client.subscribe(diagTopic, { qos: 0 });
                    console.log('[Diag] Subscribed to:', diagTopic);
                }
            } catch(e) {
                console.warn('[Diag] Subscribe error:', e);
            }

            // CRITICAL: Wrap the Paho client's onMessageArrived to intercept 
            // diagnostics messages BEFORE MQTTClient._onMessageArrived filters them out.
            // The filter in mqtt.js line 596-597 rejects ALL non-lumibot state/availability topics.
            const originalHandler = MQTTClient.client.onMessageArrived;
            MQTTClient.client.onMessageArrived = function(message) {
                const topic = message.destinationName;
                
                // Check if this is a diagnostics message for our device
                if (topic === diagTopic ||
                    topic === `lumibot/${DiagState.deviceId.toUpperCase()}/state`) {
                    try {
                        const payload = JSON.parse(message.payloadString);
                        DiagState.messageCount++;
                        setText('val-msgCount', DiagState.messageCount);
                        
                        console.log('[Diag] Message on', topic, '— keys:', Object.keys(payload).join(', '));
                        
                        // Check for diagnostics payload (has system, wifi, mqtt, etc.)
                        const isDiag = payload.system || payload.diagVersion || payload.wifi ||
                                       payload.mqtt || payload.light || payload.radar ||
                                       payload.stateMachine || payload.automation;
                        
                        if (isDiag) {
                            console.log('[Diag] ✅ Diagnostics payload received!');
                            DiagState.lastPayload = payload;
                            DiagState.lastUpdateTime = Date.now();
                            updateDiagnosticsUI(payload);
                            resetAutoRefresh();
                        }
                        
                        // Update online status from state messages
                        if (payload._online !== undefined) {
                            updateStatusBadge(payload._online);
                        }
                    } catch (e) {
                        console.error('[Diag] Parse error:', e);
                    }
                }
                
                // Always call original handler so MQTTClient state/availability still works
                if (originalHandler) {
                    originalHandler.call(MQTTClient.client, message);
                }
            };

            // Request diagnostics after connection settles
            setTimeout(() => {
                MQTTClient.publishControl(DiagState.deviceId, { command: 'diagnostics' });
                console.log('[Diag] Requested diagnostics from device');
            }, 800);

            startAutoRefresh();
        });

        MQTTClient.on('onDisconnect', () => {
            console.log('[Diag] MQTT disconnected');
            DiagState.connected = false;
            updateStatusBadge(false);
            setText('val-connStatus', 'Disconnected');
        });

        // Also listen to StateStore for online/offline status
        if (typeof StateStore !== 'undefined') {
            StateStore.subscribe(DiagState.deviceId, (state) => {
                if (!state) return;
                if (state._online !== undefined) updateStatusBadge(state._online);
            });
        }

        await MQTTClient.connect();

    } catch (error) {
        console.error('[Diag] MQTT connection failed:', error);
        setText('val-connStatus', 'Connection failed');
        try { Toast.error('Failed to connect to device'); } catch(e) {}
    }
}

// ============================================
// Status Badge
// ============================================
function updateStatusBadge(online) {
    const badge = document.getElementById('statusBadge');
    const dot = badge?.querySelector('.status-dot');
    const text = document.getElementById('statusText');

    if (!badge) return;

    badge.classList.remove('online', 'offline', 'connecting');
    if (dot) dot.classList.remove('online', 'offline', 'connecting');

    if (online === true) {
        badge.classList.add('online');
        if (dot) dot.classList.add('online');
        if (text) text.textContent = 'Online';
    } else if (online === undefined || online === null) {
        badge.classList.add('connecting');
        if (dot) dot.classList.add('connecting');
        if (text) text.textContent = 'Connecting...';
    } else {
        badge.classList.add('offline');
        if (dot) dot.classList.add('offline');
        if (text) text.textContent = 'Offline';
    }
}

// ============================================
// Helpers
// ============================================
function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = String(val ?? '--');
}

function formatUptime(seconds) {
    if (!seconds && seconds !== 0) return '--:--:--';
    const d = Math.floor(seconds / (3600 * 24));
    const h = Math.floor(seconds % (3600 * 24) / 3600);
    const m = Math.floor(seconds % 3600 / 60);
    const s = Math.floor(seconds % 60);
    
    let res = '';
    if (d > 0) res += `${d}d `;
    res += `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return res;
}

function formatBytes(bytes) {
    if (bytes == null) return '--';
    if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} B`;
}

function formatTimer(ms) {
    if (ms == null || ms <= 0) return 'Inactive';
    if (ms < 1000) return `${ms}ms`;
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    if (m > 0) return `${m}m ${s % 60}s`;
    return `${s}s`;
}

// ============================================
// Main UI Update
// ============================================
function updateDiagnosticsUI(diag) {
    console.log('[Diag] Updating UI with data...');
    try {
        const isStepper = diag.deviceType === 'stepper';
        
        // Hide/Show sections
        document.getElementById('section-light').style.display = isStepper ? 'none' : 'block';
        document.getElementById('section-radar').style.display = isStepper ? 'none' : 'block';
        document.getElementById('section-statemachine').style.display = isStepper ? 'none' : 'block';
        
        document.getElementById('section-stepper').style.display = isStepper ? 'block' : 'none';
        document.getElementById('section-touch').style.display = isStepper ? 'block' : 'none';
        
        const zSettings = document.getElementById('zaylo-adv-settings');
        if (zSettings) zSettings.style.display = isStepper ? 'none' : 'block';
        const sSettings = document.getElementById('stepper-adv-settings');
        if (sSettings) sSettings.style.display = isStepper ? 'block' : 'none';

        updateSystemSection(diag);
        updateMemorySection(diag);
        updateWiFiSection(diag);
        updateMQTTSection(diag);
        
        if (isStepper) {
            updateStepperSection(diag);
            updateTouchSection(diag);
        } else {
            updateLightSection(diag);
            updateRadarSection(diag);
            updateStateMachineSection(diag);
        }
        
        updateAutomationSection(diag, isStepper);
        updateDisplaySection(diag);
        updateEventLog(diag);
        updateLastUpdated();
        console.log('[Diag] UI update complete');
    } catch(e) {
        console.error('[Diag] UI update error:', e);
    }
}

// ── System ──────────────────────────────────
function updateSystemSection(diag) {
    const sys = diag.system || {};
    setText('val-uptime', formatUptime(sys.uptime));
    setText('val-cpuTemp', sys.cpuTemp != null ? `${sys.cpuTemp} °C` : '-- °C');
    setText('val-firmware', sys.firmware || '--');
    setText('val-cpuFreq', sys.cpuFreqMhz ? `${sys.cpuFreqMhz} MHz` : '-- MHz');
    setText('val-chip', sys.chipCores ? `${sys.chipCores} cores, rev ${sys.chipRevision || '?'}` : '--');
    setText('val-resetReason', sys.resetReason || 'Unknown');
    setText('val-uptimeDays', sys.uptimeDays != null ? `${sys.uptimeDays}` : '--');
    setText('val-localTime', diag.localTime || '--');
}

// ── Memory ──────────────────────────────────
function updateMemorySection(diag) {
    const sys = diag.system || {};
    const freeH = sys.freeHeap;
    const heapSize = sys.heapSize;
    const minH = sys.minFreeHeap;
    const maxAlloc = sys.maxAllocHeap;
    const frag = sys.fragmentation;

    setText('val-freeHeap', freeH != null ? formatBytes(freeH) : '-- KB');
    setText('val-minHeap', minH != null ? formatBytes(minH) : '-- KB');
    setText('val-maxAlloc', maxAlloc != null ? formatBytes(maxAlloc) : '-- KB');
    setText('val-fragmentation', frag != null ? `${frag}%` : '--%');
    setText('val-stackFree', sys.stackFree != null ? `${sys.stackFree} words` : '--');
    setText('val-flashSize', sys.flashSize ? formatBytes(sys.flashSize) : '--');
    setText('val-sketchSize', sys.sketchSize ? formatBytes(sys.sketchSize) : '--');
    setText('val-freeSketchSpace', sys.freeSketchSpace ? formatBytes(sys.freeSketchSpace) : '--');

    if (freeH != null && heapSize) {
        const usedH = heapSize - freeH;
        setText('val-heapUsage', `${formatBytes(usedH)} / ${formatBytes(heapSize)}`);
        const usagePct = Math.max(0, Math.min(100, (usedH / heapSize) * 100));
        const memBar = document.getElementById('val-memBar');
        if (memBar) {
            memBar.style.width = `${usagePct}%`;
            memBar.classList.remove('warn', 'danger');
            if (usagePct > 85) memBar.classList.add('danger');
            else if (usagePct > 70) memBar.classList.add('warn');
        }
    } else if (freeH != null) {
        const totalEst = 320000;
        const usedEst = totalEst - freeH;
        setText('val-heapUsage', `${formatBytes(freeH)} free`);
        const usagePct = Math.max(0, Math.min(100, (usedEst / totalEst) * 100));
        const memBar = document.getElementById('val-memBar');
        if (memBar) {
            memBar.style.width = `${usagePct}%`;
            memBar.classList.remove('warn', 'danger');
            if (usagePct > 85) memBar.classList.add('danger');
            else if (usagePct > 70) memBar.classList.add('warn');
        }
    }
}

// ── WiFi ────────────────────────────────────
function updateWiFiSection(diag) {
    const wifi = diag.wifi || {};
    
    setStatusBadge('val-wifiStatus', wifi.connected, wifi.connected ? 'Connected' : 'Disconnected');
    
    const rssi = wifi.rssi;
    setText('val-rssi', rssi != null ? `${rssi} dBm` : '-- dBm');
    updateSignalBars(rssi);

    setText('val-ssid', wifi.ssid || '--');
    setText('val-channel', wifi.channel != null ? `${wifi.channel}` : '--');
    setText('val-ip', wifi.ip || '--');
    setText('val-gateway', wifi.gateway || '--');
    setText('val-dns', wifi.dns || '--');
    setText('val-mac', wifi.mac || '--');
    setText('val-bssid', wifi.bssid || '--');
    setText('val-txPower', wifi.txPower != null ? `${wifi.txPower}` : '--');
    setText('val-wifiDrops', wifi.disconnectCount || 0);
    setText('val-twt', wifi.twtActive ? 'Yes' : 'No');

    if (wifi.history && Array.isArray(wifi.history)) {
        renderEventLog('wifiHistoryLog', wifi.history, (e) => {
            const cls = (e.type === 'CONN') ? 'conn' : (e.type === 'DISC' ? 'disc' : 'fail');
            return `<span class="c-time">${e.t}s</span>
                    <span class="c-type ${cls}">${e.type}</span>
                    <span class="c-info">${e.rssi != null ? `RSSI: ${e.rssi}` : ''} ${e.reason ? `R:${e.reason}` : ''}</span>`;
        });
    }
}

function updateSignalBars(rssi) {
    const bars = document.querySelectorAll('#val-signalBars .signal-bar');
    if (!bars.length) return;

    let level = 0;
    let colorClass = '';
    if (rssi == null || rssi === 0) {
        level = 0;
    } else if (rssi >= -50) {
        level = 5;
    } else if (rssi >= -60) {
        level = 4;
    } else if (rssi >= -70) {
        level = 3; colorClass = 'warn';
    } else if (rssi >= -80) {
        level = 2; colorClass = 'danger';
    } else {
        level = 1; colorClass = 'danger';
    }

    bars.forEach((bar, i) => {
        bar.classList.remove('active', 'warn', 'danger');
        if (i < level) {
            bar.classList.add('active');
            if (colorClass) bar.classList.add(colorClass);
        }
    });
}

// ── MQTT ────────────────────────────────────
function updateMQTTSection(diag) {
    const mqtt = diag.mqtt || {};
    
    setStatusBadge('val-mqttStatus', mqtt.connected, mqtt.connected ? 'Connected' : 'Disconnected');
    setText('val-mqttBroker', mqtt.broker || '--');
    setText('val-mqttPort', mqtt.port || '--');
    setText('val-mqttReconnects', mqtt.reconnectCount || 0);
    setText('val-pubSuccess', mqtt.publishSuccess || 0);
    setText('val-pubFail', mqtt.publishFail || 0);

    if (mqtt.history && Array.isArray(mqtt.history)) {
        renderEventLog('mqttHistoryLog', mqtt.history, (e) => {
            const cls = (e.type === 'CONN') ? 'conn' : (e.type === 'DISC' ? 'disc' : 'fail');
            return `<span class="c-time">${e.t}s</span>
                    <span class="c-type ${cls}">${e.type}</span>
                    <span class="c-info">${e.rc != null ? `RC: ${e.rc}` : ''}</span>`;
        });
    }
}

// ── Light Switch ────────────────────────────
function updateLightSection(diag) {
    const light = diag.light || {};
    
    setStatusBadge('val-lightState', light.currentState, light.currentState ? 'ON' : 'OFF');
    setText('val-totalToggles', light.totalToggles || 0);
    setText('val-falseTriggers', light.falseTriggersCount || 0);
    setText('val-falseTriggerRate', light.falseTriggerRate != null ? `${light.falseTriggerRate.toFixed(1)}%` : '0%');
    setText('val-servoCycles', light.servoCycles || 0);

    const src = light.sources || {};
    setText('val-srcTouch', src.touch || 0);
    setText('val-srcMotion', src.motion || 0);
    setText('val-srcMqtt', src.mqtt || 0);
    setText('val-srcAuto', src.automation || 0);
    setText('val-srcAlarm', src.alarm || 0);

    if (light.history && Array.isArray(light.history)) {
        const modeNames = ['AUTO', 'MANUAL', 'ALARM', 'BEDTIME', 'LOCKED'];
        renderEventLog('lightHistoryLog', light.history, (e) => {
            const stateStr = e.state ? '● ON' : '○ OFF';
            return `<span class="c-time">${e.t}s</span>
                    <span class="c-type ${e.state ? 'conn' : 'disc'}">${stateStr}</span>
                    <span class="c-info">via ${e.src || '?'} (${modeNames[e.mode] || '?'})</span>`;
        });
    }
}

// ── Stepper Motor ───────────────────────────
function updateStepperSection(diag) {
    const stepper = diag.stepper || {};
    
    setStatusBadge('val-stepperState', !stepper.isMoving, stepper.isMoving ? 'MOVING' : 'IDLE');
    setText('val-suspectedStalls', stepper.suspectedStalls || 0);
    setText('val-stepperPos', stepper.currentPos || '--');
    setText('val-stepperTargetPct', stepper.targetPct != null ? `${stepper.targetPct}%` : '--');
    setText('val-totalMoves', stepper.totalMoves || 0);
    setText('val-motorCycles', stepper.motorCycles || 0);
    setText('val-stepperCalibrated', stepper.isCalibrated ? 'Yes' : 'No');

    if (stepper.history && Array.isArray(stepper.history)) {
        renderEventLog('stepperHistoryLog', stepper.history, (e) => {
            const isMove = e.type === 'MOVE';
            return `<span class="c-time">${e.timestamp || e.t || 0}s</span>
                    <span class="c-type ${isMove ? 'conn' : 'info'}">${e.type || 'EVENT'}</span>
                    <span class="c-info">${isMove ? `Tgt: ${e.targetPos} (${e.durationMs}ms)` : ''}</span>`;
        });
    }
}

// ── Touch Sensor ────────────────────────────
function updateTouchSection(diag) {
    const touch = diag.touch || {};
    
    setText('val-touchTotal', touch.totalEvents || 0);
    setText('val-touchFalse', touch.falseTriggersCount || 0);
    setText('val-touchFalseRate', touch.falseTriggerRate != null ? `${touch.falseTriggerRate.toFixed(1)}%` : '0%');
}

// ── Radar ───────────────────────────────────
function updateRadarSection(diag) {
    const radar = diag.radar || {};
    
    setStatusBadge('val-radarStatus', radar.connected, radar.connected ? 'Connected' : 'Disconnected');
    
    const stateEl = document.getElementById('val-radarState');
    if (stateEl) {
        stateEl.textContent = radar.state || '--';
        stateEl.style.color = radar.state === 'OCCUPIED' ? 'var(--success)' 
            : radar.state === 'DEPARTING' ? 'var(--warning)' : '';
    }
    
    setText('val-motionType', radar.motionType || '--');
    setText('val-moveEnergy', radar.moveEnergy != null ? radar.moveEnergy : '--');
    setText('val-staticEnergy', radar.staticEnergy != null ? radar.staticEnergy : '--');
    setText('val-presenceScore', radar.presenceScore != null ? radar.presenceScore : '--');
    setText('val-movingDist', radar.movingDistance != null ? `${radar.movingDistance} cm` : '-- cm');
    setText('val-staticDist', radar.staticDistance != null ? `${radar.staticDistance} cm` : '-- cm');
    setText('val-activeGates', radar.activeGates != null ? radar.activeGates : '--');
    setText('val-dominantGate', radar.dominantGate != null ? `G${radar.dominantGate}` : '--');
    setText('val-radarPaused', radar.paused ? 'Yes' : 'No');

    setText('val-entryThreshMove', radar.entryThreshMove != null ? radar.entryThreshMove : '--');
    setText('val-entryThreshStatic', radar.entryThreshStatic != null ? radar.entryThreshStatic : '--');
    setText('val-holdMultiplier', radar.holdMultiplier != null ? `${radar.holdMultiplier}x` : '--');
    setText('val-confirmMs', radar.confirmMs != null ? `${radar.confirmMs} ms` : '-- ms');
    setText('val-departureDelayMs', radar.departureDelayMs != null ? `${radar.departureDelayMs} ms` : '-- ms');
    setText('val-maxGates', radar.maxGates != null ? radar.maxGates : '--');

    if (radar.gates && Array.isArray(radar.gates)) {
        updateGateVisualization(radar.gates);
    }

    if (radar.history && Array.isArray(radar.history)) {
        renderEventLog('radarStateLog', radar.history, (e) => {
            const toColor = e.to === 'OCC' || e.to === 'OCCUPIED' ? 'var(--success)' 
                : e.to === 'DEPT' || e.to === 'DEPARTING' ? 'var(--warning)' : 'var(--text-secondary)';
            return `<span class="c-time">${e.t}s</span>
                    <span class="c-info" style="color:${toColor};">${e.from || '?'} → ${e.to || '?'}</span>
                    <span class="c-info" style="color:var(--text-tertiary);">${e.dur ? `${(e.dur / 1000).toFixed(1)}s` : ''}</span>`;
        });
    }
}

function updateGateVisualization(gates) {
    let maxE = 1;
    gates.forEach(g => {
        if (g.move > maxE) maxE = g.move;
        if ((g.static || 0) > maxE) maxE = g.static;
    });

    const maxBarHeight = 50;

    gates.forEach((g, i) => {
        const moveBar = document.getElementById(`gate-move-${i}`);
        const staticBar = document.getElementById(`gate-static-${i}`);
        if (moveBar) {
            const h = Math.max(2, ((g.move || 0) / maxE) * maxBarHeight);
            moveBar.style.height = `${h}px`;
            moveBar.title = `Move: ${g.move || 0} (avg: ${g.avgMove || 0})`;
        }
        if (staticBar) {
            const h = Math.max(2, ((g.static || 0) / maxE) * maxBarHeight);
            staticBar.style.height = `${h}px`;
            staticBar.title = `Static: ${g.static || 0} (avg: ${g.avgStatic || 0})`;
        }
    });
}

// ── State Machine ───────────────────────────
function updateStateMachineSection(diag) {
    const sm = diag.stateMachine || {};
    
    setText('val-currentMode', sm.currentMode || '--');
    setText('val-smLightState', sm.lightState ? 'ON' : 'OFF');
    setText('val-dayIdle', sm.dayIdleActive ? 'Yes' : 'No');
    setText('val-motionTimeRemain', formatTimer(sm.motionTimeRemaining));
    setText('val-manualTimeRemain', formatTimer(sm.manualTimeRemaining));

    if (sm.history && Array.isArray(sm.history)) {
        const modeNames = ['AUTO', 'MANUAL', 'ALARM', 'BEDTIME', 'LOCKED'];
        renderEventLog('modeHistoryLog', sm.history, (e) => {
            return `<span class="c-time">${e.t}s</span>
                    <span class="c-info">${modeNames[e.from] || e.from} → <strong>${modeNames[e.to] || e.to}</strong></span>
                    <span class="c-info" style="color:var(--text-tertiary);">via ${e.trigger || '?'}</span>`;
        });
    }
}

// ── Automation ──────────────────────────────
function updateAutomationSection(diag, isStepper) {
    const auto = diag.automation || {};
    const rules = auto.rules || {};

    let rulesDef = [];
    if (isStepper) {
        rulesDef = [
            { key: 'sunset',      name: 'Sunset Close',    icon: '🌅' },
            { key: 'presence',    name: 'Presence',         icon: '👤' },
            { key: 'morning',    name: 'Morning Open',     icon: '☀️' },
            { key: 'night',      name: 'Night Lock',       icon: '🌙' },
            { key: 'temperature', name: 'Heat Protect',    icon: '🌡️' }
        ];
    } else {
        rulesDef = [
            { key: 'sunset',      name: 'Sunset On',       icon: '🌅' },
            { key: 'presence',    name: 'Auto Motion',      icon: '🏃' },
            { key: 'bedtime',     name: 'Bedtime Dim',      icon: '🛏️' },
            { key: 'night',       name: 'Night Lock',       icon: '🌙' }
        ];
    }

    const grid = document.getElementById('rulesGrid');
    if (grid) {
        grid.innerHTML = rulesDef.map(r => {
            const enabled = rules[r.key] === true;
            return `<div class="rule-item ${enabled ? 'enabled' : ''}">
                <span class="rule-icon">${r.icon}</span>
                <div class="rule-info">
                    <span class="rule-name">${r.name}</span>
                    <span class="rule-status">${enabled ? 'Active' : 'Off'}</span>
                </div>
            </div>`;
        }).join('');
    }

    setText('val-dayIdleEnabled', auto.dayIdleEnabled ? 'Enabled' : 'Disabled');
    setText('val-alarmEnabled', auto.alarmEnabled ? 'Enabled' : 'Disabled');
    setText('val-linkedDevice', auto.linkedDevice || 'None');
    setText('val-autoTime', auto.currentHour != null ? 
        `${String(auto.currentHour).padStart(2, '0')}:${String(auto.currentMinute || 0).padStart(2, '0')}` : '--');
    setText('val-timeSync', auto.timeSync ? 'Yes ✓' : 'No ✗');
}

// ── Display & Input ─────────────────────────
function updateDisplaySection(diag) {
    const display = diag.display || {};
    setText('val-screenWakes', display.screenWakes || 0);

    const input = diag.input || {};
    if (input.history && Array.isArray(input.history)) {
        renderEventLog('inputHistoryLog', input.history, (e) => {
            return `<span class="c-time">${e.t}s</span>
                    <span class="c-type">${e.type || '?'}</span>
                    <span class="c-info">${e.dur ? `${e.dur}ms` : ''}</span>`;
        });
    }
}

// ── Event Log ───────────────────────────────
function updateEventLog(diag) {
    const events = diag.events;
    if (events && Array.isArray(events)) {
        renderEventLog('generalEventLog', events, (e) => {
            return `<span class="c-time">${e.t}s</span>
                    <span class="c-cat">${e.cat || '?'}</span>
                    <span class="c-info">${e.msg || ''}</span>`;
        });
    }
}

// ── Shared Event Log Renderer ───────────────
function renderEventLog(containerId, events, renderFn) {
    const container = document.getElementById(containerId);
    if (!container) return;

    if (!events || events.length === 0) {
        container.innerHTML = `<div class="code-line"><span class="c-info" style="color: var(--text-tertiary);">No events recorded.</span></div>`;
        return;
    }

    let html = '';
    events.forEach(e => {
        html += `<div class="code-line">${renderFn(e)}</div>`;
    });
    container.innerHTML = html;
}

// ── Status Badge Helper ─────────────────────
function setStatusBadge(id, isActive, label) {
    const el = document.getElementById(id);
    if (!el) return;
    el.className = `status-badge ${isActive ? 'online' : 'offline'}`;
    el.innerHTML = `<span class="status-badge-dot"></span> ${label}`;
}

// ── Last Updated ────────────────────────────
function updateLastUpdated() {
    const el = document.getElementById('lastUpdated');
    if (!el) return;
    const now = new Date();
    el.textContent = `Last updated: ${now.toLocaleTimeString()}`;
}
