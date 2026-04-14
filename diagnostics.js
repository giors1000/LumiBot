/**
 * Diagnostics JS for Zaylo
 */

const DeviceState = {
    deviceId: null,
    connected: false,
    initialLoadComplete: false,
    lastDiagSync: 0,
    radarLog: []
};

// ============================================
// Initialization & PWA Support
// ============================================
document.addEventListener('DOMContentLoaded', async () => {
    // Hide mobile URL bar if possible
    window.scrollTo(0, 1);
    
    // Parse the device ID from URL
    const urlParams = new URLSearchParams(window.location.search);
    DeviceState.deviceId = urlParams.get('id');
    
    if (!DeviceState.deviceId) {
        window.location.href = 'index.html';
        return;
    }

    // Set title
    const deviceName = DeviceList.get(DeviceState.deviceId)?.name || `Device ${DeviceState.deviceId}`;
    const headerTitle = document.querySelector('.device-title');
    if (headerTitle) { headerTitle.textContent = `${deviceName} Diag`; }

    // Init Back button
    const backBtn = document.getElementById('backBtn');
    if (backBtn) {
        backBtn.addEventListener('click', () => {
            window.location.href = `index.html`;
        });
    }

    // Init Buttons
    document.getElementById('refreshBtn')?.addEventListener('click', () => {
        if(DeviceState.connected) {
            MQTTClient.publishControl(DeviceState.deviceId, { command: "diagnostics" });
            Toast.success('Requested telemetry');
        } else {
            Toast.error('Device is offline');
        }
    });

    document.getElementById('rebootBtn')?.addEventListener('click', () => {
         Modal.confirm(
            'Reboot System?',
            'Are you sure you want to reboot the device? This will take ~5 seconds.',
            () => {
                if(DeviceState.connected) {
                    MQTTClient.publishControl(DeviceState.deviceId, { command: "reboot" });
                    Toast.success('Reboot command sent');
                } else {
                    Toast.error('Device is offline');
                }
            }
        );
    });

    try {
        await Auth.waitForAuthReady();
        if (!Auth.user) {
            window.location.href = 'auth.html';
            return;
        }

        // We load settings logic manually
        connectMQTT();

    } catch (e) {
        console.error('[Diag] Initialization error', e);
    }
});


let mqttInitialized = false;

async function connectMQTT() {
    if (mqttInitialized) return;
    mqttInitialized = true;

    try {
        MQTTClient.clearCallbacks();
        MQTTClient.reconnectAttempts = 0;
        MQTTClient.reconnectDelay = 1000;
        MQTTClient.initVisibilityHandler();

        MQTTClient.on('onConnect', () => {
            DeviceState.connected = true;
            updateStatusBadge(true);
            MQTTClient.subscribeDevice(DeviceState.deviceId);

            // Subscribe to diag topic 
            MQTTClient.subscribe(`zaylo/status/${DeviceState.deviceId}/diag`);

            // Request state initially
            setTimeout(() => {
                MQTTClient.publishControl(DeviceState.deviceId, { command: 'diagnostics' });
            }, 500);

        });

        MQTTClient.on('onDisconnect', () => {
            DeviceState.connected = false;
            updateStatusBadge(false);
        });

        // Listen for standard state
        StateStore.subscribe(DeviceState.deviceId, (state) => {
            if (!state) return;

            // We can update general status from here if we want 
            // In diagnostics page, state mapping is done by custom message handler for `diag` topic
        });
        
        // Listen to raw MQTT messages for diagnostics payload
        MQTTClient.on('onMessage', (msg) => {
             try {
                // Ignore standard state messages, focus on diagnostics
                 if (msg.destinationName === `zaylo/status/${DeviceState.deviceId}/diag` || msg.destinationName === `zaylo/status/${DeviceState.deviceId}`) {
                    const payload = JSON.parse(msg.payloadString);
                    // Standard state check
                    if(payload._t) updateGeneralState(payload);

                    // Diagnostics Payload check
                    if(payload.uptime) updateDiagnosticsUI(payload);
                 }
             } catch (e) {}
        });

        await MQTTClient.connect();

    } catch (error) {
        console.error('[Diag] MQTT connection failed:', error);
        Toast.error('Failed to connect to device');
    }
}

function updateGeneralState(state) {
     if(state._online !== undefined) {
         updateStatusBadge(state._online);
     }
}

function updateStatusBadge(online) {
    const badge = document.getElementById('statusBadge');
    const dot = badge?.querySelector('.status-dot');
    const text = document.getElementById('statusText');

    if (!badge) return;

    badge.classList.remove('online', 'offline', 'connecting');
    if (dot) dot.classList.remove('online', 'offline', 'connecting');

    if (online) {
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


function formatUptime(seconds) {
    if(!seconds) return "0s";
    const d = Math.floor(seconds / (3600*24));
    const h = Math.floor(seconds % (3600*24) / 3600);
    const m = Math.floor(seconds % 3600 / 60);
    const s = Math.floor(seconds % 60);
    
    let res = "";
    if(d > 0) res += `${d}d `;
    res += `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    return res;
}
function updateDiagnosticsUI(diag) {
    // Uptime
    setText('val-uptime', formatUptime(diag.system?.uptime));

    // Reset Reason
    setText('val-resetReason', diag.system?.resetReason || 'Normal/Unknown');
    setText('val-lastError', diag.system?.lastError || 'None');

    // Network Stats
    setText('val-wifiDrops', diag.wifi?.disconnectCount || 0);
    setText('val-mqttReconnects', diag.mqtt?.reconnectCount || 0);
    
    // Hardware Stats
    setText('val-falseTriggers', diag.light?.falseTriggersCount || 0);
    setText('val-servoCycles', diag.light?.servoCycles || 0);
    setText('val-screenWakes', diag.display?.screenWakes || 0);
    
    // Memory Heap
    if(diag.system?.freeHeap && diag.system?.minFreeHeap) {
         setText('val-freeHeap', `${Math.round(diag.system?.freeHeap/1024)} KB Free`);
         setText('val-minHeap', `${Math.round(diag.system?.minFreeHeap/1024)} KB`);

         // Total Heap on esp32 c6 is ~320KB, let's assume 300KB scale
         const usagePct = Math.max(0, Math.min(100, 100 - (diag.system.freeHeap / 300000) * 100));
         const memBar = document.getElementById('val-memBar');
         if(memBar) memBar.style.width = `${usagePct}%`;
         
         if(usagePct > 85) memBar.style.background = 'var(--danger)';
         else if(usagePct > 70) memBar.style.background = 'var(--warning)';
         else memBar.style.background = 'var(--accent-gradient)';
    }

    // Process State Log
    if(diag.radar?.history && Array.isArray(diag.radar.history)) {
         updateRadarLog(diag.radar.history);
    }

    // Process Task Scheduler
    if(diag.tasks?.list && Array.isArray(diag.tasks.list)) {
        updateTaskStats(diag.tasks.list);
    }
}

function setText(id, val) {
    const el = document.getElementById(id);
    if(el) el.textContent = val;
}

function updateRadarLog(logs) {
    const logBox = document.getElementById('radarStateLog');
    if(!logBox) return;

    if(logs.length === 0) {
        logBox.innerHTML = `<div class="code-line"><span class="c-info">No transitions recorded.</span></div>`;
        return;
    }

    // Deduplicate/Combine logic
    // We get a raw array of transitions like {state: 0, ms: -5000} which means transition to state 0 happened 5s ago
    let html = '';
    const now = Date.now();

    // Map internal states
    const states = {
        0: 'EMPTY',
        1: 'OCCUPIED',
        2: 'DEPARTING'
    };

    logs.forEach(lg => {
         const timeStr = `${(-lg.ms / 1000).toFixed(1)}s`;
         const st = states[lg.state] || `INV(${lg.state})`;
         html += `<div class="code-line">
            <span class="c-time">${timeStr}</span> 
            <span class="c-info" style="color: ${st==='OCCUPIED'?'var(--success)':(st==='DEPARTING'?'var(--warning)':'var(--text-secondary)')};">→ ${st}</span>
         </div>`;
    });

    logBox.innerHTML = html;
}

function updateTaskStats(tasks) {
    const taskBox = document.getElementById('taskStatsContainer');
    if(!taskBox) return;

    if(tasks.length === 0) {
        taskBox.innerHTML = `<div class="code-line"><span class="c-info">No tasks recorded.</span></div>`;
        return;
    }

    let html = '';
    
    // Header
    html += `<div class="code-line">
        <span class="c-time" style="width: 100px;">Task Name</span> 
        <span class="c-info" style="width: 60px;">Runs</span>
        <span class="c-info" style="width: 60px;">Avg(ms)</span>
        <span class="c-info">Max(ms)</span>
    </div>`;

    tasks.forEach(t => {
         const name = t.name || 'Unknown';
         const runs = t.runCount || 0;
         const avg = (t.avgRuntime || 0).toFixed(1);
         const max = t.maxRuntime || 0;
         
         html += `<div class="code-line">
            <span class="c-time" style="width: 100px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${name}</span> 
            <span class="c-info" style="width: 60px;">${runs}</span>
            <span class="c-info" style="width: 60px; color: ${avg > 50 ? 'var(--warning)' : 'var(--text-secondary)'}">${avg}</span>
            <span class="c-info" style="color: ${max > 100 ? 'var(--danger)' : 'var(--success)'}">${max}</span>
         </div>`;
    });

    taskBox.innerHTML = html;
}
