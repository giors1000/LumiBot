/**
 * LumiBot - Device Control Page Logic
 * Handles device state, settings, and all MQTT communication
 */

// ============================================
// MQTT Configuration
// ============================================
// MQTT credentials are centralized in MQTTClient.config (mqtt.js)
// Do NOT duplicate config here - it causes maintenance issues and
// can lead to connection failures if configs get out of sync.

// ============================================
// Page State
// ============================================
const DeviceState = {
    deviceId: null,
    connected: false,
    state: null,
    timerInterval: null,
    lastTimerValue: 0,
    clientTimerSeconds: 0,
    timerTotalSeconds: 0,
    timerActive: false,
    timerPaused: false,
    lastServerTimerSync: 0,
    initialLoadComplete: false
};

// ============================================
// Initialize
// ============================================
async function init() {
    // Get device ID from URL
    const params = Utils.getQueryParams();
    DeviceState.deviceId = params.id;

    console.log('[Device] Initializing with device ID:', DeviceState.deviceId);

    if (!DeviceState.deviceId) {
        Toast.error('No device ID specified');
        setTimeout(() => window.location.href = 'index.html', 2000);
        return;
    }

    // Update title
    const device = DeviceList.get(DeviceState.deviceId);
    document.getElementById('deviceTitle').textContent = device?.name || `LumiBot-${DeviceState.deviceId}`;

    // Initialize theme
    Theme.init();

    // Show initial loader
    const loader = document.createElement('div');
    loader.id = 'initialLoader';
    loader.style.cssText = `
        position: fixed; inset: 0; background: var(--bg-primary); z-index: 9999;
        display: flex; align-items: center; justify-content: center; flex-direction: column;
        transition: opacity 0.5s ease;
    `;
    loader.innerHTML = `
        <div style="font-size: 3em; animation: pulse 1.5s infinite;">🔄</div>
        <div style="margin-top: 20px; font-weight: 500; color: var(--text-secondary);">Connecting to device...</div>
    `;
    document.body.appendChild(loader);

    // Setup event listeners
    setupTabNavigation();
    setupControlHandlers();
    setupSettingHandlers();
    setupSleepHandlers();

    // Connect to MQTT
    await connectMQTT();

    // Check for initial tab param
    if (params.tab) {
        switchTab(params.tab);
    }
}

// ============================================
// MQTT Connection
// ============================================
let mqttInitialized = false; // Guard against duplicate initialization

async function connectMQTT() {
    // Prevent duplicate initialization
    if (mqttInitialized) {
        console.log('[Device] MQTT already initialized, skipping');
        return;
    }
    mqttInitialized = true;

    try {
        // CRITICAL: Clear any existing callbacks to prevent accumulation
        MQTTClient.clearCallbacks();

        // Reset reconnect state for fresh page load
        MQTTClient.reconnectAttempts = 0;
        MQTTClient.reconnectDelay = 1000;

        MQTTClient.on('onConnect', () => {
            console.log('[Device] MQTT Connected');
            console.log(`[Device] 🔗 Subscribing to device: ${DeviceState.deviceId}`);
            DeviceState.connected = true;
            MQTTClient.subscribeDevice(DeviceState.deviceId);

            // Handle initial load completion - but DON'T call updateUI yet
            // The UI will be updated when onStateUpdate fires with actual device state
            if (!DeviceState.initialLoadComplete) {
                DeviceState.initialLoadComplete = true;
                const loader = document.getElementById('initialLoader');
                if (loader) {
                    loader.style.opacity = '0';
                    setTimeout(() => loader.remove(), 300);
                }
            }

            // Update status badge only - show online status even before full state is received
            updateStatusBadge(true, false);

            // CRITICAL: Request current device state after subscribing
            // This ensures we get the current mode/light state even if device hasn't published recently
            setTimeout(() => {
                console.log('[Device] 📡 Requesting current device state...');
                MQTTClient.publishControl(DeviceState.deviceId, { command: 'getState' });
            }, 500); // Small delay to ensure subscription is complete
        });

        MQTTClient.on('onDisconnect', () => {
            console.log('[Device] MQTT Disconnected');
            DeviceState.connected = false;
            updateStatusBadge(false);
        });

        MQTTClient.on('onStateUpdate', (deviceId, state) => {
            // CRITICAL: Always log device ID comparison
            console.log(`[Device] 📩 State from device: ${deviceId} (we expect: ${DeviceState.deviceId})`);

            if (deviceId === DeviceState.deviceId) {
                // DEBUG: Log incoming state with timer values
                console.log(`[Device] onStateUpdate received:`, {
                    light: state.light,
                    mode: state.mode,
                    motionTimer: state.motionTimer,
                    timerRemaining: state.timerRemaining,
                    motion: state.motion,
                    still: state.still
                });

                // CRITICAL: Warn if mode=2 (ALARM) as this seems unexpected
                if (state.mode === 2) {
                    console.warn(`[Device] ⚠️ ALARM MODE (2) received from device! This may be unexpected.`);
                }

                // Merge state and get _online from cached device state
                const cachedState = MQTTClient.getDeviceState(deviceId) || {};
                const prevState = DeviceState.state || {};

                // CRITICAL: Preserve Firebase sleepHistory - don't let MQTT overwrite it
                const prevSleepHistory = prevState.sleepHistory || [];
                const mqttSleepHistory = state.sleepHistory || [];
                const preservedSleepHistory = mqttSleepHistory.length > prevSleepHistory.length
                    ? mqttSleepHistory
                    : prevSleepHistory;

                DeviceState.state = {
                    ...prevState,
                    ...state,
                    sleepHistory: preservedSleepHistory,
                    isSleeping: state.isSleeping !== undefined ? state.isSleeping : prevState.isSleeping,
                    sleepStart: state.sleepStart !== undefined ? state.sleepStart : prevState.sleepStart,
                    _online: cachedState._online ?? state._online ?? prevState._online ?? false
                };

                // Handle initial load completion
                if (!DeviceState.initialLoadComplete) {
                    DeviceState.initialLoadComplete = true;
                    const loader = document.getElementById('initialLoader');
                    if (loader) {
                        loader.style.opacity = '0';
                        setTimeout(() => loader.remove(), 300);
                    }
                }

                updateUI(DeviceState.state);
            }
        });

        // ============================================
        // PARALLEL LOADING: Start MQTT and Firebase simultaneously
        // ============================================

        // Start MQTT connection immediately (don't wait for Firebase)
        const mqttPromise = MQTTClient.connect();

        // Load Firebase data in parallel (non-blocking)
        loadFirebaseDataAsync();

        // Wait for MQTT to connect (this is the critical path)
        await mqttPromise;

    } catch (error) {
        console.error('[Device] MQTT connection failed:', error);
        Toast.error('Failed to connect to device');
    }
}

/**
 * Load persisted state from Firebase in the background (non-blocking)
 * This runs in parallel with MQTT connection for faster page load
 */
async function loadFirebaseDataAsync() {
    try {
        // Initialize Firestore and wait for auth (in background)
        await DeviceService.init();
        await Auth.waitForAuthReady();

        if (!Auth.user) {
            console.warn('[Device] No authenticated user, skipping Firebase load');
            return;
        }

        console.log('[Device] Loading persisted state from Firebase...');
        const persistedDevice = await DeviceService.getDevice(Auth.user.uid, DeviceState.deviceId);

        if (!persistedDevice) {
            console.log('[Device] No persisted state found in Firebase');
            return;
        }

        console.log('[Device] Loaded persisted state from Firebase');

        // Normalize sleep history data (convert old s/e format to start/end)
        let normalizedSleepHistory = [];
        if (persistedDevice.sleepHistory && Array.isArray(persistedDevice.sleepHistory)) {
            normalizedSleepHistory = persistedDevice.sleepHistory.map(entry => {
                if (entry.s !== undefined || entry.e !== undefined) {
                    return { start: entry.start || entry.s, end: entry.end || entry.e };
                }
                return entry;
            });
        }

        // Merge persisted state - ONLY use Firebase for sleep history and config
        // CRITICAL: Do NOT use Firebase for mode/light - these MUST come from live MQTT
        const currentState = DeviceState.state || {};
        DeviceState.state = {
            ...currentState,
            config: persistedDevice.config || currentState.config,
            _online: currentState._online || false,
            mode: currentState.mode,  // ONLY from MQTT
            light: currentState.light, // ONLY from MQTT
            sleepHistory: normalizedSleepHistory.length > 0 ? normalizedSleepHistory : (currentState.sleepHistory || []),
            isSleeping: persistedDevice.isSleeping || currentState.isSleeping || false,
            sleepStart: persistedDevice.sleepStart || currentState.sleepStart || null
        };

        // Update UI with Firebase data if page is ready
        if (DeviceState.initialLoadComplete) {
            updateUI(DeviceState.state);
        }

        // Save normalized data back to Firebase if needed
        const hadOldFormat = persistedDevice.sleepHistory?.some(e => e.s !== undefined || e.e !== undefined);
        if (hadOldFormat && normalizedSleepHistory.length > 0) {
            DeviceService.updateDevice(Auth.user.uid, DeviceState.deviceId, {
                sleepHistory: normalizedSleepHistory
            }).catch(e => console.warn('[Device] Failed to save normalized data:', e));
        }

    } catch (e) {
        console.error('[Device] Error loading Firebase data:', e);
    }
}

// ============================================
// UI Updates
// ============================================
function updateUI(state) {
    if (!state) return;
    if (!DeviceState.initialLoadComplete) return;

    // Status badge
    updateStatusBadge(state._online, state.isSleeping);

    // WiFi indicator
    updateWifiIndicator(state);

    // Power button
    const powerBtn = document.getElementById('powerBtn');
    const powerLabel = document.getElementById('powerLabel');
    if (powerBtn) {
        powerBtn.classList.toggle('active', state.light);
    }
    if (powerLabel) {
        powerLabel.textContent = state.light ? 'ON' : 'OFF';
        powerLabel.classList.toggle('active', state.light);
    }

    // Mode buttons - skip update if user recently changed mode (prevents race condition)
    // Also skip if mode is undefined (not yet received from device)
    const shouldSkipModeUpdate = shouldIgnoreModeUpdate();

    // CRITICAL: Parse mode as integer - firmware might send as string "0" instead of number 0
    const rawMode = state.mode;
    const deviceMode = (rawMode !== undefined && rawMode !== null) ? parseInt(rawMode, 10) : null;
    const modeValid = deviceMode !== null && !isNaN(deviceMode);

    console.log(`[Device] updateUI mode check: rawMode=${rawMode} (type: ${typeof rawMode}), deviceMode=${deviceMode}, valid=${modeValid}, skipUpdate=${shouldSkipModeUpdate}`);

    if (!shouldSkipModeUpdate && modeValid) {
        const modeButtons = document.querySelectorAll('[data-mode]');
        console.log(`[Device] Updating ${modeButtons.length} mode buttons to reflect mode=${deviceMode}`);

        let activeFound = false;
        modeButtons.forEach(btn => {
            const btnMode = parseInt(btn.dataset.mode, 10);
            const isActive = btnMode === deviceMode;
            btn.classList.toggle('active', isActive);
            if (isActive) {
                activeFound = true;
                console.log(`[Device] ✓ Mode button ${btnMode} set to ACTIVE`);
            }
        });

        if (!activeFound) {
            console.warn(`[Device] ⚠ No mode button matches deviceMode=${deviceMode}. Button modes: ${Array.from(modeButtons).map(b => b.dataset.mode).join(', ')}`);
        }
    } else if (!modeValid) {
        console.log(`[Device] Skipping mode update - mode not valid (rawMode=${rawMode})`);
    }

    // Timer - sync with server
    syncTimerWithServer(state);

    // Presence indicators
    updatePresenceIndicators(state);

    // Stats bar
    updateStatsBar(state);

    // Sync config UI
    if (state.config) {
        syncConfigUI(state.config);
    }

    // Sleep data - ALWAYS call updateSleepUI to ensure data is rendered
    // Previously only called when state.sleepHistory was truthy, but we need to
    // always render the sleep UI with whatever data we have (including from Firebase)
    console.log('[Device] updateUI calling updateSleepUI, sleepHistory length:', state.sleepHistory?.length || 0);
    updateSleepUI(state);

    // Device info
    updateDeviceInfo(state);

    // Update Day Idle mode sunrise/sunset times
    updateDayIdleTimes(state);
}

function updateStatusBadge(online, sleeping = false) {
    const badge = document.getElementById('statusBadge');
    const dot = badge?.querySelector('.status-dot');
    const text = document.getElementById('statusText');

    if (!badge) return;

    badge.classList.remove('online', 'offline', 'sleeping');
    if (dot) dot.classList.remove('online', 'offline', 'sleeping');

    if (sleeping) {
        badge.classList.add('sleeping');
        if (dot) dot.classList.add('sleeping');
        if (text) text.textContent = 'In Sleep';
    } else if (online) {
        badge.classList.add('online');
        if (dot) dot.classList.add('online');
        if (text) text.textContent = 'Online';
    } else {
        badge.classList.add('offline');
        if (dot) dot.classList.add('offline');
        if (text) text.textContent = 'Offline';
    }
}

function syncTimerWithServer(state) {
    // =========================================================================
    // TIMER SYNC - Matches firmware field names exactly
    // Firmware publishes:
    //   - motionTimer: seconds remaining for AUTO mode (mode === 0)
    //   - timerRemaining: seconds remaining for MANUAL mode (mode === 1)
    // =========================================================================

    // Get mode directly - firmware always sends numeric mode
    const mode = typeof state.mode === 'number' ? state.mode : -1;

    // Get light state - firmware sends boolean
    const light = state.light === true;

    // Get timer values - use EXACTLY the field names firmware publishes
    // IMPORTANT: Check for both number and string types (JSON parsing edge cases)
    let motionTimer = 0;
    if (typeof state.motionTimer === 'number') {
        motionTimer = state.motionTimer;
    } else if (typeof state.motionTimer === 'string') {
        motionTimer = parseInt(state.motionTimer, 10) || 0;
    }

    let manualTimer = 0;
    if (typeof state.timerRemaining === 'number') {
        manualTimer = state.timerRemaining;
    } else if (typeof state.timerRemaining === 'string') {
        manualTimer = parseInt(state.timerRemaining, 10) || 0;
    }

    // Check for motion/presence - when detected, timer is "paused"
    const hasMotion = state.motion === true;
    const hasPresence = state.still === true;
    const isMotionActive = hasMotion || hasPresence;

    // Get total timer duration from config for progress bar
    const motionTimeout = state.config?.motionTimeout || 120;
    const manualTimeout = state.config?.manualTimeout || 60;

    // Debug logging - ALWAYS log to trace timer issues
    console.log(`[Timer] Sync: mode=${mode}, light=${light}, motionTimer=${motionTimer}, manualTimer=${manualTimer}, motion=${hasMotion}, still=${hasPresence}`);

    let timerSeconds = 0;
    let timerTotal = 0;
    let timerTitle = '';
    let isPaused = false;

    // AUTO mode (0): Show motion timer when light is ON and timer > 0
    if (mode === 0 && light && motionTimer > 0) {
        timerSeconds = motionTimer;
        timerTotal = motionTimeout;
        isPaused = isMotionActive;
        timerTitle = isPaused ? '✅ Motion Detected' : 'Auto-off Timer';
        console.log(`[Timer] ✅ Showing MOTION timer: ${timerSeconds}s / ${timerTotal}s, paused=${isPaused}`);
    }
    // MANUAL mode (1): Show manual timer when timer > 0
    else if (mode === 1 && manualTimer > 0) {
        timerSeconds = manualTimer;
        timerTotal = manualTimeout;
        isPaused = false;
        timerTitle = 'Manual Timer';
        console.log(`[Timer] ✅ Showing MANUAL timer: ${timerSeconds}s / ${timerTotal}s`);
    }
    // Log when timer is NOT shown
    else {
        if (mode === 0 && light) {
            console.log(`[Timer] ⚠ AUTO mode with light ON but motionTimer=${motionTimer} (not showing timer)`);
        } else if (mode === 1) {
            console.log(`[Timer] ⚠ MANUAL mode but manualTimer=${manualTimer} (not showing timer)`);
        }
    }

    // Show or hide timer card based on values
    if (timerSeconds > 0) {
        showTimerCard(timerSeconds, timerTotal, timerTitle, isPaused);
    } else {
        hideTimerCard();
    }
}

/**
 * Show the timer card with animation and start countdown
 * @param {number} seconds - Current remaining seconds
 * @param {number} total - Total timer duration for progress bar
 * @param {string} title - Timer title to display
 * @param {boolean} isPaused - Whether timer is paused (motion detected)
 */
function showTimerCard(seconds, total, title, isPaused) {
    const timerCard = document.getElementById('timerCard');
    const timerTitleEl = document.getElementById('timerTitle');
    const timerCountdown = document.getElementById('timerCountdown');
    const timerProgressBar = document.getElementById('timerProgressBar');

    if (!timerCard) {
        console.error('[Timer] ERROR: timerCard element not found in DOM!');
        return;
    }

    // Update stored values
    DeviceState.timerTotalSeconds = total;
    DeviceState.timerPaused = isPaused;

    // Sync timer value from server (with drift tolerance)
    const serverDelta = Math.abs(DeviceState.clientTimerSeconds - seconds);
    if (!DeviceState.timerActive || serverDelta > 2) {
        DeviceState.clientTimerSeconds = seconds;
        DeviceState.lastServerTimerSync = Date.now();
    }

    // Update title
    if (timerTitleEl) timerTitleEl.textContent = title;

    // Update countdown display
    if (timerCountdown) {
        timerCountdown.textContent = Utils.formatTime(Math.floor(seconds));
    }

    // Update progress bar
    if (timerProgressBar && total > 0) {
        const progress = (seconds / total) * 100;
        timerProgressBar.style.width = `${Math.min(100, Math.max(0, progress))}%`;
    }

    // ALWAYS ensure the card is visible - fix for cases where display state is inconsistent
    const isCurrentlyHidden = timerCard.style.display === 'none' ||
        timerCard.style.display === '' ||
        window.getComputedStyle(timerCard).display === 'none';

    // Show card with entrance animation if not already visible
    if (!DeviceState.timerActive || isCurrentlyHidden) {
        console.log(`[Timer] Making timer card visible (timerActive=${DeviceState.timerActive}, isHidden=${isCurrentlyHidden})`);

        timerCard.style.display = 'block';
        timerCard.style.opacity = '0';
        timerCard.style.transform = 'translateY(-10px)';

        // Force reflow then animate
        void timerCard.offsetWidth;
        timerCard.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
        timerCard.style.opacity = '1';
        timerCard.style.transform = 'translateY(0)';

        DeviceState.timerActive = true;
        console.log('[Timer] ✅ Timer card now visible');

        // Start countdown interval
        startCountdownInterval();
    }
}

/**
 * Start the countdown interval for smooth timer updates
 */
function startCountdownInterval() {
    // Clear any existing interval to prevent accumulation
    if (DeviceState.timerInterval) {
        clearInterval(DeviceState.timerInterval);
        DeviceState.timerInterval = null;
    }

    let lastDisplayedSecond = Math.floor(DeviceState.clientTimerSeconds);

    DeviceState.timerInterval = setInterval(() => {
        // Safety check
        if (!DeviceState.timerActive) {
            clearInterval(DeviceState.timerInterval);
            DeviceState.timerInterval = null;
            return;
        }

        // When paused, just keep sync time current
        if (DeviceState.timerPaused) {
            DeviceState.lastServerTimerSync = Date.now();
            return;
        }

        // Calculate elapsed time since last sync
        const now = Date.now();
        const elapsedMs = now - DeviceState.lastServerTimerSync;
        const elapsedSeconds = elapsedMs / 1000;

        // Calculate current remaining time
        const currentSeconds = Math.max(0, DeviceState.clientTimerSeconds - elapsedSeconds);
        const displaySecond = Math.floor(currentSeconds);

        // Update display when second changes
        if (displaySecond !== lastDisplayedSecond) {
            DeviceState.clientTimerSeconds = displaySecond;
            DeviceState.lastServerTimerSync = now;
            lastDisplayedSecond = displaySecond;

            updateTimerDisplay();
        }

        // Timer expired
        if (currentSeconds <= 0) {
            console.log('[Timer] Timer expired');
            hideTimerCard();
        }
    }, 100);
}

/**
 * Update the timer display elements
 */
function updateTimerDisplay() {
    const timerCountdown = document.getElementById('timerCountdown');
    const timerProgressBar = document.getElementById('timerProgressBar');

    if (!timerCountdown) return;

    const seconds = Math.floor(DeviceState.clientTimerSeconds);
    timerCountdown.textContent = Utils.formatTime(seconds);

    // Progress bar
    if (timerProgressBar && DeviceState.timerTotalSeconds > 0) {
        const progress = (seconds / DeviceState.timerTotalSeconds) * 100;
        timerProgressBar.style.width = `${Math.min(100, Math.max(0, progress))}%`;
    }

    // Tick animation
    if (seconds !== DeviceState.lastTimerValue) {
        timerCountdown.classList.remove('tick');
        void timerCountdown.offsetWidth;
        timerCountdown.classList.add('tick');
        DeviceState.lastTimerValue = seconds;
    }
}

/**
 * Hide the timer card with exit animation
 */
function hideTimerCard() {
    // Only hide if currently active
    if (!DeviceState.timerActive) return;

    const timerCard = document.getElementById('timerCard');

    // Clear interval
    if (DeviceState.timerInterval) {
        clearInterval(DeviceState.timerInterval);
        DeviceState.timerInterval = null;
    }

    // Reset state
    DeviceState.timerActive = false;
    DeviceState.clientTimerSeconds = 0;

    if (timerCard) {
        // Exit animation
        timerCard.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
        timerCard.style.opacity = '0';
        timerCard.style.transform = 'translateY(-10px)';

        // Hide after animation
        setTimeout(() => {
            if (!DeviceState.timerActive) {
                timerCard.style.display = 'none';
            }
        }, 300);
    }

    console.log('[Timer] Timer card hidden');
}

// Legacy function name for backward compatibility
function startSmoothCountdown(title, isPaused = false) {
    const motionTimeout = DeviceState.state?.config?.motionTimeout || 120;
    showTimerCard(DeviceState.clientTimerSeconds, motionTimeout, title, isPaused);
}

// Legacy function name for backward compatibility
function stopSmoothCountdown() {
    hideTimerCard();
}

function updateWifiIndicator(state) {
    const wifiIndicator = document.getElementById('wifiIndicator');
    const wifiStrength = document.getElementById('wifiStrength');

    if (!wifiIndicator || !wifiStrength) return;

    const rssi = state.rssi || state.stats?.wifiSignal;

    if (!state._online || rssi === undefined) {
        wifiIndicator.className = 'wifi-indicator';
        wifiStrength.textContent = '--';
        return;
    }

    // Update text
    wifiStrength.textContent = `${rssi}dBm`;

    // Update color based on signal strength
    wifiIndicator.classList.remove('strong', 'medium', 'weak');
    if (rssi >= -50) {
        wifiIndicator.classList.add('strong');
    } else if (rssi >= -70) {
        wifiIndicator.classList.add('medium');
    } else {
        wifiIndicator.classList.add('weak');
    }
}

function updatePresenceIndicators(state) {
    const motionValue = document.getElementById('motionValue');
    const stillValue = document.getElementById('stillValue');

    if (motionValue) {
        motionValue.textContent = state.motion ? 'Active' : 'None';
        motionValue.classList.toggle('active', state.motion);
    }

    if (stillValue) {
        stillValue.textContent = state.still ? 'Yes' : 'No';
        stillValue.classList.toggle('active', state.still);
    }
}

function updateStatsBar(state) {
    const rssi = state.rssi || state.stats?.wifiSignal;
    const heap = state.heap || state.stats?.heap;
    const uptime = state.uptime || state.stats?.uptime;

    const statRSSI = document.getElementById('statRSSI');
    const statHeap = document.getElementById('statHeap');
    const statUptime = document.getElementById('statUptime');

    if (rssi !== undefined && statRSSI) {
        statRSSI.textContent = `${rssi}dBm`;
    }

    if (heap !== undefined && statHeap) {
        const heapKB = Math.round(heap / 1024);
        statHeap.textContent = `${heapKB}KB`;
    }

    if (uptime !== undefined && statUptime) {
        statUptime.textContent = formatUptime(uptime);
    }
}

function formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const mins = Math.floor((seconds % 3600) / 60);

    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
}

function syncConfigUI(config) {
    // Helper function for formatting seconds as duration (same as picker)
    const formatSeconds = (s) => {
        if (!s || isNaN(s) || s <= 0) return '--';
        if (s < 60) return `${s}s`;
        const mins = Math.floor(s / 60);
        const secs = s % 60;
        if (secs === 0) return `${mins}m`;
        return `${mins}m ${secs}s`;
    };

    // Smart tab toggles
    document.getElementById('alarmEnabled').checked = config.alarmEnabled ?? false;
    document.getElementById('dayIdleEnabled').checked = config.dayIdleEnabled ?? false;
    document.getElementById('motionEnabled').checked = config.motionEnabled ?? true;
    document.getElementById('twtEnabled').checked = config.twtEnabled ?? false;

    // Alarm time
    const alarmHour = config.alarmHour ?? 7;
    const alarmMin = config.alarmMin ?? 0;
    document.getElementById('alarmTime').textContent =
        `${String(alarmHour).padStart(2, '0')}:${String(alarmMin).padStart(2, '0')}`;

    // Display timeout - use same format as picker
    const displayTimeout = config.presenceDisplayTimeout;
    document.getElementById('displayTimeoutValue').textContent =
        (displayTimeout !== undefined && displayTimeout !== null && displayTimeout > 0) ? `${displayTimeout}s` : 'Off';

    // Radar sensitivity
    document.getElementById('radarSensitivityValue').textContent =
        `${config.radarSensitivity ?? 30}%`;

    // Servo angles - show actual values from config
    document.getElementById('angleOffValue').textContent = `${config.angleOff ?? 45}°`;
    document.getElementById('angleOnValue').textContent = `${config.angleOn ?? 120}°`;

    // Timers - use formatSeconds for accurate display (same format as picker)
    document.getElementById('motionTimeoutValue').textContent =
        formatSeconds(config.motionTimeout ?? 120);
    document.getElementById('manualTimeoutValue').textContent =
        formatSeconds(config.manualTimeout ?? 60);

    // Location
    document.getElementById('cityValue').textContent = config.city || 'Not set';
    document.getElementById('sunriseOffsetValue').textContent =
        `${config.sunriseOffset >= 0 ? '+' : ''}${config.sunriseOffset ?? 20} min`;
    document.getElementById('sunsetOffsetValue').textContent =
        `${config.sunsetOffset >= 0 ? '+' : ''}${config.sunsetOffset ?? 20} min`;

    // Energy
    document.getElementById('lightWattageValue').textContent = `${config.lightWattage ?? 60}W`;

    // Sleep targets
    document.getElementById('sleepTargetDurationValue').textContent =
        Utils.formatDuration(config.sleepTargetDuration ?? 480);

    const bedtimeHour = config.sleepTargetBedtimeHour ?? 23;
    const bedtimeMin = config.sleepTargetBedtimeMin ?? 0;
    document.getElementById('sleepTargetBedtimeValue').textContent =
        `${String(bedtimeHour).padStart(2, '0')}:${String(bedtimeMin).padStart(2, '0')}`;

    // Sleep goal display
    document.getElementById('sleepGoal').textContent =
        Utils.formatDuration(config.sleepTargetDuration ?? 480);
}

function updateDeviceInfo(state) {
    document.getElementById('infoFirmware').textContent = state.firmware || state.stats?.firmware || '--';
    document.getElementById('infoUptime').textContent = formatUptime(state.uptime || 0);
    document.getElementById('infoIP').textContent = state.ip || '--';
    document.getElementById('infoRSSI').textContent = state.rssi ? `${state.rssi}dBm` : '--';
    document.getElementById('infoHeap').textContent = state.heap ? `${Math.round(state.heap / 1024)}KB` : '--';
    document.getElementById('infoCpuTemp').textContent = state.cpuTemp ? `${state.cpuTemp.toFixed(1)}°C` : '--';
}

// Update Day Idle mode sunrise/sunset times from device state
function updateDayIdleTimes(state) {
    const sunriseEl = document.getElementById('sunriseTime');
    const sunsetEl = document.getElementById('sunsetTime');

    if (!sunriseEl || !sunsetEl) return;

    // Helper to format time from various sources
    const formatTime = (value, emoji) => {
        if (value === undefined || value === null || value === 0) {
            return `${emoji} --:--`;
        }

        // Check if it's a Unix timestamp (large number, typically > 1000000)
        if (typeof value === 'number' && value > 100000) {
            // Unix timestamp - convert to local time
            const date = new Date(value * 1000);
            const hours = date.getHours();
            const mins = date.getMinutes();
            return `${emoji} ${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
        }

        // Minutes since midnight
        if (typeof value === 'number') {
            const hours = Math.floor(value / 60);
            const mins = value % 60;
            return `${emoji} ${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
        }

        // Already formatted string
        if (typeof value === 'string') {
            return `${emoji} ${value}`;
        }

        return `${emoji} --:--`;
    };

    // Priority order for sunrise:
    // 1. state.sunriseTime (Unix timestamp from firmware)
    // 2. state.config.sunriseMinute (minutes since midnight)
    // 3. Default to --:--
    let sunriseValue = state.sunriseTime;
    if ((sunriseValue === undefined || sunriseValue === null || sunriseValue === 0)
        && state.config?.sunriseMinute !== undefined) {
        sunriseValue = state.config.sunriseMinute;
    }
    sunriseEl.textContent = formatTime(sunriseValue, '☀️');

    // Priority order for sunset:
    // 1. state.sunsetTime (Unix timestamp from firmware)
    // 2. state.config.sunsetMinute (minutes since midnight)
    // 3. Default to --:--
    let sunsetValue = state.sunsetTime;
    if ((sunsetValue === undefined || sunsetValue === null || sunsetValue === 0)
        && state.config?.sunsetMinute !== undefined) {
        sunsetValue = state.config.sunsetMinute;
    }
    sunsetEl.textContent = formatTime(sunsetValue, '🌙');
}

// ============================================
// Sleep UI
// ============================================
function updateSleepUI(state) {
    const history = state.sleepHistory || [];
    const isSleeping = state.isSleeping;
    const sleepStart = state.sleepStart;
    const config = state.config || {};

    // Update action button
    const actionBtn = document.getElementById('sleepActionBtn');
    if (isSleeping) {
        actionBtn.textContent = '☀️ End Sleep';
        actionBtn.classList.remove('btn-primary');
        actionBtn.classList.add('btn-secondary');

        // Calculate current sleep duration
        if (sleepStart) {
            const now = Math.floor(Date.now() / 1000);
            const duration = now - sleepStart;
            updateSleepDisplay(duration, config);
        }
    } else {
        actionBtn.textContent = '🌙 Start Sleep';
        actionBtn.classList.remove('btn-secondary');
        actionBtn.classList.add('btn-primary');

        // Show last night's sleep or reset
        if (history.length > 0) {
            const lastSession = history[0];
            if (lastSession && lastSession.end && lastSession.start) {
                const duration = lastSession.end - lastSession.start;
                updateSleepDisplay(duration, config);
            } else {
                updateSleepDisplay(0, config);
            }
        } else {
            updateSleepDisplay(0, config);
        }
    }

    // Update stats with proper NaN handling
    document.getElementById('sleepSessions').textContent = history.length > 0 ? history.length : '--';

    // Calculate 7-day average with NaN handling
    if (history.length > 0) {
        const validSessions = history.filter(s => s && s.end && s.start && !isNaN(s.end - s.start));
        if (validSessions.length > 0) {
            const totalDuration = validSessions.reduce((sum, s) => sum + (s.end - s.start), 0);
            const avgSeconds = totalDuration / validSessions.length;
            document.getElementById('avgSleep').textContent = formatSleepDuration(avgSeconds);
        } else {
            document.getElementById('avgSleep').textContent = '--';
        }
    } else {
        document.getElementById('avgSleep').textContent = '--';
    }

    // Calculate and display Sleep Score
    const sleepScore = calculateSleepScore(history, config);
    updateSleepScoreDisplay(sleepScore);

    // Calculate and display Consistency Score
    const consistencyScore = calculateConsistencyScore(history);
    updateConsistencyScoreDisplay(consistencyScore);

    // Generate AI Overview
    generateAIOverview(history, config, sleepScore, consistencyScore);

    // Update graph
    renderSleepGraph(history);

    // Update logs
    renderSleepLogs(history);
}

// Format sleep duration with NaN handling
function formatSleepDuration(seconds) {
    if (!seconds || isNaN(seconds) || seconds <= 0) {
        return '--';
    }
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${mins}m`;
}

// Update the main sleep ring display
function updateSleepDisplay(duration, config) {
    const sleepHours = document.getElementById('sleepHours');
    const sleepRingFill = document.getElementById('sleepRingFill');

    if (!duration || isNaN(duration) || duration <= 0) {
        sleepHours.textContent = '--';
        if (sleepRingFill) sleepRingFill.style.strokeDashoffset = 502;
        return;
    }

    const hours = Math.floor(duration / 3600);
    const mins = Math.floor((duration % 3600) / 60);
    sleepHours.textContent = `${hours}h ${mins}m`;

    // Update ring progress
    const targetMinutes = config.sleepTargetDuration || 480;
    const target = targetMinutes * 60;
    const progress = Math.min(duration / target, 1);
    const circumference = 2 * Math.PI * 80;
    if (sleepRingFill) {
        sleepRingFill.style.strokeDashoffset = circumference * (1 - progress);
    }
}

// Calculate Sleep Score (0-100)
function calculateSleepScore(history, config) {
    if (!history || history.length === 0) return null;

    const targetMinutes = config.sleepTargetDuration || 480;
    const targetSeconds = targetMinutes * 60;

    // Get valid sessions
    const validSessions = history.filter(s => s && s.end && s.start && !isNaN(s.end - s.start));
    if (validSessions.length === 0) return null;

    // Calculate average duration
    const totalDuration = validSessions.reduce((sum, s) => sum + (s.end - s.start), 0);
    const avgDuration = totalDuration / validSessions.length;

    // Duration Score (0-40 points)
    // Perfect score for sleeping exactly the target, decreasing for over/under sleep
    let durationScore = 0;
    const durationRatio = avgDuration / targetSeconds;
    if (durationRatio >= 0.875 && durationRatio <= 1.125) {
        // Within 12.5% of target = optimal
        durationScore = 40;
    } else if (durationRatio >= 0.75 && durationRatio <= 1.25) {
        // Within 25% of target
        durationScore = 35;
    } else if (durationRatio >= 0.625) {
        // At least 62.5% of target
        durationScore = 25;
    } else if (durationRatio >= 0.5) {
        // At least 50% of target
        durationScore = 15;
    } else {
        durationScore = Math.max(5, durationRatio * 30);
    }

    // Timing Score (0-30 points) - based on consistent bedtime
    const targetBedtimeHour = config.sleepTargetBedtimeHour ?? 23;
    const targetBedtimeMin = config.sleepTargetBedtimeMin ?? 0;
    const targetBedtimeMinutes = targetBedtimeHour * 60 + targetBedtimeMin;

    let timingScore = 0;
    if (validSessions.length >= 1) {
        const bedtimeDeviations = validSessions.map(s => {
            const startDate = new Date(s.start * 1000);
            const startMinutes = startDate.getHours() * 60 + startDate.getMinutes();
            // Handle midnight crossing
            let deviation = Math.abs(startMinutes - targetBedtimeMinutes);
            if (deviation > 720) deviation = 1440 - deviation;
            return deviation;
        });

        const avgDeviation = bedtimeDeviations.reduce((a, b) => a + b, 0) / bedtimeDeviations.length;

        if (avgDeviation <= 15) timingScore = 30;
        else if (avgDeviation <= 30) timingScore = 25;
        else if (avgDeviation <= 60) timingScore = 20;
        else if (avgDeviation <= 90) timingScore = 15;
        else if (avgDeviation <= 120) timingScore = 10;
        else timingScore = 5;
    }

    // Regularity Score (0-30 points) - based on session count and patterns
    let regularityScore = 0;
    if (validSessions.length >= 7) {
        regularityScore = 30;
    } else if (validSessions.length >= 5) {
        regularityScore = 25;
    } else if (validSessions.length >= 3) {
        regularityScore = 20;
    } else if (validSessions.length >= 1) {
        regularityScore = 10;
    }

    return Math.round(durationScore + timingScore + regularityScore);
}

// Calculate Consistency Score (0-100)
function calculateConsistencyScore(history) {
    if (!history || history.length < 2) return null;

    const validSessions = history.filter(s => s && s.end && s.start && !isNaN(s.end - s.start));
    if (validSessions.length < 2) return null;

    // Calculate bedtime variance
    const bedtimes = validSessions.map(s => {
        const date = new Date(s.start * 1000);
        let minutes = date.getHours() * 60 + date.getMinutes();
        // Normalize to account for post-midnight bedtimes
        if (minutes < 360) minutes += 1440; // If before 6am, treat as previous day
        return minutes;
    });

    const avgBedtime = bedtimes.reduce((a, b) => a + b, 0) / bedtimes.length;
    const variance = bedtimes.reduce((sum, bt) => sum + Math.pow(bt - avgBedtime, 2), 0) / bedtimes.length;
    const stdDev = Math.sqrt(variance);

    // Calculate wake time variance
    const wakeTimes = validSessions.map(s => {
        const date = new Date(s.end * 1000);
        return date.getHours() * 60 + date.getMinutes();
    });

    const avgWakeTime = wakeTimes.reduce((a, b) => a + b, 0) / wakeTimes.length;
    const wakeVariance = wakeTimes.reduce((sum, wt) => sum + Math.pow(wt - avgWakeTime, 2), 0) / wakeTimes.length;
    const wakeStdDev = Math.sqrt(wakeVariance);

    // Combined score (lower variance = higher score)
    const combinedStdDev = (stdDev + wakeStdDev) / 2;

    if (combinedStdDev <= 15) return 100;
    if (combinedStdDev <= 30) return 90;
    if (combinedStdDev <= 45) return 80;
    if (combinedStdDev <= 60) return 70;
    if (combinedStdDev <= 90) return 60;
    if (combinedStdDev <= 120) return 50;
    if (combinedStdDev <= 180) return 40;
    return Math.max(20, Math.round(100 - combinedStdDev / 3));
}

// Update Sleep Score ring display
function updateSleepScoreDisplay(score) {
    const scoreEl = document.getElementById('sleepScore');
    const ringEl = document.getElementById('sleepScoreRing');

    if (score === null || isNaN(score)) {
        if (scoreEl) scoreEl.textContent = '--';
        if (ringEl) ringEl.style.strokeDashoffset = 157;
        return;
    }

    if (scoreEl) scoreEl.textContent = score;

    // Update ring (circumference = 2 * PI * 25 ≈ 157)
    if (ringEl) {
        const progress = score / 100;
        ringEl.style.strokeDashoffset = 157 * (1 - progress);
    }
}

// Update Consistency Score ring display
function updateConsistencyScoreDisplay(score) {
    const scoreEl = document.getElementById('consistencyScore');
    const ringEl = document.getElementById('consistencyScoreRing');

    if (score === null || isNaN(score)) {
        if (scoreEl) scoreEl.textContent = '--';
        if (ringEl) ringEl.style.strokeDashoffset = 157;
        return;
    }

    if (scoreEl) scoreEl.textContent = score;

    if (ringEl) {
        const progress = score / 100;
        ringEl.style.strokeDashoffset = 157 * (1 - progress);
    }
}

// Generate AI Overview with personalized insights
function generateAIOverview(history, config, sleepScore, consistencyScore) {
    const feedbackEl = document.getElementById('aiFeedback');
    const tipsEl = document.getElementById('aiOverviewTips');

    if (!feedbackEl || !tipsEl) return;

    // No data case
    if (!history || history.length === 0) {
        feedbackEl.textContent = "Start tracking your sleep to receive personalized insights and recommendations to improve your rest quality.";
        tipsEl.innerHTML = '';
        return;
    }

    const validSessions = history.filter(s => s && s.end && s.start && !isNaN(s.end - s.start));
    if (validSessions.length === 0) {
        feedbackEl.textContent = "Your sleep sessions don't have complete data. Ensure you end each sleep session properly to get accurate insights.";
        tipsEl.innerHTML = '';
        return;
    }

    // Calculate metrics for analysis
    const targetMinutes = config.sleepTargetDuration || 480;
    const targetSeconds = targetMinutes * 60;
    const totalDuration = validSessions.reduce((sum, s) => sum + (s.end - s.start), 0);
    const avgDuration = totalDuration / validSessions.length;
    const avgHours = avgDuration / 3600;

    // Determine bedtime trend
    let bedtimeTrend = 'stable';
    if (validSessions.length >= 3) {
        const recentBedtimes = validSessions.slice(0, 3).map(s => {
            const date = new Date(s.start * 1000);
            return date.getHours() + date.getMinutes() / 60;
        });
        const avgRecent = recentBedtimes.reduce((a, b) => a + b, 0) / 3;

        if (validSessions.length >= 5) {
            const olderBedtimes = validSessions.slice(2, 5).map(s => {
                const date = new Date(s.start * 1000);
                return date.getHours() + date.getMinutes() / 60;
            });
            const avgOlder = olderBedtimes.reduce((a, b) => a + b, 0) / olderBedtimes.length;

            if (avgRecent < avgOlder - 0.5) bedtimeTrend = 'earlier';
            else if (avgRecent > avgOlder + 0.5) bedtimeTrend = 'later';
        }
    }

    // Generate main feedback message
    let feedback = '';
    const tips = [];

    // Sleep score based feedback
    if (sleepScore >= 85) {
        feedback = `Excellent sleep quality! You're averaging ${avgHours.toFixed(1)} hours per night with great consistency. Keep up the healthy routine!`;
        tips.push({ icon: '🌟', text: 'Your sleep patterns are optimal. Maintain this routine for long-term benefits.' });
    } else if (sleepScore >= 70) {
        feedback = `Good sleep patterns! Your average of ${avgHours.toFixed(1)} hours is close to your goal. Small adjustments could push you to excellent.`;

        if (avgDuration < targetSeconds * 0.9) {
            tips.push({ icon: '⏰', text: 'Try going to bed 20-30 minutes earlier to reach your sleep goal.' });
        }
        if (consistencyScore < 70) {
            tips.push({ icon: '📅', text: 'A more consistent bedtime would significantly improve your rest quality.' });
        }
    } else if (sleepScore >= 50) {
        feedback = `Your sleep could use improvement. Averaging ${avgHours.toFixed(1)} hours is below optimal for most adults.`;

        if (avgDuration < targetSeconds * 0.8) {
            tips.push({ icon: '🛏️', text: 'You\'re getting less than 80% of your target sleep. Prioritize rest tonight!' });
        }
        if (bedtimeTrend === 'later') {
            tips.push({ icon: '🌙', text: 'Your bedtime has been creeping later. Try to reset earlier.' });
        }
        tips.push({ icon: '💡', text: 'Avoid screens 30 minutes before bed to fall asleep faster.' });
    } else {
        feedback = `Your sleep needs attention. With only ${avgHours.toFixed(1)} hours average, you may experience reduced focus and energy.`;

        tips.push({ icon: '🚨', text: 'Significant sleep debt detected. Consider catching up this weekend.' });
        tips.push({ icon: '🍵', text: 'Avoid caffeine after 2 PM to improve sleep quality.' });
        tips.push({ icon: '📵', text: 'Create a wind-down routine: dim lights, no phones, relaxing activity.' });
    }

    // Consistency specific feedback
    if (consistencyScore !== null && consistencyScore < 60) {
        tips.push({ icon: '🔄', text: 'Highly variable sleep schedule detected. Regular timing helps your body clock.' });
    }

    feedbackEl.textContent = feedback;

    // Render tips (max 3)
    const displayTips = tips.slice(0, 3);
    tipsEl.innerHTML = displayTips.map(tip => `
        <div class="ai-tip">
            <span class="ai-tip-icon">${tip.icon}</span>
            <span>${tip.text}</span>
        </div>
    `).join('');
}

function renderSleepGraph(history) {
    const container = document.getElementById('sleepGraphBars');
    if (!container) return;

    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Create 7 days of data by matching actual dates
    const data = [];
    for (let i = 6; i >= 0; i--) {
        const targetDate = new Date(today);
        targetDate.setDate(targetDate.getDate() - i);
        const dayLabel = days[targetDate.getDay()];
        const targetStart = targetDate.getTime() / 1000;
        const targetEnd = targetStart + 86400; // 24 hours

        // Find session that ENDED on this day (sleep ending in morning = that day's sleep)
        const session = history.find(s => {
            if (!s || !s.end) return false;
            return s.end >= targetStart && s.end < targetEnd;
        });

        const hours = session ? (session.end - session.start) / 3600 : 0;
        data.push({ label: dayLabel, hours: Math.max(0, hours) });
    }

    const maxHours = Math.max(...data.map(d => d.hours), 8);

    container.innerHTML = data.map(d => `
    <div class="graph-bar-wrapper">
      <div class="graph-bar-container">
        <div class="graph-bar" style="height: ${(d.hours / maxHours) * 100}%"></div>
      </div>
      <div class="graph-label">${d.label}</div>
    </div>
  `).join('');
}

function renderSleepLogs(history) {
    const container = document.getElementById('logslist');

    if (!history || history.length === 0) {
        container.innerHTML = `
            <div class="logs-empty-state">
                <div class="logs-empty-icon">🌙</div>
                <p class="logs-empty-text">No sleep sessions recorded yet.<br>Start tracking to see your history here.</p>
            </div>
        `;
        return;
    }

    container.innerHTML = history.map((session, index) => {
        // Validate session data
        if (!session || !session.start || !session.end) {
            return ''; // Skip invalid entries
        }

        const date = new Date(session.start * 1000);
        const duration = session.end - session.start;

        // Handle invalid duration
        if (isNaN(duration) || duration <= 0) {
            return ''; // Skip invalid entries
        }

        const hours = Math.floor(duration / 3600);
        const mins = Math.floor((duration % 3600) / 60);

        const startTime = new Date(session.start * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const endTime = new Date(session.end * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        return `
            <div class="log-entry" data-index="${index}" data-start="${session.start}" data-end="${session.end}">
                <div class="log-entry-content">
                    <div class="log-entry-info">
                        <div class="log-date">${date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</div>
                        <div class="log-time">${startTime} → ${endTime}</div>
                    </div>
                    <div class="log-entry-right">
                        <div class="log-duration">${hours}h ${mins}m</div>
                        <div class="log-entry-actions">
                            <button class="log-action-btn edit" data-action="edit" data-index="${index}" title="Edit">
                                <svg viewBox="0 0 24 24">
                                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                                </svg>
                            </button>
                            <button class="log-action-btn delete" data-action="delete" data-index="${index}" title="Delete">
                                <svg viewBox="0 0 24 24">
                                    <polyline points="3 6 5 6 21 6"/>
                                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                                    <line x1="10" y1="11" x2="10" y2="17"/>
                                    <line x1="14" y1="11" x2="14" y2="17"/>
                                </svg>
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }).filter(html => html !== '').join('');

    // Attach event handlers using delegation
    attachLogEntryHandlers();
}

// Attach event handlers for log entry actions
function attachLogEntryHandlers() {
    const container = document.getElementById('logslist');
    if (!container) return;

    // Remove old listener if exists (prevent duplicates)
    container.removeEventListener('click', handleLogEntryClick);
    container.addEventListener('click', handleLogEntryClick);
}

// Handle log entry click events (delegation)
function handleLogEntryClick(e) {
    const actionBtn = e.target.closest('.log-action-btn');
    if (!actionBtn) return;

    e.preventDefault();
    e.stopPropagation();

    const action = actionBtn.dataset.action;
    const index = parseInt(actionBtn.dataset.index, 10);

    if (action === 'edit') {
        openSleepLogPopup(index);
    } else if (action === 'delete') {
        deleteSleepLog(index);
    }
}


// ============================================
// Tab Navigation (Using Floating Dock with Pill)
// ============================================
const tabs = ['controls', 'smart', 'settings', 'sleep'];
let currentTabIndex = 0;
let touchStartX = 0;
let touchEndX = 0;

function setupTabNavigation() {
    // Main dock buttons
    document.querySelectorAll('.dock-btn').forEach((btn, index) => {
        btn.addEventListener('click', () => {
            // Don't trigger if hovering during/after pill drag
            if (pillDragState.recentlyDragged) return;
            switchTab(btn.dataset.tab);
        });
    });

    // Sleep sub-tabs with proper animation
    document.querySelectorAll('.sleep-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            const currentActiveTab = document.querySelector('.sleep-tab.active');
            const targetTab = btn.dataset.sleepTab;

            // Don't do anything if clicking the already active tab
            if (currentActiveTab && currentActiveTab.dataset.sleepTab === targetTab) return;

            // Determine animation direction based on tab order
            const sleepTabOrder = ['overview', 'graph', 'logs', 'settings'];
            const currentIndex = currentActiveTab ? sleepTabOrder.indexOf(currentActiveTab.dataset.sleepTab) : 0;
            const targetIndex = sleepTabOrder.indexOf(targetTab);
            const isMovingRight = targetIndex > currentIndex;

            // Use shared animation utility
            animateSleepPanelTransition(targetTab, isMovingRight);
        });
    });

    // Initialize pill position
    updateDockPill();

    // Setup swipe navigation
    setupSwipeNavigation();

    // Setup draggable pill
    setupDraggablePill();
}

function switchTab(tabName) {
    currentTabIndex = tabs.indexOf(tabName);

    // Update dock active state
    document.querySelectorAll('.dock-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tabName);
    });

    // Switch tab panels with animation
    document.querySelectorAll('.tab-panel').forEach(panel => {
        const isActive = panel.id === `${tabName}-panel`;
        if (isActive && !panel.classList.contains('active')) {
            panel.style.animation = 'none';
            panel.offsetHeight; // Trigger reflow
            panel.style.animation = 'fadeInUp 0.35s ease-out';
        }
        panel.classList.toggle('active', isActive);
    });

    // Update dock pill position
    updateDockPill();
}

function updateDockPill(animate = true) {
    const pill = document.getElementById('dockPill');
    const activeBtn = document.querySelector('.dock-btn.active');

    if (!pill || !activeBtn) return;

    const buttons = Array.from(document.querySelectorAll('.dock-btn'));
    const index = buttons.indexOf(activeBtn);

    // Each button is 52px wide
    const targetX = index * 52;

    if (animate) {
        pill.style.transition = 'transform 0.35s cubic-bezier(0.34, 1.56, 0.64, 1)';
    } else {
        pill.style.transition = 'none';
    }

    pill.style.transform = `translateX(${targetX}px)`;
}

// ============================================
// Sleep Panel Animation Utility
// ============================================
// Shared utility for sleep panel transitions - prevents double animation issues
let sleepAnimationInProgress = false;

function animateSleepPanelTransition(targetTab, isMovingRight) {
    // Prevent overlapping animations
    if (sleepAnimationInProgress) return;
    sleepAnimationInProgress = true;

    // Get elements
    const newTabBtn = document.querySelector(`[data-sleep-tab="${targetTab}"]`);
    const newPanel = document.getElementById(`sleep-${targetTab}`);

    if (!newTabBtn || !newPanel) {
        sleepAnimationInProgress = false;
        return;
    }

    // Step 1: Remove all active/animation classes from ALL tabs and panels
    document.querySelectorAll('.sleep-tab').forEach(t => {
        t.classList.remove('active', 'bouncy-enter');
    });
    document.querySelectorAll('.sleep-panel').forEach(p => {
        p.classList.remove('active', 'bouncy-left', 'bouncy-right');
        // Force clear any inline animation
        p.style.animation = 'none';
    });

    // Step 2: Force browser to acknowledge the style changes
    void newPanel.offsetHeight;

    // Step 3: Clear animation style so CSS animation can play
    newPanel.style.animation = '';

    // Step 4: Add active class and appropriate animation direction
    newTabBtn.classList.add('active', 'bouncy-enter');
    newPanel.classList.add('active', isMovingRight ? 'bouncy-left' : 'bouncy-right');

    // Step 5: Clean up animation classes after animation completes
    // This timeout MUST match the CSS animation duration (450ms)
    setTimeout(() => {
        newTabBtn.classList.remove('bouncy-enter');
        newPanel.classList.remove('bouncy-left', 'bouncy-right');
        sleepAnimationInProgress = false;
    }, 450);

    // Haptic feedback
    if (navigator.vibrate) {
        navigator.vibrate(5);
    }
}

// Draggable Pill State
const pillDragState = {
    isDragging: false,
    recentlyDragged: false, // Prevents swipe triggering right after drag ends
    startX: 0,
    startY: 0,
    currentX: 0,
    pillStartX: 0,
    buttonWidth: 52,
    numButtons: 4,
    dragThreshold: 5, // Minimum movement to consider it a drag
    hasMoved: false,
    previewIndex: -1 // Track which button is being previewed
};

function setupDraggablePill() {
    const pill = document.getElementById('dockPill');
    const dockInner = document.querySelector('.dock-inner');

    if (!pill || !dockInner) return;

    // Make pill interactive
    pill.style.cursor = 'grab';
    pill.style.pointerEvents = 'auto';

    // Touch events - use passive: false for touchstart to allow preventDefault
    pill.addEventListener('touchstart', handlePillDragStart, { passive: false });
    pill.addEventListener('touchmove', handlePillDragMove, { passive: false });
    pill.addEventListener('touchend', handlePillDragEnd);
    pill.addEventListener('touchcancel', handlePillDragEnd);

    // Mouse events
    pill.addEventListener('mousedown', handlePillDragStart);
    document.addEventListener('mousemove', handlePillDragMove);
    document.addEventListener('mouseup', handlePillDragEnd);
}

function handlePillDragStart(e) {
    const pill = document.getElementById('dockPill');
    if (!pill) return;

    // Prevent default to stop text selection and scrolling
    e.preventDefault();
    e.stopPropagation();

    const clientX = e.type.includes('touch') ? e.touches[0].clientX : e.clientX;
    const clientY = e.type.includes('touch') ? e.touches[0].clientY : e.clientY;

    pillDragState.isDragging = true;
    pillDragState.hasMoved = false;
    pillDragState.startX = clientX;
    pillDragState.startY = clientY;
    pillDragState.previewIndex = currentTabIndex;

    // Get current transform value
    const transform = pill.style.transform;
    const match = transform.match(/translateX\(([^)]+)px\)/);
    pillDragState.pillStartX = match ? parseFloat(match[1]) : currentTabIndex * pillDragState.buttonWidth;
    pillDragState.currentX = pillDragState.pillStartX;

    // Remove transition during drag for responsive feel
    pill.style.transition = 'box-shadow 0.15s ease';
    pill.style.cursor = 'grabbing';

    // Add dragging class for visual feedback
    pill.classList.add('dragging');
}

function handlePillDragMove(e) {
    if (!pillDragState.isDragging) return;

    const pill = document.getElementById('dockPill');
    if (!pill) return;

    const clientX = e.type.includes('touch') ? e.touches[0].clientX : e.clientX;
    const deltaX = clientX - pillDragState.startX;

    // Check if we've moved enough to be considered a drag
    if (!pillDragState.hasMoved && Math.abs(deltaX) > pillDragState.dragThreshold) {
        pillDragState.hasMoved = true;
    }

    if (!pillDragState.hasMoved) return;

    // Prevent default only after we've started dragging
    e.preventDefault();

    // Calculate new position with bounds
    const maxX = (pillDragState.numButtons - 1) * pillDragState.buttonWidth;
    let newX = pillDragState.pillStartX + deltaX;

    // Add smooth resistance at edges (rubber band effect)
    if (newX < 0) {
        newX = newX * 0.25; // Resistance when dragging past left edge
    } else if (newX > maxX) {
        newX = maxX + (newX - maxX) * 0.25; // Resistance when dragging past right edge
    }

    pillDragState.currentX = newX;
    pill.style.transform = `translateX(${newX}px)`;

    // Update preview highlighting on dock buttons
    const previewIndex = Math.round(Math.max(0, Math.min(newX, maxX)) / pillDragState.buttonWidth);
    if (previewIndex !== pillDragState.previewIndex) {
        pillDragState.previewIndex = previewIndex;
        // Visual preview: subtly highlight the button we'd snap to
        document.querySelectorAll('.dock-btn').forEach((btn, idx) => {
            btn.style.opacity = idx === previewIndex ? '1' : '0.6';
        });
    }
}

function handlePillDragEnd(e) {
    if (!pillDragState.isDragging) return;

    const pill = document.getElementById('dockPill');
    if (!pill) return;

    pillDragState.isDragging = false;

    // Reset button opacities
    document.querySelectorAll('.dock-btn').forEach(btn => {
        btn.style.opacity = '';
    });

    // Set recentlyDragged to prevent accidental swipe triggers
    pillDragState.recentlyDragged = true;
    setTimeout(() => {
        pillDragState.recentlyDragged = false;
    }, 150);

    pill.style.cursor = 'grab';
    pill.classList.remove('dragging');

    // If we haven't actually moved much, this was a TAP - forward to underlying button
    if (!pillDragState.hasMoved) {
        // Calculate which button was tapped based on tap position
        const dockInner = document.querySelector('.dock-inner');
        if (dockInner) {
            const rect = dockInner.getBoundingClientRect();
            const tapX = pillDragState.startX - rect.left;
            const tappedIndex = Math.floor(tapX / pillDragState.buttonWidth);
            const clampedIndex = Math.max(0, Math.min(tappedIndex, pillDragState.numButtons - 1));

            // Switch to the tapped tab
            if (clampedIndex !== currentTabIndex) {
                switchTab(tabs[clampedIndex]);
                if (navigator.vibrate) {
                    navigator.vibrate(5);
                }
            }
        }
        return;
    }

    // Determine which tab to snap to
    const snapIndex = Math.round(pillDragState.currentX / pillDragState.buttonWidth);
    const clampedIndex = Math.max(0, Math.min(snapIndex, pillDragState.numButtons - 1));

    // Only switch if actually changed
    if (clampedIndex !== currentTabIndex) {
        switchTab(tabs[clampedIndex]);

        // Haptic feedback if available
        if (navigator.vibrate) {
            navigator.vibrate(10);
        }
    } else {
        // Snap back to current position with bounce animation
        updateDockPill(true);
    }
}

function setupSwipeNavigation() {
    const tabContent = document.querySelector('.tab-content');
    if (!tabContent) return;

    tabContent.addEventListener('touchstart', (e) => {
        touchStartX = e.changedTouches[0].screenX;
    }, { passive: true });

    tabContent.addEventListener('touchend', (e) => {
        touchEndX = e.changedTouches[0].screenX;
        handleSwipe();
    }, { passive: true });
}

function handleSwipe() {
    // Prevent swipe navigation if pill is being dragged or was just released
    if (pillDragState.isDragging || pillDragState.recentlyDragged) return;

    const swipeThreshold = 50;
    const diff = touchStartX - touchEndX;

    if (Math.abs(diff) < swipeThreshold) return;

    // Check if we're in sleep tab and on a sleep sub-panel
    if (tabs[currentTabIndex] === 'sleep') {
        const handled = handleSleepSwipe(diff > 0);
        if (handled) return;
    }

    if (diff > 0) {
        // Swipe left - go to next tab
        if (currentTabIndex < tabs.length - 1) {
            switchTab(tabs[currentTabIndex + 1]);
        }
    } else {
        // Swipe right - go to previous tab
        if (currentTabIndex > 0) {
            switchTab(tabs[currentTabIndex - 1]);
        }
    }
}

function handleSleepSwipe(isSwipeLeft) {
    const sleepTabs = ['overview', 'graph', 'logs', 'settings'];
    const activeTab = document.querySelector('.sleep-tab.active');
    if (!activeTab) return false;

    const currentSleepIndex = sleepTabs.indexOf(activeTab.dataset.sleepTab);

    if (isSwipeLeft && currentSleepIndex < sleepTabs.length - 1) {
        // Swipe to next sleep sub-tab
        const nextTab = sleepTabs[currentSleepIndex + 1];
        animateSleepPanelTransition(nextTab, true);
        return true;
    } else if (!isSwipeLeft && currentSleepIndex > 0) {
        // Swipe to previous sleep sub-tab
        const prevTab = sleepTabs[currentSleepIndex - 1];
        animateSleepPanelTransition(prevTab, false);
        return true;
    }

    // If at the edge of sleep tabs, allow main navigation
    return false;
}

// ============================================
// Control Handlers
// ============================================

// Track pending mode changes to prevent race conditions
let pendingModeChange = null;
let modeChangeTimeout = null;
const MODE_CHANGE_DEBOUNCE_MS = 200;
const MODE_CHANGE_LOCK_MS = 2000; // Lock UI updates for 2s after mode change (increased from 1s)

function setupControlHandlers() {
    // Power button - with connection check and error handling
    const powerBtn = document.getElementById('powerBtn');
    const powerLabel = document.getElementById('powerLabel');

    if (!powerBtn) {
        console.error('[Device] Power button not found in DOM');
        return;
    }

    powerBtn.addEventListener('click', () => {
        console.log('[Device] Power button clicked');

        // Check if MQTT is connected
        if (!MQTTClient.connected) {
            console.warn('[Device] Cannot toggle power - MQTT not connected');
            Toast.error('Not connected to device. Please wait...');
            return;
        }

        // Check if we have a device ID
        if (!DeviceState.deviceId) {
            console.error('[Device] No device ID set');
            Toast.error('No device selected');
            return;
        }

        const currentLight = DeviceState.state?.light ?? false;
        const newState = !currentLight;

        console.log(`[Device] Toggling light: ${currentLight} -> ${newState}`);

        // Send MQTT command
        const success = MQTTClient.publishControl(DeviceState.deviceId, { light: newState });
        console.log(`[Device] Publish result: ${success ? 'sent' : 'queued'}`);

        // CRITICAL: Optimistic update - update BOTH internal state AND UI
        // This ensures subsequent clicks read the correct value
        if (!DeviceState.state) {
            DeviceState.state = {};
        }
        DeviceState.state.light = newState;

        // Update UI
        powerBtn.classList.toggle('active', newState);
        if (powerLabel) {
            powerLabel.textContent = newState ? 'ON' : 'OFF';
            powerLabel.classList.toggle('active', newState);
        }
    });

    // Mode buttons with debouncing to prevent rapid mode switching issues
    document.querySelectorAll('[data-mode]').forEach(btn => {
        btn.addEventListener('click', () => {
            const mode = parseInt(btn.dataset.mode);
            console.log(`[Device] Mode button clicked: ${mode}`);

            // Check if MQTT is connected
            if (!MQTTClient.connected) {
                console.warn('[Device] Cannot change mode - MQTT not connected');
                Toast.error('Not connected to device. Please wait...');
                return;
            }

            // Check if we have a device ID
            if (!DeviceState.deviceId) {
                console.error('[Device] No device ID set');
                Toast.error('No device selected');
                return;
            }

            // Clear any pending mode change
            if (modeChangeTimeout) {
                clearTimeout(modeChangeTimeout);
            }

            // Store pending mode with expected value for confirmation
            pendingModeChange = {
                mode: mode,
                timestamp: Date.now(),
                confirmed: false
            };

            // Immediate optimistic UI update
            document.querySelectorAll('[data-mode]').forEach(b => {
                b.classList.toggle('active', parseInt(b.dataset.mode) === mode);
            });

            // Debounced publish - prevents rapid-fire mode changes
            modeChangeTimeout = setTimeout(() => {
                if (pendingModeChange && pendingModeChange.mode === mode) {
                    console.log(`[Device] Publishing mode change: ${mode}`);
                    const success = MQTTClient.publishControl(DeviceState.deviceId, { mode });
                    console.log(`[Device] Mode publish result: ${success ? 'sent' : 'queued'}`);
                }
                modeChangeTimeout = null;
            }, MODE_CHANGE_DEBOUNCE_MS);
        });
    });

    // Reboot button
    document.getElementById('rebootBtn').addEventListener('click', () => {
        Modal.confirm('Reboot Device', 'Are you sure you want to reboot the device?', () => {
            MQTTClient.publishControl(DeviceState.deviceId, { command: 'reboot' });
            Toast.info('Rebooting device...');
        });
    });
}

// Helper function to check if mode UI update should be ignored
// (called from updateUI when device state arrives)
function shouldIgnoreModeUpdate() {
    if (!pendingModeChange) {
        return false;
    }

    const elapsed = Date.now() - pendingModeChange.timestamp;

    // Check if server confirmed our mode change
    if (DeviceState.state && DeviceState.state.mode === pendingModeChange.mode) {
        // Server confirmed our expected mode - clear pending and allow updates
        console.log(`[Device] Mode ${pendingModeChange.mode} confirmed by server`);
        pendingModeChange = null;
        return false;
    }

    // Still within lock period - ignore server updates to prevent flicker
    if (elapsed < MODE_CHANGE_LOCK_MS) {
        console.log(`[Device] Ignoring mode update - pending change in progress (${elapsed}ms elapsed)`);
        return true;
    }

    // Lock period expired but server has different mode
    // This means our change might have been rejected or overridden
    if (DeviceState.state && DeviceState.state.mode !== pendingModeChange.mode) {
        console.log(`[Device] Mode change ${pendingModeChange.mode} not confirmed, server has ${DeviceState.state.mode}`);
        // Clear pending and accept server's mode
        pendingModeChange = null;
        return false;
    }

    // Clear stale pending mode
    pendingModeChange = null;
    return false;
}

// ============================================
// Settings Handlers
// ============================================
function setupSettingHandlers() {
    // Toggle switches (Smart tab)
    document.getElementById('alarmEnabled').addEventListener('change', (e) => {
        MQTTClient.publishConfig(DeviceState.deviceId, { alarmEnabled: e.target.checked });
    });

    document.getElementById('dayIdleEnabled').addEventListener('change', (e) => {
        MQTTClient.publishConfig(DeviceState.deviceId, { dayIdleEnabled: e.target.checked });
    });

    document.getElementById('motionEnabled').addEventListener('change', (e) => {
        MQTTClient.publishConfig(DeviceState.deviceId, { motionEnabled: e.target.checked });
    });

    document.getElementById('twtEnabled').addEventListener('change', (e) => {
        MQTTClient.publishConfig(DeviceState.deviceId, { twtEnabled: e.target.checked });
    });

    // Theme toggle
    const themeToggle = document.getElementById('themeToggle');
    if (themeToggle) {
        // Set initial state based on current theme
        themeToggle.checked = Theme.get() === 'dark';

        themeToggle.addEventListener('change', (e) => {
            Theme.set(e.target.checked ? 'dark' : 'light');
            Toast.success(`Switched to ${e.target.checked ? 'dark' : 'light'} mode`);
        });
    }

    // Alarm time click - Enhanced personalized popup
    document.getElementById('alarmSetting').addEventListener('click', (e) => {
        if (e.target.closest('.toggle')) return;

        const config = DeviceState.state?.config || {};
        const currentHour = config.alarmHour ?? 7;
        const currentMinute = config.alarmMin ?? 0;

        // Create enhanced alarm modal
        const content = `
            <div style="margin-bottom: var(--spacing-lg);">
                <div style="display: flex; align-items: center; gap: var(--spacing-sm); margin-bottom: var(--spacing-sm);">
                    <span style="font-size: 2em;">⏰</span>
                    <div>
                        <div style="font-weight: 600; color: var(--text-primary); font-size: var(--font-size-lg);">Wake-Up Alarm</div>
                        <div style="font-size: var(--font-size-sm); color: var(--text-secondary);">Light turns ON at this time to help you wake naturally.</div>
                    </div>
                </div>
                <div style="background: linear-gradient(135deg, rgba(251, 191, 36, 0.15), rgba(245, 158, 11, 0.08)); 
                            border-radius: var(--radius-md); padding: var(--spacing-sm) var(--spacing-md); 
                            margin-top: var(--spacing-md); border: 1px solid rgba(251, 191, 36, 0.3);
                            font-size: var(--font-size-sm); color: var(--text-secondary);">
                    ☀️ <strong>Sunrise Simulation</strong> - waking with light is healthier than sound alarms!
                </div>
            </div>
            <div class="time-display" style="text-align: center; margin-bottom: var(--spacing-lg);">
                <div style="font-size: 2.5em; font-weight: 700; font-variant-numeric: tabular-nums;
                            background: var(--accent-gradient); -webkit-background-clip: text; 
                            -webkit-text-fill-color: transparent; background-clip: text;" id="timePreview">
                    ${String(currentHour).padStart(2, '0')}:${String(currentMinute).padStart(2, '0')}
                </div>
            </div>
            <div class="flex gap-md">
                <div class="picker" style="flex: 1;">
                    <div class="picker-highlight"></div>
                    <div class="picker-scroll" data-picker-hours>
                        <div class="picker-spacer"></div>
                        ${Array.from({ length: 24 }, (_, i) => `
                            <div class="picker-item" data-value="${i}">${String(i).padStart(2, '0')}</div>
                        `).join('')}
                        <div class="picker-spacer"></div>
                    </div>
                </div>
                <div style="font-size: 24px; font-weight: bold; display: flex; align-items: center;">:</div>
                <div class="picker" style="flex: 1;">
                    <div class="picker-highlight"></div>
                    <div class="picker-scroll" data-picker-minutes>
                        <div class="picker-spacer"></div>
                        ${Array.from({ length: 60 }, (_, i) => `
                            <div class="picker-item" data-value="${i}">${String(i).padStart(2, '0')}</div>
                        `).join('')}
                        <div class="picker-spacer"></div>
                    </div>
                </div>
            </div>
        `;

        let selectedHour = currentHour;
        let selectedMinute = currentMinute;

        const { backdrop, modal, close } = Modal.create({
            title: '⏰ Set Alarm Time',
            content,
            actions: [
                { label: 'Cancel', primary: false },
                {
                    label: '✓ Set Alarm',
                    primary: true,
                    onClick: () => {
                        MQTTClient.publishConfig(DeviceState.deviceId, {
                            alarmHour: selectedHour,
                            alarmMin: selectedMinute
                        });
                        document.getElementById('alarmTime').textContent =
                            `${String(selectedHour).padStart(2, '0')}:${String(selectedMinute).padStart(2, '0')}`;
                        Toast.success(`Alarm set for ${String(selectedHour).padStart(2, '0')}:${String(selectedMinute).padStart(2, '0')}`);
                    }
                }
            ]
        });

        const hourScroll = modal.querySelector('[data-picker-hours]');
        const minuteScroll = modal.querySelector('[data-picker-minutes]');
        const timePreview = modal.querySelector('#timePreview');
        const itemHeight = 44;

        // Initialize scroll positions
        setTimeout(() => {
            hourScroll.scrollTop = currentHour * itemHeight;
            minuteScroll.scrollTop = currentMinute * itemHeight;
        }, 100);

        // Setup scroll handlers with live preview
        const setupScroll = (scroll, values, onUpdate) => {
            let currentIndex = 0;

            const update = () => {
                const newIndex = Math.round(scroll.scrollTop / itemHeight);
                if (newIndex !== currentIndex && newIndex >= 0 && newIndex < values.length) {
                    currentIndex = newIndex;
                    onUpdate(values[currentIndex]);
                    // Update live preview
                    timePreview.textContent = `${String(selectedHour).padStart(2, '0')}:${String(selectedMinute).padStart(2, '0')}`;

                    scroll.querySelectorAll('.picker-item').forEach((item, i) => {
                        item.classList.toggle('selected', i === currentIndex);
                    });
                }
            };

            scroll.addEventListener('scroll', update);

            let timeout;
            scroll.addEventListener('scroll', () => {
                clearTimeout(timeout);
                timeout = setTimeout(() => {
                    scroll.scrollTo({ top: currentIndex * itemHeight, behavior: 'smooth' });
                }, 100);
            });
        };

        setupScroll(hourScroll, Array.from({ length: 24 }, (_, i) => i), (h) => selectedHour = h);
        setupScroll(minuteScroll, Array.from({ length: 60 }, (_, i) => i), (m) => selectedMinute = m);
    });

    // Settings rows with pickers - Using correct data-setting selectors
    setupSettingPicker('presenceDisplayTimeout', 'presenceDisplayTimeout',
        [0, 5, 10, 15, 30, 60, 120, 300],
        (v) => v === 0 ? 'Off' : `${v}s`,
        'displayTimeoutValue');

    setupSettingPicker('radarSensitivity', 'radarSensitivity',
        Array.from({ length: 21 }, (_, i) => i * 5),
        (v) => `${v}%`,
        'radarSensitivityValue');

    setupSettingPicker('angleOff', 'angleOff',
        Array.from({ length: 181 }, (_, i) => i),
        (v) => `${v}°`,
        'angleOffValue');

    setupSettingPicker('angleOn', 'angleOn',
        Array.from({ length: 181 }, (_, i) => i),
        (v) => `${v}°`,
        'angleOnValue');

    // Helper function for formatting seconds as duration
    const formatSeconds = (s) => {
        if (s < 60) return `${s}s`;
        const mins = Math.floor(s / 60);
        const secs = s % 60;
        if (secs === 0) return `${mins}m`;
        return `${mins}m ${secs}s`;
    };

    setupSettingPicker('motionTimeout', 'motionTimeout',
        [10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 300, 450, 600, 900],
        formatSeconds,
        'motionTimeoutValue');

    setupSettingPicker('manualTimeout', 'manualTimeout',
        [10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 300, 450, 600, 900],
        formatSeconds,
        'manualTimeoutValue');

    setupSettingPicker('sunriseOffset', 'sunriseOffset',
        Array.from({ length: 25 }, (_, i) => (i - 12) * 10),
        (v) => `${v >= 0 ? '+' : ''}${v} min`,
        'sunriseOffsetValue');

    setupSettingPicker('sunsetOffset', 'sunsetOffset',
        Array.from({ length: 25 }, (_, i) => (i - 12) * 10),
        (v) => `${v >= 0 ? '+' : ''}${v} min`,
        'sunsetOffsetValue');

    setupSettingPicker('lightWattage', 'lightWattage',
        [10, 20, 40, 60, 75, 100, 150, 200, 300, 500, 1000],
        (v) => `${v}W`,
        'lightWattageValue');

    // City/Location - Enhanced personalized popup
    document.querySelector('[data-setting="city"]')?.addEventListener('click', () => {
        const config = DeviceState.state?.config || {};

        const content = `
            <div style="margin-bottom: var(--spacing-lg);">
                <div style="display: flex; align-items: center; gap: var(--spacing-sm); margin-bottom: var(--spacing-sm);">
                    <span style="font-size: 2em;">📍</span>
                    <div>
                        <div style="font-weight: 600; color: var(--text-primary); font-size: var(--font-size-lg);">Your Location</div>
                        <div style="font-size: var(--font-size-sm); color: var(--text-secondary);">Used to calculate accurate sunrise and sunset times.</div>
                    </div>
                </div>
                <div style="background: linear-gradient(135deg, rgba(34, 197, 94, 0.12), rgba(16, 185, 129, 0.06)); 
                            border-radius: var(--radius-md); padding: var(--spacing-sm) var(--spacing-md); 
                            margin-top: var(--spacing-md); border: 1px solid rgba(34, 197, 94, 0.25);
                            font-size: var(--font-size-sm); color: var(--text-secondary);">
                    🌍 <strong>Day Idle Mode</strong> uses these times to know when it's light outside!
                </div>
            </div>
            <div class="input-group">
                <label style="display: block; margin-bottom: var(--spacing-xs); color: var(--text-secondary); font-size: var(--font-size-sm);">
                    Enter your city and country code:
                </label>
                <input type="text" class="input" placeholder="e.g. Bristol,GB or New York,US" 
                       value="${config.city || ''}" data-modal-input
                       style="font-size: 1.1em; padding: var(--spacing-md);">
                <div style="margin-top: var(--spacing-sm); color: var(--text-tertiary); font-size: var(--font-size-xs);">
                    💡 Use format: City,CountryCode (GB, US, DE, FR, etc.)
                </div>
            </div>
        `;

        const { backdrop, modal, close } = Modal.create({
            title: '📍 Set Location',
            content,
            actions: [
                { label: 'Cancel', primary: false },
                {
                    label: '✓ Save Location',
                    primary: true,
                    onClick: () => {
                        const input = modal.querySelector('[data-modal-input]');
                        const value = input.value.trim();
                        if (value) {
                            MQTTClient.publishConfig(DeviceState.deviceId, { city: value });
                            document.getElementById('cityValue').textContent = value;
                            Toast.success(`Location set to ${value}`);
                        }
                    }
                }
            ]
        });

        // Focus input
        setTimeout(() => {
            const input = modal.querySelector('[data-modal-input]');
            input.focus();
            input.select();
        }, 300);
    });

    // Sleep settings
    setupSettingPicker('sleepTargetDuration', 'sleepTargetDuration',
        Array.from({ length: 12 }, (_, i) => (i + 1) * 60),
        (v) => Utils.formatDuration(v),
        'sleepTargetDurationValue');

    document.querySelector('[data-setting="sleepTargetBedtime"]')?.addEventListener('click', () => {
        const config = DeviceState.state?.config || {};
        Modal.timePicker({
            title: 'Set Target Bedtime',
            hour: config.sleepTargetBedtimeHour ?? 23,
            minute: config.sleepTargetBedtimeMin ?? 0,
            onSelect: (hour, minute) => {
                MQTTClient.publishConfig(DeviceState.deviceId, {
                    sleepTargetBedtimeHour: hour,
                    sleepTargetBedtimeMin: minute
                });
                document.getElementById('sleepTargetBedtimeValue').textContent =
                    `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
            }
        });
    });

    // Change WiFi - Professional MQTT-based WiFi Changer with Network Scanner
    document.getElementById('changeWifiBtn')?.addEventListener('click', () => {
        const currentSSID = DeviceState.state?.wifi?.ssid || DeviceState.state?.ssid || 'Unknown';
        const rssi = DeviceState.state?.rssi || DeviceState.state?.wifi?.rssi || 0;

        // Calculate signal strength percentage  
        let signalPercent = 0;
        if (rssi >= -50) { signalPercent = 100; }
        else if (rssi >= -60) { signalPercent = 75; }
        else if (rssi >= -70) { signalPercent = 50; }
        else if (rssi >= -80) { signalPercent = 25; }
        else { signalPercent = 10; }

        // Helper to get signal bars
        const getSignalBars = (rssiVal) => {
            if (rssiVal >= -50) return '▂▄▆█';
            if (rssiVal >= -60) return '▂▄▆░';
            if (rssiVal >= -70) return '▂▄░░';
            if (rssiVal >= -80) return '▂░░░';
            return '░░░░';
        };

        const getSignalColor = (rssiVal) => {
            if (rssiVal >= -50) return 'var(--success)';
            if (rssiVal >= -60) return 'var(--success)';
            if (rssiVal >= -70) return 'var(--warning)';
            return 'var(--danger)';
        };

        const content = `
            <div class="wifi-changer-popup" style="display: flex; flex-direction: column; gap: var(--spacing-lg);">
                <!-- Current Network Status -->
                <div style="background: linear-gradient(135deg, rgba(34, 197, 94, 0.12), rgba(16, 185, 129, 0.06)); 
                            border-radius: var(--radius-lg); padding: var(--spacing-md); 
                            border: 1px solid rgba(34, 197, 94, 0.25);">
                    <div style="display: flex; align-items: center; justify-content: space-between;">
                        <div style="display: flex; align-items: center; gap: var(--spacing-sm);">
                            <span style="font-size: 1.5em;">📶</span>
                            <div>
                                <div style="font-weight: 600; color: var(--text-primary);">Currently Connected</div>
                                <div style="font-size: var(--font-size-sm); color: var(--text-secondary);">${currentSSID}</div>
                            </div>
                        </div>
                        <div style="text-align: right;">
                            <div style="font-size: var(--font-size-xs); color: var(--text-tertiary);">Signal</div>
                            <div style="display: flex; align-items: center; gap: 4px;">
                                <div style="width: 40px; height: 6px; background: var(--bg-tertiary); border-radius: 3px; overflow: hidden;">
                                    <div style="width: ${signalPercent}%; height: 100%; background: ${signalPercent >= 50 ? 'var(--success)' : signalPercent >= 25 ? 'var(--warning)' : 'var(--danger)'}; border-radius: 3px;"></div>
                                </div>
                                <span style="font-size: var(--font-size-xs); color: var(--text-secondary);">${rssi}dBm</span>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Scan for Networks -->
                <div style="background: var(--bg-glass); border-radius: var(--radius-lg); padding: var(--spacing-md); border: 1px solid var(--border-glass);">
                    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: var(--spacing-md);">
                        <div style="display: flex; align-items: center; gap: var(--spacing-sm);">
                            <span style="font-size: 1.3em;">🔍</span>
                            <div style="font-weight: 600; color: var(--text-primary);">Available Networks</div>
                        </div>
                        <button id="wifiScanBtn" class="btn btn-secondary" style="padding: 6px 12px; font-size: var(--font-size-sm);">
                            🔄 Scan
                        </button>
                    </div>
                    
                    <!-- Network List -->
                    <div id="wifiNetworkList" style="max-height: 180px; overflow-y: auto; border-radius: var(--radius-md);">
                        <div style="text-align: center; padding: var(--spacing-lg); color: var(--text-tertiary);">
                            <div style="font-size: 1.5em; margin-bottom: var(--spacing-xs);">📡</div>
                            <div>Tap "Scan" to discover nearby networks</div>
                        </div>
                    </div>
                </div>

                <!-- Manual Network Entry -->
                <div id="wifiManualEntry" style="background: var(--bg-glass); border-radius: var(--radius-lg); padding: var(--spacing-lg); border: 1px solid var(--border-glass);">
                    <div style="display: flex; align-items: center; gap: var(--spacing-sm); margin-bottom: var(--spacing-md);">
                        <span style="font-size: 1.3em;">✏️</span>
                        <div style="font-weight: 600; color: var(--text-primary);">Network Credentials</div>
                    </div>
                    
                    <div style="display: flex; flex-direction: column; gap: var(--spacing-md);">
                        <!-- SSID Input -->
                        <div>
                            <label style="display: block; margin-bottom: var(--spacing-xs); color: var(--text-secondary); font-size: var(--font-size-sm); font-weight: 500;">
                                Network Name (SSID)
                            </label>
                            <input type="text" id="wifiNewSSID" class="input" 
                                   placeholder="Select from scan or type manually" 
                                   autocomplete="off" autocapitalize="off" spellcheck="false"
                                   style="font-size: 1em; padding: var(--spacing-md); width: 100%; box-sizing: border-box;">
                        </div>
                        
                        <!-- Password Input with Toggle -->
                        <div>
                            <label style="display: block; margin-bottom: var(--spacing-xs); color: var(--text-secondary); font-size: var(--font-size-sm); font-weight: 500;">
                                Password
                            </label>
                            <div style="position: relative;">
                                <input type="password" id="wifiNewPassword" class="input" 
                                       placeholder="Enter WiFi password"
                                       autocomplete="off"
                                       style="font-size: 1em; padding: var(--spacing-md); padding-right: 50px; width: 100%; box-sizing: border-box;">
                                <button type="button" id="wifiTogglePassword" 
                                        style="position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
                                               background: transparent; border: none; color: var(--text-tertiary);
                                               cursor: pointer; padding: 8px; font-size: 1.2em;"
                                        title="Show/Hide Password">
                                    👁️
                                </button>
                            </div>
                        </div>
                    </div>
                    
                    <!-- Warning -->
                    <div style="background: linear-gradient(135deg, rgba(251, 191, 36, 0.12), rgba(245, 158, 11, 0.06)); 
                                border-radius: var(--radius-md); padding: var(--spacing-sm) var(--spacing-md); 
                                margin-top: var(--spacing-md); border: 1px solid rgba(251, 191, 36, 0.25);
                                font-size: var(--font-size-sm); color: var(--text-secondary);">
                        <strong>⚠️ Important:</strong> Device will disconnect and reconnect to the new network.
                        Make sure the credentials are correct!
                    </div>
                </div>
                
                <!-- Connection Status -->
                <div id="wifiConnectionStatus" style="display: none; text-align: center; padding: var(--spacing-md);
                            background: var(--bg-glass); border-radius: var(--radius-lg); border: 1px solid var(--border-glass);">
                    <div style="font-size: 2em; margin-bottom: var(--spacing-sm);">🔄</div>
                    <div style="color: var(--text-primary); font-weight: 500;" id="wifiStatusText">Connecting...</div>
                    <div style="color: var(--text-secondary); font-size: var(--font-size-sm);" id="wifiStatusSubtext">
                        Please wait while the device connects...
                    </div>
                </div>
            </div>
        `;

        const { backdrop, modal, close } = Modal.create({
            title: '📶 WiFi Network Settings',
            content,
            actions: [
                { label: 'Cancel', primary: false },
                {
                    label: '🔗 Connect',
                    primary: true,
                    onClick: () => {
                        const ssid = modal.querySelector('#wifiNewSSID')?.value?.trim();
                        const password = modal.querySelector('#wifiNewPassword')?.value;

                        if (!ssid) {
                            Toast.error('Please enter a network name (SSID)');
                            return false;
                        }

                        if (password.length < 8 && password.length > 0) {
                            Toast.error('Password must be at least 8 characters');
                            return false;
                        }

                        // Show connecting status
                        const manualEntry = modal.querySelector('#wifiManualEntry');
                        const statusContainer = modal.querySelector('#wifiConnectionStatus');
                        if (manualEntry) manualEntry.style.display = 'none';
                        if (statusContainer) statusContainer.style.display = 'block';

                        // Send WiFi config via MQTT
                        MQTTClient.publishConfig(DeviceState.deviceId, {
                            newWifiSSID: ssid,
                            newWifiPassword: password
                        });

                        Toast.info(`Sending WiFi credentials for "${ssid}"...`);

                        // Close after a delay
                        setTimeout(() => {
                            Toast.success('WiFi credentials sent! Device will reconnect shortly.');
                            close();
                        }, 2000);

                        return false;
                    }
                }
            ]
        });

        // Setup password toggle
        const toggleBtn = modal.querySelector('#wifiTogglePassword');
        const passwordInput = modal.querySelector('#wifiNewPassword');
        if (toggleBtn && passwordInput) {
            toggleBtn.addEventListener('click', () => {
                const isPassword = passwordInput.type === 'password';
                passwordInput.type = isPassword ? 'text' : 'password';
                toggleBtn.textContent = isPassword ? '🙈' : '👁️';
            });
        }

        // Setup WiFi scan functionality
        const scanBtn = modal.querySelector('#wifiScanBtn');
        const networkList = modal.querySelector('#wifiNetworkList');
        const ssidInput = modal.querySelector('#wifiNewSSID');

        if (scanBtn && networkList) {
            scanBtn.addEventListener('click', () => {
                // Show scanning state
                scanBtn.disabled = true;
                scanBtn.innerHTML = '⏳ Scanning...';
                networkList.innerHTML = `
                    <div style="text-align: center; padding: var(--spacing-lg); color: var(--text-secondary);">
                        <div class="wifi-scan-spinner" style="font-size: 2em; animation: spin 1s linear infinite; display: inline-block;">🔄</div>
                        <div style="margin-top: var(--spacing-sm);">Scanning for networks...</div>
                    </div>
                    <style>@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }</style>
                `;

                // Request WiFi scan via MQTT
                MQTTClient.publishControl(DeviceState.deviceId, { command: 'wifiScan' });

                // Listen for scan results (will come via state update)
                const onScanResults = (deviceId, state) => {
                    if (deviceId === DeviceState.deviceId && state.wifiScanResults) {
                        const networks = state.wifiScanResults;

                        if (networks.length === 0) {
                            networkList.innerHTML = `
                                <div style="text-align: center; padding: var(--spacing-lg); color: var(--text-tertiary);">
                                    <div style="font-size: 1.5em; margin-bottom: var(--spacing-xs);">😕</div>
                                    <div>No networks found. Try scanning again.</div>
                                </div>
                            `;
                        } else {
                            // Sort by signal strength
                            networks.sort((a, b) => b.rssi - a.rssi);

                            networkList.innerHTML = networks.map(net => `
                                <div class="wifi-network-item" data-ssid="${net.ssid}" 
                                     style="display: flex; align-items: center; justify-content: space-between;
                                            padding: var(--spacing-sm) var(--spacing-md); cursor: pointer;
                                            border-bottom: 1px solid var(--border-glass);
                                            transition: background 0.2s ease;">
                                    <div style="display: flex; align-items: center; gap: var(--spacing-sm); flex: 1; min-width: 0;">
                                        <span style="font-size: 1.2em;">${net.secure ? '🔒' : '🔓'}</span>
                                        <div style="flex: 1; min-width: 0;">
                                            <div style="font-weight: 500; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                                                ${net.ssid}
                                            </div>
                                            <div style="font-size: var(--font-size-xs); color: var(--text-tertiary);">
                                                ${net.rssi}dBm ${net.ssid === currentSSID ? '• Connected' : ''}
                                            </div>
                                        </div>
                                    </div>
                                    <div style="font-family: monospace; letter-spacing: 1px; color: ${getSignalColor(net.rssi)};">
                                        ${getSignalBars(net.rssi)}
                                    </div>
                                </div>
                            `).join('');

                            // Add click handlers to network items
                            networkList.querySelectorAll('.wifi-network-item').forEach(item => {
                                item.addEventListener('click', () => {
                                    const selectedSSID = item.dataset.ssid;
                                    ssidInput.value = selectedSSID;
                                    ssidInput.focus();
                                    passwordInput.focus();
                                    Toast.info(`Selected: ${selectedSSID}`);

                                    // Highlight selected
                                    networkList.querySelectorAll('.wifi-network-item').forEach(i => {
                                        i.style.background = i === item ? 'rgba(99, 102, 241, 0.15)' : '';
                                    });
                                });

                                // Hover effect
                                item.addEventListener('mouseenter', () => {
                                    if (!item.style.background) item.style.background = 'var(--bg-glass-strong)';
                                });
                                item.addEventListener('mouseleave', () => {
                                    if (item.style.background === 'var(--bg-glass-strong)') item.style.background = '';
                                });
                            });
                        }

                        // Re-enable scan button
                        scanBtn.disabled = false;
                        scanBtn.innerHTML = '🔄 Scan';

                        // Remove listener
                        MQTTClient.off('onStateUpdate', onScanResults);
                    }
                };

                MQTTClient.on('onStateUpdate', onScanResults);

                // Timeout fallback - simulated results REMOVED
                setTimeout(() => {
                    if (scanBtn.disabled) {
                        scanBtn.disabled = false;
                        scanBtn.innerHTML = '🔄 Scan';
                        networkList.innerHTML = `
                            <div style="text-align: center; padding: var(--spacing-md); color: var(--text-tertiary);">
                                <div style="font-size: 1.2em; margin-bottom: var(--spacing-xs);">⚠️</div>
                                <div style="font-size: var(--font-size-sm);">Scan timed out or not supported.</div>
                                <div style="font-size: var(--font-size-xs); margin-top: var(--spacing-xs);">Please enter the network name manually.</div>
                            </div>
                        `;
                        MQTTClient.off('onStateUpdate', onScanResults);
                    }
                }, 10000);
            });
        }

        // Focus SSID input
        setTimeout(() => {
            modal.querySelector('#wifiNewSSID')?.focus();
        }, 300);
    });
}

function setupSettingPicker(settingId, configKey, values, formatFn, displayId) {
    const element = document.querySelector(`[data-setting="${settingId}"]`);
    if (!element) return;

    // Setting metadata for personalized popups
    const settingMeta = {
        'displayTimeoutSetting': {
            icon: '🖥️',
            title: 'Display Auto-Off',
            description: 'Screen will turn off after this duration when no presence is detected.',
            tip: '💡 Lower values save power but may be inconvenient.'
        },
        'radarSensitivitySetting': {
            icon: '📡',
            title: 'Motion Sensitivity',
            description: 'How sensitive the radar sensor is to movement.',
            tip: '⚠️ Higher = more sensitive, may detect movement through walls.'
        },
        'angleOff': {
            icon: '🔴',
            title: 'OFF Position Angle',
            description: 'The servo angle when turning the light switch OFF.',
            tip: '🔧 Test after saving to verify the angle is correct.'
        },
        'angleOn': {
            icon: '🟢',
            title: 'ON Position Angle',
            description: 'The servo angle when turning the light switch ON.',
            tip: '🔧 Test after saving to verify the angle is correct.'
        },
        'motionTimeout': {
            icon: '⏱️',
            title: 'Auto-Off Timer',
            description: 'How long to wait after motion stops before turning off the light.',
            tip: '💡 Longer times = more convenience, shorter times = more savings.'
        },
        'manualTimeout': {
            icon: '✋',
            title: 'Manual Mode Timer',
            description: 'How long to keep the light on in manual mode before auto-off.',
            tip: '⏰ Set to longer for reading or working.'
        },
        'sunriseOffset': {
            icon: '🌅',
            title: 'Sunrise Offset',
            description: 'Adjust when Day Idle mode starts relative to sunrise.',
            tip: '➕ Positive = after sunrise, ➖ Negative = before sunrise'
        },
        'sunsetOffset': {
            icon: '🌆',
            title: 'Sunset Offset',
            description: 'Adjust when Day Idle mode ends relative to sunset.',
            tip: '➕ Positive = after sunset, ➖ Negative = before sunset'
        },
        'lightWattage': {
            icon: '💡',
            title: 'Light Wattage',
            description: 'Set your bulb wattage for accurate energy usage calculations.',
            tip: '🔌 Check your bulb\'s label for the correct wattage.'
        },
        'sleepTargetDuration': {
            icon: '😴',
            title: 'Sleep Goal',
            description: 'Your target sleep duration each night.',
            tip: '💤 Most adults need 7-9 hours of sleep.'
        }
    };

    const meta = settingMeta[settingId] || {
        icon: '⚙️',
        title: element.querySelector('.setting-label')?.textContent || 'Select Value',
        description: 'Choose a value from the options below.',
        tip: ''
    };

    element.addEventListener('click', () => {
        const config = DeviceState.state?.config || {};
        const currentValue = config[configKey] ?? values[Math.floor(values.length / 2)];

        // Create enhanced content with description
        const content = `
            <div style="margin-bottom: var(--spacing-lg);">
                <div style="display: flex; align-items: center; gap: var(--spacing-sm); margin-bottom: var(--spacing-sm);">
                    <span style="font-size: 1.5em;">${meta.icon}</span>
                    <div>
                        <div style="font-weight: 600; color: var(--text-primary);">${meta.title}</div>
                        <div style="font-size: var(--font-size-sm); color: var(--text-secondary);">${meta.description}</div>
                    </div>
                </div>
                ${meta.tip ? `
                    <div style="background: linear-gradient(135deg, rgba(99, 102, 241, 0.1), rgba(139, 92, 246, 0.05)); 
                                border-radius: var(--radius-md); padding: var(--spacing-sm) var(--spacing-md); 
                                margin-top: var(--spacing-md); border: 1px solid rgba(99, 102, 241, 0.2);
                                font-size: var(--font-size-sm); color: var(--text-secondary);">
                        ${meta.tip}
                    </div>
                ` : ''}
            </div>
            <div class="picker-container" style="background: var(--bg-glass); border-radius: var(--radius-lg); 
                        padding: var(--spacing-md); border: 1px solid var(--border-glass);">
                <div style="font-weight: 600; margin-bottom: var(--spacing-md); text-align: center; color: var(--text-primary);">
                    Current: <span style="color: var(--accent);">${formatFn(currentValue)}</span>
                </div>
                <div class="picker">
                    <div class="picker-highlight"></div>
                    <div class="picker-scroll" data-picker-scroll>
                        <div class="picker-spacer"></div>
                        ${values.map((v, i) => `
                            <div class="picker-item" data-index="${i}" data-value="${v}">
                                ${formatFn(v)}
                            </div>
                        `).join('')}
                        <div class="picker-spacer"></div>
                    </div>
                </div>
            </div>
        `;

        // Create enhanced modal
        let selectedIndex = values.findIndex(v => v === currentValue);
        if (selectedIndex === -1) selectedIndex = 0;

        const { backdrop, modal, close } = Modal.create({
            title: `${meta.icon} ${meta.title}`,
            content,
            actions: [
                {
                    label: '✏️ Custom',
                    primary: false,
                    onClick: () => {
                        // Open custom value input modal
                        close();
                        setTimeout(() => {
                            const customContent = `
                                <div style="margin-bottom: var(--spacing-lg);">
                                    <div style="display: flex; align-items: center; gap: var(--spacing-sm); margin-bottom: var(--spacing-md);">
                                        <span style="font-size: 1.5em;">✏️</span>
                                        <div>
                                            <div style="font-weight: 600; color: var(--text-primary);">Custom Value</div>
                                            <div style="font-size: var(--font-size-sm); color: var(--text-secondary);">Enter your own value for ${meta.title}</div>
                                        </div>
                                    </div>
                                    <div style="background: linear-gradient(135deg, rgba(251, 191, 36, 0.1), rgba(245, 158, 11, 0.05)); 
                                                border-radius: var(--radius-md); padding: var(--spacing-sm) var(--spacing-md); 
                                                border: 1px solid rgba(251, 191, 36, 0.2);
                                                font-size: var(--font-size-sm); color: var(--text-secondary);">
                                        💡 Preset values: ${values.slice(0, 5).map(v => formatFn(v)).join(', ')}...
                                    </div>
                                </div>
                                <div class="input-group">
                                    <label style="display: block; margin-bottom: var(--spacing-xs); color: var(--text-secondary); font-size: var(--font-size-sm); font-weight: 500;">
                                        Enter value (in seconds for timers, degrees for angles, etc.):
                                    </label>
                                    <input type="number" id="customValueInput" class="input" 
                                           placeholder="Enter a number" 
                                           value="${currentValue}"
                                           style="font-size: 1.2em; padding: var(--spacing-md); text-align: center; font-weight: 600;">
                                </div>
                            `;

                            Modal.create({
                                title: `✏️ Custom ${meta.title}`,
                                content: customContent,
                                actions: [
                                    { label: 'Cancel', primary: false },
                                    {
                                        label: '✓ Apply',
                                        primary: true,
                                        onClick: () => {
                                            const customModal = document.querySelector('.modal');
                                            const input = customModal?.querySelector('#customValueInput');
                                            const customValue = parseInt(input?.value);

                                            if (isNaN(customValue) || customValue < 0) {
                                                Toast.error('Please enter a valid positive number');
                                                return false;
                                            }

                                            const payload = {};
                                            payload[configKey] = customValue;
                                            MQTTClient.publishConfig(DeviceState.deviceId, payload);
                                            document.getElementById(displayId).textContent = formatFn(customValue);
                                            Toast.success(`${meta.title} set to ${formatFn(customValue)}`);
                                        }
                                    }
                                ]
                            });

                            // Focus input
                            setTimeout(() => {
                                const input = document.querySelector('#customValueInput');
                                if (input) {
                                    input.focus();
                                    input.select();
                                }
                            }, 300);
                        }, 300);
                        return false;
                    }
                },
                {
                    label: '✓ Save',
                    primary: true,
                    onClick: () => {
                        const selectedValue = values[selectedIndex];
                        const payload = {};
                        payload[configKey] = selectedValue;
                        MQTTClient.publishConfig(DeviceState.deviceId, payload);
                        document.getElementById(displayId).textContent = formatFn(selectedValue);
                        Toast.success(`${meta.title} updated to ${formatFn(selectedValue)}`);
                    }
                }
            ]
        });

        // Setup picker functionality
        const scroll = modal.querySelector('[data-picker-scroll]');
        const items = modal.querySelectorAll('.picker-item');
        const itemHeight = 44;

        // selectedIndex is already declared above

        // Scroll to initial value
        setTimeout(() => {
            scroll.scrollTop = selectedIndex * itemHeight;
            items.forEach((item, i) => {
                item.classList.toggle('selected', i === selectedIndex);
            });
        }, 100);

        // Update selection on scroll
        const updateSelection = () => {
            const scrollTop = scroll.scrollTop;
            const newIndex = Math.round(scrollTop / itemHeight);

            if (newIndex !== selectedIndex && newIndex >= 0 && newIndex < values.length) {
                selectedIndex = newIndex;
                items.forEach((item, i) => {
                    item.classList.toggle('selected', i === selectedIndex);
                });
            }
        };

        scroll.addEventListener('scroll', updateSelection);

        // Snap to nearest on scroll end
        let scrollTimeout;
        scroll.addEventListener('scroll', () => {
            clearTimeout(scrollTimeout);
            scrollTimeout = setTimeout(() => {
                scroll.scrollTo({
                    top: selectedIndex * itemHeight,
                    behavior: 'smooth'
                });
            }, 100);
        });
    });
}

// ============================================
// Sleep Handlers
// ============================================
function setupSleepHandlers() {
    // Sleep action button
    const sleepActionBtn = document.getElementById('sleepActionBtn');
    if (sleepActionBtn) {
        sleepActionBtn.addEventListener('click', () => {
            const currentState = DeviceState.state || {};
            const isSleeping = currentState.isSleeping;
            const now = Math.floor(Date.now() / 1000);

            if (!isSleeping) {
                // STARTING SLEEP
                // Optimistic update
                DeviceState.state = {
                    ...currentState,
                    isSleeping: true,
                    sleepStart: now
                };

                // Send command
                MQTTClient.publishControl(DeviceState.deviceId, { sleep: true, sleepStart: now });

                Toast.success('Sleep session started');
            } else {
                // ENDING SLEEP
                const start = currentState.sleepStart;

                // Create history entry if we have a valid start time
                let newHistory = currentState.sleepHistory ? [...currentState.sleepHistory] : [];
                if (start && (now - start) > 60) { // Only save if duration > 1 minute
                    const newSession = { start, end: now };
                    newHistory.unshift(newSession);
                    // Sort by start time descending
                    newHistory.sort((a, b) => b.start - a.start);
                }

                // Optimistic update
                DeviceState.state = {
                    ...currentState,
                    isSleeping: false,
                    sleepStart: null, // Clear start time
                    sleepHistory: newHistory
                };

                // Send command
                MQTTClient.publishControl(DeviceState.deviceId, { sleep: false });

                Toast.success('Sleep session ended');
            }

            // Update UI immediately
            updateUI(DeviceState.state);

            // Persist to Firestore immediately
            // CRITICAL: Use the NEW state from DeviceState.state (already updated above)
            // NOT the old `isSleeping` variable which captured the state BEFORE the toggle
            const user = Auth.getUser();
            if (user) {
                const nowSleeping = DeviceState.state.isSleeping;
                const updates = nowSleeping ?
                    { isSleeping: true, sleepStart: DeviceState.state.sleepStart } :
                    { isSleeping: false, sleepStart: null, sleepHistory: DeviceState.state.sleepHistory };

                DeviceService.updateDevice(user.uid, DeviceState.deviceId, updates)
                    .then(() => console.log('[Device] Sleep state synced to Firebase'))
                    .catch(e => {
                        console.warn('[Device] Sleep sync failed:', e);
                        Toast.warning('Sleep data sync failed - changes may not persist');
                    });
            }
        });
    }

    // Add manual log button
    const addLogBtn = document.getElementById('addLogBtn');
    if (addLogBtn) {
        addLogBtn.addEventListener('click', () => {
            openSleepLogPopup(); // Open in add mode (no index)
        });
    }
}

/**
 * Open an interactive sleep log popup for adding or editing a session
 * @param {number|null} index - Index of existing session to edit, or null/undefined for new entry
 */
function openSleepLogPopup(index = null) {
    const isEditing = index !== null && index !== undefined;
    const history = DeviceState.state?.sleepHistory || [];

    // Get existing session data if editing
    let existingSession = null;
    if (isEditing && history[index]) {
        existingSession = history[index];
    }

    // Default values for new entry: last night (10 PM - 6 AM)
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);

    let defaultDate = yesterday.toISOString().split('T')[0]; // YYYY-MM-DD
    let defaultBedtimeHour = 22;
    let defaultBedtimeMin = 0;
    let defaultWakeHour = 6;
    let defaultWakeMin = 0;

    // If editing, use existing session values
    if (existingSession) {
        const startDate = new Date(existingSession.start * 1000);
        const endDate = new Date(existingSession.end * 1000);

        defaultDate = startDate.toISOString().split('T')[0];
        defaultBedtimeHour = startDate.getHours();
        defaultBedtimeMin = startDate.getMinutes();
        defaultWakeHour = endDate.getHours();
        defaultWakeMin = endDate.getMinutes();
    }

    // Track selected values
    let selectedDate = defaultDate;
    let bedtimeHour = defaultBedtimeHour;
    let bedtimeMin = defaultBedtimeMin;
    let wakeHour = defaultWakeHour;
    let wakeMin = defaultWakeMin;

    // Create the popup content
    const content = `
        <div class="sleep-log-popup-content">
            <div class="sleep-log-header">
                <span class="sleep-log-header-icon">${isEditing ? '✏️' : '🌙'}</span>
                <div class="sleep-log-header-text">
                    <div class="sleep-log-header-title">${isEditing ? 'Edit Sleep Session' : 'Add Sleep Session'}</div>
                    <div class="sleep-log-header-subtitle">${isEditing ? 'Modify the times for this session' : 'Log a sleep session manually'}</div>
                </div>
            </div>

            <!-- Date Selector -->
            <div class="sleep-log-section">
                <label class="sleep-log-section-label">📅 Night of</label>
                <input type="date" class="sleep-log-date-input" id="sleepLogDate" value="${defaultDate}">
            </div>

            <!-- Time Pickers -->
            <div class="sleep-log-time-row">
                <!-- Bedtime -->
                <div class="sleep-log-time-col">
                    <label class="sleep-log-section-label">🛏️ Bedtime</label>
                    <div class="sleep-log-time-pickers">
                        <div class="picker">
                            <div class="picker-highlight"></div>
                            <div class="picker-scroll" data-picker="bedtime-hour">
                                <div class="picker-spacer"></div>
                                ${Array.from({ length: 24 }, (_, i) => `
                                    <div class="picker-item" data-value="${i}">${String(i).padStart(2, '0')}</div>
                                `).join('')}
                                <div class="picker-spacer"></div>
                            </div>
                        </div>
                        <span class="time-separator">:</span>
                        <div class="picker">
                            <div class="picker-highlight"></div>
                            <div class="picker-scroll" data-picker="bedtime-min">
                                <div class="picker-spacer"></div>
                                ${Array.from({ length: 12 }, (_, i) => `
                                    <div class="picker-item" data-value="${i * 5}">${String(i * 5).padStart(2, '0')}</div>
                                `).join('')}
                                <div class="picker-spacer"></div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Wake Time -->
                <div class="sleep-log-time-col">
                    <label class="sleep-log-section-label">☀️ Wake Time</label>
                    <div class="sleep-log-time-pickers">
                        <div class="picker">
                            <div class="picker-highlight"></div>
                            <div class="picker-scroll" data-picker="wake-hour">
                                <div class="picker-spacer"></div>
                                ${Array.from({ length: 24 }, (_, i) => `
                                    <div class="picker-item" data-value="${i}">${String(i).padStart(2, '0')}</div>
                                `).join('')}
                                <div class="picker-spacer"></div>
                            </div>
                        </div>
                        <span class="time-separator">:</span>
                        <div class="picker">
                            <div class="picker-highlight"></div>
                            <div class="picker-scroll" data-picker="wake-min">
                                <div class="picker-spacer"></div>
                                ${Array.from({ length: 12 }, (_, i) => `
                                    <div class="picker-item" data-value="${i * 5}">${String(i * 5).padStart(2, '0')}</div>
                                `).join('')}
                                <div class="picker-spacer"></div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Duration Preview -->
            <div class="sleep-log-duration-preview">
                <span class="sleep-log-duration-icon">⏱️</span>
                <div class="sleep-log-duration-text">
                    <span class="sleep-log-duration-label">Duration</span>
                    <span class="sleep-log-duration-value" id="sleepLogDurationPreview">--</span>
                </div>
            </div>
        </div>
    `;

    // Create the modal
    const { backdrop, modal, close } = Modal.create({
        title: isEditing ? '✏️ Edit Sleep Session' : '🌙 Add Sleep Session',
        content,
        actions: [
            { label: 'Cancel', primary: false },
            {
                label: isEditing ? '💾 Save Changes' : '➕ Add Session',
                primary: true,
                onClick: () => {
                    // Validate inputs
                    if (!selectedDate) {
                        Toast.error('Please select a date');
                        return false;
                    }

                    // Calculate start and end timestamps
                    const startDate = new Date(selectedDate);
                    startDate.setHours(bedtimeHour, bedtimeMin, 0, 0);

                    const endDate = new Date(selectedDate);
                    // If wake time is before bedtime, it's the next day
                    if (wakeHour < bedtimeHour || (wakeHour === bedtimeHour && wakeMin <= bedtimeMin)) {
                        endDate.setDate(endDate.getDate() + 1);
                    }
                    endDate.setHours(wakeHour, wakeMin, 0, 0);

                    const start = Math.floor(startDate.getTime() / 1000);
                    const end = Math.floor(endDate.getTime() / 1000);

                    // Validate duration
                    const duration = end - start;
                    if (duration <= 0) {
                        Toast.error('Wake time must be after bedtime');
                        return false;
                    }

                    if (duration < 60) { // Less than 1 minute
                        Toast.error('Sleep session is too short');
                        return false;
                    }

                    if (duration > 24 * 3600) { // More than 24 hours
                        Toast.error('Sleep session cannot be longer than 24 hours');
                        return false;
                    }

                    // Build command based on add vs edit
                    if (isEditing) {
                        // Edit: send both old and new timestamps
                        MQTTClient.publishControl(DeviceState.deviceId, {
                            command: 'editSleepSession',
                            oldStart: existingSession.start,
                            newStart: start,
                            newEnd: end
                        });
                        Toast.success('Sleep session updated');

                        // Optimistic Update: Update local state immediately
                        if (DeviceState.state.sleepHistory && DeviceState.state.sleepHistory[index]) {
                            DeviceState.state.sleepHistory[index] = { start, end };
                            // Sort again in case date changed significantly
                            DeviceState.state.sleepHistory.sort((a, b) => b.start - a.start);
                        }
                    } else {
                        // Add new session
                        MQTTClient.publishControl(DeviceState.deviceId, {
                            command: 'addSleepSession',
                            start,
                            end
                        });
                        Toast.success('Sleep session added');

                        // Optimistic Update: Add to local state immediately
                        if (!DeviceState.state.sleepHistory) DeviceState.state.sleepHistory = [];
                        DeviceState.state.sleepHistory.unshift({ start, end });
                        // Sort by start time descending to be safe
                        DeviceState.state.sleepHistory.sort((a, b) => b.start - a.start);
                    }

                    // Update UI immediately
                    updateSleepUI(DeviceState.state);

                    // Sync to Firestore immediately
                    const user = Auth.getUser();
                    if (user) {
                        DeviceService.updateDevice(user.uid, DeviceState.deviceId, {
                            sleepHistory: DeviceState.state.sleepHistory
                        }).then(() => console.log('[Device] Sleep history synced to Firebase'))
                            .catch(e => {
                                console.warn('[Device] Sleep history sync failed:', e);
                                Toast.warning('Sleep data sync failed - changes may not persist');
                            });
                    }

                    return true; // Close modal
                }
            }
        ]
    });

    // Function to update duration preview
    const updateDurationPreview = () => {
        const previewEl = modal.querySelector('#sleepLogDurationPreview');
        if (!previewEl) return;

        // Calculate duration based on current selections
        let durationHours = wakeHour - bedtimeHour;
        let durationMins = wakeMin - bedtimeMin;

        // Handle overnight sleep (wake time < bedtime)
        if (durationHours < 0 || (durationHours === 0 && durationMins < 0)) {
            durationHours += 24;
        }

        if (durationMins < 0) {
            durationHours -= 1;
            durationMins += 60;
        }

        const totalMinutes = durationHours * 60 + durationMins;
        if (totalMinutes <= 0 || totalMinutes > 24 * 60) {
            previewEl.textContent = '--';
        } else {
            previewEl.textContent = `${durationHours}h ${durationMins}m`;
        }
    };

    // Setup time picker scrolls
    const itemHeight = 44;

    const setupPicker = (pickerId, values, defaultValue, onUpdate) => {
        const scroll = modal.querySelector(`[data-picker="${pickerId}"]`);
        if (!scroll) return;

        // Find initial index
        let currentIndex = values.indexOf(defaultValue);
        if (currentIndex === -1) {
            // Find closest value
            currentIndex = values.reduce((closest, val, idx) =>
                Math.abs(val - defaultValue) < Math.abs(values[closest] - defaultValue) ? idx : closest
                , 0);
        }

        // Scroll to initial position
        setTimeout(() => {
            scroll.scrollTop = currentIndex * itemHeight;
        }, 100);

        // Track selection
        const updateSelection = () => {
            const newIndex = Math.round(scroll.scrollTop / itemHeight);
            if (newIndex >= 0 && newIndex < values.length && newIndex !== currentIndex) {
                currentIndex = newIndex;
                onUpdate(values[currentIndex]);
                updateDurationPreview();

                // Update visual selection
                scroll.querySelectorAll('.picker-item').forEach((item, i) => {
                    item.classList.toggle('selected', i === currentIndex);
                });
            }
        };

        scroll.addEventListener('scroll', updateSelection);

        // Snap to nearest on scroll end
        let scrollTimeout;
        scroll.addEventListener('scroll', () => {
            clearTimeout(scrollTimeout);
            scrollTimeout = setTimeout(() => {
                scroll.scrollTo({ top: currentIndex * itemHeight, behavior: 'smooth' });
            }, 100);
        });
    };

    // Setup all pickers
    const hours = Array.from({ length: 24 }, (_, i) => i);
    const minutes = Array.from({ length: 12 }, (_, i) => i * 5);

    setupPicker('bedtime-hour', hours, defaultBedtimeHour, (v) => { bedtimeHour = v; });
    setupPicker('bedtime-min', minutes, Math.floor(defaultBedtimeMin / 5) * 5, (v) => { bedtimeMin = v; });
    setupPicker('wake-hour', hours, defaultWakeHour, (v) => { wakeHour = v; });
    setupPicker('wake-min', minutes, Math.floor(defaultWakeMin / 5) * 5, (v) => { wakeMin = v; });

    // Setup date input
    const dateInput = modal.querySelector('#sleepLogDate');
    if (dateInput) {
        dateInput.addEventListener('change', (e) => {
            selectedDate = e.target.value;
        });
    }

    // Initial duration update
    setTimeout(updateDurationPreview, 200);
}

/**
 * Delete a sleep log entry with confirmation
 * @param {number} index - Index of session to delete
 */
function deleteSleepLog(index) {
    const history = DeviceState.state?.sleepHistory || [];
    const session = history[index];

    if (!session) {
        Toast.error('Session not found');
        return;
    }

    const date = new Date(session.start * 1000);
    const duration = session.end - session.start;
    const hours = Math.floor(duration / 3600);
    const mins = Math.floor((duration % 3600) / 60);

    Modal.confirm(
        '🗑️ Delete Sleep Session',
        `Are you sure you want to delete this sleep session?\n\n` +
        `📅 ${date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}\n` +
        `⏱️ Duration: ${hours}h ${mins}m\n\n` +
        `This action cannot be undone.`,
        () => {
            // Send delete command to device
            MQTTClient.publishControl(DeviceState.deviceId, {
                command: 'deleteSleepSession',
                start: session.start
            });
            Toast.success('Sleep session deleted');

            // Optimistic Update: Remove from local state immediately
            if (DeviceState.state.sleepHistory) {
                DeviceState.state.sleepHistory.splice(index, 1);
                updateSleepUI(DeviceState.state);

                // Sync to Firestore immediately
                const user = Auth.getUser();
                if (user) {
                    DeviceService.updateDevice(user.uid, DeviceState.deviceId, {
                        sleepHistory: DeviceState.state.sleepHistory
                    }).then(() => console.log('[Device] Sleep history deletion synced to Firebase'))
                        .catch(e => {
                            console.warn('[Device] Sleep history deletion sync failed:', e);
                            Toast.warning('Sleep data sync failed - changes may not persist');
                        });
                }
            }
        }
    );
}


// Debounce helper for Firestore sync
let syncTimeout;
function syncStateToFirestore(state) {
    const user = Auth.getUser();
    if (!user || !DeviceState.deviceId) return;

    clearTimeout(syncTimeout);
    syncTimeout = setTimeout(async () => {
        try {
            // Remove ephemeral internal flags before saving
            const stateToSave = { ...state };
            delete stateToSave._online;
            delete stateToSave._lastUpdate;
            delete stateToSave._lastAvailability;

            await DeviceService.updateDevice(user.uid, DeviceState.deviceId, stateToSave);
            console.log('[Device] Synced state to Firestore');
        } catch (e) {
            console.warn('[Device] Failed to sync state:', e);
        }
    }, 2000); // 2 second debounce
}

// ============================================
// Initialize on DOM Ready
// ============================================
document.addEventListener('DOMContentLoaded', init);

// Export for testing
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { DeviceState, init, updateUI };
}
