/**
 * Zaylo - Device Control Page Logic
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
    initialLoadComplete: false,
    // Anchor values for smooth timer countdown (stored in DeviceState for persistence)
    timerAnchorValue: 0,        // The timer value at anchor time (seconds)
    timerAnchorTime: 0,         // When the anchor was set (Date.now())
    lastDisplayedSecond: -1,    // Last displayed second to prevent redundant updates (-1 = unset)
    currentTimerType: null      // 'motion' or 'manual' - track which timer is active
};

// ============================================
// Initialize
// ============================================
async function init() {
    // Get device ID from URL
    const params = Utils.getQueryParams();
    // CRITICAL: Always normalize to uppercase to match firmware behavior
    DeviceState.deviceId = params.id ? params.id.trim().toUpperCase() : null;



    if (!DeviceState.deviceId) {
        Toast.error('No device ID specified');
        setTimeout(() => window.location.href = 'index.html', 2000);
        return;
    }

    // Update title and settings device name
    const device = DeviceList.get(DeviceState.deviceId);
    const deviceName = device?.name || `Zaylo-${DeviceState.deviceId}`;

    document.getElementById('deviceTitle').textContent = deviceName;
    const deviceNameVal = document.getElementById('deviceNameValue');
    if (deviceNameVal) deviceNameVal.textContent = deviceName;

    // Initialize theme
    Theme.init();

    // IMMEDIATE RENDER: Try to load cached state from DeviceList
    const cachedDevice = DeviceList.get(DeviceState.deviceId);
    if (cachedDevice && cachedDevice.state) {
        if (window.DEBUG) console.debug('[Device] ⚡ Found cached state, rendering immediately:', cachedDevice.state);
        DeviceState.state = cachedDevice.state;
        DeviceState.initialLoadComplete = true; // Mark as ready so updateUI works
        updateUI(DeviceState.state);
        hideInitialLoader();
    } else {
        if (window.DEBUG) console.debug('[Device] No cached state found, UI will update when MQTT connects');
    }

    // Setup event listeners
    setupTabNavigation();
    setupControlHandlers();
    setupSettingHandlers();
    setupSleepHandlers();

    // Resolve active home BEFORE any Firebase operations
    try {
        if (typeof HomeService !== 'undefined' && Auth.getUser()) {
            await HomeService.init();
            const homeId = await HomeService.getActiveHome(Auth.getUser().uid);
            DeviceList.setHome(homeId);
        }
    } catch (e) {
        console.error('[Device] HomeService init failed:', e);
    }

    // Connect to MQTT (non-blocking)
    await connectMQTT();

    // NEW: Subscribe to Firebase Metadata Updates (Name changes, etc)
    if (Auth.getUser() && window.DeviceService && typeof DeviceService.subscribeToDevice === 'function') {
        try {
            await DeviceService.init();
            const homeId = window.activeHomeId;
            if (!homeId) { console.warn('[Device] No activeHomeId, skipping Firebase subscription'); return; }
            DeviceService.subscribeToDevice(homeId, DeviceState.deviceId, (deviceData) => {
                if (deviceData) {
                    if (window.DEBUG) console.debug('[Device] Real-time metadata update from Firebase:', deviceData);
                    // Update header title if name changed
                    if (deviceData.name) {
                        const titleEl = document.getElementById('deviceTitle');
                        if (titleEl && titleEl.textContent !== deviceData.name) {
                            titleEl.textContent = deviceData.name;
                        }

                        // Also update settings value if visible
                        const settingsVal = document.getElementById('deviceNameValue');
                        if (settingsVal) {
                            settingsVal.textContent = deviceData.name;
                        }

                        // Update local storage so cache is fresh
                        DeviceList.update(DeviceState.deviceId, { name: deviceData.name });

                        // Update state name for consistency
                        if (DeviceState.state) {
                            DeviceState.state.name = deviceData.name;
                        }
                    }
                } else {
                    console.warn('[Device] Device deleted from Firebase while viewing!');
                    Toast.error('Device removed');
                }
            });
        } catch (e) {
            console.error('[Device] Failed to setup Firebase subscription:', e);
        }
    }

    // Check for initial tab param
    if (params.tab) {
        switchTab(params.tab);
    }

    // Safety timeout: Remove loader after 10s even if nothing loads
    setTimeout(() => {
        hideInitialLoader();
    }, 4000);
}

// Helper to update ambient background based on this device's state
function updateAmbientBackground(isOn) {
    const app = document.querySelector('.app');
    if (app) {
        app.classList.toggle('has-active-devices', isOn);
    }
}

/**
 * Helper to remove the initial full-screen loader
 */
function hideInitialLoader() {
    const loader = document.getElementById('initialLoader');
    if (loader) {
        // Prevent multiple removals
        if (loader.dataset.removing === 'true') return;
        loader.dataset.removing = 'true';

        loader.style.opacity = '0';
        setTimeout(() => {
            if (loader.parentNode) {
                loader.parentNode.removeChild(loader);
            }
        }, 500);
    }
}

// ============================================
// MQTT Connection
// ============================================
let mqttInitialized = false; // Guard against duplicate initialization

async function connectMQTT() {
    // Prevent duplicate initialization
    if (mqttInitialized) {
        if (window.DEBUG) console.debug('[Device] MQTT already initialized, skipping');
        return;
    }
    mqttInitialized = true;

    try {
        // CRITICAL: Clear any existing callbacks to prevent accumulation
        MQTTClient.clearCallbacks();

        // Reset reconnect state for fresh page load
        MQTTClient.reconnectAttempts = 0;
        MQTTClient.reconnectDelay = 1000;

        // PWA SUPPORT: Initialize visibility change handler for reconnection on app resume
        MQTTClient.initVisibilityHandler();

        MQTTClient.on('onConnect', () => {
            if (window.DEBUG) console.debug('[Device] MQTT Connected');
            if (window.DEBUG) console.debug(`[Device] 🔗 Subscribing to device: ${DeviceState.deviceId}`);
            DeviceState.connected = true;
            MQTTClient.subscribeDevice(DeviceState.deviceId);

            // Hide offline overlay if it was shown
            hideOfflineOverlay();

            // Ensure we can render if we haven't already
            DeviceState.initialLoadComplete = true;

            // Update status badge only - show online status even before full state is received
            updateStatusBadge(true, false);

            // CRITICAL: Request current device state after subscribing
            // This ensures we get the current mode/light state even if device hasn't published recently
            setTimeout(() => {
                if (window.DEBUG) console.debug('[Device] 📡 Requesting current device state...');
                MQTTClient.publishControl(DeviceState.deviceId, { command: 'getState' });

                // TIMEZONE FIX: Sync browser's current timezone to device on every connect.
                // This ensures the device always has the correct local time, even after DST changes.
                // Without this, the device would keep stale timezone offsets from EEPROM until
                // someone manually changed a config setting on the blinds page.
                MQTTClient.syncTimezoneToDevice(DeviceState.deviceId);

                // Retrying logic: If we don't have config after 2.5s, ask again
                // This handles cases where the device was just rebooting or network was glitchy
                setTimeout(() => {
                    const hasConfig = DeviceState.state &&
                        DeviceState.state.config &&
                        Object.keys(DeviceState.state.config).length > 0;

                    if (!hasConfig) {
                        console.warn('[Device] 📡 Config still empty after 2.5s, retrying getState...');
                        MQTTClient.publishControl(DeviceState.deviceId, { command: 'getState' });
                    }
                    
                    // Offline check after retrying
                    setTimeout(() => {
                        const state = MQTTClient.getDeviceState(DeviceState.deviceId);
                        if (!state || state._online === undefined) {
                            console.log(`[Device] Device timeout: ${DeviceState.deviceId}. Marking as Offline.`);
                            const offlineState = state ? { ...state, _online: false } : { _online: false };
                            MQTTClient.deviceStates.set(DeviceState.deviceId, offlineState);
                            if (typeof StateStore !== 'undefined') StateStore.update(DeviceState.deviceId, offlineState);
                            updateStatusBadge(false, false);
                        }
                    }, 2000);
                }, 2500);

            }, 500); // Small delay to ensure subscription is complete
        });

        MQTTClient.on('onDisconnect', () => {
            if (window.DEBUG) console.debug('[Device] MQTT Disconnected');
            DeviceState.connected = false;
            updateStatusBadge(false);
            showOfflineOverlay();
        });

        // Use Centralized StateStore instead of raw MQTT callbacks
        StateStore.subscribe(DeviceState.deviceId, (state) => {
            if (!state) return;

            // Preserve legacy DeviceState.state reference for existing UI components that read from it
            DeviceState.state = state;

            // Handle initial load completion
            if (!DeviceState.initialLoadComplete) {
                DeviceState.initialLoadComplete = true;
            }

            // Always hide loader when we get state
            hideInitialLoader();

            // Pass incoming mode to updateUI for accurate race condition detection
            updateUI(DeviceState.state, state.mode);

            // PERSIST: Save critical state to DeviceList (Local Storage) for immediate load next time
            const stateToCache = {
                light: state.light,
                mode: state.mode,
                _online: state._online,
                isSleeping: state.isSleeping,
                config: state.config
            };
            DeviceList.update(DeviceState.deviceId, { state: stateToCache });

            // SMART MERGE & FIREBASE SYNC:
            // The firmware sends sleepHistory (last 7 sessions only, with {s, e} keys)
            // We need to merge this with the full history in Firebase and auto-save if there's a new session.
            if (state.sleepHistory || state.isSleeping !== undefined) {
                const normalizedMqttHistory = normalizeSleepHistory(state.sleepHistory);
                
                // Get current Firebase history (if we loaded it)
                const currentStoredState = StateStore.get(DeviceState.deviceId) || {};
                const currentHistory = currentStoredState.sleepHistory || [];
                
                // Track if we had a persistent state change
                let needsFirebaseSync = false;
                const updates = {};

                // Only merge if we actually have a newer session from MQTT
                if (normalizedMqttHistory.length > 0) {
                    const mergedHistory = mergeSleepHistory(currentHistory, normalizedMqttHistory);
                    
                    // Simple and robust deep equality check to avoid infinite loops
                    if (JSON.stringify(mergedHistory) !== JSON.stringify(currentHistory)) {
                        updates.sleepHistory = mergedHistory;
                        needsFirebaseSync = true;
                        // Update local store so we don't sync again immediately
                        StateStore.update(DeviceState.deviceId, { sleepHistory: mergedHistory });
                        // Also update legacy reference
                        DeviceState.state.sleepHistory = mergedHistory;
                        console.log('[Device] New/updated sleep session detected from device. Merged history.');
                    }
                }

                // If device physically entered or exited sleep mode, we should save that status
                // But only if it differs from what we think Firebase knows.
                if (state.isSleeping !== undefined && state.isSleeping !== currentStoredState._lastSyncedIsSleeping) {
                    updates.isSleeping = state.isSleeping;
                    updates.sleepStart = state.sleepStart || null;
                    needsFirebaseSync = true;
                    // Mark so we don't save repeatedly
                    StateStore.update(DeviceState.deviceId, { _lastSyncedIsSleeping: state.isSleeping });
                    console.log(`[Device] Device physical sleep state changed to ${state.isSleeping}`);
                }

                if (needsFirebaseSync && Auth.getUser() && window.activeHomeId) {
                    DeviceService.updateDevice(window.activeHomeId, DeviceState.deviceId, updates)
                        .then(() => console.log('[Device] Auto-synced updated sleep data to Firebase'))
                        .catch(e => console.warn('[Device] Failed to auto-sync sleep data:', e));
                }
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
        // IMPROVEMENT: Race with a timeout so we don't block forever if network is slow
        const timeoutPromise = new Promise(resolve => setTimeout(resolve, 3000));
        await Promise.race([mqttPromise, timeoutPromise]);

        // If we timed out or connected, we should show the UI
        if (!DeviceState.initialLoadComplete) {
            if (window.DEBUG) console.debug('[Device] MQTT race finished (connected or timed out). forcing UI');
            hideInitialLoader();
        }

    } catch (error) {
        console.error('[Device] MQTT connection failed:', error);
        Toast.error('Failed to connect to device');
        hideInitialLoader(); // Ensure loader is hidden on error
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

        if (window.DEBUG) console.debug('[Device] Loading persisted state from Firebase...');
        const persistedDevice = await DeviceService.getDevice(window.activeHomeId, DeviceState.deviceId);

        if (!persistedDevice) {
            if (window.DEBUG) console.debug('[Device] No persisted state found in Firebase');
            return;
        }

        if (window.DEBUG) console.debug('[Device] Loaded persisted state from Firebase');

        // Normalize sleep history data
        const normalizedSleepHistory = normalizeSleepHistory(persistedDevice.sleepHistory);

        // FAILSAFE: Re-fetch the VERY LATEST state right before updating
        // This prevents race condition where MQTT update arrived while we were processing
        const latestState = DeviceState.state || {};

        // Merge config: Deep merge so we keep both recent MQTT updates and persisted Firebase fields
        const mergedConfig = {
            ...(persistedDevice.config || {}),
            ...(latestState.config || {})
        };

        // Use Firebase sleep history if larger/better
        const mqttHistory = normalizeSleepHistory(latestState.sleepHistory);
        const finalHistory = mergeSleepHistory(normalizedSleepHistory, mqttHistory);

        // Push Firebase data into StateStore instead of DeviceState
        StateStore.update(DeviceState.deviceId, {
            config: mergedConfig,
            sleepHistory: finalHistory,
            isSleeping: latestState.isSleeping ?? persistedDevice.isSleeping ?? false,
            sleepStart: latestState.sleepStart ?? persistedDevice.sleepStart ?? null,
            _lastSyncedIsSleeping: persistedDevice.isSleeping ?? false // Track what Firebase has
        });

        // Hide loader since we have data (even if MQTT isn't ready yet)
        hideInitialLoader();

        // Save normalized data back to Firebase if needed
        const hadOldFormat = persistedDevice.sleepHistory?.some(e => e.s !== undefined || e.e !== undefined);
        const isMergedLarger = finalHistory.length > normalizedSleepHistory.length;
        if (hadOldFormat || isMergedLarger) {
            DeviceService.updateDevice(window.activeHomeId, DeviceState.deviceId, {
                sleepHistory: finalHistory
            }).catch(e => console.warn('[Device] Failed to save normalized/merged data:', e));
        }

    } catch (e) {
        console.error('[Device] Error loading Firebase data:', e);
    }
}

/**
 * Helper to normalize sleep history entries to {start, end} format
 * Handles both old format {s, e} and new format {start, end}
 */
function normalizeSleepHistory(history) {
    if (!history || !Array.isArray(history)) return [];
    return history.map(entry => {
        if (!entry) return null;
        // Handle {s, e} format from firmware/MQTT
        if (entry.s !== undefined) {
            return { start: entry.s, end: entry.e };
        }
        // Handle {start, end} format
        if (entry.start !== undefined) {
            return { start: entry.start, end: entry.end };
        }
    }).filter(e => e && e.start); // Keep active sessions (end may be null/0)
}

/**
 * Merge two sleep history arrays, deduplicating by start time and sorting newest first.
 * @param {Array} historyA - First history array (e.g. from Firebase)
 * @param {Array} historyB - Second history array (e.g. from MQTT)
 * @returns {Array} Merged and sorted history array
 */
function mergeSleepHistory(historyA, historyB) {
    const combined = [...(historyA || []), ...(historyB || [])];
    if (combined.length === 0) return [];

    // Deduplicate by start time using a Map
    const uniqueMap = new Map();
    combined.forEach(session => {
        if (session && session.start) {
            // Keep the one with an end time if available, otherwise just keep it
            if (!uniqueMap.has(session.start) || session.end) {
                uniqueMap.set(session.start, session);
            }
        }
    });

    // Convert back to array and sort descending by start time
    const merged = Array.from(uniqueMap.values());
    merged.sort((a, b) => b.start - a.start);
    
    return merged;
}

// ============================================
// UI Updates
// ============================================
function updateUI(state, incomingMode = undefined) {
    if (!state) return;
    if (!DeviceState.initialLoadComplete) return;

    // Status badge
    updateStatusBadge(state._online, state.isSleeping);

    // WiFi indicator
    updateWifiIndicator(state);

    const light = state.light || false;

    // Power toggle
    const powerBtn = document.getElementById('powerBtn');
    const powerLabel = document.getElementById('powerLabel');
    const switchInner = document.querySelector('.switch-inner');

    if (powerBtn) {
        powerBtn.classList.toggle('active', light);
    }
    if (powerLabel) {
        powerLabel.textContent = light ? 'ON' : 'OFF';
        powerLabel.classList.toggle('active', light);
    }
    if (switchInner) {
        if (light) {
            switchInner.classList.add('glowing');
        } else {
            switchInner.classList.remove('glowing');
        }
    }

    updateAmbientBackground(light);

    // Device Name Setting Removed (Moved to Index Context Menu)

    // Mode buttons - skip update if user recently changed mode (prevents race condition)
    // Also skip if mode is undefined (not yet received from device)
    // Pass incomingMode (before merge) to detect race conditions accurately
    const shouldSkipModeUpdate = shouldIgnoreModeUpdate(incomingMode);

    // CRITICAL: Parse mode as integer - firmware might send as string "0" instead of number 0
    const rawMode = state.mode;
    let deviceMode = (rawMode !== undefined && rawMode !== null) ? parseInt(rawMode, 10) : null;
    const modeValid = deviceMode !== null && !isNaN(deviceMode);

    // IMPORTANT: Mode 2 (ALARM) is NOT a user mode - it's just a display indicator
    // When device reports mode 2, display it as AUTO (mode 0) since ALARM should not be used
    // This is a legacy/transition handling until firmware is updated
    let displayMode = deviceMode;
    if (deviceMode === 2) {
        if (window.DEBUG) console.debug('[Device] Mode 2 (ALARM) received - mapping to AUTO (0) for display');
        displayMode = 0; // Treat ALARM as AUTO for button display
    }



    if (!shouldSkipModeUpdate && modeValid) {
        const modeButtons = document.querySelectorAll('[data-mode]');
        if (window.DEBUG) console.debug(`[Device] Updating ${modeButtons.length} mode buttons to reflect displayMode=${displayMode}`);

        let activeFound = false;
        modeButtons.forEach(btn => {
            const btnMode = parseInt(btn.dataset.mode, 10);
            const isActive = btnMode === displayMode;
            btn.classList.toggle('active', isActive);
            if (isActive) {
                activeFound = true;
                if (window.DEBUG) console.debug(`[Device] ✓ Mode button ${btnMode} set to ACTIVE`);
            }
        });

        if (!activeFound) {

        }
    } else if (!modeValid) {

    }

    // Timer - sync with server
    syncTimerWithServer(state);

    // Presence indicators
    updatePresenceIndicators(state);
    updateStatsBar(state);

    updateSleepUI(state);

    // Device info
    updateDeviceInfo(state);

    // Sync Config UI (Settings) - CRITICAL FIX
    // This was missing, causing settings to be blank
    if (state.config) {
        syncConfigUI(state.config);
    }

    // Update Day Idle mode sunrise/sunset times
    updateDayIdleTimes(state);

}

function updateStatusBadge(online, sleeping = false) {
    const badge = document.getElementById('statusBadge');
    const dot = badge?.querySelector('.status-dot');
    const text = document.getElementById('statusText');

    if (!badge) return;

    // Handle 4 states: online, offline, sleeping, connecting
    // 'online' can be: true (online), false (offline), undefined/null (connecting)
    const isConnecting = online === undefined || online === null;
    const isOnline = online === true;

    badge.classList.remove('online', 'offline', 'sleeping', 'connecting');
    if (dot) dot.classList.remove('online', 'offline', 'sleeping', 'connecting');

    if (sleeping) {
        badge.classList.add('sleeping');
        if (dot) dot.classList.add('sleeping');
        if (text) text.textContent = 'In Sleep';
    } else if (isOnline) {
        badge.classList.add('online');
        if (dot) dot.classList.add('online');
        if (text) text.textContent = 'Online';
    } else if (isConnecting) {
        badge.classList.add('connecting');
        if (dot) dot.classList.add('connecting');
        if (text) text.textContent = 'Connecting...';
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

    // Get mode directly - firmware always sends numeric mode, but parse safely just in case
    // CRITICAL FIX: Use parseInt to ensure we handle string "1" correctly
    const rawMode = state.mode;
    const mode = (rawMode !== undefined && rawMode !== null) ? parseInt(rawMode, 10) : -1;

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
    // CRITICAL: Only auto mode timers pause on motion!
    // Manual timers should NEVER pause on motion
    const isMotionActive = hasMotion || hasPresence;

    // Get total timer duration from config for progress bar
    const motionTimeout = state.config?.motionTimeout || 120;
    const manualTimeout = state.config?.manualTimeout || 60;

    // Debug logging - ALWAYS log to trace timer issues


    let timerSeconds = 0;
    let timerTotal = 0;
    let timerTitle = '';
    let isPaused = false;
    let timerType = 'none'; // 'motion', 'manual', 'fallback'

    // LOGIC MATRIX:
    // 1. If Manual Timer is active (>0) AND Mode says Manual (1) -> SHOW MANUAL
    // 2. If Motion Timer is active (>0) AND Mode says Auto (0) or Alarm (2) -> SHOW MOTION
    // 3. AMBIGUOUS CASE: Mode is undefined/-1 but we have timers?
    //    - If Manual Timer > 0 -> Show Manual (safer assumption if light is on)
    //    - Else if Motion Timer > 0 -> Show Motion

    // CHECK 1: Explicit Manual Mode
    if (mode === 1 && manualTimer > 0) {
        timerSeconds = manualTimer;
        timerTotal = manualTimeout;
        isPaused = false; // Manual timer NEVER pauses on motion
        timerTitle = 'Manual Timer';
        timerType = 'manual';
    }
    // CHECK 2: Explicit Auto/Alarm Mode
    else if ((mode === 0 || mode === 2) && light && motionTimer > 0) {
        timerSeconds = motionTimer;
        timerTotal = motionTimeout;
        isPaused = isMotionActive;
        timerTitle = isPaused ? '✅ Motion Detected' : 'Auto-off Timer';
        timerType = 'motion';
    }
    // CHECK 3: Fallback / Ambiguous Mode - PRIORITIZE MANUAL if values exist
    // This fixes the jumping: if we have a manual timer value, we show it, rather than falling back to motion
    else if (manualTimer > 0 && light) {
        // If we have a manual timer value, use it (even if mode is weird)
        timerSeconds = manualTimer;
        timerTotal = manualTimeout;
        isPaused = false;
        timerTitle = 'Manual Timer';
        timerType = 'manual-fallback'; // Debug label
        if (window.DEBUG) console.log(`[Timer] ⚠️ Ambiguous mode (${mode}) but found manualTimer=${manualTimer}. Defaulting to MANUAL.`);
    }
    else if (motionTimer > 0 && light) {
        // Only if NO manual timer value exists do we show motion timer
        timerSeconds = motionTimer;
        timerTotal = motionTimeout;
        isPaused = isMotionActive;
        timerTitle = 'Auto-off Timer';
        timerType = 'motion-fallback';
    }

    // Show or hide timer card based on values
    if (timerSeconds > 0) {
        showTimerCard(timerSeconds, timerTotal, timerTitle, isPaused, timerType);
    } else {
        hideTimerCard();
    }
}

/**
 * Show the timer card with animation and start countdown
 * IMPROVED: Uses global anchors and only restarts interval when necessary
 * @param {number} seconds - Current remaining seconds from server
 * @param {number} total - Total timer duration for progress bar
 * @param {string} title - Timer title to display
 * @param {boolean} isPaused - Whether timer is paused (motion detected)
 * @param {string} timerType - 'motion' or 'manual' to detect type switches
 */
function showTimerCard(seconds, total, title, isPaused, timerType = 'unknown') {
    const timerCard = document.getElementById('timerCard');
    const timerTitleEl = document.getElementById('timerTitle');
    const timerCountdown = document.getElementById('timerCountdown');
    const timerProgressBar = document.getElementById('timerProgressBar');

    if (!timerCard) {
        // Silently return if timer card isn't in this UI layout
        return;
    }

    // Update stored values
    DeviceState.timerTotalSeconds = total;
    DeviceState.timerPaused = isPaused;

    // Check if we're switching timer types (motion <-> manual)
    const isTimerTypeChange = DeviceState.currentTimerType !== null &&
        DeviceState.currentTimerType !== timerType &&
        timerType !== 'unknown';

    if (isTimerTypeChange) {
        if (window.DEBUG) console.log(`[Timer] ⚡ Timer type changed: ${DeviceState.currentTimerType} → ${timerType}. Forcing anchor reset.`);
    }
    DeviceState.currentTimerType = timerType;

    // SMART SYNC: Calculate what we EXPECT the timer to be based on our anchor
    // Only resync if server value differs significantly (indicating we drifted or missed updates)
    const now = Date.now();
    let expectedSeconds = 0;

    if (DeviceState.timerActive && DeviceState.timerAnchorTime > 0 && !isTimerTypeChange) {
        // Calculate expected remaining time based on anchor
        const elapsedSinceAnchor = (now - DeviceState.timerAnchorTime) / 1000;
        expectedSeconds = Math.max(0, DeviceState.timerAnchorValue - elapsedSinceAnchor);
    }

    // Calculate drift between our predicted value and server value
    // Allow a larger drift threshold (2s) because network latency can vary
    const serverDrift = Math.abs(expectedSeconds - seconds);
    const needsResync = !DeviceState.timerActive || isTimerTypeChange || serverDrift > 2.5;

    if (needsResync) {
        if (window.DEBUG) console.log(`[Timer] 🔄 Resyncing anchor: serverValue=${seconds}s, expected=${expectedSeconds.toFixed(1)}s, drift=${serverDrift.toFixed(1)}s, typeChange=${isTimerTypeChange}`);

        // Set new anchor point
        DeviceState.timerAnchorValue = seconds;
        DeviceState.timerAnchorTime = now;
        DeviceState.clientTimerSeconds = seconds;
        DeviceState.lastServerTimerSync = now;
        DeviceState.lastDisplayedSecond = -1; // Reset to force display update
    } else {
        // Just log that we received an update but didn't resync (smooth operation)
        if (window.DEBUG) console.log(`[Timer] ✓ Server sync OK (drift: ${serverDrift.toFixed(2)}s). Keeping local countdown.`);
    }

    // Update title
    if (timerTitleEl) timerTitleEl.textContent = title;

    // Update countdown display with the current calculated value
    if (timerCountdown) {
        const displaySeconds = needsResync ? seconds : Math.floor(expectedSeconds);
        timerCountdown.textContent = Utils.formatTime(displaySeconds);
    }

    // Update progress bar
    if (timerProgressBar && total > 0) {
        const displaySeconds = needsResync ? seconds : expectedSeconds;
        const progress = (displaySeconds / total) * 100;
        timerProgressBar.style.width = `${Math.min(100, Math.max(0, progress))}%`;
    }

    // Show card with entrance animation if not already visible
    const isCurrentlyHidden = timerCard.style.display === 'none' ||
        timerCard.style.display === '' ||
        window.getComputedStyle(timerCard).display === 'none';

    if (!DeviceState.timerActive || isCurrentlyHidden) {
        if (window.DEBUG) console.log(`[Timer] Making timer card visible (timerActive=${DeviceState.timerActive}, isHidden=${isCurrentlyHidden})`);

        timerCard.style.display = 'block';
        timerCard.style.opacity = '0';
        timerCard.style.transform = 'translateY(-10px)';

        // Force reflow then animate
        void timerCard.offsetWidth;
        timerCard.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
        timerCard.style.opacity = '1';
        timerCard.style.transform = 'translateY(0)';

        DeviceState.timerActive = true;
        if (window.DEBUG) console.log('[Timer] ✅ Timer card now visible');

        // Start countdown interval ONLY when first showing the card
        startCountdownInterval();
    }
    // If timer is already active and visible, the interval keeps running
    // and will use the updated anchor values automatically
}

/**
 * Start the countdown interval for smooth timer updates
 * IMPROVED: Reads anchor values from DeviceState for dynamic updates
 * Uses anchor-based timing to prevent double-counting of elapsed time
 */
function startCountdownInterval() {
    // Clear any existing interval to prevent duplicates
    if (DeviceState.timerInterval) {
        clearInterval(DeviceState.timerInterval);
        DeviceState.timerInterval = null;
    }

    if (window.DEBUG) console.log('[Timer] Starting countdown interval using global anchors');

    DeviceState.timerInterval = setInterval(() => {
        // Safety check - stop if timer is no longer active
        if (!DeviceState.timerActive) {
            clearInterval(DeviceState.timerInterval);
            DeviceState.timerInterval = null;
            return;
        }

        const now = Date.now();

        // When paused, adjust anchor time to freeze the countdown
        // This keeps the anchor value the same but moves the anchor time forward
        if (DeviceState.timerPaused) {
            // Only adjust if we're actually counting (anchor is set)
            if (DeviceState.timerAnchorTime > 0) {
                // Move anchor time to now so elapsed time stays at 0
                DeviceState.timerAnchorTime = now;
            }
            return;
        }

        // Read anchor values from DeviceState (set by showTimerCard)
        const anchorValue = DeviceState.timerAnchorValue;
        const anchorTime = DeviceState.timerAnchorTime;

        // Safety check - ensure anchors are set
        if (anchorTime === 0 || anchorValue === 0) {
            return;
        }

        // Calculate elapsed time since anchor was set
        const elapsedMs = now - anchorTime;
        const elapsedSeconds = elapsedMs / 1000;

        // Calculate current remaining time from anchor
        const currentSeconds = Math.max(0, anchorValue - elapsedSeconds);
        const displaySecond = Math.floor(currentSeconds);

        // Update display only when the visible second changes
        if (displaySecond !== DeviceState.lastDisplayedSecond) {
            DeviceState.lastDisplayedSecond = displaySecond;
            // Update clientTimerSeconds for display purposes
            DeviceState.clientTimerSeconds = displaySecond;
            updateTimerDisplay();
        }

        // Timer expired
        if (currentSeconds <= 0) {
            if (window.DEBUG) console.log('[Timer] Timer expired - hiding card');
            hideTimerCard();
        }
    }, 250); // Run every 250ms for responsive second-boundary detection without excessive DOM writes
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

    // Reset state including anchor values
    DeviceState.timerActive = false;
    DeviceState.clientTimerSeconds = 0;
    DeviceState.timerAnchorValue = 0;
    DeviceState.timerAnchorTime = 0;
    DeviceState.lastDisplayedSecond = -1;
    DeviceState.currentTimerType = null;

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

// (Legacy smooth timer functions removed)

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

    // Update WiFi Name if available
    const currentWifi = document.getElementById('currentWifi');
    if (currentWifi) {
        if (state.ssid) {
            currentWifi.textContent = state.ssid;
        } else if (!state._online) {
            currentWifi.textContent = 'Disconnected';
        } else {
            // Keep default "Connected" or try to imply from RSSI
            // currentWifi.textContent = 'Connected'; 
        }
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
    // CRITICAL: Skip if config is empty - prevents showing defaults before device data arrives
    if (!config || typeof config !== 'object' || Object.keys(config).length === 0) {
        console.log('[Device] syncConfigUI: No config data yet, skipping to prevent showing defaults');
        return;
    }

    // Helper to show value or '--' if missing
    const showOrMissing = (val, suffix = '') => {
        if (val === undefined || val === null) return '--';
        return `${val}${suffix}`;
    };

    // Smart tab toggles - these use ?? because false is a valid value
    document.getElementById('alarmEnabled').checked = config.alarmEnabled ?? false;
    document.getElementById('dayIdleEnabled').checked = config.dayIdleEnabled ?? false;
    document.getElementById('motionEnabled').checked = config.motionEnabled ?? true;
    document.getElementById('twtEnabled').checked = config.twtEnabled ?? false;

    // Alarm time - show real values from device
    const alarmHour = config.alarmHour;
    const alarmMin = config.alarmMin;
    document.getElementById('alarmTime').textContent =
        (alarmHour !== undefined && alarmMin !== undefined)
            ? `${String(alarmHour).padStart(2, '0')}:${String(alarmMin).padStart(2, '0')}`
            : '--:--';

    // Display timeout - use same format as picker (REAL value from device)
    const displayTimeout = config.presenceDisplayTimeout;
    document.getElementById('displayTimeoutValue').textContent =
        (displayTimeout !== undefined && displayTimeout !== null)
            ? (displayTimeout === 0 ? 'Off' : Utils.formatSecondsAsDuration(displayTimeout))
            : '--';

    // Hold sensitivity (lights-on only) - separate from entry sensitivity
    // Default to 50 (firmware default) when not yet reported by device
    const holdSens = config.radarHoldSensitivity ?? 50;
    const holdDisplay = document.getElementById('radarHoldSensitivityValue');
    if (holdDisplay) {
        holdDisplay.textContent = holdSens === 50 ? '50% (default)' : `${holdSens}%`;
    }
    // Sync advanced slider if present
    const holdSlider = document.getElementById('holdSensSlider');
    const holdSliderVal = document.getElementById('holdSensSliderValue');
    if (holdSlider) {
        holdSlider.value = holdSens;
        if (holdSliderVal) holdSliderVal.textContent = `${holdSens}%`;
    }

    // Servo angles
    document.getElementById('angleOffValue').textContent = showOrMissing(config.angleOff, '°');
    document.getElementById('angleOnValue').textContent = showOrMissing(config.angleOn, '°');

    // Servo speed
    const servoSpeed = config.servoSpeed;
    if (servoSpeed !== undefined && servoSpeed !== null) {
        const speedLabels = { 0: 'Instant', 30: 'Quiet', 10: 'Slow' };
        document.getElementById('servoSpeedValue').textContent =
            speedLabels[servoSpeed] || `${servoSpeed}%`;
    } else {
        document.getElementById('servoSpeedValue').textContent = '--';
    }

    // Timers - REAL values from device
    document.getElementById('motionTimeoutValue').textContent = Utils.formatSecondsAsDuration(config.motionTimeout);
    document.getElementById('manualTimeoutValue').textContent = Utils.formatSecondsAsDuration(config.manualTimeout);

    // Sleep targets - REAL values from device
    document.getElementById('sleepTargetDurationValue').textContent =
        (config.sleepTargetDuration !== undefined)
            ? Utils.formatDuration(config.sleepTargetDuration)
            : '--';

    const bedtimeHour = config.sleepTargetBedtimeHour;
    const bedtimeMin = config.sleepTargetBedtimeMin;
    document.getElementById('sleepTargetBedtimeValue').textContent =
        (bedtimeHour !== undefined && bedtimeMin !== undefined)
            ? `${String(bedtimeHour).padStart(2, '0')}:${String(bedtimeMin).padStart(2, '0')}`
            : '--:--';

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

    // Get offsets from GLOBAL localStorage (these are now managed from the index page settings)
    const sunriseOffset = parseInt(localStorage.getItem('zaylo-SunriseOffset') || '0', 10);
    const sunsetOffset = parseInt(localStorage.getItem('zaylo-SunsetOffset') || '0', 10);

    // Helper to format time from various sources
    const formatTime = (value, offsetMinutes, isSunset) => {
        if (value === undefined || value === null || value === 0) {
            return { text: `--:--`, valid: false };
        }

        let effectiveTime = value;

        // Check if it's a Unix timestamp (large number, typically > 1000000)
        if (typeof value === 'number' && value > 100000) {
            // Apply offset (minutes -> seconds)
            // Sunrise: +offset, Sunset: -offset (per firmware logic)
            const offsetSeconds = offsetMinutes * 60;
            if (isSunset) {
                effectiveTime -= offsetSeconds;
            } else {
                effectiveTime += offsetSeconds;
            }

            const date = new Date(effectiveTime * 1000);
            const hours = date.getHours();
            const mins = date.getMinutes();
            return {
                text: `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`,
                valid: true
            };
        }

        // Minutes since midnight
        if (typeof value === 'number') {
            // Apply offset (minutes)
            if (isSunset) {
                effectiveTime -= offsetMinutes;
            } else {
                effectiveTime += offsetMinutes;
            }

            // Handle wrap-around (though unlikely for valid offsets)
            if (effectiveTime < 0) effectiveTime += 1440;
            if (effectiveTime >= 1440) effectiveTime -= 1440;

            const hours = Math.floor(effectiveTime / 60);
            const mins = effectiveTime % 60;
            return {
                text: `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`,
                valid: true
            };
        }

        return { text: `--:--`, valid: false };
    };

    // Priority order for sunrise:
    // 1. state.sunriseTime (Unix timestamp from firmware)
    // 2. state.config.sunriseMinute (minutes since midnight)
    let sunriseValue = state.sunriseTime;
    if ((sunriseValue === undefined || sunriseValue === null || sunriseValue === 0)
        && state.config?.sunriseMinute !== undefined) {
        sunriseValue = state.config.sunriseMinute;
    }
    const sr = formatTime(sunriseValue, sunriseOffset, false);
    sunriseEl.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-sun"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg> ${sr.text}`;

    // Priority order for sunset:
    let sunsetValue = state.sunsetTime;
    if ((sunsetValue === undefined || sunsetValue === null || sunsetValue === 0)
        && state.config?.sunsetMinute !== undefined) {
        sunsetValue = state.config.sunsetMinute;
    }
    const ss = formatTime(sunsetValue, sunsetOffset, true);
    sunsetEl.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-moon"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg> ${ss.text}`;
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
        actionBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-sun"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg> End Sleep';
        actionBtn.classList.remove('btn-primary');
        actionBtn.classList.add('btn-secondary');

        // Calculate current sleep duration
        if (sleepStart) {
            const now = Math.floor(Date.now() / 1000);
            const duration = now - sleepStart;
            updateSleepDisplay(duration, config);
        }
    } else {
        actionBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-moon"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg> Start Sleep';
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

    // Calculate 7-day average with NaN handling (1 hour minimum for consistency)
    if (history.length > 0) {
        const validSessions = history.filter(s => s && s.end && s.start &&
            !isNaN(s.end - s.start) && (s.end - s.start) >= 3600);
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

    // Update analytics cards (Sleep Debt, Trend, Pattern)
    updateSleepAnalyticsCards(history, config);

    // Update graph — FIX Issue #3B: pass the active session so the
    // "in progress" bar appears the instant Sleep Mode begins, instead
    // of staying invisible until the session ends and lands in history.
    const activeSession = (isSleeping && sleepStart)
        ? { start: sleepStart }
        : null;
    renderSleepGraph(history, activeSession);

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

    // Get valid sessions (1 hour minimum for consistency)
    const validSessions = history.filter(s => s && s.end && s.start &&
        !isNaN(s.end - s.start) && (s.end - s.start) >= 3600);
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

    // Filter valid sessions (1 hour minimum for consistency)
    const validSessions = history.filter(s => s && s.end && s.start &&
        !isNaN(s.end - s.start) && (s.end - s.start) >= 3600);
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

// Generate AI Overview with professional-grade personalized insights
// Uses ONLY accurately measurable data: start time, end time
function generateAIOverview(history, config, sleepScore, consistencyScore) {
    const feedbackEl = document.getElementById('aiFeedback');
    const tipsEl = document.getElementById('aiOverviewTips');

    if (!feedbackEl || !tipsEl) return;

    // === NO DATA CASES ===
    if (!history || history.length === 0) {
        feedbackEl.textContent = "Start tracking your sleep to receive personalized insights. Just tap 'Start Sleep' when you go to bed.";
        tipsEl.innerHTML = '';
        return;
    }

    const validSessions = history.filter(s => s && s.end && s.start && !isNaN(s.end - s.start) && (s.end - s.start) >= 3600);
    if (validSessions.length === 0) {
        feedbackEl.textContent = "No valid sleep sessions yet. Sessions under 1 hour are filtered as accidental.";
        tipsEl.innerHTML = '';
        return;
    }

    if (validSessions.length === 1) {
        const dur = (validSessions[0].end - validSessions[0].start) / 3600;
        feedbackEl.textContent = `Great first session of ${dur.toFixed(1)} hours recorded! Add more nights for pattern analysis.`;
        tipsEl.innerHTML = '';
        return;
    }

    // === CALCULATE ALL METRICS ===
    const targetMinutes = config.sleepTargetDuration || 480;
    const targetSeconds = targetMinutes * 60;
    const targetHours = targetMinutes / 60;

    // Duration metrics
    const totalDuration = validSessions.reduce((sum, s) => sum + (s.end - s.start), 0);
    const avgDuration = totalDuration / validSessions.length;
    const avgHours = avgDuration / 3600;

    // Sleep debt calculation (last 7 days)
    const now = Math.floor(Date.now() / 1000);
    const weekAgo = now - (7 * 24 * 3600);
    const recentSessions = validSessions.filter(s => s.start > weekAgo);
    const recentTotal = recentSessions.reduce((sum, s) => sum + (s.end - s.start), 0) / 3600;
    const expectedSleep = recentSessions.length * targetHours;
    const sleepDebt = Math.max(0, expectedSleep - recentTotal);

    // Streak calculation (consecutive nights meeting goal)
    let streak = 0;
    for (let i = 0; i < Math.min(validSessions.length, 7); i++) {
        const dur = (validSessions[i].end - validSessions[i].start) / 3600;
        if (dur >= targetHours * 0.85 && dur <= targetHours * 1.25) {
            streak++;
        } else {
            break;
        }
    }

    // Pattern type detection
    const patternType = detectPatternType(validSessions);

    // Social jet lag (weekday vs weekend bedtime variance)
    const socialJetLag = calculateSocialJetLag(validSessions);

    // Trend direction
    const trend = calculateTrendDirection(validSessions, targetHours);

    // Current time context
    const currentHour = new Date().getHours();
    const isEvening = currentHour >= 18 || currentHour < 4;
    const isMorning = currentHour >= 5 && currentHour < 12;

    // Last session info
    const lastSession = validSessions[0];
    const lastDur = (lastSession.end - lastSession.start) / 3600;
    const lastDiff = lastDur - targetHours;

    // === BUILD FEEDBACK MESSAGE ===
    let feedback = '';
    const tips = [];

    // Time-contextual greeting with score
    const greeting = isMorning ? 'Good morning!' : (isEvening ? 'Good evening!' : 'Hello!');

    if (sleepScore >= 85) {
        feedback = `${greeting} Your sleep is excellent with a score of ${sleepScore}.`;
        if (streak >= 3) {
            feedback += ` You're on a ${streak}-night streak!`;
        }
        tips.push({ icon: '🌟', text: 'Exceptional sleep patterns. Keep up the consistency!' });
    } else if (sleepScore >= 70) {
        feedback = `${greeting} Your sleep quality is strong at ${sleepScore}. Averaging ${avgHours.toFixed(1)}h per night.`;
        if (avgDuration < targetSeconds * 0.9) {
            tips.push({ icon: '⏰', text: `Try getting to bed 20-30 minutes earlier to hit your ${targetHours}h goal.` });
        }
    } else if (sleepScore >= 50) {
        feedback = `Your sleep score is ${sleepScore} - there's room to improve. You're averaging ${avgHours.toFixed(1)} hours.`;
        if (lastDiff < -1) {
            tips.push({ icon: '🛏️', text: `Last night was short at ${lastDur.toFixed(1)}h. Prioritize rest tonight.` });
        }
    } else {
        feedback = `Your sleep needs attention with a score of ${sleepScore}. Averaging only ${avgHours.toFixed(1)} hours.`;
        tips.push({ icon: '🚨', text: 'Significant sleep deficit detected. Recovery sleep is important.' });
    }

    // Social jet lag warning (if weekend vs weekday differs by > 1 hour)
    if (socialJetLag.detected && validSessions.length >= 5) {
        tips.push({
            icon: '🔀',
            text: `Weekend bedtimes differ by ${socialJetLag.difference.toFixed(1)}h - this affects your energy.`
        });
    }

    // Sleep debt tracking
    if (sleepDebt > 5) {
        tips.push({ icon: '📉', text: `You have ${sleepDebt.toFixed(0)}h of sleep debt. Catch up gradually.` });
    } else if (sleepDebt > 2 && tips.length < 2) {
        tips.push({ icon: '💤', text: `${sleepDebt.toFixed(1)}h of sleep debt this week. Extra rest helps.` });
    } else if (sleepDebt < 1 && sleepScore >= 70) {
        tips.push({ icon: '✅', text: 'No sleep debt - you\'re well-rested!' });
    }

    // Consistency feedback
    if (consistencyScore !== null && consistencyScore < 50) {
        tips.push({ icon: '📅', text: 'Irregular bedtimes affect your natural rhythm. Try fixing your wake time.' });
    } else if (consistencyScore >= 85 && tips.length < 3) {
        tips.push({ icon: '🎯', text: 'Excellent bedtime consistency!' });
    }

    // Trend direction
    if (trend === 1 && tips.length < 3) {
        tips.push({ icon: '📈', text: 'Your sleep duration is improving!' });
    } else if (trend === -1) {
        tips.push({ icon: '📉', text: 'Sleep duration has declined recently.' });
    }

    // Pattern-specific advice
    if (patternType === 'nightOwl' && tips.length < 3) {
        tips.push({ icon: '🦉', text: 'Night owl pattern detected. Shift bedtime 15min earlier each week.' });
    } else if (patternType === 'irregular' && tips.length < 3) {
        tips.push({ icon: '🔄', text: 'Irregular schedule may affect energy. Try anchoring your wake time.' });
    }

    // Evening actionable advice
    if (isEvening && tips.length < 3) {
        if (sleepDebt > 1 || lastDiff < -0.5) {
            const targetBedtime = calculateRecommendedBedtime(config);
            tips.push({ icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-moon"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>', text: `Aim for bed by ${targetBedtime} tonight.` });
        }
    }

    // Morning encouragement
    if (isMorning && tips.length < 2 && sleepScore >= 70) {
        tips.push({ icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-sun"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>', text: 'Morning sunlight reinforces your sleep-wake cycle.' });
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

// Helper: Detect sleep pattern type based on bedtimes
function detectPatternType(sessions) {
    if (sessions.length < 5) return 'regular';

    const bedtimes = sessions.slice(0, 7).map(s => {
        const d = new Date(s.start * 1000);
        let hour = d.getHours() + d.getMinutes() / 60;
        if (hour < 12) hour += 24; // Normalize post-midnight
        return hour;
    });

    const avgBedtime = bedtimes.reduce((a, b) => a + b, 0) / bedtimes.length;
    const variance = bedtimes.reduce((sum, bt) => sum + Math.pow(bt - avgBedtime, 2), 0) / bedtimes.length;
    const stdDev = Math.sqrt(variance);

    if (stdDev > 1.5) return 'irregular';
    if (avgBedtime >= 25) return 'nightOwl'; // Avg bedtime after 1am
    if (avgBedtime <= 22) return 'earlyBird';
    return 'regular';
}

// Helper: Calculate social jet lag (weekend vs weekday bedtime difference)
function calculateSocialJetLag(sessions) {
    if (sessions.length < 5) return { detected: false, difference: 0 };

    const weekdayBedtimes = [];
    const weekendBedtimes = [];

    sessions.slice(0, 14).forEach(s => {
        const d = new Date(s.start * 1000);
        const day = d.getDay();
        let hour = d.getHours() + d.getMinutes() / 60;
        if (hour < 12) hour += 24;

        if (day === 0 || day === 6) {
            weekendBedtimes.push(hour);
        } else {
            weekdayBedtimes.push(hour);
        }
    });

    if (weekdayBedtimes.length < 2 || weekendBedtimes.length < 1) {
        return { detected: false, difference: 0 };
    }

    const weekdayAvg = weekdayBedtimes.reduce((a, b) => a + b, 0) / weekdayBedtimes.length;
    const weekendAvg = weekendBedtimes.reduce((a, b) => a + b, 0) / weekendBedtimes.length;
    const diff = Math.abs(weekendAvg - weekdayAvg);

    return { detected: diff > 1.0, difference: diff };
}

// Helper: Calculate trend direction (improving/declining/stable)
function calculateTrendDirection(sessions, targetHours) {
    if (sessions.length < 6) return 0;

    // Recent 3 sessions
    const recent = sessions.slice(0, 3);
    const recentAvg = recent.reduce((sum, s) => sum + (s.end - s.start) / 3600, 0) / 3;

    // Previous 3 sessions
    const prev = sessions.slice(3, 6);
    const prevAvg = prev.reduce((sum, s) => sum + (s.end - s.start) / 3600, 0) / 3;

    // How close to target
    const recentDiff = Math.abs(recentAvg - targetHours);
    const prevDiff = Math.abs(prevAvg - targetHours);
    const improvement = prevDiff - recentDiff;

    if (improvement > 0.3) return 1;  // Improving
    if (improvement < -0.3) return -1; // Declining
    return 0; // Stable
}

// Helper: Calculate recommended bedtime
function calculateRecommendedBedtime(config) {
    const targetMinutes = config.sleepTargetDuration || 480;
    const targetHour = config.sleepTargetBedtimeHour ?? 23;
    const targetMin = config.sleepTargetBedtimeMin ?? 0;
    return `${String(targetHour).padStart(2, '0')}:${String(targetMin).padStart(2, '0')}`;
}

// Update Sleep Analytics Cards (Sleep Debt, Trend, Pattern)
function updateSleepAnalyticsCards(history, config) {
    const sleepDebtValue = document.getElementById('sleepDebtValue');
    const sleepDebtIcon = document.getElementById('sleepDebtIcon');
    const trendValue = document.getElementById('trendValue');
    const trendIcon = document.getElementById('trendIcon');
    const patternValue = document.getElementById('patternValue');
    const patternIcon = document.getElementById('patternIcon');

    // Filter valid sessions (1 hour minimum)
    const validSessions = history.filter(s => s && s.end && s.start &&
        !isNaN(s.end - s.start) && (s.end - s.start) >= 3600);

    if (validSessions.length < 2) {
        // Not enough data
        if (sleepDebtValue) sleepDebtValue.textContent = '--';
        if (trendValue) trendValue.textContent = '--';
        if (patternValue) patternValue.textContent = '--';
        return;
    }

    const targetMinutes = config.sleepTargetDuration || 480;
    const targetHours = targetMinutes / 60;

    // === SLEEP DEBT CALCULATION ===
    const now = Math.floor(Date.now() / 1000);
    const weekAgo = now - (7 * 24 * 3600);
    const recentSessions = validSessions.filter(s => s.start > weekAgo);
    const recentTotal = recentSessions.reduce((sum, s) => sum + (s.end - s.start), 0) / 3600;
    const expectedSleep = recentSessions.length * targetHours;
    const sleepDebt = Math.max(0, expectedSleep - recentTotal);

    if (sleepDebtValue) {
        if (sleepDebt < 0.5) {
            sleepDebtValue.textContent = '0h';
            if (sleepDebtIcon) sleepDebtIcon.textContent = '✅';
        } else if (sleepDebt < 5) {
            sleepDebtValue.textContent = `${sleepDebt.toFixed(1)}h`;
            if (sleepDebtIcon) sleepDebtIcon.textContent = '💤';
        } else {
            sleepDebtValue.textContent = `${Math.round(sleepDebt)}h`;
            if (sleepDebtIcon) sleepDebtIcon.textContent = '⚠️';
        }
    }

    // === TREND DIRECTION ===
    const trend = calculateTrendDirection(validSessions, targetHours);
    if (trendValue && trendIcon) {
        if (trend === 1) {
            trendValue.textContent = 'Improving';
            trendIcon.textContent = '↑';
            trendIcon.className = 'analytics-icon trend-icon improving';
        } else if (trend === -1) {
            trendValue.textContent = 'Declining';
            trendIcon.textContent = '↓';
            trendIcon.className = 'analytics-icon trend-icon declining';
        } else {
            trendValue.textContent = 'Stable';
            trendIcon.textContent = '→';
            trendIcon.className = 'analytics-icon trend-icon stable';
        }
    }

    // === PATTERN TYPE ===
    const patternType = detectPatternType(validSessions);
    if (patternValue && patternIcon) {
        switch (patternType) {
            case 'nightOwl':
                patternValue.textContent = 'Night Owl';
                patternIcon.textContent = '🦉';
                break;
            case 'earlyBird':
                patternValue.textContent = 'Early Bird';
                patternIcon.textContent = '🐦';
                break;
            case 'irregular':
                patternValue.textContent = 'Irregular';
                patternIcon.textContent = '🔀';
                break;
            default:
                patternValue.textContent = 'Regular';
                patternIcon.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-moon"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>';
        }
    }
}

// FIX Issue #3B — Sleep Graph rewrite.
//
// Adds:
//   • Click / tap / keyboard tooltip with date, time range, duration
//   • In-progress "active session" bar with pulse animation
//   • data-* attributes for every bar so handlers stay decoupled from
//     the DOM-build step
//   • GPU-accelerated transform-based bars (CSS handles the entrance)
//   • Hours-axis guide lines for context (4 / 6 / 8 / 10 h)
//
// Inputs:
//   history       — array of {start, end} (unix seconds), completed sessions
//   activeSession — optional {start} (unix seconds) for in-progress
function renderSleepGraph(history, activeSession) {
    const container = document.getElementById('sleepGraphBars');
    if (!container) return;

    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Build seven days, oldest → today
    const data = [];
    for (let i = 6; i >= 0; i--) {
        const targetDate = new Date(today);
        targetDate.setDate(targetDate.getDate() - i);
        const dayLabel = days[targetDate.getDay()];
        const targetStart = targetDate.getTime() / 1000;
        const targetEnd = targetStart + 86400;

        // Completed session that ENDED on this day (consistent with prior logic)
        const session = (history || []).find(s => {
            if (!s || !s.end || !s.start) return false;
            const dur = s.end - s.start;
            if (dur < 3600) return false;
            return s.end >= targetStart && s.end < targetEnd;
        });

        const isToday = i === 0;
        // An active session is "today's bar" if it started within the last 24 h
        // and the user hasn't ended it.
        let isActive = false;
        let activeHours = 0;
        if (isToday && activeSession && activeSession.start &&
            (nowSec - activeSession.start) < 24 * 3600 &&
            (nowSec - activeSession.start) > 0) {
            isActive = true;
            activeHours = (nowSec - activeSession.start) / 3600;
        }

        const hours = session
            ? (session.end - session.start) / 3600
            : (isActive ? activeHours : 0);

        data.push({
            label: dayLabel,
            hours: Math.max(0, hours),
            dateMs: targetDate.getTime(),
            session,
            isActive,
            activeStart: isActive ? activeSession.start : null
        });
    }

    const maxHours = Math.max(...data.map(d => d.hours), 8);

    // Build hours-axis guide lines (4 of them, evenly spaced).
    // We render them before the bars so they sit visually behind.
    const guidesHtml = `
        <div class="graph-guides" aria-hidden="true">
            <div class="guide-line"></div>
            <div class="guide-line"></div>
            <div class="guide-line"></div>
            <div class="guide-line"></div>
        </div>`;

    const fmtTime = (ts) => new Date(ts * 1000).toLocaleTimeString([], {
        hour: '2-digit', minute: '2-digit'
    });
    const fmtDate = (ms) => new Date(ms).toLocaleDateString(undefined, {
        weekday: 'short', month: 'short', day: 'numeric'
    });

    container.innerHTML = guidesHtml + data.map((d, idx) => {
        const ratio = Math.min(1, d.hours / maxHours);
        const stateClass = d.isActive
            ? 'is-active'
            : (d.hours === 0 ? 'is-empty' : '');
        const startAttr = d.session ? d.session.start
            : (d.activeStart || '');
        const endAttr = d.session ? d.session.end : '';
        const isActiveAttr = d.isActive ? '1' : '0';

        return `
            <div class="graph-bar-wrapper"
                 role="button"
                 tabindex="0"
                 data-index="${idx}"
                 data-date="${d.dateMs}"
                 data-hours="${d.hours.toFixed(2)}"
                 data-start="${startAttr}"
                 data-end="${endAttr}"
                 data-active="${isActiveAttr}"
                 aria-label="${d.label} ${d.hours > 0 ? d.hours.toFixed(1) + ' hours' : 'no sleep recorded'}">
                <div class="graph-bar-container">
                    <div class="graph-bar ${stateClass}"
                         style="height: 100%; transform: scaleY(${ratio.toFixed(3)});"></div>
                </div>
                <div class="graph-label">${d.label}</div>
            </div>
        `;
    }).join('');

    // Ensure a single tooltip element exists next to the bars.
    const graphContainer = container.closest('.graph-container') || container.parentElement;
    let tooltip = graphContainer ? graphContainer.querySelector('.graph-tooltip') : null;
    if (graphContainer && !tooltip) {
        tooltip = document.createElement('div');
        tooltip.className = 'graph-tooltip';
        tooltip.setAttribute('role', 'tooltip');
        graphContainer.appendChild(tooltip);
    }

    // Helper: position the tooltip above a specific bar wrapper.
    const positionTooltip = (wrapper) => {
        if (!tooltip || !graphContainer) return;
        const gRect = graphContainer.getBoundingClientRect();
        const bRect = wrapper.getBoundingClientRect();
        const leftPx = bRect.left + bRect.width / 2 - gRect.left;
        // Clamp so it never escapes the container horizontally.
        const tWidth = tooltip.offsetWidth || 160;
        const clamped = Math.max(tWidth / 2 + 8,
            Math.min(gRect.width - tWidth / 2 - 8, leftPx));
        tooltip.style.left = clamped + 'px';
    };

    const showTooltip = (wrapper) => {
        if (!tooltip) return;
        const dateMs = Number(wrapper.dataset.date);
        const hoursNum = Number(wrapper.dataset.hours);
        const startTs = Number(wrapper.dataset.start);
        const endTs = Number(wrapper.dataset.end);
        const isActive = wrapper.dataset.active === '1';

        const day = fmtDate(dateMs);
        let inner = `<div class="tt-day">${day}</div>`;

        if (isActive && startTs) {
            inner += `<div class="tt-range">Started at ${fmtTime(startTs)}</div>`;
            inner += `<div class="tt-duration">${hoursNum.toFixed(1)} h so far</div>`;
            inner += `<div class="tt-active">● In progress</div>`;
        } else if (startTs && endTs) {
            inner += `<div class="tt-range">${fmtTime(startTs)} → ${fmtTime(endTs)}</div>`;
            const h = Math.floor(hoursNum);
            const m = Math.round((hoursNum - h) * 60);
            inner += `<div class="tt-duration">${h}h ${m}m</div>`;
        } else {
            inner += `<div class="tt-range">No sleep recorded</div>`;
        }
        tooltip.innerHTML = inner;
        tooltip.classList.add('is-visible');

        // Clear previously-selected bar, mark this one.
        container.querySelectorAll('.graph-bar-wrapper.is-selected')
            .forEach(el => el.classList.remove('is-selected'));
        wrapper.classList.add('is-selected');

        positionTooltip(wrapper);
    };

    const hideTooltip = () => {
        if (!tooltip) return;
        tooltip.classList.remove('is-visible');
        container.querySelectorAll('.graph-bar-wrapper.is-selected')
            .forEach(el => el.classList.remove('is-selected'));
    };

    // Event delegation. We attach the listeners exactly once per element
    // (tracked via a data flag) so re-renders don't accumulate handlers.
    // Because renderSleepGraph rewrites innerHTML — not the container
    // element itself — the listeners survive renders cleanly.
    if (!container.dataset.zaylobound) {
        container.addEventListener('click', (e) => {
            const wrapper = e.target.closest('.graph-bar-wrapper');
            if (!wrapper) { hideTooltip(); return; }
            if (wrapper.classList.contains('is-selected')) {
                hideTooltip();
            } else {
                showTooltip(wrapper);
            }
        });

        container.addEventListener('keydown', (e) => {
            const wrapper = e.target.closest('.graph-bar-wrapper');
            if (!wrapper) return;
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                if (wrapper.classList.contains('is-selected')) hideTooltip();
                else showTooltip(wrapper);
            } else if (e.key === 'Escape') {
                hideTooltip();
            }
        });

        // Auto-hide on outside taps. Use capture so we always see it.
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.graph-container')) hideTooltip();
        }, true);

        // Reposition the tooltip on resize/scroll if a bar is selected.
        const reposIfNeeded = () => {
            const sel = container.querySelector('.graph-bar-wrapper.is-selected');
            if (sel) positionTooltip(sel);
        };
        window.addEventListener('resize', reposIfNeeded, { passive: true });

        container.dataset.zaylobound = '1';
    } else {
        // Render replaced the inner HTML — any prior selection is gone, so
        // make sure the tooltip from the previous render isn't left visible.
        hideTooltip();
    }
}

function renderSleepLogs(history) {
    const container = document.getElementById('logslist');

    if (!history || history.length === 0) {
        container.innerHTML = `
            <div class="logs-empty-state">
                <div class="logs-empty-icon"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-moon"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg></div>
                <p class="logs-empty-text">No sleep sessions recorded yet.<br>Start tracking to see your history here.</p>
            </div>
        `;
        return;
    }

    // Filter valid sessions (1 hour minimum for consistency)
    const validHistory = history.filter(s => s && s.start && s.end &&
        !isNaN(s.end - s.start) && (s.end - s.start) >= 3600);

    if (validHistory.length === 0) {
        container.innerHTML = `
            <div class="logs-empty-state">
                <div class="logs-empty-icon">💤</div>
                <p class="logs-empty-text">No valid sleep sessions yet.<br>Sessions under 1 hour are filtered.</p>
            </div>
        `;
        return;
    }

    container.innerHTML = validHistory.map((session, index) => {
        const date = new Date(session.start * 1000);
        const duration = session.end - session.start;
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
let touchStartY = 0;
let touchEndY = 0;

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

    // Update dock active state - Robust Reset
    document.querySelectorAll('.dock-btn').forEach(btn => {
        // CRITICAL: Explicitly clear any inline opacity leftovers from drag operations
        btn.style.opacity = '';

        // Strict class toggling
        if (btn.dataset.tab === tabName) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
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
        pill.style.transition = '';
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
    newTabBtn.classList.add('active', isMovingRight ? 'bouncy-left' : 'bouncy-right'); // Changed 'bouncy-enter' to 'bouncy-left'/'bouncy-right' for newTabBtn
    newPanel.classList.add('active', isMovingRight ? 'bouncy-left' : 'bouncy-right');

    // Step 5: Clean up animation classes after animation completes
    // This timeout MUST match the CSS animation duration (450ms)
    setTimeout(() => {
        newTabBtn.classList.remove('bouncy-enter');
        newPanel.classList.remove('bouncy-left', 'bouncy-right');
        sleepAnimationInProgress = false;
    }, 450);

    Haptic.light();
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

    // Bind drag events to the dockInner container so we aren't blocked by z-index of dock-btns
    dockInner.addEventListener('touchstart', handlePillDragStart, { passive: false });
    dockInner.addEventListener('touchmove', handlePillDragMove, { passive: false });
    dockInner.addEventListener('touchend', handlePillDragEnd);
    dockInner.addEventListener('touchcancel', handlePillDragEnd);

    dockInner.addEventListener('mousedown', handlePillDragStart);
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

    // Reset button opacities - Force Clear
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
                Haptic.light();
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

        Haptic.light();
    } else {
        // Snap back to current position with bounce animation
        updateDockPill(true);
    }
}

let isSwipeIgnored = false;

function setupSwipeNavigation() {
    const tabContent = document.querySelector('.tab-content');
    if (!tabContent) return;

    tabContent.addEventListener('touchstart', (e) => {
        // Ignore swipes that start on inputs or sliders
        if (e.target.tagName === 'INPUT' || e.target.closest('input')) {
            isSwipeIgnored = true;
            return;
        }
        isSwipeIgnored = false;
        touchStartX = e.changedTouches[0].screenX;
        touchStartY = e.changedTouches[0].screenY;
    }, { passive: true });

    tabContent.addEventListener('touchend', (e) => {
        if (isSwipeIgnored) return;
        touchEndX = e.changedTouches[0].screenX;
        touchEndY = e.changedTouches[0].screenY;
        handleSwipe();
    }, { passive: true });
}

function handleSwipe(e) {
    // Prevent swipe navigation if pill is being dragged or was just released
    if (pillDragState.isDragging || pillDragState.recentlyDragged) return;

    const swipeThreshold = 100;
    const diff = touchStartX - touchEndX;
    const verticalDiff = Math.abs(touchStartY - touchEndY);

    // Reject if vertical movement exceeds horizontal (user was scrolling, not swiping)
    if (verticalDiff > Math.abs(diff) * 0.75) return;

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
        // Silently return, device might not have a main power button
        return;
    }

    // Track last toggle time to prevent rapid-fire servo movements
    let lastPowerToggle = 0;
    const POWER_DEBOUNCE_MS = 1000; // 1 second debounce for hardware safety

    powerBtn.addEventListener('click', () => {
        const now = Date.now();
        if (now - lastPowerToggle < POWER_DEBOUNCE_MS) {
            console.warn('[Device] Power toggle debounced - ignored');
            return;
        }

        console.debug('[Device] Power button clicked');

        // Check if MQTT is connected
        if (!MQTTClient.connected) {
            console.warn('[Device] Cannot toggle power - MQTT not connected');
            Toast.error('Not connected to device. Please wait...');
            Haptic.error();
            return;
        }

        // Check if we have a device ID
        if (!DeviceState.deviceId) {
            console.error('[Device] No device ID set');
            Toast.error('No device selected');
            return;
        }

        lastPowerToggle = now;

        const currentState = DeviceState.state?.light ?? false;
        // Set switch state locally for instant UI update
        const newState = !currentState;

        // Apply visual updates immediately
        if (!DeviceState.state) {
            DeviceState.state = {};
        }
        DeviceState.state.light = newState;

        // Try to update UI if possible
        const powerBtn = document.getElementById('powerBtn');
        const powerLabel = document.getElementById('powerLabel');
        const switchInner = document.querySelector('.switch-inner');

        if (powerBtn) {
            powerBtn.classList.toggle('active', newState);
            powerBtn.style.transition = 'transform 0.1s ease-in';
            powerBtn.style.transform = 'scale(0.85)';
            setTimeout(() => {
                powerBtn.style.transition = 'transform 0.4s cubic-bezier(0.16, 1, 0.3, 1)';
                powerBtn.style.transform = '';
            }, 120);
        }

        if (powerLabel) powerLabel.textContent = newState ? 'ON' : 'OFF';

        if (switchInner) {
            if (newState) {
                switchInner.classList.add('glowing');
            } else {
                switchInner.classList.remove('glowing');
            }
        }

        updateAmbientBackground(newState);

        // Haptic feedback
        if (typeof Haptic !== 'undefined') {
            newState ? Haptic.heavy() : Haptic.medium();
        }

        // Send MQTT command
        const success = MQTTClient.publishControl(DeviceState.deviceId, { light: newState });

        if (success) {
            // Optimistic update
            DeviceState.state.light = newState;

            // Sync with StateStore for instant UI feedback
            if (typeof StateStore !== 'undefined') {
                StateStore.update(DeviceState.deviceId, { light: newState });
            }

            // Re-render UI immediately
            updateUI(DeviceState.state);

            Haptic.medium();
        }
        console.debug(`[Device] Publish result: ${success ? 'sent' : 'queued'}`);
    });

    // Mode buttons with debouncing to prevent rapid mode switching issues
    document.querySelectorAll('[data-mode]').forEach(btn => {
        btn.addEventListener('click', () => {
            const mode = parseInt(btn.dataset.mode);
            console.debug(`[Device] Mode button clicked: ${mode}`);

            // Check if MQTT is connected
            if (!MQTTClient.connected) {
                console.warn('[Device] Cannot change mode - MQTT not connected');
                Toast.error('Not connected to device. Please wait...');
                Haptic.error();
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
                const modeId = parseInt(b.dataset.mode);
                if (b) {
                    b.classList.toggle('active', mode === modeId);
                    if (mode === modeId) {
                        b.style.transform = 'scale(1.05)';
                        b.style.transition = 'transform 0.1s ease-out';
                        setTimeout(() => {
                            b.style.transform = '';
                            b.style.transition = 'transform 0.3s cubic-bezier(0.16, 1, 0.3, 1)';
                        }, 150);
                    }
                }
            });

            if (typeof Haptic !== 'undefined') Haptic.selection();

            // Debounced publish - prevents rapid-fire mode changes
            modeChangeTimeout = setTimeout(() => {
                if (pendingModeChange && pendingModeChange.mode === mode) {
                    console.debug(`[Device] Publishing mode change: ${mode}`);
                    
                    const currentState = DeviceState.state || {};
                    const isSleeping = currentState.isSleeping;
                    const now = Math.floor(Date.now() / 1000);
                    let success = false;

                    if (mode === 3 && !isSleeping) {
                        // STARTING SLEEP VIA MODE GRID
                        StateStore.update(DeviceState.deviceId, {
                            isSleeping: true,
                            sleepStart: now,
                            mode: 3
                        });
                        success = MQTTClient.publishControl(DeviceState.deviceId, { mode: 3, sleep: true, sleepStart: now, lastUpdated: now });
                        if (success) {
                            Toast.success('Sleep session started');
                        }
                    } else if (isSleeping && mode !== 3) {
                        // ENDING SLEEP VIA MODE GRID
                        const start = currentState.sleepStart;
                        let newHistory = currentState.sleepHistory ? [...currentState.sleepHistory] : [];
                        if (start && (now - start) > 60) {
                            const newSession = { start, end: now };
                            newHistory.unshift(newSession);
                            newHistory.sort((a, b) => b.start - a.start);
                        }

                        StateStore.update(DeviceState.deviceId, {
                            isSleeping: false,
                            sleepStart: null,
                            sleepHistory: newHistory,
                            mode: mode
                        });
                        success = MQTTClient.publishControl(DeviceState.deviceId, { mode: mode, sleep: false, sleepEnd: now, lastUpdated: now });
                        if (success) {
                            Toast.success('Sleep session ended');
                        }
                    } else {
                        // STANDARD MODE CHANGE
                        // FIX Issue #2A: If the device's reported mode is BEDTIME
                        // but our local isSleeping flag is out of sync (stale page
                        // load, transient MQTT drop, etc.), include sleep:false to
                        // be explicit and let the device clean up its session.
                        // The firmware now accepts a bare {mode} too, this is just
                        // belt-and-suspenders for state-sync edge cases.
                        const payload = { mode, lastUpdated: Math.floor(Date.now() / 1000) };
                        if (DeviceState.state.mode === 3 && mode !== 3) {
                            payload.sleep = false;
                            payload.sleepEnd = now;
                        }
                        success = MQTTClient.publishControl(DeviceState.deviceId, payload);
                        if (success) {
                            DeviceState.state.mode = mode;
                            if (typeof StateStore !== 'undefined') {
                                StateStore.update(DeviceState.deviceId, { mode: mode });
                            }
                        }
                    }

                    if (success) {
                        updateUI(DeviceState.state);
                        Haptic.medium();
                    }
                    console.debug(`[Device] Mode publish result: ${success ? 'sent' : 'queued'}`);
                }
                modeChangeTimeout = null;
            }, MODE_CHANGE_DEBOUNCE_MS);
        });
    });

}

// Helper function to check if mode UI update should be ignored
// (called from updateUI when device state arrives)
// incomingMode: the mode from the MQTT message BEFORE it was merged into DeviceState.state
function shouldIgnoreModeUpdate(incomingMode) {
    if (!pendingModeChange) {
        return false;
    }

    const elapsed = Date.now() - pendingModeChange.timestamp;

    // Parse incoming mode as integer for comparison
    const parsedIncomingMode = (incomingMode !== undefined && incomingMode !== null)
        ? parseInt(incomingMode, 10)
        : null;

    // Check if server confirmed our mode change using the INCOMING mode (before merge)
    if (parsedIncomingMode !== null && parsedIncomingMode === pendingModeChange.mode) {
        // Server confirmed our expected mode - clear pending and allow updates
        console.log(`[Device] Mode ${pendingModeChange.mode} confirmed by server (incoming=${parsedIncomingMode})`);
        pendingModeChange = null;
        return false;
    }

    // Still within lock period - ignore server updates to prevent flicker
    if (elapsed < MODE_CHANGE_LOCK_MS) {
        console.log(`[Device] Ignoring mode update - pending change in progress (${elapsed}ms elapsed, incoming=${parsedIncomingMode}, expected=${pendingModeChange.mode})`);
        return true;
    }

    // Lock period expired but server has different mode
    // This means our change might have been rejected or overridden
    if (parsedIncomingMode !== null && parsedIncomingMode !== pendingModeChange.mode) {
        console.log(`[Device] Mode change ${pendingModeChange.mode} not confirmed, server has ${parsedIncomingMode}`);
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
    // Device Renaming
    const deviceNameSetting = document.getElementById('deviceNameSetting');
    if (deviceNameSetting) {
        deviceNameSetting.addEventListener('click', () => {
            const currentName = document.getElementById('deviceNameValue')?.textContent || '';
            const safeName = currentName === '--' ? '' : currentName;

            Modal.input({
                title: 'Rename Device',
                placeholder: 'Enter device name',
                value: safeName,
                onSubmit: async (rawName) => {
                    // Strict sanitization matching Index page
                    const cleanName = rawName.replace(/[^a-zA-Z0-9\s\-_]/g, '').trim();

                    if (cleanName) {
                        console.log(`[Device] Renaming device ${DeviceState.deviceId} -> "${cleanName}"`);

                        // 1. Optimistic UI Update
                        const titleEl = document.getElementById('deviceTitle');
                        const valEl = document.getElementById('deviceNameValue');
                        if (titleEl) titleEl.textContent = cleanName;
                        if (valEl) valEl.textContent = cleanName;

                        // 2. Update Local Storage
                        DeviceList.update(DeviceState.deviceId, { name: cleanName });
                        if (DeviceState.state) DeviceState.state.name = cleanName;

                        // 3. Sync to Firebase
                        const user = Auth.getUser();
                        if (user) {
                            try {
                                await DeviceService.updateDevice(window.activeHomeId, DeviceState.deviceId, { name: cleanName });
                                console.log('[Device] Rename synced to Firebase');
                            } catch (e) {
                                console.error('[Device] Failed to sync name:', e);
                                Toast.error('Saved locally (sync failed)');
                            }
                        } else {
                            Toast.success('Renamed locally');
                        }

                        Toast.success('Device renamed');
                    } else {
                        Toast.error('Invalid name');
                    }
                }
            });
        });
    }

    // Region & Timezone Setting
    const timezoneSetting = document.getElementById('timezoneSetting');
    if (timezoneSetting) {
        // Initialize UI with saved value
        const savedTz = localStorage.getItem('zaylo-timezone') || 'auto';
        const tzValueEl = document.getElementById('timezoneValue');
        if (tzValueEl) {
            tzValueEl.textContent = savedTz === 'auto' ? 'Auto (Browser)' : savedTz.replace(/_/g, ' ');
        }

        timezoneSetting.addEventListener('click', () => {
            const currentTz = localStorage.getItem('zaylo-timezone') || 'auto';
            
            const commonTimezones = [
                { id: 'auto', name: 'Auto (Browser Time)' },
                { id: 'Europe/London', name: 'UK / London (GMT/BST)' },
                { id: 'Europe/Paris', name: 'Central Europe (CET/CEST)' },
                { id: 'Europe/Athens', name: 'Eastern Europe (EET/EEST)' },
                { id: 'America/New_York', name: 'US Eastern (EST/EDT)' },
                { id: 'America/Chicago', name: 'US Central (CST/CDT)' },
                { id: 'America/Denver', name: 'US Mountain (MST/MDT)' },
                { id: 'America/Los_Angeles', name: 'US Pacific (PST/PDT)' },
                { id: 'Australia/Sydney', name: 'Australia - Sydney (AEST/AEDT)' },
                { id: 'Asia/Tokyo', name: 'Japan (JST)' },
                { id: 'Asia/Dubai', name: 'UAE (GST)' }
            ];

            const content = `
                <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 10px; max-height: 50vh; overflow-y: auto; padding-right: 4px;">
                    ${commonTimezones.map(tz => `
                        <div class="tz-option ${currentTz === tz.id ? 'active' : ''}" 
                             data-tz="${tz.id}"
                             style="padding: 12px 16px; border-radius: var(--radius-md); 
                                    background: ${currentTz === tz.id ? 'rgba(124, 58, 237, 0.15)' : 'var(--bg-glass)'}; 
                                    border: 1px solid ${currentTz === tz.id ? 'var(--accent)' : 'var(--border-glass)'};
                                    color: ${currentTz === tz.id ? 'var(--text-primary)' : 'var(--text-secondary)'};
                                    cursor: pointer; transition: all 0.2s ease; display: flex; justify-content: space-between; align-items: center;">
                            <span style="font-weight: ${currentTz === tz.id ? '600' : '500'};">${tz.name}</span>
                            ${currentTz === tz.id ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>' : ''}
                        </div>
                    `).join('')}
                </div>
            `;

            let selectedTz = currentTz;

            const { modal, close } = Modal.create({
                title: 'Region & Timezone',
                content,
                actions: [
                    { label: 'Cancel', primary: false },
                    {
                        label: 'Save Region',
                        primary: true,
                        onClick: () => {
                            localStorage.setItem('zaylo-timezone', selectedTz);
                            
                            const displayEl = document.getElementById('timezoneValue');
                            if (displayEl) {
                                displayEl.textContent = selectedTz === 'auto' ? 'Auto (Browser)' : selectedTz.replace(/_/g, ' ');
                            }

                            if (DeviceState.deviceId && typeof MQTTClient !== 'undefined') {
                                MQTTClient.syncTimezoneToDevice(DeviceState.deviceId);
                            }

                            Toast.success('Timezone updated successfully');
                        }
                    }
                ]
            });

            const options = modal.querySelectorAll('.tz-option');
            options.forEach(opt => {
                opt.addEventListener('click', () => {
                    selectedTz = opt.dataset.tz;
                    options.forEach(o => {
                        const isSelected = o === opt;
                        o.style.background = isSelected ? 'rgba(124, 58, 237, 0.15)' : 'var(--bg-glass)';
                        o.style.borderColor = isSelected ? 'var(--accent)' : 'var(--border-glass)';
                        o.style.color = isSelected ? 'var(--text-primary)' : 'var(--text-secondary)';
                        o.querySelector('span').style.fontWeight = isSelected ? '600' : '500';
                        
                        const hasCheck = o.querySelector('svg');
                        if (isSelected && !hasCheck) {
                            o.insertAdjacentHTML('beforeend', '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>');
                        } else if (!isSelected && hasCheck) {
                            hasCheck.remove();
                        }
                    });
                    if (typeof Haptic !== 'undefined') Haptic.selection();
                });
            });
        });
    }
    // Toggle switches (Smart tab)
    document.getElementById('alarmEnabled').addEventListener('change', (e) => {
        Haptic.light();
        MQTTClient.publishConfig(DeviceState.deviceId, { alarmEnabled: e.target.checked });
    });

    document.getElementById('dayIdleEnabled').addEventListener('change', (e) => {
        Haptic.light();
        MQTTClient.publishConfig(DeviceState.deviceId, { dayIdleEnabled: e.target.checked });
    });

    document.getElementById('motionEnabled').addEventListener('change', (e) => {
        Haptic.light();
        MQTTClient.publishConfig(DeviceState.deviceId, { motionEnabled: e.target.checked });
    });

    document.getElementById('twtEnabled').addEventListener('change', (e) => {
        Haptic.light();
        MQTTClient.publishConfig(DeviceState.deviceId, { twtEnabled: e.target.checked });
    });

    // Theme toggle
    const themeToggle = document.getElementById('themeToggle');
    if (themeToggle) {
        // Set initial state based on current theme
        themeToggle.checked = Theme.get() === 'dark';

        themeToggle.addEventListener('change', (e) => {
            Haptic.light();
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
                    <span style="font-size: 2em; display:flex;"><svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2"/><path d="M5 3 2 6"/><path d="m22 6-3-3"/><path d="M6.38 18.7 4 21"/><path d="M17.64 18.67 20 21"/></svg></span>
                    <div>
                        <div style="font-weight: 600; color: var(--text-primary); font-size: var(--font-size-lg);">Wake-Up Alarm</div>
                        <div style="font-size: var(--font-size-sm); color: var(--text-secondary);">Light turns ON at this time to help you wake naturally.</div>
                    </div>
                </div>
                <div style="background: linear-gradient(135deg, rgba(251, 191, 36, 0.15), rgba(245, 158, 11, 0.08)); 
                            border-radius: var(--radius-md); padding: var(--spacing-sm) var(--spacing-md); 
                            margin-top: var(--spacing-md); border: 1px solid rgba(251, 191, 36, 0.3);
                            font-size: var(--font-size-sm); color: var(--text-secondary);">
                    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-sun"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg> <strong>Sunrise Simulation</strong> - waking with light is healthier than sound alarms!
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
            title: '<span style=\"display:inline-flex; align-items:center; gap:6px;\"><svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><circle cx=\"12\" cy=\"13\" r=\"8\"/><path d=\"M12 9v4l2 2\"/><path d=\"M5 3 2 6\"/><path d=\"m22 6-3-3\"/><path d=\"M6.38 18.7 4 21\"/><path d=\"M17.64 18.67 20 21\"/></svg> Set Alarm Time</span>',
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

        // Initialize scroll positions (350ms ensures modal animation completes)
        setTimeout(() => {
            hourScroll.scrollTop = currentHour * itemHeight;
            minuteScroll.scrollTop = currentMinute * itemHeight;
        }, 350);

        // Setup scroll handlers with live preview
        const setupScroll = (scroll, values, initialValue, onUpdate) => {
            let currentIndex = values.indexOf(initialValue);
            if (currentIndex === -1) currentIndex = 0;

            // Set initial selected class
            scroll.querySelectorAll('.picker-item').forEach((item, i) => {
                item.classList.toggle('selected', i === currentIndex);
            });

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

            // Tap to select functionality
            scroll.querySelectorAll('.picker-item').forEach((item, index) => {
                item.addEventListener('click', () => {
                    // Smooth scroll to this item
                    scroll.scrollTo({
                        top: index * itemHeight,
                        behavior: 'smooth'
                    });
                });
            });
        };

        setupScroll(hourScroll, Array.from({ length: 24 }, (_, i) => i), currentHour, (h) => selectedHour = h);
        setupScroll(minuteScroll, Array.from({ length: 60 }, (_, i) => i), currentMinute, (m) => selectedMinute = m);
    });

    // Settings rows with pickers - Using correct data-setting selectors
    setupSettingPicker('presenceDisplayTimeout', 'presenceDisplayTimeout',
        [0, 5, 10, 15, 30, 60, 120, 300],
        (v) => v === 0 ? 'Off' : Utils.formatSecondsAsDuration(v),
        'displayTimeoutValue');

    // ========== HOLD SENSITIVITY DECREASE BUTTON ("Lights didn't turn off?") ==========
    const sensBumpBtn = document.getElementById('sensitivityBumpBtn');
    if (sensBumpBtn) {
        sensBumpBtn.addEventListener('click', (e) => {
            e.stopPropagation();

            const config = DeviceState.state?.config || {};
            let currentVal = config.radarHoldSensitivity ?? 50;
            if (currentVal > 100) currentVal = 50;

            // Decrease by 5 (stricter hold = lights turn off more easily), min 0
            const newVal = Math.max(currentVal - 5, 0);

            // Update local state immediately
            if (DeviceState.state && DeviceState.state.config) {
                DeviceState.state.config.radarHoldSensitivity = newVal;
            }

            // Update display
            const displayEl = document.getElementById('radarHoldSensitivityValue');
            if (displayEl) {
                displayEl.textContent = newVal === 50 ? '50% (default)' : `${newVal}%`;
            }

            const slider = document.getElementById('holdSensSlider');
            const sliderVal = document.getElementById('holdSensSliderValue');
            if (slider) slider.value = newVal;
            if (sliderVal) sliderVal.textContent = `${newVal}%`;

            // Publish to device via MQTT
            MQTTClient.publishConfig(DeviceState.deviceId, { radarHoldSensitivity: newVal });

            // Visual feedback
            sensBumpBtn.style.transform = 'scale(0.95)';
            setTimeout(() => { sensBumpBtn.style.transform = ''; }, 150);

            if (typeof Haptic !== 'undefined') Haptic.medium();

            if (newVal <= 0) {
                Toast.success('Maximum strictness reached (0%)');
            } else {
                Toast.success(`Hold sensitivity: ${newVal}%`);
            }
        });
    }

    // ========== HOLD SENSITIVITY RESET BUTTON ==========
    const sensResetBtn = document.getElementById('sensitivityResetBtn');
    if (sensResetBtn) {
        sensResetBtn.addEventListener('click', (e) => {
            e.stopPropagation();

            const DEFAULT_HOLD = 50;
            const config = DeviceState.state?.config || {};
            const currentVal = config.radarHoldSensitivity ?? 50;

            if (currentVal === DEFAULT_HOLD) {
                Toast.success('Already at default (50%)');
                if (typeof Haptic !== 'undefined') Haptic.light();
                return;
            }

            // Update local state
            if (DeviceState.state && DeviceState.state.config) {
                DeviceState.state.config.radarHoldSensitivity = DEFAULT_HOLD;
            }

            // Update display
            const displayEl = document.getElementById('radarHoldSensitivityValue');
            if (displayEl) displayEl.textContent = '50% (default)';

            const slider = document.getElementById('holdSensSlider');
            const sliderVal = document.getElementById('holdSensSliderValue');
            if (slider) slider.value = DEFAULT_HOLD;
            if (sliderVal) sliderVal.textContent = '50%';

            // Publish to device
            MQTTClient.publishConfig(DeviceState.deviceId, { radarHoldSensitivity: DEFAULT_HOLD });

            if (typeof Haptic !== 'undefined') Haptic.medium();
            Toast.success('Hold sensitivity reset to default (50%)');
        });
    }

    // ========== ADVANCED TOGGLE (expand/collapse slider) ==========
    const advToggle = document.getElementById('holdSensAdvancedToggle');
    const advPanel = document.getElementById('holdSensAdvancedPanel');
    const advChevron = document.getElementById('holdSensChevron');
    if (advToggle && advPanel) {
        advToggle.addEventListener('click', () => {
            const isOpen = advPanel.style.display !== 'none';
            advPanel.style.display = isOpen ? 'none' : 'block';
            if (advChevron) advChevron.style.transform = isOpen ? '' : 'rotate(90deg)';
            advToggle.style.opacity = isOpen ? '0.7' : '1';

            // Sync slider to current value when opening
            if (!isOpen) {
                const cfg = DeviceState.state?.config || {};
                const val = cfg.radarHoldSensitivity ?? 50;
                const slider = document.getElementById('holdSensSlider');
                const valDisplay = document.getElementById('holdSensSliderValue');
                if (slider) slider.value = val;
                if (valDisplay) valDisplay.textContent = `${val}%`;
            }
        });
    }

    // ========== ADVANCED SLIDER (manual hold sensitivity control) ==========
    const holdSensSlider = document.getElementById('holdSensSlider');
    if (holdSensSlider) {
        // Live preview on drag
        holdSensSlider.addEventListener('input', (e) => {
            const val = parseInt(e.target.value);
            const valDisplay = document.getElementById('holdSensSliderValue');
            if (valDisplay) valDisplay.textContent = `${val}%`;
        });

        // Commit on release
        holdSensSlider.addEventListener('change', (e) => {
            const val = parseInt(e.target.value);

            // Update local state
            if (DeviceState.state && DeviceState.state.config) {
                DeviceState.state.config.radarHoldSensitivity = val;
            }

            // Update header display
            const displayEl = document.getElementById('radarHoldSensitivityValue');
            if (displayEl) {
                displayEl.textContent = val === 50 ? '50% (default)' : `${val}%`;
            }

            // Publish to device
            MQTTClient.publishConfig(DeviceState.deviceId, { radarHoldSensitivity: val });

            if (typeof Haptic !== 'undefined') Haptic.light();
            Toast.success(`Hold sensitivity: ${val}%`);
        });
    }

    // ========== PROFESSIONAL SERVO CALIBRATION UI ==========
    // Custom interactive modal with visual servo indicator and live preview
    setupServoCalibration('angleOff', 'OFF Position', 'angleOffValue', '🔴');
    setupServoCalibration('angleOn', 'ON Position', 'angleOnValue', '🟢');

    setupServoSpeedUI();

    // More granular time options (minimum 15s for motion timeout safety)
    // 5s steps from 15s to 1min, then 15s steps up to 5min, then 1min steps
    const timerValues = [
        ...Array.from({ length: 10 }, (_, i) => 15 + i * 5), // 15, 20, 25 ... 60
        ...Array.from({ length: 16 }, (_, i) => 60 + (i + 1) * 15), // 75, 90 ... 300
        ...Array.from({ length: 25 }, (_, i) => 300 + (i + 1) * 60) // 360, 420 ... 1800 (30m)
    ];

    setupSettingPicker('motionTimeout', 'motionTimeout',
        timerValues,
        Utils.formatSecondsAsDuration,
        'motionTimeoutValue');

    setupSettingPicker('manualTimeout', 'manualTimeout',
        timerValues,
        Utils.formatSecondsAsDuration,
        'manualTimeoutValue');

    // NOTE: sunriseOffset and sunsetOffset are now managed globally from the index page Settings.
    // The setupSettingPicker calls for these have been removed.
    // Global offsets are stored in localStorage('zaylo-SunriseOffset') and ('zaylo-SunsetOffset')
    // and broadcast to all devices from the index page when changed.

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

    // Change WiFi - Professional MQTT-based WiFi Changer with Network Scanner (Premium UI)
    document.getElementById('changeWifiBtn')?.addEventListener('click', () => {
        const currentSSID = DeviceState.state?.wifi?.ssid || DeviceState.state?.ssid || 'Unknown';
        const rssi = DeviceState.state?.rssi || DeviceState.state?.wifi?.rssi || 0;

        // Calculate signal bars (0-4)
        const getSignalLevel = (r) => {
            if (r >= -50) return 4;
            if (r >= -60) return 3;
            if (r >= -70) return 2;
            if (r >= -80) return 1;
            return 0;
        };

        const renderSignalBars = (level) => {
            return `
                <div class="wifi-signal-bars">
                    <div class="wifi-bar ${level >= 1 ? 'active' : ''}"></div>
                    <div class="wifi-bar ${level >= 2 ? 'active' : ''}"></div>
                    <div class="wifi-bar ${level >= 3 ? 'active' : ''}"></div>
                    <div class="wifi-bar ${level >= 4 ? 'active' : ''}"></div>
                </div>
            `;
        };

        const currentSignalLevel = getSignalLevel(rssi);

        const content = `
            <div class="wifi-changer-popup">
                <!-- Current Network Status Card -->
                <div style="background: linear-gradient(135deg, rgba(34, 197, 94, 0.15), rgba(16, 185, 129, 0.05)); 
                            border-radius: var(--radius-lg); padding: var(--spacing-md); 
                            border: 1px solid rgba(34, 197, 94, 0.3); display: flex; align-items: center; gap: var(--spacing-md);">
                    <div style="background: rgba(34, 197, 94, 0.2); width: 48px; height: 48px; border-radius: 50%; 
                                display: flex; align-items: center; justify-content: center; font-size: 1.5em; color: var(--success);">
                        📶
                    </div>
                    <div style="flex: 1;">
                        <div style="font-size: var(--font-size-xs); color: var(--success-light); font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">Current Network</div>
                        <div style="font-size: var(--font-size-lg); font-weight: 600; color: var(--text-primary); margin-bottom: 2px;">${Utils.escapeHtml(currentSSID)}</div>
                        <div style="display: flex; align-items: center; gap: 6px; font-size: var(--font-size-sm); color: var(--text-secondary);">
                            <span>Signal: ${rssi}dBm</span>
                            ${renderSignalBars(currentSignalLevel)}
                        </div>
                    </div>
                </div>

                <!-- Scan Section -->
                <div style="background: var(--bg-glass); border-radius: var(--radius-lg); border: 1px solid var(--border-glass); overflow: hidden;">
                    <div style="padding: var(--spacing-md); border-bottom: 1px solid var(--border-glass); display: flex; align-items: center; justify-content: space-between;">
                        <div style="font-weight: 600; color: var(--text-primary);">Available Networks</div>
                        <button id="wifiScanBtn" class="btn btn-secondary btn-sm" style="gap: 6px;">
                            <span>🔄</span> Scan
                        </button>
                    </div>
                    
                    <div id="wifiNetworkList" class="wifi-network-list" style="margin-top: 0; padding: 0;">
                        <div style="padding: var(--spacing-lg); text-align: center; color: var(--text-tertiary);">
                            <div style="font-size: 2em; margin-bottom: var(--spacing-sm); opacity: 0.5;">📡</div>
                            <div>Tap "Scan" to find networks</div>
                        </div>
                    </div>
                </div>

                <!-- Credentials Input -->
                <div id="wifiManualEntry" style="background: var(--bg-glass); border-radius: var(--radius-lg); padding: var(--spacing-lg); border: 1px solid var(--border-glass);">
                    <div style="font-weight: 600; color: var(--text-primary); margin-bottom: var(--spacing-md);">Connect</div>
                    
                    <div class="form-group" style="margin-bottom: var(--spacing-md);">
                        <label class="form-label">Network Name (SSID)</label>
                        <input type="text" id="wifiNewSSID" class="modal-input" placeholder="Select or type..." style="width: 100%;">
                    </div>
                    
                    <div class="form-group" style="margin-bottom: 0;">
                        <label class="form-label">Password</label>
                        <div style="position: relative;">
                            <input type="password" id="wifiNewPassword" class="modal-input" placeholder="Enter password" style="width: 100%; padding-right: 40px;">
                            <button type="button" id="wifiTogglePassword" aria-label="Toggle password visibility" style="position: absolute; right: 0; top: 0; bottom: 0; width: 40px; background: none; border: none; cursor: pointer; color: var(--text-tertiary);">
                                👁️
                            </button>
                        </div>
                    </div>
                </div>

                 <!-- Connection Status Overlay (Hidden by default) -->
                <div id="wifiConnectionStatus" style="display: none; text-align: center; padding: var(--spacing-xl);">
                    <div class="loading-spinner" style="margin: 0 auto var(--spacing-md); width: 40px; height: 40px; border-width: 4px;"></div>
                    <div style="font-size: var(--font-size-lg); font-weight: 600; margin-bottom: var(--spacing-xs);">Connecting...</div>
                    <div style="color: var(--text-secondary);">Please wait while the device joins the network.</div>
                </div>
            </div>
        `;

        const { close, modal } = Modal.create({
            title: 'WiFi Settings',
            content,
            actions: [
                { label: 'Cancel', primary: false },
                {
                    label: 'Connect',
                    primary: true,
                    onClick: () => {
                        const ssid = modal.querySelector('#wifiNewSSID').value.trim();
                        const pass = modal.querySelector('#wifiNewPassword').value;

                        if (!ssid) {
                            Toast.error("SSID is required");
                            return false;
                        }

                        // Show loading
                        const manualEntry = modal.querySelector('#wifiManualEntry');
                        const statusContainer = modal.querySelector('#wifiConnectionStatus');
                        if (manualEntry) manualEntry.style.display = 'none';
                        if (statusContainer) statusContainer.style.display = 'block';

                        MQTTClient.publishConfig(DeviceState.deviceId, {
                            wifiSsid: ssid,
                            wifiPass: pass
                        });

                        // Fake progress/success sequence for better UX
                        setTimeout(() => {
                            Toast.success(`Sent credentials for "${ssid}"`);
                            // Auto-close after short delay
                            setTimeout(() => close(), 1500);
                        }, 2000);

                        return false; // Keep modal open during "connecting"
                    }
                }
            ]
        });

        // Toggle Password
        const toggleBtn = modal.querySelector('#wifiTogglePassword');
        const passInput = modal.querySelector('#wifiNewPassword');
        if (toggleBtn && passInput) {
            toggleBtn.addEventListener('click', () => {
                const isPass = passInput.type === 'password';
                passInput.type = isPass ? 'text' : 'password';
                toggleBtn.textContent = isPass ? '👁️' : '🙈';
            });
        }

        // Scan Logic
        const scanBtn = modal.querySelector('#wifiScanBtn');
        const list = modal.querySelector('#wifiNetworkList');
        const ssidInput = modal.querySelector('#wifiNewSSID');

        if (scanBtn && list && ssidInput) {
            scanBtn.addEventListener('click', () => {
                if (scanBtn.disabled) return;
                scanBtn.disabled = true;
                scanBtn.innerHTML = `<span>⏳</span> Scanning...`;

                list.innerHTML = `
                    <div class="scan-spinner-container">
                        <div class="scan-radar"></div>
                        <div>Scanning for networks...</div>
                    </div>
                `;

                MQTTClient.publishControl(DeviceState.deviceId, { command: 'wifiScan' });

                // Subscribe to results
                const onScan = (deviceId, state) => {
                    if (deviceId !== DeviceState.deviceId) return;

                    // Support various payload structures
                    const results = state.wifiScanResults || state.scanResults || state.networks;
                    if (results) {
                        // Cleanup listener immediately to prevent dups
                        MQTTClient.off('onStateUpdate', onScan);
                        scanBtn.disabled = false;
                        scanBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg> Scan`;

                        if (!Array.isArray(results) || !results.length) {
                            list.innerHTML = `<div style="padding: 20px; text-align: center; color: var(--text-secondary);">No networks found</div>`;
                            return;
                        }

                        // Sort by signal strength
                        results.sort((a, b) => (b.rssi || -100) - (a.rssi || -100));

                        list.innerHTML = '';
                        results.forEach((net, index) => {
                            const item = document.createElement('div');
                            item.className = 'wifi-network-item';
                            // Stagger animation
                            item.style.animationDelay = `${index * 0.05}s`;

                            const ssid = net.ssid || 'Unknown';
                            const rssiVal = net.rssi || -100;
                            const isSecure = net.secure || (net.authMode && net.authMode !== 0);
                            const level = getSignalLevel(rssiVal);

                            item.innerHTML = `
                                <div class="wifi-network-left">
                                    <div class="wifi-network-icon">${isSecure ? '<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"3\" y=\"11\" width=\"18\" height=\"11\" rx=\"2\" ry=\"2\"/><path d=\"M7 11V7a5 5 0 0 1 10 0v4\"/></svg>' : '<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"3\" y=\"11\" width=\"18\" height=\"11\" rx=\"2\" ry=\"2\"/><path d=\"M7 11V7a5 5 0 0 1 9.9-1\"/></svg>'}</div>
                                    <div class="wifi-network-info">
                                        <div class="wifi-ssid">${Utils.escapeHtml(ssid)}</div>
                                        <div class="wifi-meta">
                                            ${rssiVal}dBm
                                        </div>
                                    </div>
                                </div>
                                <div style="color: ${level >= 3 ? 'var(--success)' : (level >= 2 ? 'var(--warning)' : 'var(--danger)')}">
                                    ${renderSignalBars(level)}
                                </div>
                            `;

                            item.addEventListener('click', () => {
                                ssidInput.value = ssid;
                                if (passInput) passInput.focus();

                                // Visual feedback
                                list.querySelectorAll('.wifi-network-item').forEach(i => i.classList.remove('current'));
                                item.classList.add('current');
                            });

                            list.appendChild(item);
                        });
                    }
                };

                MQTTClient.on('onStateUpdate', onScan);

                // Timeout after 15s
                setTimeout(() => {
                    if (scanBtn.disabled) {
                        MQTTClient.off('onStateUpdate', onScan);
                        scanBtn.disabled = false;
                        scanBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg> Retry`;
                        list.innerHTML = `<div style="padding: 20px; text-align: center; color: var(--danger);">Scan timed out</div>`;
                    }
                }, 15000);
            });
        }

        // Focus input
        setTimeout(() => {
            const el = modal.querySelector('#wifiNewSSID');
            if (el) el.focus();
        }, 300);
    });

    // Reboot Device Handler
    const rebootBtn = document.getElementById('rebootBtn');
    if (rebootBtn) {
        rebootBtn.addEventListener('click', () => {
            Haptic.medium();
            Modal.confirm('🔄 Reboot Device', 'Are you sure you want to reboot the device? It will be offline for a few moments.', () => {
                Toast.info('Reboot command sent');
                MQTTClient.publishControl(DeviceState.deviceId, { command: 'reboot' });
                return true;
            });
        });
    }

    // ──────────────────────────────────────────────────────────────
    // FIX Issue #5 — Backup & Restore handlers
    // ──────────────────────────────────────────────────────────────
    //
    // Export: request the device's current config via MQTT and download
    //         the returned envelope as `<deviceId>-<date>.zaylobackup`.
    //
    // Restore: read a user-selected file, validate envelope, show the
    //          user a diff vs. current device state, and on confirm
    //          publish the payload to importConfig.

    const exportConfigBtn = document.getElementById('exportConfigBtn');
    if (exportConfigBtn) {
        let _exportTimer = null;
        let _exportHandler = null;

        const downloadBackup = (envelope) => {
            try {
                const json = JSON.stringify(envelope, null, 2);
                const blob = new Blob([json], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const stamp = new Date().toISOString().slice(0, 10);
                const a = document.createElement('a');
                a.href = url;
                a.download = `${envelope.deviceId || 'zaylo'}-${stamp}.zaylobackup`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                Toast.success('Backup downloaded');
            } catch (e) {
                console.error('[Backup] download failed', e);
                Toast.error('Failed to write backup file');
            }
        };

        exportConfigBtn.addEventListener('click', () => {
            Haptic.light();
            if (!DeviceState.connected) {
                Toast.error('Device offline — cannot export');
                return;
            }

            // Subscribe to the one-shot export response.
            if (typeof MQTTClient.onConfigExport === 'function') {
                _exportHandler = (envelope) => {
                    if (_exportTimer) { clearTimeout(_exportTimer); _exportTimer = null; }
                    MQTTClient.onConfigExport(null);
                    downloadBackup(envelope);
                };
                MQTTClient.onConfigExport(_exportHandler);
            } else {
                // Fallback: listen on raw MQTT topic via a quick subscription.
                console.warn('[Backup] MQTTClient.onConfigExport not implemented; using fallback handler');
            }

            Toast.info('Requesting backup from device…');
            MQTTClient.publishControl(DeviceState.deviceId, { command: 'exportConfig' });

            _exportTimer = setTimeout(() => {
                if (_exportHandler && typeof MQTTClient.onConfigExport === 'function') {
                    MQTTClient.onConfigExport(null);
                }
                Toast.error('Export timed out — device did not respond');
            }, 5000);
        });
    }

    const importConfigBtn = document.getElementById('importConfigBtn');
    const importConfigFile = document.getElementById('importConfigFile');
    if (importConfigBtn && importConfigFile) {
        importConfigBtn.addEventListener('click', () => {
            Haptic.light();
            importConfigFile.value = ''; // allow re-selecting the same file
            importConfigFile.click();
        });

        importConfigFile.addEventListener('change', async (e) => {
            const file = e.target.files && e.target.files[0];
            if (!file) return;

            let parsed;
            try {
                const text = await file.text();
                parsed = JSON.parse(text);
            } catch (err) {
                Toast.error('Invalid backup file — not valid JSON');
                return;
            }

            if (parsed.type !== 'configExport' || !parsed.config || !parsed.schemaVersion) {
                Toast.error('Backup file missing required fields');
                return;
            }

            // Build a human-readable diff summary against current state.
            const cur = (DeviceState.state && DeviceState.state.config) || {};
            const incoming = parsed.config;
            const diffs = [];
            const keys = Object.keys(incoming);
            for (const k of keys) {
                const a = JSON.stringify(cur[k]);
                const b = JSON.stringify(incoming[k]);
                if (a !== b) diffs.push({ key: k, from: cur[k], to: incoming[k] });
            }

            const sourceDevice = parsed.deviceId || 'unknown';
            const exportedAt = parsed.exportedAt
                ? new Date(parsed.exportedAt * 1000).toLocaleString()
                : 'unknown';
            const sameDevice = (sourceDevice === DeviceState.deviceId);

            let msg = `From device: ${sourceDevice}${sameDevice ? ' (this device)' : ' ⚠ different device'}\n`;
            msg += `Exported: ${exportedAt}\n`;
            msg += `Schema: v${parsed.schemaVersion}\n\n`;

            if (diffs.length === 0) {
                msg += 'No differences — this backup matches your current settings.';
            } else {
                msg += `${diffs.length} setting(s) will change:\n\n`;
                msg += diffs.slice(0, 15)
                    .map(d => `• ${d.key}: ${JSON.stringify(d.from)} → ${JSON.stringify(d.to)}`)
                    .join('\n');
                if (diffs.length > 15) msg += `\n• …and ${diffs.length - 15} more`;
            }

            Modal.confirm('Restore Configuration', msg, () => {
                if (!DeviceState.connected) {
                    Toast.error('Device offline — restore aborted');
                    return false;
                }
                // Forward the entire envelope as `payload` so the device
                // can verify its own signature.
                MQTTClient.publishControl(DeviceState.deviceId, {
                    command: 'importConfig',
                    payload: parsed
                });
                Toast.info('Restore sent — waiting for device to apply…');
                return true;
            });
        });
    }

    // Factory Reset Device Handler
    const factoryResetBtn = document.getElementById('factoryResetBtn');
    if (factoryResetBtn) {
        factoryResetBtn.addEventListener('click', () => {
            Haptic.heavy();
            Modal.confirm(
                '⚠️ Factory Reset Device',
                'Are you absolutely sure you want to completely erase the device? This will wipe WiFi credentials, calibration data, and all settings. The device will reboot into Setup Mode.\n\nThis cannot be undone.',
                async () => {
                    if (typeof MQTTClient !== 'undefined' && DeviceState.connected) {
                        MQTTClient.publishConfig(DeviceState.deviceId, {
                            cmd: 'factory_reset'
                        });
                        Toast.success('Factory reset command sent. Device is rebooting...');

                        setTimeout(() => {
                            window.location.href = 'index.html';
                        }, 2000);
                    } else {
                        Toast.error('Cannot reset device: Not connected via MQTT.');
                    }
                    return true;
                }
            );
        });
    }

    // Remove Device Handler
    const removeDeviceBtn = document.getElementById('removeDeviceBtn');
    if (removeDeviceBtn) {
        removeDeviceBtn.addEventListener('click', () => {
            Haptic.heavy();
            Modal.confirm('⚠️ Remove Device', 'Are you sure you want to remove this device from your account? This action cannot be undone and will delete all configuration.', async () => {
                const user = (typeof Auth !== 'undefined') ? Auth.getUser() : null;
                if (user && DeviceState && DeviceState.deviceId) {
                    try {
                        const originalHtml = removeDeviceBtn.innerHTML;
                        removeDeviceBtn.disabled = true;
                        removeDeviceBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-trash-2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg> Removing...';

                        const success = await DeviceService.removeDevice(window.activeHomeId, DeviceState.deviceId);

                        if (success) {
                            Toast.success('Device removed successfully.');
                            setTimeout(() => { window.location.href = 'index.html'; }, 500);
                        } else {
                            Toast.error('Failed to remove device. Please try again.');
                            removeDeviceBtn.disabled = false;
                            removeDeviceBtn.innerHTML = originalHtml;
                        }
                    } catch (error) {
                        console.error('Error removing device:', error);
                        Toast.error('Error removing device.');
                        removeDeviceBtn.disabled = false;
                        removeDeviceBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-trash-2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg> Remove Device';
                    }
                } else {
                    Toast.error('Authentication Error. Cannot remove device.');
                }
                return true;
            });
        });
    }
}

/**
 * Setup Servo Calibration UI - Interactive modal with live preview and test functionality
 * @param {string} configKey - The config key to update (e.g., 'angleOff', 'angleOn')
 * @param {string} title - Display title for the setting
 * @param {string} displayId - ID of the element to update with current value
 * @param {string} emoji - Emoji indicator for the position
 */
function setupServoCalibration_Legacy(configKey, title, displayId, emoji) { // Legacy - replaced by professional version below
    const element = document.querySelector(`[data-setting="${configKey}"]`);
    if (!element) return;

    element.addEventListener('click', () => {
        const config = DeviceState.state?.config || {};
        const currentAngle = config[configKey] ?? (configKey === 'angleOff' ? 0 : 180);

        let selectedAngle = currentAngle;

        const content = `
            <div style="margin-bottom: var(--spacing-lg);">
                <div style="display: flex; align-items: center; gap: var(--spacing-sm); margin-bottom: var(--spacing-sm);">
                    <span style="font-size: 1.5em;">${emoji}</span>
                    <div>
                        <div style="font-weight: 600; color: var(--text-primary);">${title}</div>
                        <div style="font-size: var(--font-size-sm); color: var(--text-secondary);">
                            Adjust the servo angle for this switch position.
                        </div>
                    </div>
                </div>
                <div style="background: linear-gradient(135deg, rgba(99, 102, 241, 0.1), rgba(139, 92, 246, 0.05)); 
                            border-radius: var(--radius-md); padding: var(--spacing-sm) var(--spacing-md); 
                            margin-top: var(--spacing-md); border: 1px solid rgba(99, 102, 241, 0.2);
                            font-size: var(--font-size-sm); color: var(--text-secondary);">
                    🔧 <strong>Tip:</strong> Use the Test button to preview the angle on the device.
                </div>
            </div>
            
            <!-- Angle Display -->
            <div style="text-align: center; margin-bottom: var(--spacing-lg);">
                <div id="servoAngleDisplay" style="font-size: 3em; font-weight: 700; 
                            background: var(--accent-gradient); -webkit-background-clip: text; 
                            -webkit-text-fill-color: transparent; background-clip: text;">
                    ${currentAngle}°
                </div>
            </div>
            
            <!-- Slider -->
            <div style="padding: 0 var(--spacing-md); margin-bottom: var(--spacing-lg);">
                <input type="range" id="servoSlider" min="0" max="180" value="${currentAngle}" 
                       style="width: 100%; height: 8px; -webkit-appearance: none; appearance: none;
                              background: linear-gradient(90deg, var(--accent-primary), var(--accent-secondary));
                              border-radius: 4px; outline: none; cursor: pointer;">
            </div>
            
            <!-- Quick presets -->
            <div style="display: flex; gap: var(--spacing-sm); justify-content: center; margin-bottom: var(--spacing-lg);">
                <button class="btn btn-secondary btn-sm" data-preset="0">0°</button>
                <button class="btn btn-secondary btn-sm" data-preset="45">45°</button>
                <button class="btn btn-secondary btn-sm" data-preset="90">90°</button>
                <button class="btn btn-secondary btn-sm" data-preset="135">135°</button>
                <button class="btn btn-secondary btn-sm" data-preset="180">180°</button>
            </div>
            
            <!-- Test button -->
            <div style="text-align: center;">
                <button id="testServoBtn" class="btn btn-secondary" style="gap: var(--spacing-xs);">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg> Test Position
                </button>
            </div>
        `;

        const { backdrop, modal, close } = Modal.create({
            title: `${emoji} ${title}`,
            content,
            actions: [
                { label: 'Cancel', primary: false },
                {
                    label: '✓ Save',
                    primary: true,
                    onClick: () => {
                        MQTTClient.publishConfig(DeviceState.deviceId, { [configKey]: selectedAngle });

                        // Update display
                        const displayEl = document.getElementById(displayId);
                        if (displayEl) displayEl.textContent = `${selectedAngle}°`;

                        Toast.success(`${title} set to ${selectedAngle}°`);
                    }
                }
            ]
        });

        const slider = modal.querySelector('#servoSlider');
        const angleDisplay = modal.querySelector('#servoAngleDisplay');
        const testBtn = modal.querySelector('#testServoBtn');

        // Slider change handler
        slider.addEventListener('input', (e) => {
            selectedAngle = parseInt(e.target.value);
            angleDisplay.textContent = `${selectedAngle}°`;
        });

        // Preset buttons
        modal.querySelectorAll('[data-preset]').forEach(btn => {
            btn.addEventListener('click', () => {
                selectedAngle = parseInt(btn.dataset.preset);
                slider.value = selectedAngle;
                angleDisplay.textContent = `${selectedAngle}°`;
            });
        });

        // Test button - sends the angle to device for preview
        testBtn.addEventListener('click', () => {
            MQTTClient.publishControl(DeviceState.deviceId, {
                command: 'testServo',
                angle: selectedAngle
            });
            Toast.info(`Testing angle: ${selectedAngle}°`);
        });
    });
}

// ============================================
// Professional Servo Calibration Modal
// ============================================
function setupServoCalibration(settingId, title, displayId, emoji) {
    const element = document.querySelector(`[data-setting="${settingId}"]`);
    if (!element) return;

    element.addEventListener('click', () => {
        const config = DeviceState.state?.config || {};
        const configKey = settingId;
        const currentValue = config[configKey] ?? 90;
        const otherKey = settingId === 'angleOn' ? 'angleOff' : 'angleOn';
        const otherValue = config[otherKey] ?? (settingId === 'angleOn' ? 0 : 90);

        let selectedAngle = currentValue;
        let lastTestedAngle = null;

        // Send servo command to device
        const sendServoCommand = (angle) => {
            console.log(`[Servo] Moving to: ${angle}°`);
            MQTTClient.publishControl(DeviceState.deviceId, {
                command: 'calibrate',
                angle: angle
            });
        };

        const content = `
            <style>
                .servo-cal-modal {
                    display: flex;
                    flex-direction: column;
                    gap: var(--spacing-xl);
                }
                
                /* === VISUAL SECTION === */
                .servo-visual-section {
                    position: relative;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    padding: var(--spacing-xl) var(--spacing-lg);
                    background: radial-gradient(ellipse at center, rgba(99, 102, 241, 0.12) 0%, transparent 70%);
                    border-radius: var(--radius-2xl);
                    border: 1px solid rgba(99, 102, 241, 0.2);
                    overflow: hidden;
                }
                
                .servo-visual-section::before {
                    content: '';
                    position: absolute;
                    inset: 0;
                    background: linear-gradient(180deg, transparent 0%, rgba(99, 102, 241, 0.05) 100%);
                    pointer-events: none;
                }
                
                .servo-display {
                    position: relative;
                    width: 200px;
                    height: 200px;
                }
                
                .servo-svg {
                    width: 100%;
                    height: 100%;
                    filter: drop-shadow(0 8px 24px rgba(99, 102, 241, 0.3));
                }
                
                /* Degree markers */
                .degree-marker {
                    font-size: 11px;
                    font-weight: 600;
                    fill: var(--text-tertiary);
                }
                .degree-marker.active {
                    fill: var(--accent);
                }
                
                /* Servo body */
                .servo-body {
                    fill: var(--bg-tertiary);
                    stroke: var(--border-glass);
                    stroke-width: 2;
                }
                
                /* Dual arm design */
                .servo-arms {
                    transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
                    transform-origin: 100px 100px;
                }
                
                .servo-arm-piece {
                    fill: url(#armGradient);
                    filter: drop-shadow(0 2px 6px rgba(99, 102, 241, 0.5));
                }
                
                .servo-arm-hole {
                    fill: var(--bg-tertiary);
                    stroke: rgba(255,255,255,0.1);
                    stroke-width: 1;
                }
                
                .servo-center-hub {
                    fill: var(--text-primary);
                }
                
                .servo-center-dot {
                    fill: var(--bg-primary);
                }
                
                /* Angle display */
                .angle-readout {
                    margin-top: var(--spacing-lg);
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: var(--spacing-xs);
                }
                
                .angle-value {
                    font-size: 3em;
                    font-weight: 800;
                    background: var(--accent-gradient);
                    -webkit-background-clip: text;
                    -webkit-text-fill-color: transparent;
                    background-clip: text;
                    line-height: 1;
                    font-variant-numeric: tabular-nums;
                }
                
                .angle-label {
                    font-size: var(--font-size-sm);
                    color: var(--text-tertiary);
                    text-transform: uppercase;
                    letter-spacing: 1px;
                }
                
                /* === CONTROLS SECTION === */
                .servo-controls-section {
                    display: flex;
                    flex-direction: column;
                    gap: var(--spacing-lg);
                }
                
                /* Slider */
                .slider-wrapper {
                    background: var(--bg-glass);
                    border-radius: var(--radius-xl);
                    padding: var(--spacing-lg);
                    border: 1px solid var(--border-glass);
                }
                
                .angle-slider {
                    width: 100%;
                    height: 12px;
                    appearance: none;
                    -webkit-appearance: none;
                    background: linear-gradient(90deg, 
                        rgba(239, 68, 68, 0.3) 0%, 
                        rgba(99, 102, 241, 0.5) 50%, 
                        rgba(34, 197, 94, 0.3) 100%);
                    border-radius: 6px;
                    outline: none;
                    cursor: pointer;
                }
                
                .angle-slider::-webkit-slider-thumb {
                    appearance: none;
                    -webkit-appearance: none;
                    width: 32px;
                    height: 32px;
                    background: var(--accent);
                    border-radius: 50%;
                    cursor: grab;
                    box-shadow: 
                        0 4px 12px rgba(99, 102, 241, 0.5),
                        0 0 0 4px rgba(99, 102, 241, 0.2),
                        inset 0 2px 4px rgba(255,255,255,0.3);
                    transition: transform 0.15s ease, box-shadow 0.15s ease;
                }
                
                .angle-slider::-webkit-slider-thumb:hover {
                    transform: scale(1.1);
                }
                
                .angle-slider::-webkit-slider-thumb:active {
                    cursor: grabbing;
                    transform: scale(1.05);
                }
                
                .slider-labels {
                    display: flex;
                    justify-content: space-between;
                    margin-top: var(--spacing-sm);
                    padding: 0 var(--spacing-xs);
                }
                
                .slider-label {
                    font-size: var(--font-size-xs);
                    color: var(--text-tertiary);
                    font-weight: 500;
                }
                
                /* Input + Presets row */
                .input-presets-row {
                    display: flex;
                    gap: var(--spacing-md);
                    align-items: stretch;
                }
                
                .angle-input-wrapper {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: var(--spacing-xs);
                }
                
                .angle-input {
                    width: 90px;
                    padding: var(--spacing-md);
                    font-size: 1.5em;
                    font-weight: 700;
                    text-align: center;
                    background: var(--bg-glass);
                    border: 2px solid var(--border-glass);
                    border-radius: var(--radius-lg);
                    color: var(--text-primary);
                    font-variant-numeric: tabular-nums;
                    transition: all 0.2s ease;
                }
                
                .angle-input:focus {
                    outline: none;
                    border-color: var(--accent);
                    box-shadow: 0 0 0 4px rgba(99, 102, 241, 0.15);
                }
                
                .angle-input-label {
                    font-size: var(--font-size-xs);
                    color: var(--text-tertiary);
                }
                
                .preset-grid {
                    flex: 1;
                    display: grid;
                    grid-template-columns: repeat(5, 1fr);
                    gap: var(--spacing-xs);
                }
                
                .preset-btn {
                    padding: var(--spacing-sm) var(--spacing-xs);
                    background: var(--bg-glass);
                    border: 1px solid var(--border-glass);
                    border-radius: var(--radius-md);
                    color: var(--text-secondary);
                    font-size: var(--font-size-sm);
                    font-weight: 600;
                    cursor: pointer;
                    transition: all 0.2s ease;
                }
                
                .preset-btn:hover {
                    background: var(--bg-glass-strong);
                    border-color: var(--accent);
                    color: var(--text-primary);
                    transform: translateY(-1px);
                }
                
                .preset-btn.active {
                    background: linear-gradient(135deg, rgba(99, 102, 241, 0.3), rgba(139, 92, 246, 0.2));
                    border-color: var(--accent);
                    color: var(--accent);
                }
                
                /* Test button - PROMINENT */
                .test-btn-primary {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: var(--spacing-sm);
                    padding: var(--spacing-lg);
                    background: linear-gradient(135deg, var(--accent), #8b5cf6);
                    border: none;
                    border-radius: var(--radius-xl);
                    color: white;
                    font-size: var(--font-size-md);
                    font-weight: 600;
                    cursor: pointer;
                    transition: all 0.2s ease;
                    box-shadow: 0 4px 16px rgba(99, 102, 241, 0.4);
                }
                
                .test-btn-primary:hover {
                    transform: translateY(-2px);
                    box-shadow: 0 6px 20px rgba(99, 102, 241, 0.5);
                }
                
                .test-btn-primary:active {
                    transform: translateY(0);
                }
                
                .test-btn-primary.testing {
                    animation: pulse-glow 0.6s ease;
                }
                
                @keyframes pulse-glow {
                    0%, 100% { box-shadow: 0 4px 16px rgba(99, 102, 241, 0.4); }
                    50% { box-shadow: 0 4px 30px rgba(99, 102, 241, 0.8); }
                }
                
                /* Quick test buttons */
                .quick-tests {
                    display: flex;
                    gap: var(--spacing-sm);
                }
                
                .quick-test-btn {
                    flex: 1;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: var(--spacing-xs);
                    padding: var(--spacing-md);
                    background: var(--bg-glass);
                    border: 1px solid var(--border-glass);
                    border-radius: var(--radius-lg);
                    color: var(--text-secondary);
                    font-size: var(--font-size-sm);
                    font-weight: 500;
                    cursor: pointer;
                    transition: all 0.2s ease;
                }
                
                .quick-test-btn:hover {
                    background: var(--bg-glass-strong);
                    color: var(--text-primary);
                }
                
                /* Status bar */
                .test-status {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: var(--spacing-sm);
                    padding: var(--spacing-sm) var(--spacing-md);
                    background: var(--bg-glass);
                    border-radius: var(--radius-lg);
                    font-size: var(--font-size-sm);
                    color: var(--text-tertiary);
                    min-height: 40px;
                }
                
                .test-status.tested {
                    background: linear-gradient(135deg, rgba(34, 197, 94, 0.15), rgba(22, 163, 74, 0.1));
                    border: 1px solid rgba(34, 197, 94, 0.3);
                    color: #22c55e;
                }
                
                .status-dot {
                    width: 8px;
                    height: 8px;
                    border-radius: 50%;
                    background: var(--text-tertiary);
                }
                
                .test-status.tested .status-dot {
                    background: #22c55e;
                    animation: status-pulse 2s infinite;
                }
                
                @keyframes status-pulse {
                    0%, 100% { opacity: 1; }
                    50% { opacity: 0.5; }
                }
            </style>
            
            <div class="servo-cal-modal">
                <div class="servo-visual-section">
                    <div class="servo-display">
                        <svg class="servo-svg" viewBox="0 0 200 200">
                            <defs>
                                <linearGradient id="armGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                                    <stop offset="0%" style="stop-color:#6366f1"/>
                                    <stop offset="100%" style="stop-color:#8b5cf6"/>
                                </linearGradient>
                            </defs>
                            
                            <!-- Degree markers around the circle -->
                            <g class="degree-markers">
                                ${[0, 45, 90, 135, 180].map(deg => {
            const rad = (90 - deg) * Math.PI / 180;
            const x = 100 + 85 * Math.cos(rad);
            const y = 100 - 85 * Math.sin(rad);
            const tickX1 = 100 + 68 * Math.cos(rad);
            const tickY1 = 100 - 68 * Math.sin(rad);
            const tickX2 = 100 + 75 * Math.cos(rad);
            const tickY2 = 100 - 75 * Math.sin(rad);
            return `
                                        <line x1="${tickX1}" y1="${tickY1}" x2="${tickX2}" y2="${tickY2}" 
                                              stroke="var(--text-tertiary)" stroke-width="2" opacity="0.5"/>
                                        <text x="${x}" y="${y + 4}" text-anchor="middle" 
                                              class="degree-marker" id="marker${deg}">${deg}°</text>
                                    `;
        }).join('')}
                            </g>
                            
                            <!-- Servo body (outer ring) -->
                            <circle class="servo-body" cx="100" cy="100" r="55"/>
                            
                            <!-- Ghost arm showing other position -->
                            <g opacity="0.2" style="transform: rotate(${90 - otherValue}deg); transform-origin: 100px 100px;">
                                <rect x="94" y="50" width="12" height="52" rx="6" fill="var(--text-tertiary)"/>
                                <rect x="94" y="98" width="12" height="52" rx="6" fill="var(--text-tertiary)"/>
                            </g>
                            
                            <!-- DUAL SERVO ARMS - connected at center, vertical = 90° -->
                            <g class="servo-arms" id="servoArms" style="transform: rotate(${90 - currentValue}deg);">
                                <!-- Upper arm -->
                                <rect class="servo-arm-piece" x="91" y="45" width="18" height="56" rx="9"/>
                                <circle class="servo-arm-hole" cx="100" cy="55" r="4"/>
                                
                                <!-- Lower arm -->
                                <rect class="servo-arm-piece" x="91" y="99" width="18" height="56" rx="9"/>
                                <circle class="servo-arm-hole" cx="100" cy="145" r="4"/>
                            </g>
                            
                            <!-- Center hub -->
                            <circle class="servo-center-hub" cx="100" cy="100" r="14"/>
                            <circle class="servo-center-dot" cx="100" cy="100" r="6"/>
                            <circle cx="100" cy="100" r="3" fill="var(--accent)" opacity="0.8"/>
                        </svg>
                    </div>
                    
                    <div class="angle-readout">
                        <div class="angle-value"><span id="angleValue">${currentValue}</span>°</div>
                        <div class="angle-label">Selected Angle</div>
                    </div>
                </div>
                
                <div class="servo-controls-section">
                    <div class="slider-wrapper">
                        <input type="range" class="angle-slider" id="angleSlider" 
                               min="0" max="180" value="${currentValue}">
                        <div class="slider-labels">
                            <span class="slider-label">0° (Left)</span>
                            <span class="slider-label">90° (Center)</span>
                            <span class="slider-label">180° (Right)</span>
                        </div>
                    </div>
                    
                    <div class="input-presets-row">
                        <div class="angle-input-wrapper">
                            <input type="number" class="angle-input" id="angleInput" 
                                   min="0" max="180" value="${currentValue}">
                            <span class="angle-input-label">Degrees</span>
                        </div>
                        <div class="preset-grid">
                            <button class="preset-btn ${currentValue === 0 ? 'active' : ''}" data-angle="0">0°</button>
                            <button class="preset-btn ${currentValue === 45 ? 'active' : ''}" data-angle="45">45°</button>
                            <button class="preset-btn ${currentValue === 90 ? 'active' : ''}" data-angle="90">90°</button>
                            <button class="preset-btn ${currentValue === 135 ? 'active' : ''}" data-angle="135">135°</button>
                            <button class="preset-btn ${currentValue === 180 ? 'active' : ''}" data-angle="180">180°</button>
                        </div>
                    </div>
                    
                    <button class="test-btn-primary" id="testSelectedBtn">
                        🎯 Test This Angle
                    </button>
                    
                    <div class="quick-tests">
                        <button class="quick-test-btn" id="testSavedBtn">
                            📌 Test Saved (${currentValue}°)
                        </button>
                        <button class="quick-test-btn" id="testOtherBtn">
                            ${settingId === 'angleOn' ? '🔴' : '🟢'} Test ${settingId === 'angleOn' ? 'OFF' : 'ON'} (${otherValue}°)
                        </button>
                    </div>
                    
                    <div class="test-status" id="testStatus">
                        <span class="status-dot"></span>
                        <span id="statusText">Adjust angle, then press "Test This Angle"</span>
                    </div>
                </div>
            </div>
        `;

        const { backdrop, modal, close } = Modal.create({
            title: `${emoji} ${title}`,
            content,
            actions: [
                { label: 'Cancel', primary: false },
                {
                    label: '✓ Save Position',
                    primary: true,
                    onClick: () => {
                        const payload = {};
                        payload[configKey] = selectedAngle;
                        MQTTClient.publishConfig(DeviceState.deviceId, payload);
                        document.getElementById(displayId).textContent = `${selectedAngle}°`;
                        Toast.success(`${title} saved as ${selectedAngle}°`);
                    }
                }
            ]
        });

        // Get elements
        const slider = modal.querySelector('#angleSlider');
        const input = modal.querySelector('#angleInput');
        const angleValue = modal.querySelector('#angleValue');
        const servoArms = modal.querySelector('#servoArms');
        const presetBtns = modal.querySelectorAll('.preset-btn');
        const testSelectedBtn = modal.querySelector('#testSelectedBtn');
        const testSavedBtn = modal.querySelector('#testSavedBtn');
        const testOtherBtn = modal.querySelector('#testOtherBtn');
        const testStatus = modal.querySelector('#testStatus');
        const statusText = modal.querySelector('#statusText');

        // Update visual only (no device command)
        const updateVisual = (angle) => {
            angle = Math.max(0, Math.min(180, parseInt(angle) || 0));
            selectedAngle = angle;

            slider.value = angle;
            input.value = angle;
            angleValue.textContent = angle;

            // Update the visual servo arm
            servoArms.style.transform = `rotate(${90 - angle}deg)`;

            // Update preset buttons
            presetBtns.forEach(btn => {
                btn.classList.toggle('active', parseInt(btn.dataset.angle) === angle);
            });

            // Update status if not tested yet
            if (lastTestedAngle !== angle) {
                testStatus.classList.remove('tested');
                statusText.textContent = 'Adjust angle, then press "Test This Angle"';
            }
        };

        // Test button animation
        const animateTest = (btn) => {
            btn.classList.add('testing');
            setTimeout(() => btn.classList.remove('testing'), 600);
        };

        // Slider input
        slider.addEventListener('input', (e) => updateVisual(e.target.value));

        // Number input
        input.addEventListener('input', (e) => updateVisual(e.target.value));
        input.addEventListener('change', (e) => updateVisual(e.target.value));

        // Preset buttons
        presetBtns.forEach(btn => {
            btn.addEventListener('click', () => updateVisual(btn.dataset.angle));
        });

        // TEST THIS ANGLE - main button
        testSelectedBtn.addEventListener('click', () => {
            sendServoCommand(selectedAngle);
            // Update the visual servo arm ONLY on Test
            servoArms.style.transform = `rotate(${90 - selectedAngle}deg)`;
            lastTestedAngle = selectedAngle;
            testStatus.classList.add('tested');
            statusText.textContent = `✓ Tested: ${selectedAngle}° — servo moved!`;
            animateTest(testSelectedBtn);
            Toast.success(`Testing ${selectedAngle}°`);
        });

        // Test saved position
        testSavedBtn.addEventListener('click', () => {
            sendServoCommand(currentValue);
            Toast.success(`Testing saved position: ${currentValue}°`);
        });

        // Test other position
        testOtherBtn.addEventListener('click', () => {
            sendServoCommand(otherValue);
            Toast.success(`Testing ${settingId === 'angleOn' ? 'OFF' : 'ON'}: ${otherValue}°`);
        });
    });
}

// ============================================
// Professional Servo Speed UI
// ============================================
function setupServoSpeedUI() {
    const element = document.querySelector(`[data-setting="servoSpeed"]`);
    if (!element) return;

    element.addEventListener('click', () => {
        const config = DeviceState.state?.config || {};
        const currentValue = config.servoSpeed ?? 0;

        let selectedSpeed = currentValue;

        // Presets definition
        const presets = [
            { value: 0, icon: '⚡', label: 'Instant', desc: 'Fastest response — flips the switch immediately' },
            { value: 30, icon: '🤫', label: 'Quiet', desc: 'Fast enough to flip reliably, much quieter' },
            { value: 10, icon: '🐢', label: 'Slow', desc: 'Slowest and quietest — gentle motion' }
        ];

        const getActivePreset = (val) => presets.find(p => p.value === val);
        const activePreset = getActivePreset(currentValue);

        const content = `
            <style>
                .speed-presets {
                    display: flex;
                    flex-direction: column;
                    gap: var(--spacing-sm);
                    margin-bottom: var(--spacing-lg);
                }
                .speed-preset-btn {
                    display: flex;
                    align-items: center;
                    gap: var(--spacing-md);
                    padding: var(--spacing-md) var(--spacing-lg);
                    background: var(--bg-glass);
                    border: 2px solid var(--border-glass);
                    border-radius: var(--radius-xl);
                    cursor: pointer;
                    transition: all 0.2s ease;
                    text-align: left;
                }
                .speed-preset-btn:hover {
                    background: var(--bg-glass-strong);
                    border-color: rgba(99, 102, 241, 0.3);
                }
                .speed-preset-btn.active {
                    background: linear-gradient(135deg, rgba(99, 102, 241, 0.15), rgba(139, 92, 246, 0.1));
                    border-color: var(--accent);
                    box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
                }
                .speed-preset-icon {
                    font-size: 1.8em;
                    width: 44px;
                    height: 44px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    background: var(--bg-glass-strong);
                    border-radius: var(--radius-lg);
                    flex-shrink: 0;
                }
                .speed-preset-btn.active .speed-preset-icon {
                    background: linear-gradient(135deg, var(--accent), #8b5cf6);
                    box-shadow: 0 4px 12px rgba(99, 102, 241, 0.4);
                }
                .speed-preset-info {
                    flex: 1;
                    min-width: 0;
                }
                .speed-preset-label {
                    font-weight: 600;
                    font-size: var(--font-size-md);
                    color: var(--text-primary);
                    margin-bottom: 2px;
                }
                .speed-preset-btn.active .speed-preset-label {
                    color: var(--accent);
                }
                .speed-preset-desc {
                    font-size: var(--font-size-sm);
                    color: var(--text-tertiary);
                    line-height: 1.3;
                }
                .speed-preset-check {
                    width: 24px;
                    height: 24px;
                    border-radius: 50%;
                    border: 2px solid var(--border-glass);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    flex-shrink: 0;
                    transition: all 0.2s ease;
                }
                .speed-preset-btn.active .speed-preset-check {
                    background: var(--accent);
                    border-color: var(--accent);
                    color: white;
                }
                .speed-advanced-toggle {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: var(--spacing-xs);
                    padding: var(--spacing-sm);
                    background: none;
                    border: none;
                    color: var(--text-tertiary);
                    font-size: var(--font-size-sm);
                    font-weight: 500;
                    cursor: pointer;
                    transition: color 0.2s ease;
                    width: 100%;
                    font-family: inherit;
                }
                .speed-advanced-toggle:hover {
                    color: var(--text-secondary);
                }
                .speed-advanced-toggle svg {
                    transition: transform 0.2s ease;
                }
                .speed-advanced-toggle.open svg {
                    transform: rotate(180deg);
                }
                .speed-advanced-panel {
                    display: none;
                    padding-top: var(--spacing-md);
                }
                .speed-advanced-panel.open {
                    display: block;
                }
                .speed-slider-wrapper {
                    background: var(--bg-glass);
                    border-radius: var(--radius-xl);
                    padding: var(--spacing-lg);
                    border: 1px solid var(--border-glass);
                }
                .speed-slider {
                    width: 100%;
                    height: 12px;
                    appearance: none;
                    -webkit-appearance: none;
                    background: linear-gradient(90deg, 
                        rgba(99, 102, 241, 0.3) 0%, 
                        rgba(99, 102, 241, 0.8) 100%);
                    border-radius: 6px;
                    outline: none;
                    cursor: pointer;
                }
                .speed-slider::-webkit-slider-thumb {
                    appearance: none;
                    -webkit-appearance: none;
                    width: 32px;
                    height: 32px;
                    background: var(--accent);
                    border-radius: 50%;
                    cursor: grab;
                    box-shadow: 
                        0 4px 12px rgba(99, 102, 241, 0.5),
                        0 0 0 4px rgba(99, 102, 241, 0.2),
                        inset 0 2px 4px rgba(255,255,255,0.3);
                    transition: transform 0.15s ease, box-shadow 0.15s ease;
                }
                .speed-slider::-webkit-slider-thumb:hover {
                    transform: scale(1.1);
                }
                .speed-slider::-webkit-slider-thumb:active {
                    cursor: grabbing;
                    transform: scale(1.05);
                }
                .speed-slider-labels {
                    display: flex;
                    justify-content: space-between;
                    margin-top: var(--spacing-sm);
                    padding: 0 var(--spacing-xs);
                }
                .speed-slider-label {
                    font-size: var(--font-size-xs);
                    color: var(--text-tertiary);
                    font-weight: 500;
                }
                .speed-slider-readout {
                    text-align: center;
                    font-size: var(--font-size-lg);
                    font-weight: 700;
                    color: var(--accent);
                    margin-bottom: var(--spacing-sm);
                    font-variant-numeric: tabular-nums;
                }
            </style>
            
            <div style="margin-bottom: var(--spacing-lg);">
                <div style="display: flex; align-items: center; gap: var(--spacing-sm); margin-bottom: var(--spacing-sm);">
                    <span style="font-size: 1.5em;">🏎️</span>
                    <div>
                        <div style="font-weight: 600; color: var(--text-primary);">Servo Speed</div>
                        <div style="font-size: var(--font-size-sm); color: var(--text-secondary);">
                            Choose how the servo moves between positions.
                        </div>
                    </div>
                </div>
            </div>
            
            <div class="speed-presets">
                ${presets.map(p => `
                    <button class="speed-preset-btn ${selectedSpeed === p.value ? 'active' : ''}" data-speed="${p.value}">
                        <div class="speed-preset-icon">${p.icon}</div>
                        <div class="speed-preset-info">
                            <div class="speed-preset-label">${p.label}</div>
                            <div class="speed-preset-desc">${p.desc}</div>
                        </div>
                        <div class="speed-preset-check">
                            ${selectedSpeed === p.value ? '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' : ''}
                        </div>
                    </button>
                `).join('')}
            </div>
            
            <button class="speed-advanced-toggle" id="advancedToggle">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
                Advanced — Custom Value
            </button>
            
            <div class="speed-advanced-panel" id="advancedPanel">
                <div class="speed-slider-wrapper">
                    <div class="speed-slider-readout" id="sliderReadout">${selectedSpeed === 0 ? 'Instant' : selectedSpeed + '%'}</div>
                    <input type="range" class="speed-slider" id="speedSlider" 
                           min="0" max="100" value="${selectedSpeed}" step="1">
                    <div class="speed-slider-labels">
                        <span class="speed-slider-label">Instant</span>
                        <span class="speed-slider-label">Fastest Sweep</span>
                    </div>
                </div>
            </div>
            
            <button class="btn btn-secondary" id="defaultSpeedBtn" style="width: 100%; justify-content: center; gap: var(--spacing-xs); margin-top: var(--spacing-md);">
                <span style="font-size: 1.2em; display:inline-flex; align-items:center;"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg></span> Reset to Default (Instant)
            </button>
        `;

        const { backdrop, modal, close } = Modal.create({
            title: '<span style=\"display:inline-flex; align-items:center; gap:6px;\"><svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10\"/></svg> Servo Speed</span>',
            content,
            actions: [
                { label: 'Cancel', primary: false },
                {
                    label: '✓ Save',
                    primary: true,
                    onClick: () => {
                        MQTTClient.publishConfig(DeviceState.deviceId, { servoSpeed: selectedSpeed });
                        const displayEl = document.getElementById('servoSpeedValue');
                        if (displayEl) {
                            const preset = presets.find(p => p.value === selectedSpeed);
                            displayEl.textContent = preset ? preset.label : `${selectedSpeed}%`;
                        }
                        const preset = presets.find(p => p.value === selectedSpeed);
                        Toast.success(`Servo speed set to ${preset ? preset.label : selectedSpeed + '%'}`);
                    }
                }
            ]
        });

        const presetBtns = modal.querySelectorAll('.speed-preset-btn');
        const slider = modal.querySelector('#speedSlider');
        const sliderReadout = modal.querySelector('#sliderReadout');
        const advancedToggle = modal.querySelector('#advancedToggle');
        const advancedPanel = modal.querySelector('#advancedPanel');
        const defaultBtn = modal.querySelector('#defaultSpeedBtn');

        const updatePresetUI = (val) => {
            selectedSpeed = parseInt(val);
            
            // Update preset button states
            presetBtns.forEach(btn => {
                const isActive = parseInt(btn.dataset.speed) === selectedSpeed;
                btn.classList.toggle('active', isActive);
                const check = btn.querySelector('.speed-preset-check');
                check.innerHTML = isActive 
                    ? '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'
                    : '';
            });
            
            // Update slider to match
            slider.value = selectedSpeed;
            sliderReadout.textContent = selectedSpeed === 0 ? 'Instant' : `${selectedSpeed}%`;
        };

        // Preset button clicks
        presetBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                updatePresetUI(btn.dataset.speed);
                Haptic.light();
            });
        });

        // Advanced toggle
        advancedToggle.addEventListener('click', () => {
            advancedToggle.classList.toggle('open');
            advancedPanel.classList.toggle('open');
        });

        // Slider input
        slider.addEventListener('input', (e) => {
            selectedSpeed = parseInt(e.target.value);
            sliderReadout.textContent = selectedSpeed === 0 ? 'Instant' : `${selectedSpeed}%`;
            
            // Deselect all preset buttons since user is using custom value
            presetBtns.forEach(btn => {
                const isActive = parseInt(btn.dataset.speed) === selectedSpeed;
                btn.classList.toggle('active', isActive);
                const check = btn.querySelector('.speed-preset-check');
                check.innerHTML = isActive
                    ? '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'
                    : '';
            });
        });

        // Reset to default (Instant)
        defaultBtn.addEventListener('click', () => {
            updatePresetUI(0);
            Haptic.light();
        });
    });
}

function setupSettingPicker(settingId, configKey, values, formatFn, displayId, onSave = null) {
    const element = document.querySelector(`[data-setting="${settingId}"]`);
    if (!element) return;

    // Setting metadata for personalized popups
    const settingMeta = {
        'presenceDisplayTimeout': {
            icon: '<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect width=\"20\" height=\"14\" x=\"2\" y=\"3\" rx=\"2\"/><line x1=\"8\" x2=\"16\" y1=\"21\" y2=\"21\"/><line x1=\"12\" x2=\"12\" y1=\"17\" y2=\"21\"/></svg>',
            title: 'Display Auto-Off',
            description: 'Screen will turn off after this duration when no presence is detected.',
            tip: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-lightbulb"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.9 1.2 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg> Lower values save power but may be inconvenient.'
        },
        // radarSensitivity: Removed — uses inline button controls instead of picker modal
        'angleOff': {
            icon: '<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"var(--danger)\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><circle cx=\"12\" cy=\"12\" r=\"10\"/></svg>',
            title: 'OFF Position Angle',
            description: 'The servo angle when turning the light switch OFF.',
            tip: '<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z\"/></svg> Test after saving to verify the angle is correct.'
        },
        'angleOn': {
            icon: '<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"var(--success)\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><circle cx=\"12\" cy=\"12\" r=\"10\"/></svg>',
            title: 'ON Position Angle',
            description: 'The servo angle when turning the light switch ON.',
            tip: '<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z\"/></svg> Test after saving to verify the angle is correct.'
        },
        'servoSpeed': {
            icon: '<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10\"/></svg>',
            title: 'Servo Speed',
            description: 'Controls how fast the servo moves between positions. 0 = instant (default), 1 = very slow, 100 = fast sweep.',
            tip: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-lightbulb"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.9 1.2 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg> A slower speed produces a quieter, smoother switch action. Set to 0 for the original instant behavior.'
        },
        'motionTimeout': {
            icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-timer"><line x1="10" x2="14" y1="2" y2="2"/><line x1="12" x2="15" y1="14" y2="11"/><circle cx="12" cy="14" r="8"/></svg>',
            title: 'Auto-Off Timer',
            description: 'How long to wait after motion stops before turning off the light.',
            tip: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-lightbulb"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.9 1.2 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg> Longer times = more convenience, shorter times = more savings.'
        },
        'manualTimeout': {
            icon: '<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M18 11V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v0\"/><path d=\"M14 10V4a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v2\"/><path d=\"M10 10.5V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v8\"/><path d=\"M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15\"/></svg>',
            title: 'Manual Mode Timer',
            description: 'How long to keep the light on in manual mode before auto-off.',
            tip: '<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><circle cx=\"12\" cy=\"13\" r=\"8\"/><path d=\"M12 9v4l2 2\"/><path d=\"M5 3 2 6\"/><path d=\"m22 6-3-3\"/><path d=\"M6.38 18.7 4 21\"/><path d=\"M17.64 18.67 20 21\"/></svg> Set to longer for reading or working.'
        },
        // NOTE: sunriseOffset and sunsetOffset have been removed — now managed globally from index page Settings.
        'lightWattage': {
            icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-lightbulb"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.9 1.2 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg>',
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
        icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-settings"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>',
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
            title: meta.title,
            content,
            actions: [
                {
                    label: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-pencil"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg> Custom',
                    primary: false,
                    onClick: () => {
                        // Open custom value input modal
                        close();
                        setTimeout(() => {
                            const customContent = `
                                <div style="margin-bottom: var(--spacing-lg);">
                                    <div style="display: flex; align-items: center; gap: var(--spacing-sm); margin-bottom: var(--spacing-md);">
                                        <span style="font-size: 1.5em;"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-pencil"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg></span>
                                        <div>
                                            <div style="font-weight: 600; color: var(--text-primary);">Custom Value</div>
                                            <div style="font-size: var(--font-size-sm); color: var(--text-secondary);">Enter your own value for ${meta.title}</div>
                                        </div>
                                    </div>
                                    <div style="background: linear-gradient(135deg, rgba(251, 191, 36, 0.1), rgba(245, 158, 11, 0.05)); 
                                                border-radius: var(--radius-md); padding: var(--spacing-sm) var(--spacing-md); 
                                                border: 1px solid rgba(251, 191, 36, 0.2);
                                                font-size: var(--font-size-sm); color: var(--text-secondary);">
                                        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-lightbulb"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.9 1.2 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg> Preset values: ${values.slice(0, 5).map(v => formatFn(v)).join(', ')}...
                                    </div>
                                </div>
                                <div class="input-group">
                                    <label style="display: block; margin-bottom: var(--spacing-xs); color: var(--text-secondary); font-size: var(--font-size-sm); font-weight: 500;">
                                        Enter value (in seconds for timers, degrees for angles, etc.):
                                    </label>
                                    <input type="number" id="customValueInput" class="modal-input" 
                                           placeholder="Enter a number" 
                                           value="${currentValue}"
                                           style="font-size: 1.2em; padding: var(--spacing-md); text-align: center; font-weight: 600;">
                                </div>
                            `;

                            Modal.create({
                                title: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-pencil"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg> Custom ${meta.title}`,
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
                                            if (onSave) onSave(customValue);
                                        }
                                    }
                                ]
                            });

                            // Focus input - disabled to prevent iOS/Android keyboard scroll jumps
                            setTimeout(() => {
                                const input = document.querySelector('#customValueInput');
                                if (input) {
                                    // input.focus();
                                    // input.select();
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
                        if (onSave) onSave(selectedValue);
                    }
                }
            ]
        });

        // Setup picker functionality
        const scroll = modal.querySelector('[data-picker-scroll]');
        const items = modal.querySelectorAll('.picker-item');
        const itemHeight = 44;

        // selectedIndex is already declared above

        // SERVO CALIBRATION LIVE PREVIEW
        // For angleOn/angleOff settings, send calibrate command to device
        // so user can see the servo move in real-time while scrolling
        const isServoSetting = (settingId === 'angleOn' || settingId === 'angleOff');
        let previewTimeout = null;
        const sendServoPreview = (angle) => {
            // Debounce preview commands to avoid MQTT spam
            clearTimeout(previewTimeout);
            previewTimeout = setTimeout(() => {
                console.log(`[Servo] Preview angle: ${angle}°`);
                MQTTClient.publishControl(DeviceState.deviceId, {
                    command: 'calibrate',
                    angle: angle
                });
            }, 100);
        };

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

                // Live preview for servo calibration
                if (isServoSetting) {
                    sendServoPreview(values[selectedIndex]);
                }
            }
        };

        scroll.addEventListener('scroll', updateSelection);

        // Snap to nearest on scroll end
        let scrollTimeout;
        scroll.addEventListener('scroll', () => {
            clearTimeout(scrollTimeout);
            // Reduced timeout for snappier feel (100ms -> 60ms)
            scrollTimeout = setTimeout(() => {
                scroll.scrollTo({
                    top: selectedIndex * itemHeight,
                    behavior: 'smooth'
                });
            }, 60);
        });

        // Tap to select functionality
        items.forEach((item, index) => {
            item.addEventListener('click', () => {
                // Smooth scroll to this item
                scroll.scrollTo({
                    top: index * itemHeight,
                    behavior: 'smooth'
                });
            });
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
                // Optimistic update in central StateStore
                StateStore.update(DeviceState.deviceId, {
                    isSleeping: true,
                    sleepStart: now,
                    mode: 3 // Optimistically sync mode to Sleep (3)
                });

                // Send command
                MQTTClient.publishControl(DeviceState.deviceId, { sleep: true, sleepStart: now, mode: 3, lastUpdated: now });

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

                // Optimistic update in central StateStore
                StateStore.update(DeviceState.deviceId, {
                    isSleeping: false,
                    sleepStart: null, // Clear start time
                    sleepHistory: newHistory,
                    mode: 0 // Optimistically sync mode to Auto (0)
                });

                // Send command
                MQTTClient.publishControl(DeviceState.deviceId, { sleep: false, sleepEnd: now, mode: 0, lastUpdated: now });

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

                DeviceService.updateDevice(window.activeHomeId, DeviceState.deviceId, updates)
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
                <span class="sleep-log-header-icon">${isEditing ? '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-pencil"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>' : '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-moon"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>'}</span>
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
                    <label class="sleep-log-section-label"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-sun"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg> Wake Time</label>
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
                <span class="sleep-log-duration-icon"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-timer"><line x1="10" x2="14" y1="2" y2="2"/><line x1="12" x2="15" y1="14" y2="11"/><circle cx="12" cy="14" r="8"/></svg></span>
                <div class="sleep-log-duration-text">
                    <span class="sleep-log-duration-label">Duration</span>
                    <span class="sleep-log-duration-value" id="sleepLogDurationPreview">--</span>
                </div>
            </div>
        </div>
    `;

    // Create the modal
    const { backdrop, modal, close } = Modal.create({
        title: isEditing ? '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-pencil"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg> Edit Sleep Session' : '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-moon"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg> Add Sleep Session',
        content,
        actions: [
            { label: 'Cancel', primary: false },
            {
                label: isEditing ? 'Save Changes' : 'Add Session',
                primary: true,
                onClick: () => {
                    if (!selectedDate) {
                        Toast.error('Please select a date');
                        return false;
                    }
                    const startDate = new Date(selectedDate);
                    startDate.setHours(bedtimeHour, bedtimeMin, 0, 0);
                    const endDate = new Date(selectedDate);
                    if (wakeHour < bedtimeHour || (wakeHour === bedtimeHour && wakeMin <= bedtimeMin)) {
                        endDate.setDate(endDate.getDate() + 1);
                    }
                    endDate.setHours(wakeHour, wakeMin, 0, 0);
                    const start = Math.floor(startDate.getTime() / 1000);
                    const end = Math.floor(endDate.getTime() / 1000);
                    const duration = end - start;
                    if (duration <= 0) {
                        Toast.error('Wake time must be after bedtime');
                        return false;
                    }
                    if (duration < 60) {
                        Toast.error('Sleep session is too short');
                        return false;
                    }
                    if (duration > 24 * 3600) {
                        Toast.error('Sleep session cannot be longer than 24 hours');
                        return false;
                    }
                    if (isEditing) {
                        MQTTClient.publishControl(DeviceState.deviceId, {
                            command: 'editSleepSession',
                            oldStart: existingSession.start,
                            newStart: start,
                            newEnd: end
                        });
                        Toast.success('Sleep session updated');
                        if (DeviceState.state.sleepHistory && DeviceState.state.sleepHistory[index]) {
                            DeviceState.state.sleepHistory[index] = { start, end };
                            DeviceState.state.sleepHistory.sort((a, b) => b.start - a.start);
                        }
                    } else {
                        MQTTClient.publishControl(DeviceState.deviceId, {
                            command: 'addSleepSession',
                            start,
                            end
                        });
                        Toast.success('Sleep session added');
                        if (!DeviceState.state.sleepHistory) DeviceState.state.sleepHistory = [];
                        DeviceState.state.sleepHistory.unshift({ start, end });
                        DeviceState.state.sleepHistory.sort((a, b) => b.start - a.start);
                    }
                    updateSleepUI(DeviceState.state);
                    const user = Auth.getUser();
                    if (user) {
                        DeviceService.updateDevice(window.activeHomeId, DeviceState.deviceId, {
                            sleepHistory: DeviceState.state.sleepHistory
                        }).then(() => console.log('[Device] Sleep history synced to Firebase'))
                            .catch(e => {
                                console.warn('[Device] Sleep history sync failed:', e);
                                Toast.warning('Sleep data sync failed - changes may not persist');
                            });
                    }
                    return true;
                }
            }
        ]
    });

    const updateDurationPreview = () => {
        const previewEl = modal.querySelector('#sleepLogDurationPreview');
        if (!previewEl) return;
        let durationHours = wakeHour - bedtimeHour;
        let durationMins = wakeMin - bedtimeMin;
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

    const itemHeight = 44;
    const setupPicker = (pickerId, values, defaultValue, onUpdate) => {
        const scroll = modal.querySelector(`[data-picker="${pickerId}"]`);
        if (!scroll) return;
        let currentIndex = values.indexOf(defaultValue);
        if (currentIndex === -1) {
            currentIndex = values.reduce((closest, val, idx) =>
                Math.abs(val - defaultValue) < Math.abs(values[closest] - defaultValue) ? idx : closest, 0);
        }
        scroll.querySelectorAll('.picker-item').forEach((item, i) => {
            item.classList.toggle('selected', i === currentIndex);
        });
        setTimeout(() => { scroll.scrollTop = currentIndex * itemHeight; }, 350);
        const updateSelection = () => {
            const newIndex = Math.round(scroll.scrollTop / itemHeight);
            if (newIndex >= 0 && newIndex < values.length && newIndex !== currentIndex) {
                currentIndex = newIndex;
                onUpdate(values[currentIndex]);
                updateDurationPreview();
                scroll.querySelectorAll('.picker-item').forEach((item, i) => {
                    item.classList.toggle('selected', i === currentIndex);
                });
            }
        };
        scroll.addEventListener('scroll', updateSelection);
        let scrollTimeout;
        scroll.addEventListener('scroll', () => {
            clearTimeout(scrollTimeout);
            scrollTimeout = setTimeout(() => {
                scroll.scrollTo({ top: currentIndex * itemHeight, behavior: 'smooth' });
            }, 100);
        });
    };
    const hours = Array.from({ length: 24 }, (_, i) => i);
    const minutes = Array.from({ length: 12 }, (_, i) => i * 5);
    setupPicker('bedtime-hour', hours, defaultBedtimeHour, (v) => { bedtimeHour = v; });
    setupPicker('bedtime-min', minutes, Math.floor(defaultBedtimeMin / 5) * 5, (v) => { bedtimeMin = v; });
    setupPicker('wake-hour', hours, defaultWakeHour, (v) => { wakeHour = v; });
    setupPicker('wake-min', minutes, Math.floor(defaultWakeMin / 5) * 5, (v) => { wakeMin = v; });

    const dateInput = modal.querySelector('#sleepLogDate');
    if (dateInput) {
        dateInput.addEventListener('change', (e) => {
            selectedDate = e.target.value;
        });
    }
    setTimeout(updateDurationPreview, 200);
}

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
        'Delete Sleep Session',
        `Delete this sleep session?\n\nDate: ${date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}\nDuration: ${hours}h ${mins}m\n\nThis action cannot be undone.`,
        () => {
            MQTTClient.publishControl(DeviceState.deviceId, {
                command: 'deleteSleepSession',
                start: session.start
            });
            Toast.success('Sleep session deleted');
            if (DeviceState.state.sleepHistory) {
                DeviceState.state.sleepHistory.splice(index, 1);
                updateSleepUI(DeviceState.state);
                const user = Auth.getUser();
                if (user) {
                    DeviceService.updateDevice(window.activeHomeId, DeviceState.deviceId, {
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
            const stateToSave = { ...state };
            delete stateToSave._online;
            delete stateToSave._lastUpdate;
            delete stateToSave._lastAvailability;
            await DeviceService.updateDevice(window.activeHomeId, DeviceState.deviceId, stateToSave);
            console.log('[Device] Synced state to Firestore');
        } catch (e) {
            console.warn('[Device] Failed to sync state:', e);
        }
    }, 2000);
}

function showOfflineOverlay() {
    if (document.getElementById('offlineOverlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'offlineOverlay';
    overlay.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        background: linear-gradient(135deg, rgba(239, 68, 68, 0.95), rgba(185, 28, 28, 0.95));
        color: white;
        padding: max(12px, env(safe-area-inset-top)) 20px 12px;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 10px;
        z-index: 9998;
        font-size: 14px;
        font-weight: 500;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        animation: offlineSlideDown 0.3s ease-out;
    `;
    if (!document.getElementById('offlineOverlayStyles')) {
        const style = document.createElement('style');
        style.id = 'offlineOverlayStyles';
        style.textContent = `
            @keyframes offlineSlideDown {
                from { transform: translateY(-100%); opacity: 0; }
                to { transform: translateY(0); opacity: 1; }
            }
            @keyframes offlineFadeOut {
                from { opacity: 1; transform: translateY(0); }
                to { opacity: 0; transform: translateY(-100%); }
            }
        `;
        document.head.appendChild(style);
    }
    overlay.innerHTML = `
        <span style="font-size: 18px;">!</span>
        <span>Connection Lost - Retrying...</span>
        <div style="width: 16px; height: 16px; border: 2px solid rgba(255,255,255,0.3); border-top-color: white; border-radius: 50%; animation: spin 1s linear infinite;"></div>
    `;
    document.body.appendChild(overlay);
    console.log('[Device] Offline overlay shown');
}

function hideOfflineOverlay() {
    const overlay = document.getElementById('offlineOverlay');
    if (!overlay) return;
    overlay.style.animation = 'offlineFadeOut 0.3s ease-out forwards';
    setTimeout(() => overlay.remove(), 300);
    console.log('[Device] Offline overlay hidden');
}


// ============================================
// Page Cleanup: Prevent memory leaks on navigation
// ============================================
window.addEventListener('pagehide', () => {
    if (DeviceState.timerInterval) {
        clearInterval(DeviceState.timerInterval);
        DeviceState.timerInterval = null;
    }
    if (typeof syncTimeout !== 'undefined' && syncTimeout) {
        clearTimeout(syncTimeout);
    }
});

// ============================================
// Initialize on DOM Ready
// ============================================
document.addEventListener('DOMContentLoaded', init);


// Export for testing
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { DeviceState, init, updateUI };
}
