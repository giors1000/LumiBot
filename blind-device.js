/**
 * Zaylo — Smart Blind Device Page Logic
 * Premium blind control with smart automations
 * Supports: Roller, Vertical, Zebra blind types
 */

// ============================================
// Constants
// ============================================
const BLIND_TYPES = ['roller', 'vertical', 'zebra'];
const BLIND_TYPE_LABELS = { roller: 'Roller Blind', vertical: 'Vertical Blind', zebra: 'Zebra Blind' };
const BLIND_TYPE_ICONS = { roller: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-blinds"><path d="M3 3h18"/><path d="M20 7H8"/><path d="M20 11H8"/><path d="M10 19h10"/><path d="M8 15h12"/><path d="M4 3v14"/><circle cx="4" cy="19" r="2"/></svg>', vertical: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 3v18"/><path d="M12 3v18"/><path d="M16 3v18"/></svg>', zebra: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 7h18"/><path d="M3 15h18"/><path d="M3 11h18" stroke-dasharray="3 3"/><path d="M3 19h18" stroke-dasharray="3 3"/></svg>' };
const SLAT_COUNT = 12;
const VERTICAL_SLAT_COUNT = 8;
const BLIND_PAGE_LOADED_AT = Date.now();
let _animFrameId = null;
let _vizAnimFrameId = null;
let _visualPos = 0;  // smoothly interpolated visualization position

const tabs = ['controls', 'smart', 'settings'];
let currentTabIndex = 0;
let touchStartX = 0;
let touchEndX = 0;
let touchStartY = 0;
let touchEndY = 0;

// ============================================
// State
// ============================================
const BlindState = {
    deviceId: new URLSearchParams(window.location.search).get('id')?.trim().toUpperCase() || null,
    blindType: 'roller',    // roller | vertical | zebra
    position: 0,            // 0 = closed, 100 = fully open (from MQTT)
    targetPosition: 0,      // destination, used for buttons
    pendingTargetPosition: null,
    pendingCommandStatus: null,
    pendingCommandTs: null,
    _displayPos: 0,         // animated display position for smooth counter
    _visualPos: 0,          // smoothly interpolated visualization position
    _visualTargetPos: 0,    // live/optimistic target used by the renderer
    isOpen: false,
    isOnline: false,
    isCalibrated: null,     // null until fresh firmware state confirms stepper limits
    isMoving: false,
    firmware: null,
    deviceStatus: null,
    lastStateAt: null,
    rssi: null,
    ssid: null,
    stateTruncated: false,
    requiredBytes: null,
    bufferBytes: null,
    cfgRev: null,
    lastCommandRejected: null,
    lastCommandRejectedSeq: 0,
    lastCommandRejectedAt: null,
    lastCommandRejectedTarget: null,
    _handledRejectSeq: 0,
    _seenLiveState: false,
    // True until the rules become EXPLICIT — loaded from a saved local state,
    // confirmed by the device, adopted from the cloud, imported, or toggled by
    // the user. While provisional, config pushes OMIT the rules object entirely
    // (firmware is containsKey-guarded), so the app's optimistic defaults
    // (sunset/presence/morning ON) can never silently enable automations on a
    // device whose own defaults are all OFF. See BlindSchema.buildConfigPayload.
    _rulesProvisional: true,
    calibration: {
        currentPosition: null,
        lastSavedPosition: null,
        driftSteps: null,
        lastEmergencyStopPosition: null,
        lastEmergencyStopRecorded: false,
        lastPowerLossRecorded: false,
        powerLossDuringMove: false,
        lastPowerLossPosition: null,
        confidence: null
    },
    maintenance: {
        diagnosticsUpdatedAt: null,
        uptime: null,
        totalMoves: null,
        motorCycles: null,
        positionModelAnomalies: null,
        lastMove: null,
        lastDiagnostics: null
    },
    matterCommissioned: false,
    matterActiveFabrics: 0,
    matterWindowOpen: false,
    matterReachable: true,
    linkedDeviceId: null,
    rules: {
        sunset: true,
        presence: true,
        morningOpen: true,
        nightLock: false,
        temperature: false
    },
    config: {         // Stored locally and merged with device state
        openDuration: 15,       // seconds
        closeDuration: 15,      // seconds
        sunsetOffset: null, // null = inherit the home-wide global ('zaylo-SunsetOffset'); a number = per-device override
        sunsetTarget: 0,
        tempReopenEnabled: false, // heat-protection auto-reopen (hysteresis)
        tempReopenThreshold: 25,  // °C: reopen once the outdoor temp falls to/below this
        tempReopenTarget: 100,    // % to move to when reopening
        motionTimeout: 5,
        presenceTarget: 0,
        presenceOpenTarget: 100,
        presenceAction: 'close_only',
        presenceTimeFilter: 'all',
        morningTime: '07:00',
        morningDuration: 30,
        morningTarget: 100,
        morningDays: null,  // null = uniform schedule (use morningTime/Duration/Target for all days)
        nightTime: '22:00',
        nightTarget: 0,
        nightDays: null,    // null = all days enabled
        tempThreshold: 30,
        tempTarget: 20,
        lat: null,
        lon: null,
        angleOn: 90,           // Default value for "open" servo angle
        angleOff: 0,           // Default value for "closed" servo angle
        stepperOpenSpeed: 2000, // steps/s when opening
        stepperCloseSpeed: 2000, // steps/s when closing
        stepperRelaxSteps: 128,  // tension relief steps after upward move
        stepperStopDelay: 3000,  // motor idle timeout in ms
        stepperAcceleration: 2000, // acceleration/braking rate steps/s²
        stepperIdleHold: false,  // keep motor energized at idle to stop droop (off = release after stopDelay)
        twtEnabled: false,
        twtActive: undefined,
        twtRequested: false,
        wifi6: undefined
    },
    isDragging: false,      // Prevent incoming MQTT state updates from jumping slider
    ignoreIncomingConfig: false // Active guard to prevent device defaults from overwriting local setup configs during sync
};

// Track whether we've received the first position from MQTT.
// The first update should snap instantly (no animation) to prevent
// the closed→open flash when blinds are already in position.
let _firstPositionReceived = false;
let _blindStateUnsubscribe = null;
let _activityLogUnsubscribe = null;
let _diagnosticsMessageHandler = null;
let _lastDiagnosticsRequestAt = 0;
let _localControlFeedbackAttached = false;

// ============================================
// Initialization
// ============================================
function hideInitialLoader() {
    const loader = document.getElementById('initialLoader');
    if (loader) {
        if (loader.dataset.removing === 'true') return;
        loader.dataset.removing = 'true';
        loader.style.opacity = '0';
        loader.style.visibility = 'hidden';
        setTimeout(() => {
            if (loader.parentNode) {
                loader.parentNode.removeChild(loader);
            }
        }, 500);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const params = new URLSearchParams(window.location.search);
    BlindState.deviceId = params.get('id')?.trim().toUpperCase() || null;

    if (!BlindState.deviceId) {
        window.location.href = 'index.html';
        return;
    }

    // Theme init
    Theme.init();
    const themeToggle = document.getElementById('themeToggle');
    if (themeToggle) {
        themeToggle.checked = Theme.get() === 'dark';
        themeToggle.addEventListener('change', () => Theme.toggle());
    }

    // Load saved state
    const hasCache = loadDeviceState();

    // Render the saved config (speed, TWT, automation targets/times) to the UI
    // IMMEDIATELY from localStorage — including the values customised in the setup
    // wizard. Previously updateConfigUI() only ran inside the async auth/Firebase
    // callbacks, so a freshly set-up or offline blind showed default values until
    // auth resolved or the device reported back. This guarantees the main page
    // reflects the setup choices on first paint.
    if (typeof updateConfigUI === 'function') updateConfigUI();

    // Resolve Home and sync Firebase metadata (asynchronously in background)
    const initHomeAndSyncFirebase = async () => {
        try {
            if (typeof Auth !== 'undefined') {
                await Auth.waitForAuthReady();
                const user = Auth.getUser();
                if (user) {
                    if (typeof HomeService !== 'undefined') {
                        await HomeService.init();
                        const homeId = await HomeService.getActiveHome(user.uid);
                        if (homeId) {
                            window.activeHomeId = homeId; // ensure the cloud path is valid
                            if (typeof DeviceList !== 'undefined') DeviceList.setHome(homeId);
                            if (typeof updateConfigUI === 'function') updateConfigUI();
                            // Flush any cloud sync that was deferred because the home
                            // context wasn't ready yet (otherwise it would write to an
                            // invalid Firestore path and silently fail).
                            if (typeof flushDeferredCloudSync === 'function') flushDeferredCloudSync();

                            // Sync with Firebase (slow, but ensures cross-device persistence)
                            if (typeof DeviceService !== 'undefined') {
                                await DeviceService.init();
                                const fbDevice = await DeviceService.getDevice(homeId, BlindState.deviceId);
                                if (fbDevice) {
                                    let updated = false;
                                    if (fbDevice.blindType && fbDevice.blindType !== BlindState.blindType) {
                                        BlindState.blindType = fbDevice.blindType;
                                        updated = true;
                                    }
                                    if (fbDevice.linkedDeviceId !== undefined && fbDevice.linkedDeviceId !== BlindState.linkedDeviceId) {
                                        BlindState.linkedDeviceId = fbDevice.linkedDeviceId;
                                        updated = true;
                                    }
                                    // Don't let (possibly stale) cloud rules/config clobber a LOCAL config
                                    // that hasn't reached the device yet — a just-completed setup or an
                                    // offline edit still queued in ConfigSync is the freshest source of
                                    // truth, and applying Firebase here would silently revert the user's
                                    // just-made choices. blindType/linkedDeviceId above are still adopted.
                                    let localConfigPending = false;
                                    try {
                                        localConfigPending = localStorage.getItem(`blind-pending-sync-${BlindState.deviceId}`) === '1'
                                            || !!localStorage.getItem(`blind-cfgsync-${BlindState.deviceId}`);
                                    } catch (e) {}
                                    if (fbDevice.rules && !localConfigPending) {
                                        Object.assign(BlindState.rules, fbDevice.rules);
                                        // Cloud rules were saved by an explicit
                                        // action on some device — adopt as explicit.
                                        BlindState._rulesProvisional = false;
                                        updated = true;
                                    }
                                    if (fbDevice.config && !localConfigPending) {
                                        Object.assign(BlindState.config, fbDevice.config);
                                        updated = true;
                                    }
                                    if (updated) {
                                        // Trigger UI refreshes
                                        Object.entries(BlindState.rules).forEach(([rule, enabled]) => {
                                            const toggle = document.querySelector(`[data-rule-toggle="${rule}"]`);
                                            if (toggle) {
                                                toggle.checked = enabled;
                                                const card = toggle.closest('.smart-rule-card');
                                                if (card) card.classList.toggle('active-rule', enabled);
                                            }
                                        });
                                        if (typeof updateLinkedDevice === 'function') updateLinkedDevice();
                                        if (typeof updateConfigUI === 'function') updateConfigUI();
                                        if (typeof updateTypePill === 'function') updateTypePill();
                                        
                                        // Overwrite local storage copy
                                        const key = `blind-state-${BlindState.deviceId}`;
                                        const stateObj = {
                                            blindType: BlindState.blindType,
                                            position: BlindState.position,
                                            targetPosition: BlindState.targetPosition,
                                            isOpen: BlindState.isOpen,
                                            linkedDeviceId: BlindState.linkedDeviceId,
                                            rules: BlindState.rules,
                                            config: BlindState.config
                                        };
                                        localStorage.setItem(key, JSON.stringify(stateObj));
                                    }
                                }
                            }
                        }
                    }
                }
            }
        } catch (e) {
            console.error('[Blind] Home & Firebase sync failed:', e);
        }
    };
    initHomeAndSyncFirebase();

    // Setup UI
    generateVisualization();
    // Immediately apply saved position so the visualization starts at the correct state
    // (prevents flash from 0% to saved position)
    _applyVisualization(BlindState.position);
    const _initFrame = document.getElementById('blindsFrame');
    if (_initFrame) _initFrame.classList.toggle('open', BlindState.position > 20);

    setupDock();
    setupControls();
    setupSlider();
    setupPresets();
    setupRuleToggles();
    setupRuleConfigModals();
    setupTypeSelector();
    setupSettings();
    setupNewFeatures();
    setupLocalControlFeedback();
    updateUI();
    updateHealthPanel();
    updateCalibrationTools();

    // Show the last-known Matter pairing QR/code from cache so pairing works
    // before (or without) a live device connection.
    restoreCachedMatterPairing();

    // Reload any config change that was made offline in a previous session so it
    // is re-delivered (and shows a pending-sync status until the device acks it).
    if (typeof ConfigSync !== 'undefined') ConfigSync.init();

    // Add resize listener to keep pill aligned
    window.addEventListener('resize', () => {
        if (typeof updateTypePill === 'function') updateTypePill();
    });

    // Setup MQTT
    setupMQTT();

    if (params.get('calibrate') === '1') {
        let attempts = 0;
        const openCalibrationWhenReady = setInterval(() => {
            attempts++;
            if (BlindState.isOnline === true && typeof MQTTClient !== 'undefined' && MQTTClient.connected) {
                clearInterval(openCalibrationWhenReady);
                openLimitsCalibrationWizard();
                try {
                    params.delete('calibrate');
                    const qs = params.toString();
                    history.replaceState(null, '', `${location.pathname}${qs ? `?${qs}` : ''}`);
                } catch (e) {}
            } else if (attempts >= 24) {
                clearInterval(openCalibrationWhenReady);
                if (typeof Toast !== 'undefined') Toast.info('Open Settings to calibrate once the blind is online');
            }
        }, 1500);
    }

    // Hide loader immediately if we have a valid cached state to show
    if (hasCache) {
        hideInitialLoader();
    }

    // Safety timeout: Remove loader after 4s even if nothing loads
    setTimeout(() => {
        hideInitialLoader();
    }, 4000);

    // Keep the "What Happens Next" relative countdowns fresh even when the blind
    // is idle and not publishing fresh state (renderBlindState only runs on state
    // updates / config changes).
    setInterval(() => {
        if (typeof updateUpcomingAutomations === 'function') updateUpcomingAutomations();
    }, 60000);
});

// ============================================
// MQTT & Connectivity
// ============================================
function setupMQTT() {
    if (typeof MQTTClient === 'undefined') {
        console.error('MQTTClient not found');
        return;
    }

    MQTTClient.clearCallbacks();
    MQTTClient.reconnectAttempts = 0;
    MQTTClient.reconnectDelay = 1000;
    
    // Initialize PWA visibility handler for background reconnection
    MQTTClient.initVisibilityHandler();

    // Subscribe to callbacks FIRST before connecting
    MQTTClient.on('onConnect', () => {
        if (BlindState.deviceId) {
            MQTTClient.subscribeDevice(BlindState.deviceId);
            setTimeout(() => {
                if (MQTTClient.connected) {
                    const pendingKey = `blind-pending-sync-${BlindState.deviceId}`;
                    if (localStorage.getItem(pendingKey) === '1') {
                        syncPendingSetupConfig();
                    } else {
                        MQTTClient.publishControl(BlindState.deviceId, { command: 'getState' });
                    }

                    // TIMEZONE FIX: Sync browser's current timezone to device on every connect.
                    // This ensures the blinds always have the correct local time for scheduled
                    // automations (morning open, sunset close, night lock), even after DST changes.
                    MQTTClient.syncTimezoneToDevice(BlindState.deviceId);

                    // Timeout check — Blind firmware may not respond to getState,
                    // AND a stale retained LWT "offline" message may have arrived.
                    // If no actual state data (position, etc.) was received, assume online.
                    setTimeout(() => {
                        const state = MQTTClient.getDeviceState(BlindState.deviceId);
                        const hasRealState = state && (state.position !== undefined || state.blindPosition !== undefined);
                        if (!state || !hasRealState || state._online === undefined || state._online === false) {
                            console.log(`[BlindDevice] Waiting for live state from ${BlindState.deviceId}.`);
                            const waitingState = state
                                ? { ...state, _online: undefined, _waitingForLiveState: true }
                                : { _online: undefined, _waitingForLiveState: true };
                            MQTTClient.deviceStates.set(BlindState.deviceId, waitingState);
                            if (typeof StateStore !== 'undefined') StateStore.update(BlindState.deviceId, waitingState);
                        }
                    }, 3000);

                    setTimeout(() => {
                        const state = MQTTClient.getDeviceState(BlindState.deviceId);
                        const hasRealState = state && (state.position !== undefined || state.blindPosition !== undefined);
                        if (!state || (!hasRealState && state._online !== true)) {
                            console.log(`[BlindDevice] Device timeout: ${BlindState.deviceId}. Marking as Offline after grace period.`);
                            const offlineState = state
                                ? { ...state, _online: false, _waitingForLiveState: false, _offlineConfirmed: true }
                                : { _online: false, _waitingForLiveState: false, _offlineConfirmed: true };
                            MQTTClient.deviceStates.set(BlindState.deviceId, offlineState);
                            if (typeof StateStore !== 'undefined') StateStore.update(BlindState.deviceId, offlineState);
                        }
                    }, 12000);
                }
            }, 300);
        }
        if (BlindState.linkedDeviceId) {
            MQTTClient.subscribeDevice(BlindState.linkedDeviceId);
        }
        updateConnectionStatus('checking');

        if (typeof BlindSync !== 'undefined' && typeof BlindSync.init === 'function') {
            BlindSync.init({ deviceIds: [BlindState.deviceId] });
        }

        // Commands queued while offline are flushed by BlindCommandQueue itself
        // (it listens for the MQTT connect event and applies expiry/retry caps).
        // The page no longer keeps its own shadow queue.

        // Re-deliver any config change that was queued while offline, and re-arm
        // the one-shot setup sync if it hasn't been acked yet.
        if (typeof ConfigSync !== 'undefined') ConfigSync.flush();

        if (typeof requestDiagnosticsSnapshot === 'function') {
            requestDiagnosticsSnapshot({ force: true, delay: 900 });
        }
    });

    MQTTClient.on('onDisconnect', () => {
        updateConnectionStatus(false);
    });

    if (typeof setupDiagnosticsSubscription === 'function') {
        setupDiagnosticsSubscription();
    }

    // Connect to broker AFTER callbacks are registered
    MQTTClient.connect();

    // Use Centralized StateStore
    if (_blindStateUnsubscribe) {
        _blindStateUnsubscribe();
        _blindStateUnsubscribe = null;
    }
    _blindStateUnsubscribe = StateStore.subscribe(BlindState.deviceId, (state) => {
        if (state) {
            handleStateUpdate(state);
            hideInitialLoader(); // Always hide loader once we get a live state update
        }
    });
}

function updateConnectionStatus(connected) {
    const status = (connected === 'checking' || connected === undefined)
        ? 'checking'
        : (connected ? 'online' : 'offline');
    BlindState.connectionStatus = status;
    BlindState.isOnline = status === 'online';
    const badge = document.getElementById('statusBadge');
    const dot = document.getElementById('statusDot');
    const text = document.getElementById('statusText');
    if (badge) {
        badge.className = `device-status-badge ${status}`;
    }
    if (dot) {
        dot.className = `status-dot ${status === 'online' ? 'online' : (status === 'checking' ? 'checking' : '')}`;
    }
    if (text) {
        text.textContent = status === 'online' ? 'Online' : (status === 'checking' ? 'Waiting' : 'Offline');
    }
    if (typeof updateTwtStatusLabel === 'function') updateTwtStatusLabel();
    if (typeof updateHealthPanel === 'function') updateHealthPanel();
    if (typeof updateCalibrationTools === 'function') updateCalibrationTools();
}

function extractMatterQrPayload(value) {
    let payload = String(value || '').trim();
    if (!payload) return payload;

    try {
        const urlObj = new URL(payload);
        for (const key of ['data', 'payload', 'code']) {
            const candidate = urlObj.searchParams.get(key);
            if (candidate && candidate.trim().startsWith('MT:')) {
                return candidate.trim();
            }
        }
    } catch (e) {
        // Not a URL, or not parseable by URL(). Fall through to regex extraction.
    }

    try {
        const decoded = decodeURIComponent(payload);
        const match = decoded.match(/MT:[A-Za-z0-9._%-]+/);
        if (match) return match[0];
    } catch (e) {
        const match = payload.match(/MT:[A-Za-z0-9._%-]+/);
        if (match) return match[0];
    }

    return payload;
}

// Render the Matter pairing QR locally — no third-party service, works offline.
// The previous implementation sent the raw "MT:" setup payload (which encodes the
// pairing passcode + discriminator) to api.qrserver.com, leaking commissioning
// secrets. We now encode it on-device with a bundled MIT QR generator
// (window.qrcode) and draw a crisp, scalable SVG on a white card so phones can
// scan it reliably against the dark Matter panel.
function renderMatterQrLocally(container, payload) {
    if (!container) return;
    payload = String(payload || '').trim();
    if (!payload) return;

    const showFallback = () => {
        container.style.background = '#ffffff';
        container.innerHTML = `<div style="padding:10px; font-family:monospace; font-size:10px; line-height:1.35; color:#111; word-break:break-all; text-align:center;">${payload}</div>`;
    };

    if (typeof qrcode === 'undefined') {
        // Library missing — show the payload as text rather than fall back to a
        // third-party service (which would re-introduce the data leak).
        console.warn('[Matter] QR library not loaded; showing payload as text.');
        showFallback();
        return;
    }

    try {
        const qr = qrcode(0, 'M'); // type 0 = auto-size to fit; 'M' ≈ 15% ECC
        qr.addData(payload);
        qr.make();
        container.style.background = '#ffffff';
        container.style.padding = '8px';
        container.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
        const svg = container.querySelector('svg');
        if (svg) {
            svg.style.width = '100%';
            svg.style.height = '100%';
            svg.style.display = 'block';
            svg.setAttribute('shape-rendering', 'crispEdges');
        }
    } catch (e) {
        console.warn('[Matter] Local QR render failed:', e);
        showFallback();
    }
}

// Restore the last-known Matter pairing QR + manual code from cache so the
// pairing screen works without a live connection (offline pairing). The Matter
// onboarding payload is static per device, so a cached copy is always valid.
function restoreCachedMatterPairing() {
    if (!BlindState.deviceId) return;
    try {
        const code = localStorage.getItem(`matter-code-${BlindState.deviceId}`);
        const qrPayload = localStorage.getItem(`matter-qr-${BlindState.deviceId}`);
        if (!code && !qrPayload) return; // device never reported Matter support

        // The device supports Matter — reveal the (otherwise hidden) card so the
        // pairing info is visible before/without a live connection.
        const settingsGroup = document.getElementById('matterSettingsGroup');
        if (settingsGroup) settingsGroup.style.display = 'block';

        if (code) {
            const el = document.getElementById('matterManualCode');
            if (el) {
                let f = code;
                if (code.length === 11 && !code.includes('-')) {
                    f = `${code.substr(0,3)}-${code.substr(3,2)}-${code.substr(5,3)}-${code.substr(8,3)}`;
                }
                el.textContent = f;
            }
        }
        if (qrPayload) {
            const container = document.getElementById('matterQRCodeContainer');
            if (container) renderMatterQrLocally(container, qrPayload);
        }

        // Reflect last-known commissioning state so the correct section shows.
        const commissioned = localStorage.getItem(`matter-commissioned-${BlindState.deviceId}`) === '1';
        const pairingSection = document.getElementById('matterPairingSection');
        const connectedSection = document.getElementById('matterConnectedSection');
        const badge = document.getElementById('matterStatusBadge');
        if (commissioned) {
            if (pairingSection) pairingSection.style.display = 'none';
            if (connectedSection) connectedSection.style.display = 'block';
            if (badge) { badge.className = 'device-status-badge online'; badge.textContent = 'Paired'; }
        } else {
            if (pairingSection) pairingSection.style.display = 'block';
            if (connectedSection) connectedSection.style.display = 'none';
        }
    } catch (e) { /* best effort */ }
}

function _numberOrNull(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}

function _mergeCalibrationTelemetry(state) {
    if (!state) return false;

    const incoming = { ...(state.calibration || {}) };
    if (state.positionConfidence !== undefined && incoming.confidence === undefined) {
        incoming.confidence = state.positionConfidence;
    }

    const numericKeys = [
        'currentPosition',
        'lastSavedPosition',
        'driftSteps',
        'lastEmergencyStopPosition',
        'lastPowerLossPosition',
        'confidence'
    ];
    let changed = false;

    numericKeys.forEach((key) => {
        if (incoming[key] === undefined) return;
        const value = _numberOrNull(incoming[key]);
        if (BlindState.calibration[key] !== value) {
            BlindState.calibration[key] = value;
            changed = true;
        }
    });

    if (incoming.lastEmergencyStopRecorded !== undefined) {
        const value = !!incoming.lastEmergencyStopRecorded;
        if (BlindState.calibration.lastEmergencyStopRecorded !== value) {
            BlindState.calibration.lastEmergencyStopRecorded = value;
            changed = true;
        }
    }

    if (incoming.lastPowerLossRecorded !== undefined) {
        const value = !!incoming.lastPowerLossRecorded;
        if (BlindState.calibration.lastPowerLossRecorded !== value) {
            BlindState.calibration.lastPowerLossRecorded = value;
            changed = true;
        }
    }

    if (incoming.powerLossDuringMove !== undefined) {
        const value = !!incoming.powerLossDuringMove;
        if (BlindState.calibration.powerLossDuringMove !== value) {
            BlindState.calibration.powerLossDuringMove = value;
            changed = true;
        }
    }

    return changed;
}

// One-time, per-incident prompt when the firmware reports power was lost while
// the blind was MOVING. The boot-restored position comes from the last
// mid-move checkpoint (up to 5% of travel old), so it can be slightly off —
// the user should eye-check it and recalibrate if it looks wrong. The firmware
// keeps the flag true for its whole boot, so the incident is identified by the
// boot timestamp (now − uptime) and acknowledged in localStorage; otherwise
// every state publish and page load would re-toast the same event.
function _maybeNotifyPowerLossDuringMove(state) {
    if (!BlindState.calibration.powerLossDuringMove) return;
    const uptime = _numberOrNull(state && state.uptime);
    if (uptime === null) return; // can't identify the incident without a boot time
    // 10-minute buckets absorb clock drift between state publishes.
    const bootBucket = Math.round((Date.now() - uptime * 1000) / 600000);
    const key = `blind-powerloss-ack-${BlindState.deviceId}`;
    let acked = null;
    try { acked = localStorage.getItem(key); } catch (e) {}
    if (acked !== null && Math.abs(Number(acked) - bootBucket) <= 1) return; // already shown
    try { localStorage.setItem(key, String(bootBucket)); } catch (e) {}

    const pos = BlindState.calibration.lastPowerLossPosition;
    if (typeof Toast !== 'undefined') {
        Toast.warning('Power was lost while the blind was moving. Its position was restored from the last checkpoint and may be slightly off — check it looks right, or recalibrate from Settings.');
    }
    if (typeof addLogEntry === 'function') {
        addLogEntry('⚡', `Power loss during movement detected${pos !== null ? ` (near ${pos} steps)` : ''}. Position restored from checkpoint — verify or recalibrate.`, { key: `powerloss:${bootBucket}`, source: 'device' });
    }
}

function renderBlindState(options = {}) {
    const renderCore = options.core !== false;
    if (renderCore) {
        updateUI();
        updateCalibrationWarning();
    }
    updateMorningTimeline();
    if (typeof updateUpcomingAutomations === 'function') updateUpcomingAutomations();
    updateHealthPanel();
    updateCalibrationTools();
    if (typeof renderMaintenanceInsights === 'function') renderMaintenanceInsights();
}

function _commandRejectMessage(reason) {
    const clean = String(reason || '').trim();
    if (clean === 'not_calibrated') return 'Calibration required before moving this blind';
    if (clean === 'calibration_mode_active') return 'Finish calibration before moving this blind';
    if (clean === 'invalid_position') return 'The requested blind position was rejected';
    return clean ? `Command rejected: ${clean.replace(/_/g, ' ')}` : 'Command rejected by blind';
}

function _handleCommandRejectionTelemetry(state, options = {}) {
    const seq = Number(state.lastCommandRejectedSeq || 0);
    if (!Number.isFinite(seq) || seq <= 0 || seq <= (BlindState.lastCommandRejectedSeq || 0)) {
        return false;
    }

    const reason = String(state.lastCommandRejected || 'rejected');
    const target = state.lastCommandRejectedTarget !== undefined
        ? Number(state.lastCommandRejectedTarget)
        : null;
    BlindState.lastCommandRejected = reason;
    BlindState.lastCommandRejectedSeq = seq;
    const rejectedAt = Number(state.lastCommandRejectedAt);
    BlindState.lastCommandRejectedAt = Number.isFinite(rejectedAt) ? rejectedAt : null;
    BlindState.lastCommandRejectedTarget = Number.isFinite(target) ? target : null;

    const message = _commandRejectMessage(reason);
    const recentUserCommand = Date.now() - (window._uiActionTimestamp || 0) < 10000;
    const hasWallClockRejectTime = BlindState.lastCommandRejectedAt > 1000000000;
    const rejectionIsFresh = hasWallClockRejectTime
        ? ((Date.now() / 1000) - BlindState.lastCommandRejectedAt < 20)
        : true;
    const statePosition = Number(state.position !== undefined ? state.position : state.blindPosition);
    const snapPosition = Number.isFinite(statePosition)
        ? Math.max(0, Math.min(100, statePosition))
        : BlindState.position;

    BlindState.targetPosition = snapPosition;
    BlindState._visualTargetPos = snapPosition;

    if (reason === 'not_calibrated') {
        BlindState.isCalibrated = false;
    }

    if (seq > (BlindState._handledRejectSeq || 0)) {
        BlindState._handledRejectSeq = seq;
        if (typeof addLogEntry === 'function') {
            addLogEntry('!', message, { key: `reject:${seq}`, source: 'device' });
        }
        if (!options.suppressToast && (recentUserCommand || rejectionIsFresh) && typeof Toast !== 'undefined') {
            Toast.error(message);
        }
    }

    if (typeof setStopButtonVisible === 'function') setStopButtonVisible(false);
    return true;
}

function setupLocalControlFeedback() {
    if (_localControlFeedbackAttached || typeof window === 'undefined') return;
    _localControlFeedbackAttached = true;
    window.addEventListener('zaylo:local-control-failed', (event) => {
        const detail = event.detail || {};
        const eventDeviceId = String(detail.deviceId || '').toUpperCase();
        if (!eventDeviceId || eventDeviceId !== BlindState.deviceId) return;

        const responseMessage = detail.response && detail.response.message
            ? String(detail.response.message)
            : '';
        const responseReason = detail.response && detail.response.reason
            ? String(detail.response.reason)
            : '';
        const isCalibrationModeReject = /calibration_mode_active/i.test(responseReason) || /calibration mode active/i.test(responseMessage);
        const isCalibrationRequiredReject = /not_calibrated/i.test(responseReason) || /calibration required/i.test(responseMessage);
        if (!isCalibrationModeReject && !isCalibrationRequiredReject) return;

        const reason = isCalibrationModeReject ? 'calibration_mode_active' : 'not_calibrated';
        const message = _commandRejectMessage(reason);
        const snapPosition = Number.isFinite(Number(BlindState.position)) ? BlindState.position : 0;
        if (reason === 'not_calibrated') BlindState.isCalibrated = false;
        BlindState.targetPosition = snapPosition;
        BlindState._visualTargetPos = snapPosition;
        BlindState._visualPos = snapPosition;
        BlindState._displayPos = snapPosition;
        if (typeof updateUI === 'function') updateUI();
        if (typeof _applyVisualization === 'function') _applyVisualization(snapPosition);
        if (typeof setStopButtonVisible === 'function') setStopButtonVisible(false);
        if (typeof BlindCommandQueue !== 'undefined' && typeof BlindCommandQueue.markRejected === 'function') {
            const rejectedRaw = detail.payload && (detail.payload.position !== undefined ? detail.payload.position : detail.payload.blindPosition);
            BlindCommandQueue.markRejected(BlindState.deviceId, reason, rejectedRaw);
        }
        if (typeof Toast !== 'undefined') Toast.error(message);
        if (typeof addLogEntry === 'function') {
            addLogEntry('!', message, { key: `local-reject:${Date.now()}`, source: 'device' });
        }
    });
}

function handleStateUpdate(state) {
    let changed = false;
    const wasMoving = BlindState.isMoving;

    // Config-ack: clear the pending-sync queue once the device echoes back the
    // revision token we pushed (proof it applied our config, not just that the
    // broker accepted the publish).
    if (typeof BlindSync !== 'undefined' && typeof BlindSync.handleState === 'function') {
        BlindSync.handleState(BlindState.deviceId, state);
    }
    if (typeof ConfigSync !== 'undefined') ConfigSync.handleAck(state);
    if (typeof updatePendingBadge === 'function') updatePendingBadge();

    const hasLiveSnapshot = state.position !== undefined ||
        state.blindPosition !== undefined ||
        state.config !== undefined ||
        state.rules !== undefined ||
        state.rssi !== undefined ||
        state.ssid !== undefined ||
        state.isCalibrated !== undefined ||
        state.calibration !== undefined ||
        state.positionConfidence !== undefined ||
        state.firmware !== undefined ||
        state.version !== undefined ||
        state.fwVersion !== undefined;

    const isFirstLiveSnapshot = hasLiveSnapshot && !BlindState._seenLiveState;
    if (hasLiveSnapshot) BlindState.lastStateAt = Date.now();
    if (state.firmware !== undefined) BlindState.firmware = state.firmware;
    if (state.fwVersion !== undefined) BlindState.firmware = state.fwVersion;
    if (state.version !== undefined && !BlindState.firmware) BlindState.firmware = state.version;
    if (state.status !== undefined) BlindState.deviceStatus = state.status;
    if (state.stateTruncated !== undefined) BlindState.stateTruncated = !!state.stateTruncated;
    else if (hasLiveSnapshot) BlindState.stateTruncated = false;
    if (state.requiredBytes !== undefined) BlindState.requiredBytes = state.requiredBytes;
    if (state.bufferBytes !== undefined) BlindState.bufferBytes = state.bufferBytes;
    if (state.cfgRev !== undefined) BlindState.cfgRev = state.cfgRev;
    if (_mergeCalibrationTelemetry(state)) changed = true;
    _maybeNotifyPowerLossDuringMove(state);
    if (_handleCommandRejectionTelemetry(state, { suppressToast: isFirstLiveSnapshot })) changed = true;
    if (hasLiveSnapshot) BlindState._seenLiveState = true;
    if (state.twtEnabled !== undefined) BlindState.config.twtEnabled = !!state.twtEnabled;
    if (state.twtActive !== undefined) BlindState.config.twtActive = !!state.twtActive;
    if (state.twtRequested !== undefined) BlindState.config.twtRequested = !!state.twtRequested;
    if (state.wifi6 !== undefined) BlindState.config.wifi6 = !!state.wifi6;

    // Device online/offline status from MQTT state store
    if (state._waitingForLiveState) {
        updateConnectionStatus('checking');
    } else if (state._online !== undefined) {
        const hasOnlyAvailability = !hasLiveSnapshot && state._online === false && !state._offlineConfirmed;
        updateConnectionStatus(hasOnlyAvailability ? 'checking' : state._online);

        // If the blind was still booting (e.g. right after provisioning) when we
        // first connected to MQTT, the one-shot setup sync couldn't reach it.
        // Retry the moment it actually reports online so the wizard's settings
        // always land. syncPendingSetupConfig() no-ops once the flag is cleared.
        if (state._online === true &&
            localStorage.getItem(`blind-pending-sync-${BlindState.deviceId}`) === '1') {
            syncPendingSetupConfig();
        }
    }

    // Position updates — firmware sends 'blindPosition' and 'position'
    // Ignore updates if the user is actively dragging the position slider to prevent jumping
    //
    // Deliberately NOT edge-rounded: the firmware's reported percentage already
    // resolves to exact 0/100 at the limits (relax offset is latched and
    // corrected on-device), so snapping 98→100 here only HID real drift — a
    // blind stuck 2% short of its limit displayed as fully open, masking the
    // exact signal a user/support needs to spot a slipping or miscalibrated
    // unit. State carries the device's truth.
    const pos = state.position !== undefined ? state.position : state.blindPosition;

    // Calibration state
    if (state.isCalibrated !== undefined && state.isCalibrated !== BlindState.isCalibrated) {
        BlindState.isCalibrated = state.isCalibrated;
        changed = true;
    }

    // Matter Integration State
    if (state.matterCommissioned !== undefined || state.matterManualCode !== undefined ||
        state.matterActiveFabrics !== undefined || state.matterWindowOpen !== undefined ||
        state.matterQRCodeURL !== undefined) {
        const settingsGroup = document.getElementById('matterSettingsGroup');
        if (settingsGroup && settingsGroup.style.display !== 'block') {
            settingsGroup.style.display = 'block'; // Auto-reveal Matter card if firmware supports it
        }
        
        if (state.matterWindowOpen !== undefined) {
            BlindState.matterWindowOpen = state.matterWindowOpen;
            const pairingSection = document.getElementById('matterPairingSection');
            if (state.matterWindowOpen) {
                if (pairingSection) pairingSection.style.display = 'block';
                let notice = document.getElementById('matterPairingNotice');
                if (!notice && pairingSection) {
                    notice = document.createElement('p');
                    notice.id = 'matterPairingNotice';
                    notice.className = 'setting-sublabel';
                    notice.style.color = 'var(--blind-accent)';
                    notice.style.fontWeight = 'bold';
                    notice.style.marginTop = '8px';
                    notice.style.textAlign = 'center';
                    notice.textContent = '⚡ Pairing window active! Connect your new app now.';
                    pairingSection.insertBefore(notice, pairingSection.firstChild);
                }
            } else {
                let notice = document.getElementById('matterPairingNotice');
                if (notice) notice.remove();
                if (pairingSection && BlindState.matterCommissioned) {
                    pairingSection.style.display = 'none';
                }
            }
        }
        
        if (state.matterReachable !== undefined) BlindState.matterReachable = state.matterReachable;
        if (state.matterCommissioned !== undefined) {
            BlindState.matterCommissioned = state.matterCommissioned;
            // Cache for offline pairing display (chooses pairing vs connected view).
            try { localStorage.setItem(`matter-commissioned-${BlindState.deviceId}`, state.matterCommissioned ? '1' : '0'); } catch (e) {}
            const badge = document.getElementById('matterStatusBadge');
            if (badge) {
                // `matterReachable` is undefined on older firmware → treat as reachable
                // so we never raise a false alarm; only an explicit false flags trouble.
                const reachable = BlindState.matterReachable !== false;
                if (state.matterCommissioned && !reachable) {
                    // Paired, but the blind isn't currently advertising operational
                    // records over IPv6 — so Google/Apple Home will show it offline.
                    // Surface that honestly instead of a misleading bare "Paired".
                    badge.className = 'device-status-badge offline';
                    badge.textContent = 'Paired · Unreachable';
                    badge.title = "Paired, but the blind isn't advertising over IPv6/mDNS right now, so Google/Apple Home may show it offline. It self-heals automatically; if it persists, check the blind's Wi-Fi and that your router has IPv6 enabled.";
                } else {
                    badge.className = `device-status-badge ${state.matterCommissioned ? 'online' : 'offline'}`;
                    badge.textContent = state.matterCommissioned ? 'Paired' : 'Unpaired';
                    badge.title = '';
                }
            }
            
            const pairingSection = document.getElementById('matterPairingSection');
            const connectedSection = document.getElementById('matterConnectedSection');
            if (!BlindState.matterWindowOpen) {
                if (state.matterCommissioned) {
                    if (pairingSection) pairingSection.style.display = 'none';
                    if (connectedSection) connectedSection.style.display = 'block';
                } else {
                    if (pairingSection) pairingSection.style.display = 'block';
                    if (connectedSection) connectedSection.style.display = 'none';
                }
            } else {
                if (connectedSection) connectedSection.style.display = 'block';
            }
        }
        
        if (state.matterActiveFabrics !== undefined) {
            BlindState.matterActiveFabrics = state.matterActiveFabrics;
            const fabricsCountEl = document.getElementById('matterFabricsCount');
            if (fabricsCountEl) {
                fabricsCountEl.textContent = state.matterActiveFabrics;
            }
        }
        
        if (state.matterManualCode) {
            const manualCodeEl = document.getElementById('matterManualCode');
            if (manualCodeEl) {
                let rawCode = String(state.matterManualCode);
                let formattedCode = rawCode;
                // Matter manual codes are typically 11 digits: e.g. 34905000032
                // We format them into readable blocks: 349-05-000-032
                if (rawCode.length === 11 && !rawCode.includes('-')) {
                    formattedCode = `${rawCode.substr(0, 3)}-${rawCode.substr(3, 2)}-${rawCode.substr(5, 3)}-${rawCode.substr(8, 3)}`;
                }
                manualCodeEl.textContent = formattedCode;
                // Cache the manual pairing code for offline display.
                try { localStorage.setItem(`matter-code-${BlindState.deviceId}`, rawCode); } catch (e) {}
            }
        }
        
        if (state.matterQRCodeURL && window._lastRenderedMatterQR !== state.matterQRCodeURL) {
            window._lastRenderedMatterQR = state.matterQRCodeURL;
            const container = document.getElementById('matterQRCodeContainer');
            if (container) {
                // Smart-home apps expect the raw Matter "MT:" setup payload.
                // Firmware may send that directly or wrap it in an onboarding URL.
                const qrPayload = extractMatterQrPayload(state.matterQRCodeURL);
                // Render locally (no third-party service, works offline). The old
                // path sent this payload — which encodes the pairing passcode — to
                // api.qrserver.com, leaking commissioning secrets to a third party.
                renderMatterQrLocally(container, qrPayload);
                // Cache so pairing can be shown offline; the Matter onboarding
                // payload is static per device.
                try { localStorage.setItem(`matter-qr-${BlindState.deviceId}`, qrPayload); } catch (e) {}
            }
        }
    }

    if (pos !== undefined && !BlindState.isDragging) {
        BlindState._visualTargetPos = pos;
    }

    if (pos !== undefined && pos !== BlindState.position && !BlindState.isDragging) {
        BlindState.position = pos;
        BlindState.isOpen = pos > 0;
        changed = true;

        if (!_firstPositionReceived) {
            // First position update after page load — snap instantly.
            // This prevents the visual animation from closed→open when the
            // blinds are already in their open position on the hardware.
            _firstPositionReceived = true;
            BlindState._visualPos = pos;
            BlindState._visualTargetPos = pos;
            BlindState._displayPos = pos;
            _applyVisualization(pos);
            const frame = document.getElementById('blindsFrame');
            if (frame) frame.classList.toggle('open', pos > 20);
            const label = document.getElementById('positionLabel');
            if (label) label.textContent = `${Math.round(pos)}%`;
        } else {
            // Subsequent updates — animate smoothly to match motor speed
            animateVisualization();
            animatePositionLabel();
        }
    } else if (pos !== undefined && !_firstPositionReceived) {
        // Position matches saved state — just mark as received
        _firstPositionReceived = true;
        BlindState._visualTargetPos = pos;
    }

    const timeSinceLastAction = Date.now() - (window._uiActionTimestamp || 0);
    const ignoreIncomingTarget = timeSinceLastAction < 2500;

    if (!ignoreIncomingTarget && state.targetPosition !== undefined && state.targetPosition !== BlindState.targetPosition) {
        BlindState.targetPosition = state.targetPosition;
        changed = true;
    } else if (state.targetPosition === undefined && pos !== undefined && pos !== BlindState.targetPosition) {
        // Fallback if firmware isn't sending targetPosition yet
        // Only fallback if the device is not moving, or it's been a while since we touched it
        if (!state.isMoving && timeSinceLastAction > 3000) {
            BlindState.targetPosition = pos;
            changed = true;
        }
    }

    // Moving state
    if (state.isMoving !== undefined) {
        BlindState.isMoving = !!state.isMoving;
        const label = document.getElementById('positionLabel');
        if (label) {
            label.classList.toggle('is-moving', state.isMoving);
        }
        // Reveal the live Stop control while the motor is actually running.
        if (typeof setStopButtonVisible === 'function') setStopButtonVisible(state.isMoving);

        // Critical Fix: when the device reports it is stopped, the UI target must
        // match the actual live position even inside the short command-ack guard.
        // Otherwise a stop/e-stop can leave the app showing the old destination.
        if (state.isMoving === false && BlindState.position !== undefined) {
            if (BlindState.targetPosition !== BlindState.position) {
                BlindState.targetPosition = BlindState.position;
                BlindState._visualTargetPos = BlindState.position;
                changed = true;
            }
            if (wasMoving && typeof requestDiagnosticsSnapshot === 'function') {
                requestDiagnosticsSnapshot({ delay: 1200 });
            }
        }
    }

    // Config updates (e.g., calibration angles)
    if (state.config) {
        if (BlindState.ignoreIncomingConfig) {
            console.log('[BlindDevice] Guard active: ignoring incoming config update from device to prevent overwriting setup config');
        } else {
            // Firmware now sends morningDays as object[] { enabled, time, duration, target }
            // Handle both legacy boolean[] format and new object[] format
            if (state.config.morningDays && Array.isArray(state.config.morningDays) &&
                state.config.morningDays.length === 7) {
                if (typeof state.config.morningDays[0] === 'boolean') {
                    // Legacy boolean[] format — convert to object[] with fallback values
                    const existingDays = BlindState.config.morningDays;
                    const fallbackTime = state.config.morningTime || BlindState.config.morningTime || '07:00';
                    const fallbackDuration = state.config.morningDuration || BlindState.config.morningDuration || 30;
                    const fallbackTarget = state.config.morningTarget !== undefined ? state.config.morningTarget :
                        (BlindState.config.morningTarget !== undefined ? BlindState.config.morningTarget : 100);
                    state.config.morningDays = state.config.morningDays.map((enabled, i) => {
                        if (existingDays && existingDays[i] && typeof existingDays[i] === 'object') {
                            return { ...existingDays[i], enabled: enabled };
                        }
                        return { enabled, time: fallbackTime, duration: fallbackDuration, target: fallbackTarget };
                    });
                }
                // If already object[] (new firmware format), use as-is — no conversion needed
            }
            // Firmware V14 sends nightDays as object[] { enabled, time, target }.
            // Keep that richer shape in the UI so per-day lock times are not lost
            // after the next save. Legacy boolean[] is migrated to objects.
            if (state.config.nightDays && Array.isArray(state.config.nightDays) && state.config.nightDays.length === 7) {
                const existingDays = BlindState.config.nightDays;
                const fallbackTime = state.config.nightTime || BlindState.config.nightTime || '22:00';
                const fallbackTarget = state.config.nightTarget !== undefined ? state.config.nightTarget :
                    (BlindState.config.nightTarget !== undefined ? BlindState.config.nightTarget : 0);
                state.config.nightDays = state.config.nightDays.map((d, i) => {
                    const existing = existingDays && existingDays[i] && typeof existingDays[i] === 'object'
                        ? existingDays[i]
                        : null;
                    if (d && typeof d === 'object') {
                        return {
                            enabled: d.enabled !== false,
                            time: d.time || existing?.time || fallbackTime,
                            target: d.target !== undefined ? d.target :
                                (existing?.target !== undefined ? existing.target : fallbackTarget)
                        };
                    }
                    return {
                        ...(existing || {}),
                        enabled: d === true,
                        time: existing?.time || fallbackTime,
                        target: existing?.target !== undefined ? existing.target : fallbackTarget
                    };
                });
            }
            // motionTimeout: firmware sends in SECONDS, UI stores in MINUTES
            // Convert before merging so all UI code works with minutes
            if (state.config.motionTimeout !== undefined && state.config.motionTimeout > 0) {
                state.config.motionTimeout = Math.round(state.config.motionTimeout / 60);
                // Clamp to minimum 1 minute for UI display
                if (state.config.motionTimeout < 1) state.config.motionTimeout = 1;
            }
            // Preserve the app-side sunset-offset PREFERENCE across the ingest. The
            // firmware only stores the RESOLVED number (it has no concept of
            // "inherit the home default"), so blindly ingesting its echo would
            // collapse a per-device "inherit" (null) into an explicit override and
            // silently stop the blind from tracking the global offset. The app is
            // the source of truth for this preference; keep it.
            const _preservedSunsetOffset = BlindState.config.sunsetOffset;
            Object.assign(BlindState.config, state.config);
            if (state.config.sunsetOffset !== undefined) {
                BlindState.config.sunsetOffset = _preservedSunsetOffset;
            }
            updateConfigUI();
        }
    }

    // Rules updates
    if (state.rules) {
        if (BlindState.ignoreIncomingConfig) {
            console.log('[BlindDevice] Guard active: ignoring incoming rules update from device to prevent overwriting setup config');
        } else {
            const rulesWereProvisional = BlindState._rulesProvisional;
            let rulesChanged = false;
            Object.entries(state.rules).forEach(([rule, enabled]) => {
                if (BlindState.rules[rule] !== enabled) rulesChanged = true;
            });
            Object.assign(BlindState.rules, state.rules);
            // The DEVICE's reported rules are the ground truth — once seen, the
            // local rules are explicit and may be included in config pushes.
            BlindState._rulesProvisional = false;
            Object.entries(BlindState.rules).forEach(([rule, enabled]) => {
                const toggle = document.querySelector(`[data-rule-toggle="${rule}"]`);
                if (toggle) {
                    toggle.checked = enabled;
                    const card = toggle.closest('.smart-rule-card');
                    if (card) card.classList.toggle('active-rule', enabled);
                }
            });
            if (typeof updateActiveRulesCount === 'function') updateActiveRulesCount();
            // Persist when something actually changed OR this was the first
            // device-confirmed rule set (so the explicitness survives reload).
            if (rulesChanged || rulesWereProvisional) changed = true;
        }
    }

    // Live Wi-Fi telemetry from the device (used by the TWT compatibility test
    // and status displays). These reflect the blind's REAL association, not a
    // placeholder.
    if (state.rssi !== undefined) BlindState.rssi = state.rssi;
    if (state.ssid !== undefined) BlindState.ssid = state.ssid;

    // Sunset/Sunrise Time from Device
    if (state.sunsetTime !== undefined) BlindState.sunsetTime = state.sunsetTime;
    if (state.sunriseTime !== undefined) BlindState.sunriseTime = state.sunriseTime;

    // Linked Device ID — re-subscribe if changed via firmware/remote
    if (state.linkedDeviceId !== undefined && state.linkedDeviceId !== BlindState.linkedDeviceId) {
        const oldLinked = BlindState.linkedDeviceId;
        BlindState.linkedDeviceId = state.linkedDeviceId;
        if (typeof MQTTClient !== 'undefined' && MQTTClient.connected) {
            if (oldLinked) MQTTClient.unsubscribeDevice(oldLinked);
            if (state.linkedDeviceId) MQTTClient.subscribeDevice(state.linkedDeviceId);
        }
        if (typeof updateLinkedDevice === 'function') updateLinkedDevice();
        // Re-subscribe for presence badge updates with the new linked device
        setupPresenceSubscription();
        saveDeviceState(null, true); // reacting to device state — persist locally, don't echo back
    }

    if (changed) {
        renderBlindState({ core: true });
        // Persist updated position/state to localStorage so the next page load
        // initializes the UI at the correct position (avoids the closed→open flash).
        saveDeviceState(null, true); // incoming device state — persist locally, don't echo back
    } else {
        renderBlindState({ core: false });
    }
}

function updateCalibrationWarning() {
    const warningEl = document.getElementById('calibrationWarning');
    const controlsContainer = document.querySelector('.blind-actions');
    const sliderContainer = document.querySelector('.slider-card');
    const presetsContainer = document.querySelector('.presets-grid');
    
    // Safety check: skip if UI elements aren't loaded
    if (!warningEl || !controlsContainer || !sliderContainer) return;

    // BlindState.blindType is the visualization mode (roller/vertical/etc), not
    // the hardware type. Use the same hardware check as Settings.
    const isStepperDevice = _isStepperBlindDevice(true);

    if (isStepperDevice && BlindState.isCalibrated !== true) {
        warningEl.style.display = 'flex';
        
        // Disable controls visually and functionally via CSS
        controlsContainer.style.opacity = '0.5';
        controlsContainer.style.pointerEvents = 'none';
        
        sliderContainer.style.opacity = '0.5';
        sliderContainer.style.pointerEvents = 'none';
        
        if (presetsContainer) {
            presetsContainer.style.opacity = '0.5';
            presetsContainer.style.pointerEvents = 'none';
        }
    } else {
        warningEl.style.display = 'none';
        
        controlsContainer.style.opacity = '1';
        controlsContainer.style.pointerEvents = 'auto';
        
        sliderContainer.style.opacity = '1';
        sliderContainer.style.pointerEvents = 'auto';
        
        if (presetsContainer) {
            presetsContainer.style.opacity = '1';
            presetsContainer.style.pointerEvents = 'auto';
        }
    }
}

// ============================================
// Multi-Type Visualization Dispatcher
// Note: Visualization and rendering logic is now located in blind-renderer.js
// ============================================

// ============================================
// Type Selector
// ============================================
function setupTypeSelector() {
    const btns = document.querySelectorAll('.type-btn');
    const pill = document.getElementById('typePill');
    const selector = document.querySelector('.type-selector');

    btns.forEach((btn, idx) => {
        // Set initial active (snap instantly on page load)
        if (btn.dataset.type === BlindState.blindType) {
            btn.classList.add('active');
            if (pill) moveTypePill(idx, true);
        }

        btn.addEventListener('click', () => {
            if (btn.dataset.type === BlindState.blindType) return;
            BlindState.blindType = btn.dataset.type;

            // Update active state
            btns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            if (pill) moveTypePill(idx, false); // smooth glide animation on manual click

            // Crossfade visualization
            const frame = document.getElementById('blindsFrame');
            if (frame) {
                frame.style.transition = 'opacity 0.25s ease';
                frame.style.opacity = '0';
                setTimeout(() => {
                    generateVisualization();
                    updateVisualization(BlindState.position);
                    frame.style.opacity = '1';
                    setTimeout(() => { frame.style.transition = ''; }, 300);
                }, 250);
            } else {
                generateVisualization();
                updateVisualization(BlindState.position);
            }

            saveDeviceState();
            if (typeof Haptic !== 'undefined') Haptic.selection();
        });
    });

    // Premium Resize & Visibility Observer to guarantee perfect selector alignment under all conditions
    if (selector && typeof ResizeObserver !== 'undefined') {
        const resizeObserver = new ResizeObserver(() => {
            if (typeof updateTypePill === 'function') updateTypePill(true); // snap on container resize/visibility
        });
        resizeObserver.observe(selector);
    }

    // Ensure pill is perfectly centered when returning to the webpage or tab
    window.addEventListener('focus', () => {
        if (typeof updateTypePill === 'function') updateTypePill(true); // snap on tab focus
    });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            if (typeof updateTypePill === 'function') updateTypePill(true); // snap when tab becomes visible
        }
    });
}

function moveTypePill(idx, snap = false) {
    const pill = document.getElementById('typePill');
    if (!pill) return;
    const btns = document.querySelectorAll('.type-btn');
    if (!btns[idx]) return;
    
    const btn = btns[idx];
    
    // Fallback: If elements are hidden (display:none), offsetWidth is 0
    // In that case, we don't attempt to move the pill to prevent it from disappearing.
    if (btn.offsetWidth === 0) return;
    
    if (snap) {
        // Temporarily disable transition for instant snapping without transition flyovers
        const originalTransition = pill.style.transition;
        pill.style.transition = 'none';
        pill.style.width = `${btn.offsetWidth}px`;
        pill.style.transform = `translateX(${btn.offsetLeft}px)`;
        // Force layout reflow
        pill.offsetHeight;
        // Restore transition in a microtask for future manual clicks
        setTimeout(() => {
            pill.style.transition = originalTransition;
        }, 50);
    } else {
        pill.style.width = `${btn.offsetWidth}px`;
        pill.style.transform = `translateX(${btn.offsetLeft}px)`;
    }
}

function updateTypePill(snap = false) {
    const btns = document.querySelectorAll('.type-btn');
    if (!btns.length) return;
    
    btns.forEach((btn, idx) => {
        if (btn.dataset.type === BlindState.blindType) {
            btns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            moveTypePill(idx, snap);
        }
    });
}


// ============================================
// Animated Position Counter
// ============================================
function animatePositionLabel() {
    if (_animFrameId) return;
    const label = document.getElementById('positionLabel');
    if (!label) return;

    let lastTime = performance.now();

    function tick(now) {
        if (BlindState.isDragging) {
            _animFrameId = null;
            return;
        }

        const dt = Math.min(now - lastTime, 50);
        lastTime = now;

        // STRICT TRACKING: Track target position for immediate response
        const target = BlindState.targetPosition !== undefined ? BlindState.targetPosition : 0;
        const diff = target - BlindState._displayPos;

        if (Math.abs(diff) < 0.5) {
            BlindState._displayPos = target;
            label.textContent = `${Math.round(target)}%`;
            _animFrameId = null;
            return;
        }

        // Use same interpolation speed as visuals to keep numbers in sync
        const maxSpeedPerMs = _calculateAnimationSpeed(diff);
        const maxStep = maxSpeedPerMs * dt;
        
        if (maxStep >= Math.abs(diff)) {
            BlindState._displayPos = target;
        } else {
            BlindState._displayPos += Math.sign(diff) * maxStep;
        }

        label.textContent = `${Math.round(BlindState._displayPos)}%`;
        _animFrameId = requestAnimationFrame(tick);
    }

    _animFrameId = requestAnimationFrame(tick);
}

// ============================================
// Dock Navigation
// ============================================
function setupDock() {
    const dockBtns = document.querySelectorAll('.dock-btn');
    dockBtns.forEach((btn, index) => {
        btn.addEventListener('click', () => {
            switchTab(btn.dataset.tab);
            if (typeof Haptic !== 'undefined') Haptic.selection();
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
        btn.style.opacity = '';
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
        
        // Refresh the pill when settings tab becomes visible so bounding rects work
        if (isActive && tabName === 'settings') {
            requestAnimationFrame(() => {
                if (typeof updateTypePill === 'function') updateTypePill();
            });
        }
    });

    updateDockPill(true);
}

function updateDockPill(animate = true) {
    const pill = document.getElementById('dockPill');
    const activeBtn = document.querySelector('.dock-btn.active');

    if (!pill || !activeBtn) return;

    const buttons = Array.from(document.querySelectorAll('.dock-btn'));
    const index = buttons.indexOf(activeBtn);

    const targetX = index * 52;

    if (animate) {
        pill.style.transition = '';
    } else {
        pill.style.transition = 'none';
    }

    pill.style.transform = `translateX(${targetX}px)`;
}

// Draggable Pill State
const pillDragState = {
    isDragging: false,
    recentlyDragged: false,
    startX: 0,
    startY: 0,
    currentX: 0,
    pillStartX: 0,
    buttonWidth: 52,
    numButtons: 3,
    dragThreshold: 5,
    hasMoved: false,
    previewIndex: -1
};

function setupDraggablePill() {
    const pill = document.getElementById('dockPill');
    const dockInner = document.querySelector('.dock-inner');

    if (!pill || !dockInner) return;

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

    e.preventDefault();
    e.stopPropagation();

    const clientX = e.type.includes('touch') ? e.touches[0].clientX : e.clientX;
    const clientY = e.type.includes('touch') ? e.touches[0].clientY : e.clientY;

    pillDragState.isDragging = true;
    pillDragState.hasMoved = false;
    pillDragState.startX = clientX;
    pillDragState.startY = clientY;
    pillDragState.previewIndex = currentTabIndex;

    const transform = pill.style.transform;
    const match = transform.match(/translateX\(([^)]+)px\)/);
    pillDragState.pillStartX = match ? parseFloat(match[1]) : currentTabIndex * pillDragState.buttonWidth;
    pillDragState.currentX = pillDragState.pillStartX;

    pill.style.transition = 'box-shadow 0.15s ease';
    pill.style.cursor = 'grabbing';
    pill.classList.add('dragging');
}

function handlePillDragMove(e) {
    if (!pillDragState.isDragging) return;

    const pill = document.getElementById('dockPill');
    if (!pill) return;

    const clientX = e.type.includes('touch') ? e.touches[0].clientX : e.clientX;
    const deltaX = clientX - pillDragState.startX;

    if (!pillDragState.hasMoved && Math.abs(deltaX) > pillDragState.dragThreshold) {
        pillDragState.hasMoved = true;
    }

    if (!pillDragState.hasMoved) return;

    e.preventDefault();

    const maxX = (pillDragState.numButtons - 1) * pillDragState.buttonWidth;
    let newX = pillDragState.pillStartX + deltaX;

    if (newX < 0) {
        newX = newX * 0.25;
    } else if (newX > maxX) {
        newX = maxX + (newX - maxX) * 0.25;
    }

    pillDragState.currentX = newX;
    pill.style.transform = `translateX(${newX}px)`;

    const previewIndex = Math.round(Math.max(0, Math.min(newX, maxX)) / pillDragState.buttonWidth);
    if (previewIndex !== pillDragState.previewIndex) {
        pillDragState.previewIndex = previewIndex;
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

    document.querySelectorAll('.dock-btn').forEach(btn => {
        btn.style.opacity = '';
    });

    pillDragState.recentlyDragged = true;
    setTimeout(() => {
        pillDragState.recentlyDragged = false;
    }, 150);

    pill.style.cursor = 'grab';
    pill.classList.remove('dragging');

    if (!pillDragState.hasMoved) {
        const dockInner = document.querySelector('.dock-inner');
        if (dockInner) {
            const rect = dockInner.getBoundingClientRect();
            const tapX = pillDragState.startX - rect.left;
            const tappedIndex = Math.floor(tapX / pillDragState.buttonWidth);
            const clampedIndex = Math.max(0, Math.min(tappedIndex, pillDragState.numButtons - 1));

            if (clampedIndex !== currentTabIndex) {
                switchTab(tabs[clampedIndex]);
                if (typeof Haptic !== 'undefined') Haptic.light();
            }
        }
        return;
    }

    const snapIndex = Math.round(pillDragState.currentX / pillDragState.buttonWidth);
    const clampedIndex = Math.max(0, Math.min(snapIndex, pillDragState.numButtons - 1));

    if (clampedIndex !== currentTabIndex) {
        switchTab(tabs[clampedIndex]);
        if (typeof Haptic !== 'undefined') Haptic.light();
    } else {
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

function handleSwipe() {
    if (pillDragState.isDragging || pillDragState.recentlyDragged) return;

    const swipeThreshold = 100;
    const diff = touchStartX - touchEndX;
    const verticalDiff = Math.abs(touchStartY - touchEndY);

    // Reject if vertical movement exceeds horizontal (user was scrolling, not swiping)
    if (verticalDiff > Math.abs(diff) * 0.75) return;

    if (Math.abs(diff) < swipeThreshold) return;

    if (diff > 0) {
        // Swipe left
        if (currentTabIndex < tabs.length - 1) {
            switchTab(tabs[currentTabIndex + 1]);
        }
    } else {
        // Swipe right
        if (currentTabIndex > 0) {
            switchTab(tabs[currentTabIndex - 1]);
        }
    }
}




// ============================================
// Controls
// ============================================
function setupControls() {
    const openBtn = document.getElementById('openBtn');
    const closeBtn = document.getElementById('closeBtn');

    if (openBtn) {
        openBtn.addEventListener('click', () => {
            setPosition(100);
            _pulseButton(openBtn);
            if (typeof Haptic !== 'undefined') Haptic.heavy();
        });
    }

    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            setPosition(0);
            _pulseButton(closeBtn);
            if (typeof Haptic !== 'undefined') Haptic.medium();
        });
    }

    // Live Stop control: two-stage hold. A deliberate hold sends a normal stop;
    // continuing to hold escalates to emergency stop while preserving position.
    const stopBtn = document.getElementById('stopBtn');
    if (stopBtn) {
        let normalStopTimer = null;
        let emergencyStopTimer = null;
        let holdFrame = null;
        let holdStartedAt = 0;
        let activePointerId = null;
        let emergencyFired = false;
        const normalHoldMs = 450;
        const emergencyHoldMs = 1200;
        const hint = document.getElementById('stopBtnHint');
        const status = stopBtn.querySelector('.blind-stop-status');

        const setHoldProgress = (pct) => {
            stopBtn.style.setProperty('--stop-hold-progress', `${Math.max(0, Math.min(100, pct))}%`);
        };

        const resetStopVisual = () => {
            stopBtn.classList.remove('is-pressed', 'is-emergency');
            setHoldProgress(0);
            if (hint) hint.textContent = 'Tap to stop';
            if (status) status.textContent = 'Stop';
        };

        const tickHoldProgress = () => {
            if (!holdStartedAt) return;
            const elapsed = Date.now() - holdStartedAt;
            setHoldProgress((elapsed / emergencyHoldMs) * 100);
            if (elapsed < emergencyHoldMs && !emergencyFired) {
                holdFrame = requestAnimationFrame(tickHoldProgress);
            }
        };

        // Delivery verification: a stop is deliberately never queued (a stale
        // stop firing later is dangerous), but a stop lost in transit is just
        // as bad — the UI said "Stopping…" while the blind kept moving. If the
        // blind still reports motion ~1.5 s after a stop and we're online,
        // re-send it ONCE and tell the user. State arrives every 250 ms while
        // moving, so isMoving is fresh enough to judge by.
        let stopVerifyTimer = null;
        const verifyStopDelivered = (emergency) => {
            clearTimeout(stopVerifyTimer);
            stopVerifyTimer = setTimeout(() => {
                stopVerifyTimer = null;
                if (!BlindState.isMoving) return; // confirmed stopped — done
                if (typeof MQTTClient === 'undefined' || !MQTTClient.connected) return;
                const cmd = emergency ? { command: 'emergencyStop' } : { command: 'stop' };
                if (typeof BlindCommandQueue !== 'undefined' && typeof BlindCommandQueue.send === 'function') {
                    BlindCommandQueue.send(BlindState.deviceId, cmd, { source: 'blind-page', persist: false });
                } else {
                    MQTTClient.publishStepperControl(BlindState.deviceId, cmd);
                }
                if (typeof Toast !== 'undefined') Toast.info('Still moving — stop re-sent');
                if (typeof addLogEntry === 'function') addLogEntry('Stop', 'Stop re-sent (no confirmation within 1.5s)');
            }, 1500);
        };

        const sendStop = (emergency) => {
            const cmd = emergency ? { command: 'emergencyStop' } : { command: 'stop' };
            if (typeof MQTTClient === 'undefined') {
                if (typeof Toast !== 'undefined') Toast.error(emergency ? "Can't emergency stop right now" : "Can't stop right now");
                if (typeof Haptic !== 'undefined') Haptic.error();
                return false;
            }
            let attempted = false;
            if (typeof BlindCommandQueue !== 'undefined' && typeof BlindCommandQueue.send === 'function') {
                BlindCommandQueue.send(BlindState.deviceId, cmd, { source: 'blind-page', persist: false });
                attempted = true;
            } else {
                MQTTClient.publishStepperControl(BlindState.deviceId, cmd);
                attempted = true;
            }
            verifyStopDelivered(emergency);
            // Halt the local visual at the current position instead of letting it
            // keep animating toward the old target.
            window._uiActionTimestamp = Date.now();
            BlindState.targetPosition = BlindState.position;
            BlindState._visualTargetPos = BlindState.position;
            if (typeof updateUI === 'function') updateUI();
            if (typeof Toast !== 'undefined') {
                if (MQTTClient.connected) Toast.success(emergency ? 'Emergency stop sent' : 'Stopping...');
                else Toast.info(emergency ? 'Trying emergency stop on local LAN' : 'Trying local stop on the LAN');
            }
            if (typeof addLogEntry === 'function') addLogEntry('Stop', emergency ? 'Emergency stop triggered' : 'Stop requested');
            return attempted;
        };

        stopBtn.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            activePointerId = e.pointerId;
            if (typeof stopBtn.setPointerCapture === 'function') {
                try { stopBtn.setPointerCapture(activePointerId); } catch (err) { /* best effort */ }
            }
            emergencyFired = false;
            holdStartedAt = Date.now();
            stopBtn.classList.add('is-pressed');
            if (hint) hint.textContent = 'Stop sent. Hold for emergency';
            if (status) status.textContent = 'Stopping';
            setHoldProgress(0);
            holdFrame = requestAnimationFrame(tickHoldProgress);
            if (typeof Haptic !== 'undefined') Haptic.medium();
            sendStop(false);
            emergencyStopTimer = setTimeout(() => {
                emergencyStopTimer = null;
                emergencyFired = true;
                if (sendStop(true)) {
                    stopBtn.classList.add('is-emergency');
                    setHoldProgress(100);
                    if (typeof Haptic !== 'undefined' && typeof Haptic.notification === 'function') Haptic.notification('warning');
                    else if (typeof Haptic !== 'undefined') Haptic.heavy();
                    if (hint) hint.textContent = 'Emergency stop sent';
                    if (status) status.textContent = 'Sent';
                }
            }, emergencyHoldMs);
        });

        const endPress = (graceful) => {
            if (holdFrame) { cancelAnimationFrame(holdFrame); holdFrame = null; }
            if (normalStopTimer) { clearTimeout(normalStopTimer); normalStopTimer = null; }
            if (emergencyStopTimer) { clearTimeout(emergencyStopTimer); emergencyStopTimer = null; }
            if (activePointerId !== null && typeof stopBtn.releasePointerCapture === 'function') {
                try { stopBtn.releasePointerCapture(activePointerId); } catch (err) { /* best effort */ }
            }
            activePointerId = null;
            holdStartedAt = 0;
            emergencyFired = false;
            setTimeout(resetStopVisual, graceful ? 180 : 0);
        };
        stopBtn.addEventListener('pointerup', (e) => { e.preventDefault(); endPress(true); });
        // Sliding off cancels a pending hold without firing a graceful stop.
        stopBtn.addEventListener('pointerleave', () => endPress(false));
        stopBtn.addEventListener('pointercancel', () => endPress(false));
    }
}

// Show the live Stop control only while the blind is actually moving.
function setStopButtonVisible(visible) {
    const row = document.getElementById('blindStopRow');
    if (!row) return;
    row.style.display = visible ? 'block' : 'none';
    if (visible) {
        const hint = document.getElementById('stopBtnHint');
        const stopBtn = document.getElementById('stopBtn');
        const status = stopBtn ? stopBtn.querySelector('.blind-stop-status') : null;
        if (hint) hint.textContent = 'Tap to stop';
        if (status) status.textContent = 'Stop';
        if (stopBtn) {
            stopBtn.classList.remove('is-pressed', 'is-emergency');
            stopBtn.style.setProperty('--stop-hold-progress', '0%');
        }
    }
}

/**
 * Provides visual press feedback on a button — a quick scale-down + spring-back.
 * Ensures the user always sees confirmation that their tap registered,
 * even if the target position is already set.
 */
function _pulseButton(btn) {
    btn.style.transition = 'transform 0.08s ease-in';
    btn.style.transform = 'scale(0.93)';
    setTimeout(() => {
        btn.style.transition = 'transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)';
        btn.style.transform = '';
    }, 80);
}

function setPosition(pos) {
    window._uiActionTimestamp = Date.now();
    // Only update the target position immediately so the UI buttons react
    // We do NOT update the real 'position' here, so the animation doesn't jump
    const safePos = Math.max(0, Math.min(100, pos));

    if (_isStepperBlindDevice(true) && BlindState.isCalibrated !== true) {
        BlindState.targetPosition = BlindState.position;
        BlindState._visualTargetPos = BlindState.position;
        BlindState._visualPos = BlindState.position;
        BlindState._displayPos = BlindState.position;
        updateUI();
        _applyVisualization(BlindState.position);
        if (typeof setStopButtonVisible === 'function') setStopButtonVisible(false);
        const message = _commandRejectMessage('not_calibrated');
        if (typeof Toast !== 'undefined') Toast.error(message);
        if (typeof addLogEntry === 'function') {
            addLogEntry('!', message, { key: `local:not-calibrated:${Date.now()}`, source: 'app' });
        }
        return false;
    }

    BlindState.targetPosition = safePos;
    BlindState._visualTargetPos = safePos;
    updateUI();
    // Reveal the Stop control immediately when a real move is commanded (don't
    // wait for the device's isMoving echo); it hides again once the blind reports
    // it has stopped. A no-op move (already at target) shouldn't show it.
    if (typeof setStopButtonVisible === 'function' && safePos !== BlindState.position) {
        setStopButtonVisible(true);
    }
    saveDeviceState(null, true); // local persist only — the position is published separately below

    // Trigger local animation immediately so the visual moves!
    if (typeof animateVisualization === 'function') {
        animateVisualization();
    }
    if (typeof animatePositionLabel === 'function') {
        animatePositionLabel();
    }

    const command = { blindPosition: safePos };

    // Send position command via MQTT.
    // Stepper devices use a dedicated topic (stepper/set_position).
    if (typeof BlindCommandQueue !== 'undefined' && typeof BlindCommandQueue.sendPosition === 'function') {
        BlindCommandQueue.sendPosition(BlindState.deviceId, safePos, { source: 'blind-page' });
        if (typeof StateStore !== 'undefined') {
            StateStore.update(BlindState.deviceId, { targetPosition: safePos });
        }
    } else if (typeof MQTTClient !== 'undefined') {
        // Degraded fallback (blind-sync.js failed to load — it is precached, so
        // this is exceptional): direct publish, with an HONEST failure instead
        // of a second shadow queue. Unbounded shadow queues replayed stale
        // moves hours later.
        const sent = MQTTClient.publishStepperControl(BlindState.deviceId, command);

        if (typeof StateStore !== 'undefined') {
            StateStore.update(BlindState.deviceId, { targetPosition: safePos });
        }
        if (!sent && typeof Toast !== 'undefined') {
            Toast.error('No connection — the blind did not receive that command');
        }
    } else if (typeof Toast !== 'undefined') {
        Toast.error('No connection — the blind did not receive that command');
    }
    return true;
}

// ============================================
// Position Slider
// ============================================
function setupSlider() {
    const slider = document.getElementById('positionSlider');
    const tooltip = document.getElementById('sliderTooltip');
    if (!slider) return;

    slider.addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10);
        // Update the slider visual (gradient + value label) while dragging.
        updateSliderGradient(val);
        const sliderVal = document.getElementById('sliderValue');
        if (sliderVal) sliderVal.textContent = `${val}% `;

        // Update absolute tooltip value & horizontal left coordinate
        if (tooltip) {
            tooltip.textContent = `${val}%`;
            tooltip.style.left = `${val}%`;
            tooltip.classList.add('visible');
        }
        slider.classList.add('active-drag');

        // Update SVG visualization in real-time during dragging for premium UX
        if (typeof updateVisualization === 'function') {
            updateVisualization(val);
        }
        // Keep the renderer's stored visual position in lock-step with the live
        // preview. Without this, the post-release animation (animateVisualization)
        // starts from the stale pre-drag _visualPos and visibly snaps back before
        // settling on the released value.
        BlindState._visualPos = val;
        BlindState._visualTargetPos = val;
        BlindState._displayPos = val;

        if (!BlindState.isDragging) {
            BlindState.isDragging = true;
            document.body.classList.add('no-transition');
            if (typeof Haptic !== 'undefined') Haptic.light();
        }
    });

    slider.addEventListener('change', (e) => {
        BlindState.isDragging = false;
        document.body.classList.remove('no-transition');
        const val = parseInt(e.target.value, 10);
        
        // Hide tooltip & remove glowing halo when dragging halts
        if (tooltip) {
            tooltip.classList.remove('visible');
        }
        slider.classList.remove('active-drag');

        setPosition(val);
    });
}

function updateSliderGradient(value) {
    const slider = document.getElementById('positionSlider');
    if (!slider) return;
    const pct = value;
    // Premium fill: teal gradient on the filled portion, subtle dark track after.
    slider.style.background = `linear-gradient(90deg, #2dd4bf 0%, #14b8a6 ${pct}%, rgba(255,255,255,0.07) ${pct}%, rgba(255,255,255,0.07) 100%)`;
}

// ============================================
// Presets
// ============================================
function setupPresets() {
    const presetBtns = document.querySelectorAll('.preset-btn');
    presetBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const val = parseInt(btn.dataset.preset, 10);
            setPosition(val);
            if (typeof Haptic !== 'undefined') Haptic.selection();

            // Spring animation
            btn.style.transition = 'transform 0.1s ease-in';
            btn.style.transform = 'scale(0.88)';
            setTimeout(() => {
                btn.style.transition = 'transform 0.45s cubic-bezier(0.34, 1.56, 0.64, 1)';
                btn.style.transform = '';
            }, 100);
        });
    });
}

function updatePresetActive(targetPosition) {
    document.querySelectorAll('.preset-btn').forEach(btn => {
        const preset = parseInt(btn.dataset.preset, 10);
        btn.classList.toggle('active', preset === targetPosition);
    });
}

// ============================================
// Smart Rule Toggles
// ============================================
function setupRuleToggles() {
    document.querySelectorAll('[data-rule-toggle]').forEach(toggle => {
        // Prevent duplicate listener attachments
        if (toggle.dataset.ruleListenerAttached) return;
        toggle.dataset.ruleListenerAttached = 'true';

        toggle.addEventListener('change', () => {
            // Debounce the change event to prevent mobile browser multi-firing quirks
            if (toggle.dataset.isChanging === 'true') return;
            toggle.dataset.isChanging = 'true';
            setTimeout(() => toggle.dataset.isChanging = 'false', 300);

            const rule = toggle.dataset.ruleToggle;
            BlindState.rules[rule] = toggle.checked;
            // A user toggle is the definition of an explicit rule choice.
            BlindState._rulesProvisional = false;

            // Toggle active-rule class on card
            const card = toggle.closest('.smart-rule-card');
            if (card) card.classList.toggle('active-rule', toggle.checked);

            updateActiveRulesCount();
            // saveDeviceState() reliably delivers the full rules+config via
            // ConfigSync (queued offline, confirmed by firmware ack), so an
            // offline rule toggle is no longer silently dropped.
            saveDeviceState();

            // Tell the engine rules changed so it re-evaluates immediately
            if (typeof AutomationEngine !== 'undefined' && AutomationEngine.evaluate) {
                AutomationEngine.evaluate();
            }

            if (typeof Haptic !== 'undefined') Haptic.selection();
            if (typeof Toast !== 'undefined') {
                // Show next wake-up countdown when enabling morningOpen
                if (rule === 'morningOpen' && toggle.checked) {
                    const msg = _getNextMorningWakeupMessage();
                    Toast.success(msg || 'Morning wake-up enabled');
                } else {
                    Toast.success(`${toggle.checked ? 'Enabled' : 'Disabled'} rule`);
                }
            }
        });
    });
}

function updateActiveRulesCount() {
    const rulesToCount = { ...BlindState.rules };
    delete rulesToCount.presence;
    const count = Object.values(rulesToCount).filter(v => v).length;
    const badge = document.getElementById('activeRulesCount');
    if (badge) badge.textContent = `${count} Active`;
}

// ============================================
// Smart Rule Config Modals
// ============================================
function setupRuleConfigModals() {
    document.querySelectorAll('.rule-config-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation(); // prevent card click
            const rule = btn.dataset.configRule;
            if (typeof Modal === 'undefined') return;

            if (rule === 'sunset') showSunsetConfigModal();
            else if (rule === 'presence') showPresenceConfigModal();
            else if (rule === 'morningOpen') showMorningConfigModal();
            else if (rule === 'nightLock') showNightLockConfigModal();
            else if (rule === 'temperature') showTempConfigModal();
        });
    });
}

function _publishRulesConfig() {
    // saveDeviceState() persists locally + to Firebase and (debounced) delivers
    // the full rules+config to the device via ConfigSync — queued when offline,
    // retried, and confirmed by the firmware cfgRev ack. No separate
    // connected-only publish is needed (it would just drop changes when offline).
    saveDeviceState();

    // Trigger engine to immediately re-evaluate with new config
    if (typeof AutomationEngine !== 'undefined' && AutomationEngine.evaluate) {
        AutomationEngine.evaluate();
    }
}

function showSunsetConfigModal() {
    // ── Resolve effective location & offset ──────────────────────
    const globalOffset = parseInt(localStorage.getItem('zaylo-SunsetOffset') || '0', 10);
    const perDevice = Number(BlindState.config.sunsetOffset);
    const hasOffsetOverride = BlindState.config.sunsetOffset !== null &&
        BlindState.config.sunsetOffset !== undefined && Number.isFinite(perDevice);
    const effectiveOffset = hasOffsetOverride ? perDevice : globalOffset;

    const hasCustomLocation = BlindState.config.lat != null && BlindState.config.lon != null &&
        Number.isFinite(Number(BlindState.config.lat)) && Number.isFinite(Number(BlindState.config.lon));
    const effectiveLat = hasCustomLocation ? BlindState.config.lat : localStorage.getItem('zaylo-LocationLat');
    const effectiveLon = hasCustomLocation ? BlindState.config.lon : localStorage.getItem('zaylo-LocationLon');
    const effectiveCity = hasCustomLocation
        ? (BlindState.config.city || 'Custom Location')
        : (localStorage.getItem('zaylo-LocationCity') || '');
    const locationSourceLabel = hasCustomLocation ? 'Custom Override' : 'Home Default';

    const defaultTarget = BlindState.config.sunsetTarget !== undefined ? BlindState.config.sunsetTarget : 0;
    const fmtOffset = (v) => `${v >= 0 ? '+' : ''}${v} min`;
    const OPENWEATHER_KEY = (typeof OPENWEATHER_API_KEY !== 'undefined') ? OPENWEATHER_API_KEY : 'e20c6a9a37404d9726371c943d7da0ba';

    // ── Build modal ──────────────────────────────────────────────
    const { modal, close } = Modal.create({
        title: 'Sunset Auto-Close',
        content: `
            <!-- ─── Location Card ─── -->
            <div class="sunset-location-card" id="sunsetLocationCard">
                <div class="sunset-location-header">
                    <div class="sunset-location-icon-wrap">
                        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>
                    </div>
                    <div class="sunset-location-info">
                        <div class="sunset-location-city" id="sunsetLocCity">${effectiveCity || 'No location set'}</div>
                        <div class="sunset-location-source" id="sunsetLocSource">${effectiveCity ? locationSourceLabel : 'Set a location for accurate sunset times'}</div>
                    </div>
                    <button class="sunset-location-toggle" id="sunsetLocToggle" aria-label="Change location" type="button">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
                    </button>
                </div>
                <div class="sunset-location-body" id="sunsetLocBody" style="display:none;">
                    <div style="display:flex; gap:8px; margin-bottom:10px;">
                        <input type="text" id="sunsetLocInput" placeholder="e.g. London or SW1A 1AA" value="" style="flex:1; padding:10px 12px; background:var(--bg-glass); border:1px solid var(--border-glass); border-radius:10px; color:var(--text-primary); font-size:13px; font-family:var(--font-family);">
                        <button id="sunsetLocSetBtn" type="button" style="padding:0 14px; border-radius:10px; border:none; background:linear-gradient(135deg,#a855f7,#7c3aed); color:#fff; font-size:13px; font-weight:700; cursor:pointer; transition:all 0.2s ease; font-family:var(--font-family);">Set</button>
                    </div>
                    <div style="display:flex; gap:8px;">
                        <button id="sunsetLocGpsBtn" type="button" style="flex:1; padding:10px; border-radius:10px; border:1px solid var(--border-glass); background:var(--bg-glass); color:var(--text-secondary); font-size:12px; font-weight:600; cursor:pointer; transition:all 0.2s ease; display:flex; align-items:center; justify-content:center; gap:6px; font-family:var(--font-family);">
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2v4"/><path d="M12 18v4"/><path d="M2 12h4"/><path d="M18 12h4"/></svg>
                            Use GPS
                        </button>
                        <button id="sunsetLocResetBtn" type="button" style="flex:1; padding:10px; border-radius:10px; border:1px solid var(--border-glass); background:var(--bg-glass); color:var(--text-secondary); font-size:12px; font-weight:600; cursor:pointer; transition:all 0.2s ease; display:${hasCustomLocation ? 'flex' : 'none'}; align-items:center; justify-content:center; gap:6px; font-family:var(--font-family);">
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
                            Reset to Home
                        </button>
                    </div>
                </div>
            </div>

            <!-- ─── Sunset Time Preview ─── -->
            <div class="sunset-time-preview" id="sunsetTimePreview">
                <div class="sunset-time-row">
                    <div class="sunset-time-block sunset">
                        <div class="sunset-time-label">
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 10V2"/><path d="m4.93 10.93 1.41 1.41"/><path d="M2 18h2"/><path d="M20 18h2"/><path d="m19.07 10.93-1.41 1.41"/><path d="M22 22H2"/><path d="m16 6-4 4-4-4"/><path d="M16 18a4 4 0 0 0-8 0"/></svg>
                            Sunset
                        </div>
                        <div class="sunset-time-value" id="sunsetBaseTime">--:--</div>
                    </div>
                    <div class="sunset-time-arrow">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
                    </div>
                    <div class="sunset-time-block closing">
                        <div class="sunset-time-label">
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>
                            Closes at
                        </div>
                        <div class="sunset-time-value" id="sunsetCloseTime">--:--</div>
                    </div>
                </div>
                <div class="sunset-time-loading" id="sunsetTimeLoading">
                    <svg class="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
                    <span>Fetching sunset time…</span>
                </div>
            </div>

            <!-- ─── Offset Slider ─── -->
            <div class="setting-item" style="padding: 16px 0 8px 0; border: none;">
                <div class="setting-left">
                    <span class="setting-label">Sunset Offset</span>
                    <span class="setting-sublabel">Negative = before sunset · Positive = after</span>
                </div>
            </div>
            <input type="range" id="sunsetOffsetInput" min="-120" max="120" step="5" value="${effectiveOffset}" class="blind-slider" style="width: 100%; height: 8px; border-radius: 4px; -webkit-appearance: none; background: var(--bg-tertiary); outline: none;">
            <div class="modal-value-display" id="sunsetOffsetDisplay">${fmtOffset(effectiveOffset)}</div>

            <!-- ─── Target Slider ─── -->
            <div class="setting-item" style="padding: 16px 0 12px 0; border: none;">
                <div class="setting-left">
                    <span class="setting-label">Target Position (%)</span>
                    <span class="setting-sublabel">0 is fully closed</span>
                </div>
            </div>
            <input type="range" id="sunsetTargetInput" min="0" max="100" value="${defaultTarget}" class="blind-slider" style="width: 100%; height: 8px; border-radius: 4px; -webkit-appearance: none; background: var(--bg-tertiary); outline: none;">
            <div class="modal-value-display" id="sunsetTargetDisplay">${defaultTarget}%</div>
        `,
        actions: [
            { label: 'Cancel', primary: false },
            {
                label: 'Save', primary: true, onClick: () => {
                    let offsetVal = parseInt(modal.querySelector('#sunsetOffsetInput').value, 10);
                    BlindState.config.sunsetOffset = isNaN(offsetVal) ? 0 : Math.max(-120, Math.min(120, offsetVal));

                    let targetVal = parseInt(modal.querySelector('#sunsetTargetInput').value, 10);
                    BlindState.config.sunsetTarget = isNaN(targetVal) ? 0 : targetVal;

                    updateConfigUI();

                    _publishRulesConfig();
                    if (typeof Toast !== 'undefined') Toast.success('Sunset rules updated');
                    return true;
                }
            }
        ]
    });

    // ── Internal state for live sunset preview ───────────────────
    let _sunsetUnix = 0; // raw sunset epoch seconds from API
    let _activeLat = effectiveLat;
    let _activeLon = effectiveLon;
    let _activeCity = effectiveCity;
    let _isCustom = hasCustomLocation;

    // ── Helpers ──────────────────────────────────────────────────
    const _fmtTime = (date) => `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;

    function _updateCloseTimePreview() {
        const closeTimeEl = modal.querySelector('#sunsetCloseTime');
        const baseTimeEl = modal.querySelector('#sunsetBaseTime');
        if (!closeTimeEl) return;

        if (!_sunsetUnix) {
            closeTimeEl.textContent = '--:--';
            return;
        }

        const currentOffset = parseInt(modal.querySelector('#sunsetOffsetInput')?.value || '0', 10);
        const effectiveUnix = _sunsetUnix + (currentOffset * 60);
        const closeDate = new Date(effectiveUnix * 1000);
        const newText = _fmtTime(closeDate);

        // Micro-animation: scale pop on value change
        if (closeTimeEl.textContent !== newText) {
            closeTimeEl.textContent = newText;
            closeTimeEl.style.transform = 'scale(1.12)';
            closeTimeEl.style.transition = 'transform 0.15s cubic-bezier(0.34, 1.56, 0.64, 1)';
            setTimeout(() => { closeTimeEl.style.transform = ''; }, 180);
        }
    }

    function _updateLocationUI() {
        const cityEl = modal.querySelector('#sunsetLocCity');
        const sourceEl = modal.querySelector('#sunsetLocSource');
        const resetBtn = modal.querySelector('#sunsetLocResetBtn');

        if (cityEl) cityEl.textContent = _activeCity || 'No location set';
        if (sourceEl) sourceEl.textContent = _activeCity
            ? (_isCustom ? 'Custom Override' : 'Home Default')
            : 'Set a location for accurate sunset times';
        if (resetBtn) resetBtn.style.display = _isCustom ? 'flex' : 'none';
    }

    function _fetchSunsetForCoords(lat, lon) {
        if (!lat || !lon) return;
        const loadingEl = modal.querySelector('#sunsetTimeLoading');
        const baseTimeEl = modal.querySelector('#sunsetBaseTime');
        if (loadingEl) loadingEl.style.display = 'flex';

        fetch(`https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${OPENWEATHER_KEY}`)
            .then(r => r.json())
            .then(data => {
                if (data?.sys?.sunset) {
                    _sunsetUnix = data.sys.sunset;
                    const sunsetDate = new Date(_sunsetUnix * 1000);
                    if (baseTimeEl) baseTimeEl.textContent = _fmtTime(sunsetDate);
                    _updateCloseTimePreview();
                    if (loadingEl) loadingEl.style.display = 'none';
                } else {
                    if (baseTimeEl) baseTimeEl.textContent = '--:--';
                    if (loadingEl) {
                        loadingEl.innerHTML = '<span style="font-size:11px; color:var(--text-tertiary);">Could not load sunset time</span>';
                        loadingEl.style.display = 'flex';
                    }
                }
            })
            .catch(() => {
                if (loadingEl) {
                    loadingEl.innerHTML = '<span style="font-size:11px; color:var(--text-tertiary);">Failed to fetch sunset time</span>';
                    loadingEl.style.display = 'flex';
                }
            });
    }

    function _applyLocationToDevice(lat, lon, cityName) {
        _activeLat = lat;
        _activeLon = lon;
        _activeCity = cityName;
        _isCustom = true;
        BlindState.config.lat = parseFloat(lat);
        BlindState.config.lon = parseFloat(lon);
        BlindState.config.city = cityName;
        _updateLocationUI();
        _fetchSunsetForCoords(lat, lon);
        if (typeof Haptic !== 'undefined') Haptic.success();
    }

    // ── Wire up offset slider for real-time preview ─────────────
    const offsetInput = modal.querySelector('#sunsetOffsetInput');
    const offsetDisplayEl = modal.querySelector('#sunsetOffsetDisplay');
    if (offsetInput) {
        offsetInput.addEventListener('input', (e) => {
            const val = parseInt(e.target.value, 10);
            if (offsetDisplayEl) {
                const newLabel = fmtOffset(val);
                offsetDisplayEl.textContent = newLabel;
                offsetDisplayEl.style.transform = 'scale(1.08)';
                setTimeout(() => { offsetDisplayEl.style.transform = ''; }, 150);
            }
            _updateCloseTimePreview();
            if (typeof Haptic !== 'undefined') Haptic.light();
        });
    }

    // ── Wire up target slider ───────────────────────────────────
    const targetInput = modal.querySelector('#sunsetTargetInput');
    const targetDisplay = modal.querySelector('#sunsetTargetDisplay');
    if (targetInput) {
        targetInput.addEventListener('input', (e) => {
            if (targetDisplay) targetDisplay.textContent = e.target.value + '%';
            if (typeof Haptic !== 'undefined') Haptic.light();
        });
    }

    // ── Location panel toggle (accordion) ───────────────────────
    const locToggle = modal.querySelector('#sunsetLocToggle');
    const locBody = modal.querySelector('#sunsetLocBody');
    if (locToggle && locBody) {
        locToggle.addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpen = locBody.style.display !== 'none';
            locBody.style.display = isOpen ? 'none' : 'block';
            locToggle.style.transform = isOpen ? '' : 'rotate(180deg)';
            if (typeof Haptic !== 'undefined') Haptic.light();
        });
    }
    // Also toggle when tapping the header
    const locHeader = modal.querySelector('.sunset-location-header');
    if (locHeader) {
        locHeader.addEventListener('click', (e) => {
            if (e.target.closest('#sunsetLocToggle')) return; // already handled
            if (locToggle) locToggle.click();
        });
    }

    // ── Set location via text input ─────────────────────────────
    const locSetBtn = modal.querySelector('#sunsetLocSetBtn');
    const locInput = modal.querySelector('#sunsetLocInput');
    if (locSetBtn && locInput) {
        locSetBtn.addEventListener('click', () => {
            const query = locInput.value.trim();
            if (!query) {
                if (typeof Toast !== 'undefined') Toast.warning('Enter a city or postcode');
                return;
            }
            locSetBtn.disabled = true;
            locSetBtn.textContent = '…';

            fetch(`https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(query)}&appid=${OPENWEATHER_KEY}&units=metric`)
                .then(res => { if (!res.ok) throw new Error('Not found'); return res.json(); })
                .then(data => {
                    if (data?.coord) {
                        const cityName = data.name || query;
                        locInput.value = cityName;
                        _applyLocationToDevice(data.coord.lat, data.coord.lon, cityName);
                        if (typeof Toast !== 'undefined') Toast.success(`Location set to ${cityName}`);
                    } else {
                        throw new Error('Invalid');
                    }
                })
                .catch(() => {
                    if (typeof Toast !== 'undefined') Toast.error('Location not found. Try City, Country code.');
                })
                .finally(() => {
                    locSetBtn.disabled = false;
                    locSetBtn.textContent = 'Set';
                });
        });
    }

    // ── Use GPS ─────────────────────────────────────────────────
    const gpsBtn = modal.querySelector('#sunsetLocGpsBtn');
    if (gpsBtn) {
        gpsBtn.addEventListener('click', () => {
            if (!navigator.geolocation) {
                if (typeof Toast !== 'undefined') Toast.error('Geolocation not supported');
                return;
            }
            gpsBtn.disabled = true;
            gpsBtn.innerHTML = '<svg class="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg> Locating…';

            navigator.geolocation.getCurrentPosition(
                (pos) => {
                    const lat = pos.coords.latitude;
                    const lon = pos.coords.longitude;
                    fetch(`https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${OPENWEATHER_KEY}&units=metric`)
                        .then(r => r.json())
                        .then(data => {
                            const name = data?.name || 'GPS Location';
                            _applyLocationToDevice(lat, lon, name);
                            if (locInput) locInput.value = name;
                        })
                        .catch(() => {
                            _applyLocationToDevice(lat, lon, 'GPS Location');
                        })
                        .finally(() => {
                            gpsBtn.disabled = false;
                            gpsBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2v4"/><path d="M12 18v4"/><path d="M2 12h4"/><path d="M18 12h4"/></svg> Use GPS';
                        });
                },
                (err) => {
                    gpsBtn.disabled = false;
                    gpsBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2v4"/><path d="M12 18v4"/><path d="M2 12h4"/><path d="M18 12h4"/></svg> Use GPS';
                    if (err.code === 1) {
                        if (typeof Toast !== 'undefined') Toast.error('Location permission denied');
                    } else {
                        if (typeof Toast !== 'undefined') Toast.error('Could not get GPS position');
                    }
                },
                { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
            );
        });
    }

    // ── Reset to Home Default ───────────────────────────────────
    const resetBtn = modal.querySelector('#sunsetLocResetBtn');
    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            BlindState.config.lat = null;
            BlindState.config.lon = null;
            BlindState.config.city = null;
            _isCustom = false;
            _activeLat = localStorage.getItem('zaylo-LocationLat');
            _activeLon = localStorage.getItem('zaylo-LocationLon');
            _activeCity = localStorage.getItem('zaylo-LocationCity') || '';
            _updateLocationUI();
            if (_activeLat && _activeLon) {
                _fetchSunsetForCoords(_activeLat, _activeLon);
            } else {
                const baseEl = modal.querySelector('#sunsetBaseTime');
                const closeEl = modal.querySelector('#sunsetCloseTime');
                if (baseEl) baseEl.textContent = '--:--';
                if (closeEl) closeEl.textContent = '--:--';
                _sunsetUnix = 0;
            }
            if (locInput) locInput.value = '';
            if (typeof Haptic !== 'undefined') Haptic.medium();
            if (typeof Toast !== 'undefined') Toast.success('Using home location');
        });
    }

    // ── Initial sunset time fetch ───────────────────────────────
    if (_activeLat && _activeLon) {
        _fetchSunsetForCoords(_activeLat, _activeLon);
    } else {
        const loadingEl = modal.querySelector('#sunsetTimeLoading');
        if (loadingEl) {
            loadingEl.innerHTML = '<span style="font-size:11px; color:var(--text-tertiary);">Set a location to see sunset times</span>';
        }
    }
}

function showPresenceConfigModal() {
    const defaultTimeout = BlindState.config.motionTimeout !== undefined ? BlindState.config.motionTimeout : 5;
    const defaultTarget = BlindState.config.presenceTarget !== undefined ? BlindState.config.presenceTarget : 0;
    const defaultAction = BlindState.config.presenceAction || 'close_only';
    const defaultOpenTarget = BlindState.config.presenceOpenTarget !== undefined ? BlindState.config.presenceOpenTarget : 100;
    const defaultTimeFilter = BlindState.config.presenceTimeFilter || 'all';

    const { modal, close } = Modal.create({
        title: 'Presence Configuration',
        content: `
            <div class="setting-item" style="padding: 12px 0; border: none;">
                <div class="setting-left">
                    <span class="setting-label">Action</span>
                    <span class="setting-sublabel">What to do on presence</span>
                </div>
            </div>
            <select id="presenceActionSelect" class="modal-select" style="margin-bottom: 12px;">
                <option value="close_only" ${defaultAction === 'close_only' ? 'selected' : ''}>Close when empty</option>
                <option value="open_close" ${defaultAction === 'open_close' ? 'selected' : ''}>Open when entered & Close when empty</option>
            </select>

            <div id="presenceOpenTargetSection" style="display: ${defaultAction === 'open_close' ? 'block' : 'none'};">
                <div class="setting-item" style="padding: 0 0 12px 0; border: none; margin-top: 4px;">
                    <div class="setting-left">
                        <span class="setting-label">Open Target Position (%)</span>
                        <span class="setting-sublabel">When entering the room</span>
                    </div>
                </div>
                <input type="range" id="presenceOpenTargetInput" min="0" max="100" value="${defaultOpenTarget}" class="blind-slider" style="width: 100%; height: 8px; border-radius: 4px; -webkit-appearance: none; background: var(--bg-tertiary); outline: none;">
                <div class="modal-value-display" id="presenceOpenTargetDisplay" style="margin-top: 8px; margin-bottom: 12px;">${defaultOpenTarget}%</div>
            </div>

            <div class="setting-item" style="padding: 12px 0; border: none;">
                <div class="setting-left">
                    <span class="setting-label">Time of Day</span>
                    <span class="setting-sublabel">When should this run?</span>
                </div>
            </div>
            <select id="presenceTimeFilterSelect" class="modal-select" style="margin-bottom: 12px;">
                <option value="all" ${defaultTimeFilter === 'all' ? 'selected' : ''}>All Day</option>
                <option value="day" ${defaultTimeFilter === 'day' ? 'selected' : ''}>Daytime Only (Sunrise to Sunset)</option>
                <option value="night" ${defaultTimeFilter === 'night' ? 'selected' : ''}>Nighttime Only (Sunset to Sunrise)</option>
            </select>

            <div class="setting-item" style="padding: 12px 0; border: none;">
                <div class="setting-left">
                    <span class="setting-label">Motion Timeout (Minutes)</span>
                    <span class="setting-sublabel">Wait time before closing</span>
                </div>
            </div>
            <input type="number" id="motionTimeoutInput" value="${defaultTimeout}" min="1" class="modal-input" placeholder="Minutes">
            
            <div class="setting-item" style="padding: 16px 0 12px 0; border: none; margin-top: 8px;">
                <div class="setting-left">
                    <span class="setting-label">Close Target Position (%)</span>
                    <span class="setting-sublabel">When leaving the room</span>
                </div>
            </div>
            <input type="range" id="presenceTargetInput" min="0" max="100" value="${defaultTarget}" class="blind-slider" style="width: 100%; height: 8px; border-radius: 4px; -webkit-appearance: none; background: var(--bg-tertiary); outline: none;">
            <div class="modal-value-display" id="presenceTargetDisplay">${defaultTarget}%</div>
        `,
        actions: [
            { label: 'Cancel', primary: false },
            {
                label: 'Save', primary: true, onClick: () => {
                    let motionT = parseInt(modal.querySelector('#motionTimeoutInput').value, 10);
                    BlindState.config.motionTimeout = isNaN(motionT) ? 5 : Math.max(1, motionT);
                    
                    let targetT = parseInt(modal.querySelector('#presenceTargetInput').value, 10);
                    BlindState.config.presenceTarget = isNaN(targetT) ? 0 : targetT;
                    
                    BlindState.config.presenceAction = modal.querySelector('#presenceActionSelect').value;
                    
                    let openTargetT = parseInt(modal.querySelector('#presenceOpenTargetInput').value, 10);
                    BlindState.config.presenceOpenTarget = isNaN(openTargetT) ? 100 : openTargetT;
                    
                    BlindState.config.presenceTimeFilter = modal.querySelector('#presenceTimeFilterSelect').value;

                    // Update UI immediately (moved to updateConfigUI to keep it centralized)
                    updateConfigUI();

                    _publishRulesConfig();
                    if (typeof Toast !== 'undefined') Toast.success('Presence rules updated');
                    return true;
                }
            }
        ]
    });

    const targetInput = modal.querySelector('#presenceTargetInput');
    const targetDisplay = modal.querySelector('#presenceTargetDisplay');
    targetInput.addEventListener('input', (e) => {
        targetDisplay.textContent = e.target.value + '%';
        if (typeof Haptic !== 'undefined') Haptic.light();
    });

    const openTargetInput = modal.querySelector('#presenceOpenTargetInput');
    const openTargetDisplay = modal.querySelector('#presenceOpenTargetDisplay');
    openTargetInput.addEventListener('input', (e) => {
        openTargetDisplay.textContent = e.target.value + '%';
        if (typeof Haptic !== 'undefined') Haptic.light();
    });

    const actionSelect = modal.querySelector('#presenceActionSelect');
    const openSection = modal.querySelector('#presenceOpenTargetSection');
    actionSelect.addEventListener('change', (e) => {
        openSection.style.display = e.target.value === 'open_close' ? 'block' : 'none';
    });
}

/**
 * Calculates the next morning wake-up time and returns a human-readable message.
 * Returns null if no days are enabled.
 */
function _getNextMorningWakeupMessage() {
    const days = BlindState.config.morningDays;
    const fallbackTime = BlindState.config.morningTime || '07:00';
    const now = new Date();
    
    // Safety check: is the rule even enabled?
    if (BlindState.rules && BlindState.rules.morningOpen === false) {
        return null; // Not enabled, no upcoming wake-up
    }

    let minDiffMs = null;
    let foundUpcoming = false;

    // Check all 7 days of the week to find the closest upcoming alarm
    for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek++) {
        let dayTime = fallbackTime;
        let dayEnabled = false;

        const hasPerDay = days && Array.isArray(days) && days.length === 7;
        if (hasPerDay) {
            const ds = days[dayOfWeek];
            if (ds && typeof ds === 'object') {
                dayEnabled = ds.enabled !== false;
                dayTime = ds.time || fallbackTime;
            } else if (typeof ds === 'boolean') {
                dayEnabled = ds;
            }
        } else {
            // No per-day schedule (null/uniform default): Morning Open runs every
            // day at the single morningTime. Previously this left dayEnabled false
            // for all 7 days and returned null, so a freshly set-up blind with the
            // rule ON showed "no upcoming wake-up".
            dayEnabled = true;
        }

        if (!dayEnabled) continue;

        const [hst, mst] = dayTime.split(':');
        const targetHours = parseInt(hst, 10);
        const targetMinutes = parseInt(mst, 10);
        
        if (isNaN(targetHours) || isNaN(targetMinutes)) continue;

        // Construct a Date object for this day of the week
        let targetDate = new Date(now);
        // Calculate days to add to get to the target dayOfWeek
        // offset is how many days from today (0-6)
        let offset = (dayOfWeek - now.getDay() + 7) % 7;
        
        targetDate.setDate(now.getDate() + offset);
        targetDate.setHours(targetHours, targetMinutes, 0, 0);

        // Calculate the physical start time of the gradual movement series.
        // Guard against `days` being null (the default/uniform schedule): only
        // index it when a per-day array was confirmed (hasPerDay), otherwise this
        // threw "Cannot read properties of null" because `typeof null[i]` still
        // evaluates the member access before typeof applies.
        const dayObj = hasPerDay ? days[dayOfWeek] : null;
        const durationMins = (dayObj && typeof dayObj === 'object' && dayObj.duration) ? dayObj.duration : 30;
        targetDate.setMinutes(targetDate.getMinutes() - durationMins);

        // If offset is 0 (today) and the physical start time has already passed, 
        // the next occurrence for this specific day of the week is next week (+7 days)
        if (offset === 0 && targetDate.getTime() <= now.getTime()) {
            targetDate.setDate(targetDate.getDate() + 7);
        }

        const diffMs = targetDate.getTime() - now.getTime();
        
        if (minDiffMs === null || diffMs < minDiffMs) {
            minDiffMs = diffMs;
            foundUpcoming = true;
        }
    }

    if (!foundUpcoming) return null;

    const diffMinutesTotal = Math.floor(minDiffMs / 60000);
    const hours = Math.floor(diffMinutesTotal / 60);
    const mins = diffMinutesTotal % 60;

    let timeStr = '';
    // Format elegantly based on duration
    if (hours >= 24) {
        const days = Math.floor(hours / 24);
        const remHours = hours % 24;
        timeStr += `${days} day${days > 1 ? 's' : ''}`;
        if (remHours > 0) timeStr += ` ${remHours} hr${remHours > 1 ? 's' : ''}`;
    } else {
        if (hours > 0) timeStr += `${hours} hr${hours > 1 ? 's' : ''} `;
        if (mins > 0) timeStr += `${mins} min${mins > 1 ? 's' : ''}`;
        if (hours === 0 && mins === 0) timeStr = 'less than a minute';
    }

    return `Next wake-up in ${timeStr.trim()}`;
}

function showMorningConfigModal() {
    const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const fallbackTime = BlindState.config.morningTime || '07:00';
    const fallbackDuration = BlindState.config.morningDuration || 30;
    const fallbackTarget = BlindState.config.morningTarget !== undefined ? BlindState.config.morningTarget : 100;

    // Build working copy of per-day schedule
    // morningDays is an array of 7 objects: { enabled, time, duration, target }
    const existingDays = BlindState.config.morningDays;
    const daySchedule = [];
    for (let i = 0; i < 7; i++) {
        if (existingDays && existingDays[i]) {
            daySchedule.push({
                enabled: existingDays[i].enabled !== false,
                time: existingDays[i].time || fallbackTime,
                duration: existingDays[i].duration || fallbackDuration,
                target: existingDays[i].target !== undefined ? existingDays[i].target : fallbackTarget
            });
        } else {
            daySchedule.push({
                enabled: true,
                time: fallbackTime,
                duration: fallbackDuration,
                target: fallbackTarget
            });
        }
    }

    let selectedDay = new Date().getDay(); // Start on today

    const { modal, close } = Modal.create({
        title: 'Morning Wake-Up',
        content: `
            <div class="day-pills" id="morningDayPills">
                ${DAY_LABELS.map((lbl, i) => {
                    const sel = i === selectedDay ? ' selected' : '';
                    const dis = !daySchedule[i].enabled ? ' disabled' : '';
                    return `<button class="day-pill${sel}${dis}" data-day="${i}">${lbl}</button>`;
                }).join('')}
            </div>

            <div class="setting-item" style="padding: 4px 0 12px 0; border: none;">
                <div class="setting-left">
                    <span class="setting-label">Enabled</span>
                    <span class="setting-sublabel" id="morningEnabledDesc">Wake-up active on this day</span>
                </div>
                <label class="toggle">
                    <input type="checkbox" id="morningDayEnabled" ${daySchedule[selectedDay].enabled ? 'checked' : ''}>
                    <div class="toggle-track"><div class="toggle-thumb"></div></div>
                </label>
            </div>

            <div id="morningDayFields">
                <div class="setting-item" style="padding: 12px 0; border: none;">
                    <div class="setting-left">
                        <span class="setting-label">Wake-up Time</span>
                        <span class="setting-sublabel">When should the routine finish?</span>
                    </div>
                </div>
                <input type="time" id="morningTimeInput" value="${daySchedule[selectedDay].time}" class="modal-input">
                
                <div class="setting-item" style="padding: 16px 0 12px 0; border: none; margin-top: 12px;">
                    <div class="setting-left">
                        <span class="setting-label">Gradual Duration (Minutes)</span>
                        <span class="setting-sublabel">How long to slowly open</span>
                    </div>
                </div>
                <input type="number" id="morningDurationInput" value="${daySchedule[selectedDay].duration}" min="1" max="120" class="modal-input" placeholder="Minutes">

                <div class="setting-item" style="padding: 16px 0 12px 0; border: none; margin-top: 12px;">
                    <div class="setting-left">
                        <span class="setting-label">Target Open Position (%)</span>
                    </div>
                </div>
                <input type="range" id="morningTargetInput" min="0" max="100" value="${daySchedule[selectedDay].target}" class="blind-slider" style="width: 100%; height: 8px; border-radius: 4px; -webkit-appearance: none; background: var(--bg-tertiary); outline: none;">
                <div class="modal-value-display" id="morningTargetDisplay">${daySchedule[selectedDay].target}%</div>
            </div>

            <button id="morningApplyAllBtn" class="modal-apply-all-btn">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                Apply to All Days
            </button>
        `,
        actions: [
            { label: 'Cancel', primary: false },
            {
                label: 'Save', primary: true, onClick: () => {
                    // Flush current day's inputs before saving
                    _flushCurrentDayInputs();

                    // Save the per-day schedule
                    BlindState.config.morningDays = daySchedule.map(d => ({ ...d }));

                    // Also update legacy fields to the first enabled day for backward compat
                    const firstEnabled = daySchedule.find(d => d.enabled);
                    if (firstEnabled) {
                        BlindState.config.morningTime = firstEnabled.time;
                        BlindState.config.morningDuration = firstEnabled.duration;
                        BlindState.config.morningTarget = firstEnabled.target;
                    }

                    updateConfigUI();
                    _publishRulesConfig();
                    
                    // --- Show time until next wake-up ---
                    if (typeof Toast !== 'undefined') {
                        const msg = _getNextMorningWakeupMessage();
                        setTimeout(() => {
                            if (typeof Toast !== 'undefined') {
                                Toast.success(msg || 'Morning schedule saved');
                            }
                        }, 500); // Wait for MQTT to settle
                    }
                    return true;
                }
            }
        ]
    });

    // --- Helper: flush current input values into the working daySchedule ---
    function _flushCurrentDayInputs() {
        const timeEl = modal.querySelector('#morningTimeInput');
        const durEl = modal.querySelector('#morningDurationInput');
        const tgtEl = modal.querySelector('#morningTargetInput');
        const enEl = modal.querySelector('#morningDayEnabled');
        if (!timeEl || !durEl || !tgtEl || !enEl) return;
        
        daySchedule[selectedDay].time = timeEl.value || '07:00';
        const dv = parseInt(durEl.value, 10);
        daySchedule[selectedDay].duration = isNaN(dv) ? 30 : Math.max(1, dv);
        const tv = parseInt(tgtEl.value, 10);
        daySchedule[selectedDay].target = isNaN(tv) ? 100 : tv;
        daySchedule[selectedDay].enabled = enEl.checked;
    }

    // --- Helper: populate modal inputs from daySchedule for a given day index ---
    function _loadDayInputs(dayIdx) {
        const ds = daySchedule[dayIdx];
        modal.querySelector('#morningTimeInput').value = ds.time;
        modal.querySelector('#morningDurationInput').value = ds.duration;
        modal.querySelector('#morningTargetInput').value = ds.target;
        modal.querySelector('#morningTargetDisplay').textContent = ds.target + '%';
        modal.querySelector('#morningDayEnabled').checked = ds.enabled;
        modal.querySelector('#morningDayFields').style.opacity = ds.enabled ? '1' : '0.4';
        modal.querySelector('#morningDayFields').style.pointerEvents = ds.enabled ? '' : 'none';
    }

    // --- Day pill click handler ---
    modal.querySelectorAll('.day-pill').forEach(pill => {
        pill.addEventListener('click', () => {
            // Save the current day's inputs first
            _flushCurrentDayInputs();

            // Switch to the clicked day
            selectedDay = parseInt(pill.dataset.day, 10);

            // Update pill visual states
            modal.querySelectorAll('.day-pill').forEach((p, i) => {
                p.classList.toggle('selected', i === selectedDay);
                p.classList.toggle('disabled', !daySchedule[i].enabled);
            });

            // Load the new day's values into the form
            _loadDayInputs(selectedDay);

            if (typeof Haptic !== 'undefined') Haptic.selection();
        });
    });

    // --- Enabled toggle handler ---
    const enabledToggle = modal.querySelector('#morningDayEnabled');
    enabledToggle.addEventListener('change', () => {
        daySchedule[selectedDay].enabled = enabledToggle.checked;
        modal.querySelector('#morningDayFields').style.opacity = enabledToggle.checked ? '1' : '0.4';
        modal.querySelector('#morningDayFields').style.pointerEvents = enabledToggle.checked ? '' : 'none';

        // Update the pill visual
        const pill = modal.querySelector(`.day-pill[data-day="${selectedDay}"]`);
        if (pill) pill.classList.toggle('disabled', !enabledToggle.checked);

        if (typeof Haptic !== 'undefined') Haptic.selection();
    });

    // --- Target slider live update ---
    const targetInput = modal.querySelector('#morningTargetInput');
    const targetDisplay = modal.querySelector('#morningTargetDisplay');
    targetInput.addEventListener('input', (e) => {
        targetDisplay.textContent = e.target.value + '%';
        if (typeof Haptic !== 'undefined') Haptic.light();
    });

    // --- Apply to All Days ---
    modal.querySelector('#morningApplyAllBtn').addEventListener('click', () => {
        _flushCurrentDayInputs();
        const src = daySchedule[selectedDay];
        for (let i = 0; i < 7; i++) {
            daySchedule[i].time = src.time;
            daySchedule[i].duration = src.duration;
            daySchedule[i].target = src.target;
            daySchedule[i].enabled = src.enabled;
        }
        // Refresh pill disabled states
        modal.querySelectorAll('.day-pill').forEach((p, i) => {
            p.classList.toggle('disabled', !daySchedule[i].enabled);
        });
        if (typeof Haptic !== 'undefined') Haptic.notification('success');
        if (typeof Toast !== 'undefined') Toast.success('Applied to all days');
    });
}

function showNightLockConfigModal() {
    // Per-day Night Lock editor — mirrors the Morning Wake-Up modal so each day
    // can have its own lock time + target. Previously this modal reduced the
    // schedule to 7 booleans and saved a single time/target for every day, which
    // silently discarded the richer per-day schedule the firmware (V14+) supports
    // and the app receives. Now it edits/saves the full { enabled, time, target }
    // objects, so opening and saving never flattens per-day times/targets.
    const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const fallbackTime = BlindState.config.nightTime || '22:00';
    const fallbackTarget = BlindState.config.nightTarget !== undefined ? BlindState.config.nightTarget : 0;

    // Build a working copy of the per-day schedule from whatever shape is stored
    // (object[], legacy boolean[], or null/default).
    const existingDays = BlindState.config.nightDays;
    const daySchedule = [];
    for (let i = 0; i < 7; i++) {
        const ds = existingDays && existingDays[i] !== undefined ? existingDays[i] : undefined;
        if (ds && typeof ds === 'object') {
            daySchedule.push({
                enabled: ds.enabled !== false,
                time: ds.time || fallbackTime,
                target: ds.target !== undefined ? ds.target : fallbackTarget
            });
        } else if (typeof ds === 'boolean') {
            daySchedule.push({ enabled: ds, time: fallbackTime, target: fallbackTarget });
        } else {
            daySchedule.push({ enabled: true, time: fallbackTime, target: fallbackTarget });
        }
    }

    let selectedDay = new Date().getDay(); // Start on today

    const { modal, close } = Modal.create({
        title: 'Night Lock',
        content: `
            <div class="day-pills" id="nightDayPills">
                ${DAY_LABELS.map((lbl, i) => {
                    const sel = i === selectedDay ? ' selected' : '';
                    const dis = !daySchedule[i].enabled ? ' disabled' : '';
                    return `<button class="day-pill night${sel}${dis}" data-day="${i}">${lbl}</button>`;
                }).join('')}
            </div>

            <div class="setting-item" style="padding: 4px 0 12px 0; border: none;">
                <div class="setting-left">
                    <span class="setting-label">Enabled</span>
                    <span class="setting-sublabel">Lock the blinds on this day</span>
                </div>
                <label class="toggle">
                    <input type="checkbox" id="nightDayEnabled" ${daySchedule[selectedDay].enabled ? 'checked' : ''}>
                    <div class="toggle-track"><div class="toggle-thumb"></div></div>
                </label>
            </div>

            <div id="nightDayFields">
                <div class="setting-item" style="padding: 12px 0; border: none;">
                    <div class="setting-left">
                        <span class="setting-label">Lock Time</span>
                        <span class="setting-sublabel">When should the blinds close?</span>
                    </div>
                </div>
                <input type="time" id="nightTimeInput" value="${daySchedule[selectedDay].time}" class="modal-input">

                <div class="setting-item" style="padding: 16px 0 12px 0; border: none; margin-top: 12px;">
                    <div class="setting-left">
                        <span class="setting-label">Target Position (%)</span>
                        <span class="setting-sublabel">0 is fully closed</span>
                    </div>
                </div>
                <input type="range" id="nightTargetInput" min="0" max="100" value="${daySchedule[selectedDay].target}" class="blind-slider" style="width: 100%; height: 8px; border-radius: 4px; -webkit-appearance: none; background: var(--bg-tertiary); outline: none;">
                <div class="modal-value-display" id="nightTargetDisplay">${daySchedule[selectedDay].target}%</div>
            </div>

            <button id="nightApplyAllBtn" class="modal-apply-all-btn">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                Apply to All Days
            </button>
        `,
        actions: [
            { label: 'Cancel', primary: false },
            {
                label: 'Save', primary: true, onClick: () => {
                    _flushCurrentDayInputs();

                    // Save the full per-day schedule (objects, not booleans).
                    BlindState.config.nightDays = daySchedule.map(d => ({ ...d }));

                    // Keep the legacy single fields in sync with the first enabled
                    // day for backward compatibility / "Apply to All" semantics.
                    const firstEnabled = daySchedule.find(d => d.enabled);
                    if (firstEnabled) {
                        BlindState.config.nightTime = firstEnabled.time;
                        BlindState.config.nightTarget = firstEnabled.target;
                    }

                    updateConfigUI();
                    _publishRulesConfig();
                    if (typeof Toast !== 'undefined') Toast.success('Night lock configuration updated');
                    return true;
                }
            }
        ]
    });

    // --- Helper: flush current input values into the working daySchedule ---
    function _flushCurrentDayInputs() {
        const timeEl = modal.querySelector('#nightTimeInput');
        const tgtEl = modal.querySelector('#nightTargetInput');
        const enEl = modal.querySelector('#nightDayEnabled');
        if (!timeEl || !tgtEl || !enEl) return;

        daySchedule[selectedDay].time = timeEl.value || '22:00';
        const tv = parseInt(tgtEl.value, 10);
        daySchedule[selectedDay].target = isNaN(tv) ? 0 : tv;
        daySchedule[selectedDay].enabled = enEl.checked;
    }

    // --- Helper: populate modal inputs from daySchedule for a given day index ---
    function _loadDayInputs(dayIdx) {
        const ds = daySchedule[dayIdx];
        modal.querySelector('#nightTimeInput').value = ds.time;
        modal.querySelector('#nightTargetInput').value = ds.target;
        modal.querySelector('#nightTargetDisplay').textContent = ds.target + '%';
        modal.querySelector('#nightDayEnabled').checked = ds.enabled;
        modal.querySelector('#nightDayFields').style.opacity = ds.enabled ? '1' : '0.4';
        modal.querySelector('#nightDayFields').style.pointerEvents = ds.enabled ? '' : 'none';
    }

    // --- Day pill click handler: switch the edited day (NOT a toggle) ---
    modal.querySelectorAll('.day-pill').forEach(pill => {
        pill.addEventListener('click', () => {
            _flushCurrentDayInputs();
            selectedDay = parseInt(pill.dataset.day, 10);
            modal.querySelectorAll('.day-pill').forEach((p, i) => {
                p.classList.toggle('selected', i === selectedDay);
                p.classList.toggle('disabled', !daySchedule[i].enabled);
            });
            _loadDayInputs(selectedDay);
            if (typeof Haptic !== 'undefined') Haptic.selection();
        });
    });

    // --- Enabled toggle handler ---
    const enabledToggle = modal.querySelector('#nightDayEnabled');
    enabledToggle.addEventListener('change', () => {
        daySchedule[selectedDay].enabled = enabledToggle.checked;
        modal.querySelector('#nightDayFields').style.opacity = enabledToggle.checked ? '1' : '0.4';
        modal.querySelector('#nightDayFields').style.pointerEvents = enabledToggle.checked ? '' : 'none';
        const pill = modal.querySelector(`.day-pill[data-day="${selectedDay}"]`);
        if (pill) pill.classList.toggle('disabled', !enabledToggle.checked);
        if (typeof Haptic !== 'undefined') Haptic.selection();
    });

    // --- Target slider live update ---
    const targetInput = modal.querySelector('#nightTargetInput');
    const targetDisplay = modal.querySelector('#nightTargetDisplay');
    targetInput.addEventListener('input', (e) => {
        targetDisplay.textContent = e.target.value + '%';
        if (typeof Haptic !== 'undefined') Haptic.light();
    });

    // --- Apply to All Days ---
    modal.querySelector('#nightApplyAllBtn').addEventListener('click', () => {
        _flushCurrentDayInputs();
        const src = daySchedule[selectedDay];
        for (let i = 0; i < 7; i++) {
            daySchedule[i].time = src.time;
            daySchedule[i].target = src.target;
            daySchedule[i].enabled = src.enabled;
        }
        modal.querySelectorAll('.day-pill').forEach((p, i) => {
            p.classList.toggle('disabled', !daySchedule[i].enabled);
        });
        if (typeof Haptic !== 'undefined') Haptic.notification('success');
        if (typeof Toast !== 'undefined') Toast.success('Applied to all days');
    });
}

function showTempConfigModal() {
    // Unit-aware presentation: storage/firmware stay °C, ONLY the inputs and
    // labels convert (see BlindSchema temp helpers). US customers previously
    // saw a bare "30°C" with no way to think in Fahrenheit.
    const _unit = (typeof BlindSchema !== 'undefined' && BlindSchema.tempUnitSuffix) ? BlindSchema.tempUnitSuffix() : '°C';
    const _toDisp = (c) => (typeof BlindSchema !== 'undefined' && BlindSchema.cToDisplay) ? BlindSchema.cToDisplay(c) : Math.round(c);
    const _toC = (v) => (typeof BlindSchema !== 'undefined' && BlindSchema.displayToC) ? BlindSchema.displayToC(v) : Math.round(v);

    const defaultTemp = BlindState.config.tempThreshold || 30;
    const defaultTarget = BlindState.config.tempTarget !== undefined ? BlindState.config.tempTarget : 20;
    // Auto-reopen (hysteresis) defaults. Reopen threshold defaults to 5°C below
    // the close threshold so there's a sensible deadband out of the box.
    const reopenEnabled = BlindState.config.tempReopenEnabled === true;
    const reopenThreshold = BlindState.config.tempReopenThreshold !== undefined
        ? BlindState.config.tempReopenThreshold : Math.max(0, defaultTemp - 5);
    const reopenTarget = BlindState.config.tempReopenTarget !== undefined ? BlindState.config.tempReopenTarget : 100;

    const { modal, close } = Modal.create({
        title: 'Heat Protection',
        content: `
            <div class="setting-item" style="padding: 12px 0; border: none;">
                <div class="setting-left">
                    <span class="setting-label">Outdoor Temperature Threshold (${_unit})</span>
                    <span class="setting-sublabel">Close the blinds when it's hotter than this outside</span>
                </div>
            </div>
            <input type="number" id="tempThresholdInput" value="${_toDisp(defaultTemp)}" class="modal-input" placeholder="Threshold ${_unit}">

            <div style="margin-top:10px; padding:10px; border-radius:10px; background:rgba(99,102,241,0.08); border:1px solid rgba(99,102,241,0.15);">
                <p style="color:var(--accent); font-size:11px; line-height:1.4; margin:0; display:flex; align-items:flex-start; gap:6px;">
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0; margin-top:1px;"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
                    <span>Uses the live <strong>outdoor temperature</strong> from the OpenWeatherMap feed for your location — not an on-device sensor.</span>
                </p>
            </div>

            <div class="setting-item" style="padding: 16px 0 12px 0; border: none; margin-top: 12px;">
                <div class="setting-left">
                    <span class="setting-label">Target Protection Position (%)</span>
                    <span class="setting-sublabel">Typically 20-30%</span>
                </div>
            </div>
            <input type="range" id="tempTargetInput" min="0" max="100" value="${defaultTarget}" class="blind-slider" style="width: 100%; height: 8px; border-radius: 4px; -webkit-appearance: none; background: var(--bg-tertiary); outline: none;">
            <div class="modal-value-display" id="tempTargetDisplay">${defaultTarget}%</div>

            <div class="setting-item" style="padding: 18px 0 4px 0; border: none; margin-top: 14px; border-top: 1px solid var(--border-glass);">
                <div class="setting-left">
                    <span class="setting-label">Auto-reopen when it cools</span>
                    <span class="setting-sublabel">Reopen automatically once the outdoor temperature drops</span>
                </div>
                <label class="toggle">
                    <input type="checkbox" id="tempReopenEnabledInput" ${reopenEnabled ? 'checked' : ''}>
                    <div class="toggle-track"><div class="toggle-thumb"></div></div>
                </label>
            </div>
            <div id="tempReopenFields" style="display:${reopenEnabled ? 'block' : 'none'};">
                <div class="setting-item" style="padding: 12px 0; border: none;">
                    <div class="setting-left">
                        <span class="setting-label">Reopen Below (${_unit})</span>
                        <span class="setting-sublabel">Kept below the close threshold to avoid chatter</span>
                    </div>
                </div>
                <input type="number" id="tempReopenThresholdInput" value="${_toDisp(reopenThreshold)}" class="modal-input" placeholder="Reopen ${_unit}">

                <div class="setting-item" style="padding: 16px 0 12px 0; border: none; margin-top: 12px;">
                    <div class="setting-left">
                        <span class="setting-label">Reopen To Position (%)</span>
                        <span class="setting-sublabel">Where to move when it cools</span>
                    </div>
                </div>
                <input type="range" id="tempReopenTargetInput" min="0" max="100" value="${reopenTarget}" class="blind-slider" style="width: 100%; height: 8px; border-radius: 4px; -webkit-appearance: none; background: var(--bg-tertiary); outline: none;">
                <div class="modal-value-display" id="tempReopenTargetDisplay">${reopenTarget}%</div>
            </div>
        `,
        actions: [
            { label: 'Cancel', primary: false },
            {
                label: 'Save', primary: true, onClick: () => {
                    // Inputs are in the DISPLAY unit; convert to canonical °C
                    // before storing/pushing (firmware thresholds are °C ints).
                    let threshVal = parseInt(modal.querySelector('#tempThresholdInput').value, 10);
                    BlindState.config.tempThreshold = isNaN(threshVal) ? 30 : _toC(threshVal);
                    const tempTargetVal = parseInt(modal.querySelector('#tempTargetInput').value, 10);
                    BlindState.config.tempTarget = isNaN(tempTargetVal) ? 20 : tempTargetVal;

                    // Auto-reopen (hysteresis)
                    BlindState.config.tempReopenEnabled = modal.querySelector('#tempReopenEnabledInput').checked;
                    let reopenThreshVal = parseInt(modal.querySelector('#tempReopenThresholdInput').value, 10);
                    reopenThreshVal = isNaN(reopenThreshVal)
                        ? Math.max(0, BlindState.config.tempThreshold - 5)
                        : _toC(reopenThreshVal);
                    // Enforce the deadband IN °C: the reopen threshold must stay
                    // strictly below the close threshold (mirrors the firmware clamp).
                    if (reopenThreshVal >= BlindState.config.tempThreshold) {
                        reopenThreshVal = BlindState.config.tempThreshold - 1;
                    }
                    BlindState.config.tempReopenThreshold = Math.max(0, reopenThreshVal);
                    const reopenTargetVal = parseInt(modal.querySelector('#tempReopenTargetInput').value, 10);
                    BlindState.config.tempReopenTarget = isNaN(reopenTargetVal) ? 100 : reopenTargetVal;

                    updateConfigUI();

                    _publishRulesConfig();
                    if (typeof Toast !== 'undefined') Toast.success('Heat protection updated');
                    return true;
                }
            }
        ]
    });

    const targetInput = modal.querySelector('#tempTargetInput');
    const targetDisplay = modal.querySelector('#tempTargetDisplay');
    targetInput.addEventListener('input', (e) => {
        targetDisplay.textContent = e.target.value + '%';
        if (typeof Haptic !== 'undefined') Haptic.light();
    });

    const reopenToggle = modal.querySelector('#tempReopenEnabledInput');
    const reopenFields = modal.querySelector('#tempReopenFields');
    reopenToggle.addEventListener('change', () => {
        reopenFields.style.display = reopenToggle.checked ? 'block' : 'none';
        if (typeof Haptic !== 'undefined') Haptic.selection();
    });

    const reopenTargetInput = modal.querySelector('#tempReopenTargetInput');
    const reopenTargetDisplay = modal.querySelector('#tempReopenTargetDisplay');
    reopenTargetInput.addEventListener('input', (e) => {
        reopenTargetDisplay.textContent = e.target.value + '%';
        if (typeof Haptic !== 'undefined') Haptic.light();
    });
}

// ============================================
// Stepper Limits Calibration Wizard
// ============================================
function openLimitsCalibrationWizard() {
    try {
        console.log('[Wizard] openLimitsCalibrationWizard invoked.');
        if (typeof Haptic !== 'undefined' && typeof Haptic.impact === 'function') {
            Haptic.impact('medium');
        }
        
        const wizard = document.getElementById('calibrationWizard');
        if (!wizard) {
            console.error('[Wizard] Element #calibrationWizard not found in DOM.');
            if (typeof Toast !== 'undefined') Toast.error('Calibration wizard element not found.');
            return;
        }

        const calibrationSessionId = `cal-${BlindState.deviceId || 'unknown'}-${Date.now().toString(36)}`;
        let selfTestRunning = false;

        const isCalibrationLinkLive = () => (
            typeof MQTTClient !== 'undefined' &&
            MQTTClient.connected === true &&
            BlindState.deviceId &&
            BlindState.isOnline === true
        );

        const clearCalibrationQueues = () => {
            if (typeof BlindCommandQueue !== 'undefined' && typeof BlindCommandQueue.clearBySource === 'function') {
                BlindCommandQueue.clearBySource('calibration-self-test', BlindState.deviceId);
            }
            if (typeof MQTTClient !== 'undefined' && MQTTClient.pendingMessages && BlindState.deviceId) {
                const id = BlindState.deviceId.toUpperCase();
                MQTTClient.pendingMessages.delete(`lumibot/${id}/stepper/set_position`);
                MQTTClient.pendingMessages.delete(`lumibot/${id}/config/set`);
            }
        };

        const publishCalibrationConfig = (payload) => {
            if (!isCalibrationLinkLive()) return false;
            return MQTTClient.publishConfig(BlindState.deviceId, {
                ...payload,
                calibrationSession: calibrationSessionId
            }, { queue: false, localFallback: false });
        };

        const publishCalibrationStepper = (payload, allowLocalFallback = true) => {
            if (!BlindState.deviceId || typeof MQTTClient === 'undefined') return false;
            if (!MQTTClient.connected && !allowLocalFallback) return false;
            return MQTTClient.publishStepperControl(BlindState.deviceId, {
                ...payload,
                calibrationSession: calibrationSessionId
            }, { queue: false, localFallback: allowLocalFallback });
        };

        clearCalibrationQueues();

        if (!isCalibrationLinkLive()) {
            if (typeof Toast !== 'undefined') Toast.error('Calibration needs a live connection to the blind');
            return;
        }

        if (!publishCalibrationConfig({ cmd: 'calibration_start' })) {
            if (typeof Toast !== 'undefined') Toast.error('Calibration could not start. Check the blind connection and try again.');
            return;
        }

        // Reset step state variables
        let currentStep = 1;
        let virtualPosition = 100;
        let isJogging = false;
        let jogInterval = null;
        let jogKeepalive = null; // deadman refresh while a jog button is held

        // Query static elements from DOM
        const wizProgress = wizard.querySelector('#wizProgress');
        const stepNodes = wizard.querySelectorAll('.wiz-step-node');
        const stepTitle = wizard.querySelector('#wizStepTitle');
        const stepDesc = wizard.querySelector('#wizStepDesc');
        const actionBtn = wizard.querySelector('#wizActionBtn');
        const logDot = wizard.querySelector('#wizLogDot');
        const logText = wizard.querySelector('#wizLogText');
        const jogControls = wizard.querySelector('#wizJogControls');
        const testProgress = wizard.querySelector('#wizTestProgress');
        const testProgressFill = wizard.querySelector('#wizTestProgressFill');

        // Reset UI nodes to step 1 state
        stepNodes.forEach((node, idx) => {
            node.className = idx === 0 ? 'wiz-step-node active' : 'wiz-step-node';
        });
        if (wizProgress) wizProgress.style.width = '0%';
        if (jogControls) jogControls.style.display = 'flex';
        if (testProgress) testProgress.style.display = 'none';
        
        if (actionBtn) {
            actionBtn.style.display = 'flex';
            actionBtn.className = 'wiz-action-btn primary';
            actionBtn.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-arrow-up-to-line"><path d="M5 3h14"/><path d="m18 13-6-6-6 6"/><path d="M12 7v14"/></svg>
                Save Open Limit
            `;
        }
        if (stepTitle) {
            stepTitle.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-info" style="color: var(--blind-accent-light);"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
                <span>Step 1: Set Open Boundary</span>
            `;
        }
        if (stepDesc) {
            stepDesc.innerHTML = `
                Jog the blind upwards until it is in the fully <strong>OPEN</strong> position. Adjust precisely, then tap <strong>Save Open Limit</strong>.
            `;
        }

        // Show wizard modal overlay
        wizard.style.display = 'flex';
        // Force reflow
        wizard.offsetHeight;
        wizard.classList.add('active');

        // Generate visual slats (disabled dynamically if visual preview container is removed)
        const spSlats = wizard.querySelector('#wizardBlindsSlats');
        const updatePreview = (pos) => {
            if (spSlats) {
                _applyVisualization(pos, spSlats);
            }
        };

        if (spSlats) {
            setContainerClass(spSlats);
            switch (BlindState.blindType) {
                case 'roller': generateRoller(spSlats); break;
                case 'vertical': generateVertical(spSlats); break;
                case 'zebra': generateZebra(spSlats); break;
                default: generateRoller(spSlats);
            }
            // Start visualization at fully open (100%) for Step 1
            updatePreview(100);
        }

        // Log Helper
        const logMsg = (msg, type = 'normal') => {
            if (logText) logText.textContent = msg;
            if (logDot) {
                logDot.className = 'wiz-terminal-dot';
                if (type === 'active') logDot.classList.add('active');
                else if (type === 'error') logDot.classList.add('error');
            }
        };

        logMsg('Ready. Select Jog Up/Down to adjust open limit.', 'active');

        const readLimitsFromState = (snapshot = {}) => {
            const cfg = snapshot.config || {};
            const top = Number(cfg.stepperTop);
            const bottom = Number(cfg.stepperBottom);
            return {
                top: Number.isFinite(top) ? top : null,
                bottom: Number.isFinite(bottom) ? bottom : null,
                isCalibrated: snapshot.isCalibrated === true
            };
        };

        // Snapshot the pre-wizard limits so an abandoned HALF-calibration can
        // restore them. Closing after "Save Open Limit" but before "Save Closed
        // Limit" used to leave the device mixing a NEW top with the OLD bottom —
        // two different reference frames, so subsequent percentage moves could
        // overdrive the blind. (0/0 = previously uncalibrated is a valid
        // restore target too: it simply returns the device to uncalibrated.)
        const preWizardLimits = readLimitsFromState(
            (typeof MQTTClient !== 'undefined' && MQTTClient.getDeviceState(BlindState.deviceId)) || {});
        let wizTopSavedNew = false;
        let wizBottomSavedNew = false;

        const waitForCalibrationEcho = (cmd, validator, timeoutMs = 6000) => {
            return new Promise(resolve => {
                let settled = false;
                const finish = (result) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    if (typeof MQTTClient !== 'undefined') MQTTClient.off('onStateUpdate', onState);
                    resolve(result);
                };
                const onState = (deviceId, snapshot) => {
                    if (String(deviceId || '').toUpperCase() !== BlindState.deviceId) return;
                    const limits = readLimitsFromState(snapshot);
                    if (validator(snapshot, limits)) {
                        finish({ ok: true, snapshot, limits });
                    }
                };
                const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), timeoutMs);
                if (typeof MQTTClient !== 'undefined') {
                    MQTTClient.on('onStateUpdate', onState);
                    if (!publishCalibrationConfig({ cmd })) {
                        finish({ ok: false, reason: 'offline' });
                        return;
                    }
                    setTimeout(() => {
                        if (MQTTClient.connected) {
                            MQTTClient.publishControl(BlindState.deviceId, { command: 'getState' }, { queue: false, localFallback: false });
                        }
                    }, 700);
                } else {
                    finish({ ok: false, reason: 'mqtt_unavailable' });
                }
            });
        };

        // Self-test leg timeout derived from the blind's PHYSICS instead of a
        // fixed 35 s: travel time = range / configured speed. A tall window on
        // the "Quiet" preset (e.g. 60,000 steps at 1,000 steps/s = 60 s) used to
        // fail the verification test with "check the motor" while nothing was
        // wrong. 1.5× margin covers accel ramps + a 10 s comms floor; the result
        // is clamped to [35 s, 180 s] so a corrupt config can't hang the wizard.
        const selfTestTimeoutMs = (opening) => {
            const top = Number(BlindState.config.stepperTop);
            const bottom = Number(BlindState.config.stepperBottom);
            const speed = Number(opening ? BlindState.config.stepperOpenSpeed
                                         : BlindState.config.stepperCloseSpeed) || 2000;
            let travelMs = 0;
            if (Number.isFinite(top) && Number.isFinite(bottom) && speed > 0) {
                travelMs = (Math.abs(top - bottom) / speed) * 1000;
            }
            return Math.max(35000, Math.min(180000, Math.round(travelMs * 1.5 + 10000)));
        };

        const waitForMotionTarget = (target, timeoutMs = 30000) => {
            const expected = Math.max(0, Math.min(100, Number(target)));
            // Rejection baseline: the firmware echoes lastCommandRejected/-Seq in
            // EVERY state publish for the rest of its boot once ANY command has been
            // rejected (e.g. an open tapped before calibration). Their mere presence
            // says nothing about THIS move — only a sequence number HIGHER than the
            // one already known when the wait starts marks a fresh rejection.
            const stateAtStart = (typeof MQTTClient !== 'undefined' && MQTTClient.getDeviceState)
                ? (MQTTClient.getDeviceState(BlindState.deviceId) || {})
                : {};
            const baselineRejectSeq = Math.max(
                Number(stateAtStart.lastCommandRejectedSeq) || 0,
                Number(BlindState.lastCommandRejectedSeq) || 0
            );
            return new Promise(resolve => {
                let settled = false;
                let pollTimer = null;
                const finish = (result) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    clearInterval(pollTimer);
                    if (typeof MQTTClient !== 'undefined') MQTTClient.off('onStateUpdate', onState);
                    resolve(result);
                };
                const inspect = (snapshot = {}) => {
                    const rejectSeq = Number(snapshot.lastCommandRejectedSeq);
                    if (Number.isFinite(rejectSeq) && rejectSeq > baselineRejectSeq) {
                        finish({ ok: false, reason: snapshot.lastCommandRejected || 'command_rejected', snapshot });
                        return;
                    }
                    const rawPos = snapshot.blindPosition !== undefined ? snapshot.blindPosition : snapshot.position;
                    const pos = Number(rawPos);
                    const moving = snapshot.isMoving === true;
                    if (Number.isFinite(pos) && Math.abs(pos - expected) <= 2 && !moving) {
                        finish({ ok: true, snapshot, position: pos });
                    }
                };
                const onState = (deviceId, snapshot) => {
                    if (String(deviceId || '').toUpperCase() !== BlindState.deviceId) return;
                    inspect(snapshot);
                };
                const requestState = () => {
                    if (typeof MQTTClient !== 'undefined' && MQTTClient.connected) {
                        MQTTClient.publishControl(BlindState.deviceId, { command: 'getState' }, { queue: false, localFallback: false });
                    }
                };
                const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), timeoutMs);
                if (typeof MQTTClient !== 'undefined') {
                    MQTTClient.on('onStateUpdate', onState);
                    inspect(MQTTClient.getDeviceState(BlindState.deviceId) || {});
                    requestState();
                    pollTimer = setInterval(requestState, 1000);
                } else {
                    finish({ ok: false, reason: 'mqtt_unavailable' });
                }
            });
        };

        const setActionBusy = (busy, text) => {
            if (!cleanActionBtn) return;
            cleanActionBtn.disabled = busy;
            cleanActionBtn.style.opacity = busy ? '0.7' : '1';
            cleanActionBtn.style.cursor = busy ? 'not-allowed' : 'pointer';
            if (text) {
                cleanActionBtn.dataset.savedHtml = cleanActionBtn.dataset.savedHtml || cleanActionBtn.innerHTML;
                cleanActionBtn.textContent = text;
            } else if (!busy && cleanActionBtn.dataset.savedHtml) {
                cleanActionBtn.innerHTML = cleanActionBtn.dataset.savedHtml;
                delete cleanActionBtn.dataset.savedHtml;
            }
        };

        // Continuous Virtual Jog Animation
        const runVirtualJog = (dir) => {
            if (dir === 1) {
                virtualPosition = Math.min(100, virtualPosition + 1.2);
            } else {
                virtualPosition = Math.max(0, virtualPosition - 1.2);
            }
            updatePreview(virtualPosition);
            
            const frame = wizard.querySelector('#wizardBlindsFrame');
            if (frame) {
                frame.classList.toggle('open', virtualPosition > 20);
            }
        };

        // Always-safe jog halt. Publishes jog:0 unconditionally (idempotent on the
        // firmware) and tears down the local timers, so a jog can never outlive the
        // UI that started it. Used by every exit path — button release, wizard
        // close, errors, and page hide / visibility loss.
        const forceStopJog = () => {
            isJogging = false;
            clearInterval(jogInterval);
            clearInterval(jogKeepalive);
            if (typeof MQTTClient !== 'undefined' && BlindState.deviceId) {
                publishCalibrationStepper({ jog: 0 }, true);
            }
        };

        // Stop the jog if the page is hidden/closed mid-press (app switched away,
        // tab closed). Without this the pointerup that would send jog:0 may never
        // fire; the firmware deadman is the final backstop, but stopping promptly
        // here avoids any extra travel. Listeners are removed in closeWizard().
        const onVisibilityHide = () => { if (document.hidden) forceStopJog(); };
        document.addEventListener('visibilitychange', onVisibilityHide);
        window.addEventListener('pagehide', forceStopJog);

        // Jog Triggers
        const startJogging = (direction) => {
            if (isJogging) return;
            isJogging = true;

            if (typeof Haptic !== 'undefined' && typeof Haptic.impact === 'function') {
                Haptic.impact('light');
            }

            if (!isCalibrationLinkLive()) {
                isJogging = false;
                logMsg('Connection lost. Reconnect before jogging.', 'error');
                if (typeof Toast !== 'undefined') Toast.error('Connection lost — jog not sent');
                return;
            }

            publishCalibrationStepper({ jog: direction }, false);

            logMsg(direction === 1 ? 'Jogging upward (Opening)...' : 'Jogging downward (Closing)...', 'active');
            jogInterval = setInterval(() => runVirtualJog(direction), 50);

            // Deadman keepalive: the firmware auto-halts a jog if no command
            // arrives within ~2.5s, so refresh it every 700ms while the button is
            // held. A lost stop (app backgrounded/closed) then trips the firmware
            // deadman instead of leaving the motor running into the limit.
            clearInterval(jogKeepalive);
            jogKeepalive = setInterval(() => {
                if (isJogging) publishCalibrationStepper({ jog: direction }, false);
            }, 700);
        };

        const stopJogging = () => {
            if (!isJogging) return;
            forceStopJog();
            logMsg(`Motor stopped at virtual position ${Math.round(virtualPosition)}%.`);
        };

        // Event listeners for Jog buttons (pointer based for continuous press)
        const jogUpBtn = wizard.querySelector('#wizJogUpBtn');
        const jogDownBtn = wizard.querySelector('#wizJogDownBtn');

        // Re-clone nodes to wipe old listeners and prevent double events
        const cleanJogUp = jogUpBtn.cloneNode(true);
        const cleanJogDown = jogDownBtn.cloneNode(true);
        jogUpBtn.parentNode.replaceChild(cleanJogUp, jogUpBtn);
        jogDownBtn.parentNode.replaceChild(cleanJogDown, jogDownBtn);

        const bindJogEvents = (btn, dir) => {
            btn.addEventListener('pointerdown', (e) => {
                e.preventDefault();
                btn.classList.add('active');
                startJogging(dir);
            });
            const handleRelease = (e) => {
                e.preventDefault();
                btn.classList.remove('active');
                stopJogging();
            };
            btn.addEventListener('pointerup', handleRelease);
            btn.addEventListener('pointerleave', handleRelease);
            btn.addEventListener('pointercancel', handleRelease);
        };

        bindJogEvents(cleanJogUp, 1);
        bindJogEvents(cleanJogDown, -1);

        // Step Controller
        const advanceToStep = (step) => {
            currentStep = step;
            
            stepNodes.forEach((node, idx) => {
                const nodeStep = idx + 1;
                node.className = 'wiz-step-node';
                if (nodeStep < step) node.classList.add('completed');
                else if (nodeStep === step) node.classList.add('active');
            });
            
            if (wizProgress) wizProgress.style.width = `${((step - 1) / 2) * 100}%`;
            
            if (step === 2) {
                if (stepTitle) {
                    stepTitle.innerHTML = `
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="color: var(--blind-accent-light);"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
                        <span>Step 2: Set Closed Boundary</span>
                    `;
                }
                if (stepDesc) {
                    stepDesc.innerHTML = `
                        Jog the blind downwards until it is in the fully <strong>CLOSED</strong> position. Adjust precisely, then tap <strong>Save Closed Limit</strong>.
                    `;
                }
                if (actionBtn) {
                    actionBtn.className = 'wiz-action-btn primary';
                    actionBtn.innerHTML = `
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-arrow-down-to-line"><path d="M5 21h14"/><path d="m6 11 6 6 6-6"/><path d="M12 17V3"/></svg>
                        Save Closed Limit
                    `;
                }
                logMsg('Ready to configure bottom boundary limit.', 'active');
                
                let count = 0;
                const transition = setInterval(() => {
                    if (count >= 20 || virtualPosition <= 5) {
                        clearInterval(transition);
                    } else {
                        virtualPosition = Math.max(5, virtualPosition - 5);
                        updatePreview(virtualPosition);
                        count++;
                    }
                }, 20);
                
            } else if (step === 3) {
                if (jogControls) jogControls.style.display = 'none';
                if (stepTitle) {
                    stepTitle.innerHTML = `
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="color: var(--success);"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>
                        <span>Step 3: Verification Test</span>
                    `;
                }
                if (stepDesc) {
                    stepDesc.innerHTML = `
                        Run a self-test verification. The blind will travel a complete sequence to test coordinates and confirm limits are saved in hardware NVS flash.
                    `;
                }
                const actBtn = wizard.querySelector('#wizActionBtn');
                if (actBtn) {
                    actBtn.className = 'wiz-action-btn success';
                    actBtn.innerHTML = `
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-play"><polygon points="6 3 20 12 6 21 6 3"/></svg>
                        Start Verification Test
                    `;
                }
                logMsg('Boundaries saved. Ready for transit check.');
            }
        };

        // Main Action Button Event
        const cleanActionBtn = actionBtn.cloneNode(true);
        actionBtn.parentNode.replaceChild(cleanActionBtn, actionBtn);

        cleanActionBtn.addEventListener('click', async () => {
            if (currentStep === 1) {
                setActionBusy(true, 'Saving Open Limit...');
                logMsg('Saving open limit and waiting for device confirmation...', 'active');
                // Genuine confirmation: stepperTop is present in EVERY state the
                // firmware publishes, so "top !== null" would pass on any echo.
                // The save is only proven when the echoed top matches where the
                // blind physically is right now (save_top stores the current
                // absolute position), with a changed-value fallback for states
                // that omit the live step counter.
                const beforeTop = readLimitsFromState(
                    (typeof MQTTClient !== 'undefined' && MQTTClient.getDeviceState(BlindState.deviceId)) || {}
                ).top;
                const result = await waitForCalibrationEcho('save_top', (snapshot, limits) => {
                    if (limits.top === null) return false;
                    const cur = _numberOrNull(snapshot.calibration && snapshot.calibration.currentPosition);
                    if (cur !== null) return Math.abs(limits.top - cur) <= 8;
                    return beforeTop === null || limits.top !== beforeTop;
                });
                setActionBusy(false);
                if (!result.ok) {
                    logMsg('Open limit was not confirmed. Check connection and try again.', 'error');
                    if (typeof Toast !== 'undefined') Toast.error('Open limit was not confirmed');
                    return;
                }
                if (typeof Haptic !== 'undefined' && typeof Haptic.notification === 'function') {
                    Haptic.notification('success');
                }
                if (typeof Toast !== 'undefined') Toast.success('Open limit confirmed');
                logMsg('Open limit confirmed by firmware.', 'normal');
                wizTopSavedNew = true;
                advanceToStep(2);
                
            } else if (currentStep === 2) {
                setActionBusy(true, 'Saving Closed Limit...');
                logMsg('Saving closed limit and validating calibration range...', 'active');
                const result = await waitForCalibrationEcho('save_bottom', (snapshot, limits) => {
                    const range = (limits.top !== null && limits.bottom !== null)
                        ? Math.abs(limits.top - limits.bottom)
                        : 0;
                    if (!(snapshot.isCalibrated === true && range >= 500)) return false;
                    // Same physical-position correspondence as save_top: the echoed
                    // bottom must match where the blind is now (when reported).
                    const cur = _numberOrNull(snapshot.calibration && snapshot.calibration.currentPosition);
                    return cur === null || Math.abs(limits.bottom - cur) <= 8;
                });
                setActionBusy(false);
                if (!result.ok) {
                    BlindState.isCalibrated = false;
                    updateCalibrationWarning();
                    updateCalibrationTools();
                    logMsg('Calibration range was rejected. Move farther between open and closed limits.', 'error');
                    if (typeof Toast !== 'undefined') Toast.error('Calibration range too small or not confirmed');
                    return;
                }
                if (typeof Haptic !== 'undefined' && typeof Haptic.notification === 'function') {
                    Haptic.notification('success');
                }
                BlindState.isCalibrated = true;
                if (typeof Toast !== 'undefined') Toast.success('Closed limit confirmed');
                logMsg('Closed limit confirmed. Calibration range is valid.', 'normal');
                wizBottomSavedNew = true;
                advanceToStep(3);
                
            } else if (currentStep === 3) {
                if (cleanActionBtn.classList.contains('success')) {
                    cleanActionBtn.style.display = 'none';
                    if (testProgress) testProgress.style.display = 'block';
                    logMsg('Self-Test running: Moving to OPEN...', 'active');
                    
                    if (typeof Haptic !== 'undefined' && typeof Haptic.impact === 'function') {
                        Haptic.impact('medium');
                    }

                    cleanActionBtn.disabled = true;
                    let visualPct = 0;
                    const progressTimer = setInterval(() => {
                        visualPct = Math.min(95, visualPct + 1.5);
                        if (testProgressFill) testProgressFill.style.width = `${visualPct}%`;
                        virtualPosition = visualPct < 50
                            ? Math.min(100, virtualPosition + 2)
                            : Math.max(0, virtualPosition - 2);
                        updatePreview(virtualPosition);
                    }, 120);

                    const sendTestTarget = (target) => {
                        if (!isCalibrationLinkLive()) {
                            return { sent: false, queued: false, reason: 'offline' };
                        }
                        if (typeof BlindCommandQueue !== 'undefined' && typeof BlindCommandQueue.send === 'function') {
                            return BlindCommandQueue.send(BlindState.deviceId, {
                                blindPosition: target,
                                calibrationSession: calibrationSessionId
                            }, {
                                source: 'calibration-self-test',
                                persist: false
                            });
                        } else {
                            const sent = publishCalibrationStepper({ position: target }, false);
                            return { sent, queued: false };
                        }
                    };

                    selfTestRunning = true;
                    const openSend = sendTestTarget(100);
                    if (!openSend || openSend.sent === false) {
                        clearInterval(progressTimer);
                        if (testProgress) testProgress.style.display = 'none';
                        cleanActionBtn.disabled = false;
                        cleanActionBtn.style.display = 'flex';
                        logMsg('Self-test could not start because the blind is offline.', 'error');
                        if (typeof Toast !== 'undefined') Toast.error('Blind is offline — self-test not started');
                        selfTestRunning = false;
                        return;
                    }
                    const openResult = await waitForMotionTarget(100, selfTestTimeoutMs(true));
                    if (!openResult.ok) {
                        clearInterval(progressTimer);
                        if (testProgress) testProgress.style.display = 'none';
                        cleanActionBtn.disabled = false;
                        cleanActionBtn.style.display = 'flex';
                        logMsg('Self-test failed while opening. Check travel range and motor direction.', 'error');
                        if (typeof Toast !== 'undefined') Toast.error('Self-test did not reach open limit');
                        publishCalibrationStepper({ command: 'stop' }, true);
                        selfTestRunning = false;
                        return;
                    }

                    if (testProgressFill) testProgressFill.style.width = '50%';
                    logMsg('Open verified. Moving to CLOSED...', 'active');
                    virtualPosition = 100;
                    updatePreview(virtualPosition);

                    const closeSend = sendTestTarget(0);
                    if (!closeSend || closeSend.sent === false) {
                        clearInterval(progressTimer);
                        if (testProgress) testProgress.style.display = 'none';
                        cleanActionBtn.disabled = false;
                        cleanActionBtn.style.display = 'flex';
                        logMsg('Self-test could not continue because the blind is offline.', 'error');
                        if (typeof Toast !== 'undefined') Toast.error('Blind is offline — self-test stopped');
                        publishCalibrationStepper({ command: 'stop' }, true);
                        selfTestRunning = false;
                        return;
                    }
                    const closeResult = await waitForMotionTarget(0, selfTestTimeoutMs(false));
                    clearInterval(progressTimer);
                    if (!closeResult.ok) {
                        if (testProgress) testProgress.style.display = 'none';
                        cleanActionBtn.disabled = false;
                        cleanActionBtn.style.display = 'flex';
                        logMsg('Self-test failed while closing. Check closed limit and travel range.', 'error');
                        if (typeof Toast !== 'undefined') Toast.error('Self-test did not reach closed limit');
                        publishCalibrationStepper({ command: 'stop' }, true);
                        selfTestRunning = false;
                        return;
                    }

                    if (testProgressFill) testProgressFill.style.width = '100%';
                    virtualPosition = BlindState.position;
                    updatePreview(virtualPosition);

                    if (typeof Haptic !== 'undefined' && typeof Haptic.notification === 'function') {
                        Haptic.notification('success');
                    }

                    if (testProgress) testProgress.style.display = 'none';
                    cleanActionBtn.disabled = false;
                    cleanActionBtn.style.display = 'flex';
                    cleanActionBtn.className = 'wiz-action-btn success';
                    cleanActionBtn.innerHTML = `
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check-circle"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                        Finish Calibration
                    `;

                    BlindState.isCalibrated = true;
                    BlindState.ignoreIncomingConfig = true;
                    setTimeout(() => { BlindState.ignoreIncomingConfig = false; }, 3000);

                    updateCalibrationWarning();
                    updateConfigUI();
                    saveDeviceState();

                    logMsg('Verification complete! Stepper fully operational.');
                    selfTestRunning = false;
                    currentStep = 4;
                }
            } else if (currentStep === 4) {
                closeWizard();
            }
        });

        // Close wizard logic
        const closeWizard = () => {
            if (typeof Haptic !== 'undefined' && typeof Haptic.impact === 'function') {
                Haptic.impact('light');
            }
            // Guarantee the motor is stopped on close (the wizard can be dismissed
            // mid-jog), then drop the page-hide guards so they don't accumulate
            // across re-opens.
            forceStopJog();
            if (selfTestRunning) publishCalibrationStepper({ command: 'stop' }, true);
            // Abandoned HALF-calibration (exactly one limit saved): the device
            // is now mixing a new limit with an old one — two different
            // reference frames. Restore the pre-wizard limits so percentage
            // moves can't overdrive the blind. Restoring 0/0 (previously
            // uncalibrated) simply returns the device to uncalibrated.
            if (wizTopSavedNew !== wizBottomSavedNew) {
                if (preWizardLimits.top !== null && preWizardLimits.bottom !== null) {
                    publishCalibrationConfig({
                        stepperTop: preWizardLimits.top,
                        stepperBottom: preWizardLimits.bottom
                    });
                    if (typeof Toast !== 'undefined') Toast.info('Calibration cancelled — previous limits restored');
                    if (typeof addLogEntry === 'function') {
                        addLogEntry('↩', 'Calibration abandoned half-way — previous limits restored', { source: 'app' });
                    }
                } else if (typeof Toast !== 'undefined') {
                    // No known previous limits to restore (no state snapshot yet).
                    Toast.warning('Calibration incomplete — set BOTH limits before moving the blind');
                }
            }
            publishCalibrationConfig({ cmd: 'calibration_end' });
            clearCalibrationQueues();
            document.removeEventListener('visibilitychange', onVisibilityHide);
            window.removeEventListener('pagehide', forceStopJog);
            wizard.classList.remove('active');
            setTimeout(() => {
                wizard.style.display = 'none';
            }, 350);
        };

        // Hook close button click with cloning to avoid leak
        const closeBtn = wizard.querySelector('#closeWizBtn');
        const cleanCloseBtn = closeBtn.cloneNode(true);
        closeBtn.parentNode.replaceChild(cleanCloseBtn, closeBtn);
        cleanCloseBtn.addEventListener('click', closeWizard);

    } catch (err) {
        console.error('[Wizard] Fatal error in openLimitsCalibrationWizard:', err);
        // Defensive: if anything threw after a jog could have started, make sure
        // the motor isn't left running (forceStopJog is scoped inside the try).
        try {
            if (typeof MQTTClient !== 'undefined' && BlindState.deviceId) {
                MQTTClient.publishStepperControl(BlindState.deviceId, { jog: 0 });
            }
        } catch (_) { /* ignore */ }
        if (typeof Toast !== 'undefined') {
            Toast.error('Failed to open calibration wizard: ' + err.message);
        }
    }
}

// ============================================
// Settings
// ============================================
function setupSettings() {
    // Device name setting
    document.getElementById('deviceNameSetting')?.addEventListener('click', () => {
        if (typeof Modal === 'undefined') return;
        const { modal, close } = Modal.create({
            title: 'Device Name',
        content: `
            <input type="text" id="blindNameInput" value="${escapeHtml(getDeviceName())}"
                class="modal-input" maxlength="24" placeholder="Smart Blinds">
        `,
            actions: [
                { label: 'Cancel', primary: false },
                {
                    label: 'Save', primary: true,
                    onClick: () => {
                        const input = modal.querySelector('#blindNameInput');
                        const name = input?.value.trim() || 'Smart Blinds';
                        setDeviceName(name);
                        return true;
                    }
                }
            ]
        });
        setTimeout(() => modal.querySelector('#blindNameInput')?.focus(), 50);
    });

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
                                    background: ${currentTz === tz.id ? 'rgba(20, 184, 166, 0.15)' : 'var(--bg-glass)'};
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

                            saveDeviceState();
                            pushFullConfigNow();

                            if (typeof Toast !== 'undefined') Toast.success('Timezone updated successfully');
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
                        o.style.background = isSelected ? 'rgba(20, 184, 166, 0.15)' : 'var(--bg-glass)';
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

    // Temperature Unit Setting (°C / °F). Presentation-only: storage, firmware
    // payloads and MQTT stay °C; every display converts via BlindSchema helpers.
    const tempUnitSetting = document.getElementById('tempUnitSetting');
    if (tempUnitSetting) {
        const renderTempUnit = () => {
            const valueEl = document.getElementById('tempUnitValue');
            const unit = (typeof BlindSchema !== 'undefined' && BlindSchema.tempUnit) ? BlindSchema.tempUnit() : 'C';
            if (valueEl) valueEl.textContent = unit === 'F' ? 'Fahrenheit (°F)' : 'Celsius (°C)';
        };
        renderTempUnit();
        tempUnitSetting.addEventListener('click', () => {
            if (typeof BlindSchema === 'undefined' || !BlindSchema.setTempUnit) return;
            const next = BlindSchema.tempUnit() === 'F' ? 'C' : 'F';
            BlindSchema.setTempUnit(next);
            renderTempUnit();
            // Refresh every temperature display in the new unit.
            if (typeof updateConfigUI === 'function') updateConfigUI();
            if (typeof Haptic !== 'undefined') Haptic.selection();
            if (typeof Toast !== 'undefined') {
                Toast.success(next === 'F' ? 'Temperatures now shown in °F' : 'Temperatures now shown in °C');
            }
        });
    }

    // Wi-Fi Credentials Setting
    const wifiCredentialsSetting = document.getElementById('wifiCredentialsSetting');
    if (wifiCredentialsSetting) {
        wifiCredentialsSetting.addEventListener('click', () => {
            if (typeof Modal === 'undefined') return;

            let selectedSSID = '';
            let isScanning = false;
            let wifiChangeTimeout = null;
            let scanTimeout = null;
            // Ghost-connection guard: the firmware sends an explicit ack, but if that
            // single message is lost/late we also treat the blind REAPPEARING on the
            // broker (state or availability) after the change as success — the device
            // genuinely reconnected on the new network, which is what matters.
            let awaitingWifiChange = false;
            let wifiChangeStartTs = 0;

            const scanTopic = `lumibot/${BlindState.deviceId}/wifi-scan`;
            const ackTopic = `lumibot/${BlindState.deviceId}/wifi-change-ack`;
            const stateTopic = `lumibot/${BlindState.deviceId}/state`;
            const availTopic = `lumibot/${BlindState.deviceId}/availability`;

            // Subscribe to topics. Pulled into a function and ALSO re-run on
            // every broker (re)connect while the modal is open: these manual
            // subscriptions are not in MQTTClient's tracked subscription map,
            // so a WebSocket blip mid-change used to silently drop them — the
            // explicit ack (and any scan results) then never arrived.
            const subscribeModalTopics = () => {
                if (typeof MQTTClient === 'undefined' || !MQTTClient.connected) return;
                try {
                    MQTTClient.client.subscribe(scanTopic, { qos: 1 });
                    MQTTClient.client.subscribe(ackTopic, { qos: 1 });
                    MQTTClient.client.subscribe(availTopic, { qos: 1 });
                    // stateTopic is already subscribed by the page; no-op if so.
                    MQTTClient.client.subscribe(stateTopic, { qos: 1 });
                } catch (e) {
                    console.error('MQTT subscribe error:', e);
                }
            };
            subscribeModalTopics();
            const onModalReconnect = () => subscribeModalTopics();
            if (typeof MQTTClient !== 'undefined') MQTTClient.on('onConnect', onModalReconnect);

            const initialContent = `
                <div id="wifiModalBody" style="display: flex; flex-direction: column; gap: 14px; margin-top: 10px; max-height: 70vh; overflow-y: auto; padding-bottom: 10px; padding-right: 4px;">
                    
                    <div style="display: flex; flex-direction: column; gap: 6px;">
                        <label style="font-size: 12px; font-weight: 700; color: var(--text-tertiary); text-transform: uppercase; letter-spacing: 0.05em;">SSID (Network Name)</label>
                        <div style="display: flex; gap: 8px; position: relative;">
                            <input type="text" id="wifiSSIDInput" placeholder="Enter network name" class="modal-input" style="flex: 1; padding-right: 40px;" maxlength="32">
                            <button id="scanWiFiBtn" aria-label="Scan for Wi-Fi networks" style="position: absolute; right: 10px; top: 50%; transform: translateY(-50%); background: none; border: none; color: var(--blind-accent); cursor: pointer; display: flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: 50%; transition: all 0.2s ease;" title="Scan Networks">
                                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-search"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
                            </button>
                        </div>
                    </div>
 
                    <!-- Scanned Networks Section -->
                    <div id="scannedWiFiSection" style="display: none; flex-direction: column; gap: 12px; background: rgba(0, 0, 0, 0.2); border: 1px solid var(--border-glass); border-radius: var(--radius-lg); padding: 18px; margin-bottom: 4px;">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                            <span style="font-size: 12px; font-weight: 700; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.05em;">Scanned Networks</span>
                            <span id="scanStatusText" style="font-size: 12px; color: var(--text-tertiary);">Select network below</span>
                        </div>
                        <div id="scannedNetworksList" class="wifi-network-list" style="display: flex; flex-direction: column; gap: 12px; padding-right: 4px; max-height: 240px; overflow-y: auto; -webkit-overflow-scrolling: touch;">
                            <!-- Scan results list items -->
                        </div>
                    </div>

                    <div style="display: flex; flex-direction: column; gap: 6px;">
                        <label style="font-size: 12px; font-weight: 700; color: var(--text-tertiary); text-transform: uppercase; letter-spacing: 0.05em;">Wi-Fi Password</label>
                        <div style="display: flex; gap: 8px; position: relative;">
                            <input type="password" id="wifiPasswordInput" placeholder="Enter password (minimum 8 characters)" class="modal-input" style="flex: 1; padding-right: 40px;" maxlength="64">
                            <button id="toggleWifiPasswordBtn" aria-label="Show or hide password" style="position: absolute; right: 10px; top: 50%; transform: translateY(-50%); background: none; border: none; color: var(--text-tertiary); cursor: pointer; display: flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: 50%; transition: all 0.2s ease;">
                                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" id="eyeIcon"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0z"/><circle cx="12" cy="12" r="3"/></svg>
                            </button>
                        </div>
                    </div>
                </div>
            `;

            const onMqttMessage = (topic, payload) => {
                const sTopic = `lumibot/${BlindState.deviceId}/wifi-scan`;
                const aTopic = `lumibot/${BlindState.deviceId}/wifi-change-ack`;

                if (topic === sTopic) {
                    try {
                        if (scanTimeout) { clearTimeout(scanTimeout); scanTimeout = null; }
                        const networks = JSON.parse(payload);
                        isScanning = false;
                        const scanBtn = modal.querySelector('#scanWiFiBtn');
                        if (scanBtn) {
                            scanBtn.disabled = false;
                            scanBtn.style.opacity = '1';
                        }
                        renderScannedNetworks(networks);
                    } catch (e) {
                        console.error('WiFi Scan parse failed:', e);
                        isScanning = false;
                    }
                } else if (topic === aTopic) {
                    try {
                        const data = JSON.parse(payload);
                        if (wifiChangeTimeout) {
                            clearTimeout(wifiChangeTimeout);
                            wifiChangeTimeout = null;
                        }
                        awaitingWifiChange = false;
                        handleWiFiChangeAck(data);
                    } catch (e) {
                        console.error('WiFi Change Ack parse failed:', e);
                    }
                } else if (awaitingWifiChange && (topic === stateTopic || topic === availTopic)) {
                    // The blind reappeared on the broker AFTER we asked it to switch
                    // networks → it reconnected on the new SSID. Accept as success even
                    // if the dedicated ack never arrived. Gate on elapsed time so a
                    // stale retained message (delivered on subscribe) can't false-trip.
                    const online = topic === availTopic
                        ? String(payload).toLowerCase().includes('online')
                        : true; // any fresh state publish means it's alive on the network
                    if (online && (Date.now() - wifiChangeStartTs > 6000)) {
                        if (wifiChangeTimeout) { clearTimeout(wifiChangeTimeout); wifiChangeTimeout = null; }
                        awaitingWifiChange = false;
                        handleWiFiChangeAck({ status: 'success', ssid: selectedSSID });
                    }
                }
            };

            const renderScannedNetworks = (networks) => {
                const list = modal.querySelector('#scannedNetworksList');
                if (!list) return;

                if (!networks || networks.length === 0) {
                    list.innerHTML = `<div style="text-align:center; padding: 16px; font-size:12px; color:var(--text-tertiary);">No networks found</div>`;
                    return;
                }

                const filtered = networks.filter(n => n.s && n.s.trim().length > 0).sort((a, b) => b.r - a.r);

                list.innerHTML = filtered.map(net => {
                    let rssiText = 'Weak';
                    let activeBars = 1;
                    if (net.r >= -50) { rssiText = 'Excellent'; activeBars = 4; }
                    else if (net.r >= -65) { rssiText = 'Good'; activeBars = 3; }
                    else if (net.r >= -80) { rssiText = 'Fair'; activeBars = 2; }

                    const wifi6Badge = net.ax ? `<span style="flex-shrink: 0; white-space: nowrap; font-size: 9px; font-weight: 800; background: linear-gradient(135deg, #10b981 0%, #14b8a6 100%); color: white; padding: 2px 7px; border-radius: 5px; text-transform: uppercase; letter-spacing: 0.04em; box-shadow: 0 2px 6px rgba(16, 185, 129, 0.25); line-height: 1.5;">WiFi&nbsp;6</span>` : '';

                    const lockIcon = net.e ? `
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="color: var(--text-secondary); opacity: 0.8; flex-shrink: 0;"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                    ` : `
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="color: var(--text-tertiary); opacity: 0.5; flex-shrink: 0;"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>
                    `;

                    const signalIcon = `
                        <svg width="20" height="15" viewBox="0 0 16 12" fill="none" style="flex-shrink: 0; align-self: center; margin-left: auto;">
                            <rect x="0" y="9" width="2.5" height="3" rx="0.5" fill="${activeBars >= 1 ? 'var(--blind-accent)' : 'var(--text-tertiary)'}" opacity="${activeBars >= 1 ? '1' : '0.3'}"/>
                            <rect x="4.5" y="6" width="2.5" height="6" rx="0.5" fill="${activeBars >= 2 ? 'var(--blind-accent)' : 'var(--text-tertiary)'}" opacity="${activeBars >= 2 ? '1' : '0.3'}"/>
                            <rect x="9" y="3" width="2.5" height="9" rx="0.5" fill="${activeBars >= 3 ? 'var(--blind-accent)' : 'var(--text-tertiary)'}" opacity="${activeBars >= 3 ? '1' : '0.3'}"/>
                            <rect x="13.5" y="0" width="2.5" height="12" rx="0.5" fill="${activeBars >= 4 ? 'var(--blind-accent)' : 'var(--text-tertiary)'}" opacity="${activeBars >= 4 ? '1' : '0.3'}"/>
                        </svg>
                    `;

                    return `
                        <div class="wifi-network-item" data-ssid="${escapeHtml(net.s)}"
                             style="display: flex; align-items: center; gap: 16px; padding: 16px 20px; border-radius: var(--radius-lg); background: var(--bg-glass); border: 1px solid var(--border-glass); cursor: pointer; transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1); box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);">
                            <span style="flex-shrink: 0; display: flex; align-items: center;">${lockIcon}</span>
                            <div style="display: flex; flex-direction: column; gap: 6px; flex: 1 1 auto; min-width: 0;">
                                <div style="display: flex; align-items: center; gap: 8px; min-width: 0;">
                                    <span style="flex: 0 1 auto; min-width: 0; font-size: 16px; font-weight: 600; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(net.s)}</span>
                                    ${wifi6Badge}
                                </div>
                                <span style="font-size: 13px; color: var(--text-tertiary);">${rssiText} · ${net.r} dBm</span>
                            </div>
                            <span style="flex-shrink: 0; display: flex; align-items: center;">${signalIcon}</span>
                        </div>
                    `;
                }).join('');

                const items = list.querySelectorAll('.wifi-network-item');
                items.forEach(item => {
                    item.addEventListener('mouseenter', () => {
                        if (item.dataset.ssid !== selectedSSID) {
                            item.style.background = 'rgba(255, 255, 255, 0.08)';
                            item.style.borderColor = 'rgba(255, 255, 255, 0.15)';
                        }
                    });
                    item.addEventListener('mouseleave', () => {
                        if (item.dataset.ssid !== selectedSSID) {
                            item.style.background = 'var(--bg-glass)';
                            item.style.borderColor = 'var(--border-glass)';
                        }
                    });

                    item.addEventListener('click', () => {
                        const ssid = item.dataset.ssid;
                        const ssidInput = modal.querySelector('#wifiSSIDInput');
                        if (ssidInput) {
                            ssidInput.value = ssid;
                            selectedSSID = ssid;
                        }
                        
                        items.forEach(i => {
                            i.style.background = 'var(--bg-glass)';
                            i.style.borderColor = 'var(--border-glass)';
                            i.style.boxShadow = '0 2px 4px rgba(0, 0, 0, 0.05)';
                        });
                        item.style.background = 'rgba(20, 184, 166, 0.12)';
                        item.style.borderColor = 'var(--blind-accent)';
                        item.style.boxShadow = '0 0 10px rgba(20, 184, 166, 0.2)';
                        
                        if (typeof Haptic !== 'undefined') Haptic.selection();
                    });
                });
            };

            const triggerScan = () => {
                if (isScanning) return;
                isScanning = true;

                const scanBtn = modal.querySelector('#scanWiFiBtn');
                if (scanBtn) {
                    scanBtn.disabled = true;
                    scanBtn.style.opacity = '0.5';
                }

                const list = modal.querySelector('#scannedNetworksList');
                const section = modal.querySelector('#scannedWiFiSection');
                if (section) section.style.display = 'flex';
                if (list) {
                    list.innerHTML = `
                        <div class="twt-radar-loader">
                            <div class="twt-radar-wave"></div>
                            <div class="twt-radar-wave"></div>
                            <div class="twt-radar-wave"></div>
                        </div>
                        <div style="text-align: center; font-size: 13px; color: var(--text-tertiary); margin-bottom: 8px;">Scanning networks...</div>
                    `;
                }

                if (typeof MQTTClient !== 'undefined' && MQTTClient.connected) {
                    MQTTClient.publishConfig(BlindState.deviceId, { cmd: "scan_wifi" }, { queue: false, localFallback: false });
                    // Never spin forever: if no results arrive (scan failed, packet
                    // lost, or the device is mid-reconnect) surface a retry instead
                    // of an infinite "Scanning…". Cleared when results arrive.
                    if (scanTimeout) clearTimeout(scanTimeout);
                    scanTimeout = setTimeout(() => {
                        scanTimeout = null;
                        if (!isScanning) return;
                        isScanning = false;
                        if (scanBtn) { scanBtn.disabled = false; scanBtn.style.opacity = '1'; }
                        if (list) list.innerHTML = `<div style="text-align:center; padding:16px; font-size:12px; color:var(--text-tertiary);">Scan timed out. Tap "Scan" to try again.</div>`;
                    }, 12000);
                } else {
                    // MQTT offline — don't leave the loader spinning.
                    isScanning = false;
                    if (scanBtn) { scanBtn.disabled = false; scanBtn.style.opacity = '1'; }
                    if (list) list.innerHTML = `<div style="text-align:center; padding:16px; font-size:12px; color:var(--text-tertiary);">Can't scan — the blind appears offline.</div>`;
                    if (typeof Toast !== 'undefined') Toast.error('Blind is offline — can\'t scan for networks');
                }
            };

            const handleWiFiChangeAck = (data) => {
                const body = modal.querySelector('#wifiModalBody');
                if (!body) return;

                const actionWrapper = modal.querySelector('.modal-actions');
                if (actionWrapper) actionWrapper.style.display = 'none';

                if (data.status === 'success') {
                    body.innerHTML = `
                        <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 40px 20px; gap: 20px; text-align: center;">
                            <div style="width: 60px; height: 60px; border-radius: 50%; background: rgba(16, 185, 129, 0.15); border: 2px solid #10b981; display: flex; align-items: center; justify-content: center; font-size: 32px; box-shadow: 0 0 20px rgba(16, 185, 129, 0.4); animation: scaleUp 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);">
                                ✓
                            </div>
                            <div style="display: flex; flex-direction: column; gap: 6px;">
                                <h4 style="font-size: 18px; font-weight: 800; color: var(--text-primary); margin: 0;">Wi-Fi Connected!</h4>
                                <span style="font-size: 13px; color: var(--text-secondary);">Blinds successfully moved to new network</span>
                            </div>
                            <div style="background: var(--bg-glass); border: 1px solid var(--border-glass); border-radius: var(--radius-md); padding: 8px 16px; font-size: 13px; font-weight: 600; color: var(--blind-accent); display: inline-flex; align-items: center; gap: 6px;">
                                🌐 ${escapeHtml(data.ssid || selectedSSID)}
                            </div>
                            <button id="closeWiFiSuccessBtn" class="save-btn on" style="width: 100%; border-radius: var(--radius-md); padding: 12px; font-weight: 700; border: none; cursor: pointer;">Close Settings</button>
                        </div>
                    `;
                    modal.querySelector('#closeWiFiSuccessBtn')?.addEventListener('click', () => {
                        close(); // Modal's own close — runs onClose cleanup
                    });
                    if (typeof Toast !== 'undefined') Toast.success('Wi-Fi credentials updated successfully!');
                } else {
                    body.innerHTML = `
                        <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 40px 20px; gap: 20px; text-align: center;">
                            <div style="width: 60px; height: 60px; border-radius: 50%; background: rgba(239, 68, 68, 0.15); border: 2px solid #ef4444; display: flex; align-items: center; justify-content: center; font-size: 32px; box-shadow: 0 0 20px rgba(239, 68, 68, 0.4); animation: scaleUp 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);">
                                ✗
                            </div>
                            <div style="display: flex; flex-direction: column; gap: 6px;">
                                <h4 style="font-size: 18px; font-weight: 800; color: var(--text-primary); margin: 0;">Connection Failed</h4>
                                <span style="font-size: 13px; color: var(--text-secondary);">SSID connection timed out or credentials invalid</span>
                            </div>
                            <p style="font-size: 12px; color: var(--text-tertiary); max-width: 280px; margin: 0; line-height: 1.4;">
                                Previous credentials have been <strong>safely restored</strong>. Blinds remain connected and online.
                            </p>
                            <button id="retryWiFiBtn" class="save-btn off" style="width: 100%; border-radius: var(--radius-md); padding: 12px; font-weight: 700; border: none; cursor: pointer;">Try Again</button>
                        </div>
                    `;
                    modal.querySelector('#retryWiFiBtn')?.addEventListener('click', () => {
                        close(); // Modal's own close — runs onClose cleanup
                        setTimeout(() => wifiCredentialsSetting.click(), 100);
                    });
                }
            };

            const applyWiFiCredentials = () => {
                const ssidInput = modal.querySelector('#wifiSSIDInput');
                const passInput = modal.querySelector('#wifiPasswordInput');
                const ssid = ssidInput?.value.trim() || '';
                // NEVER trim the password: WPA passphrases may legitimately begin
                // or end with spaces — trimming corrupted them and the change
                // failed with a misleading "check the password".
                const pass = passInput?.value || '';

                if (ssid.length === 0) {
                    if (typeof Toast !== 'undefined') Toast.error('Please enter or select a network SSID');
                    return;
                }
                // The 802.11 SSID limit (and the firmware buffer) is 32 BYTES.
                // maxlength counts UTF-16 characters, so a multi-byte (emoji/CJK)
                // SSID could pass the field limit yet truncate mid-character on
                // the device and never match the real network.
                if (new TextEncoder().encode(ssid).length > 32) {
                    if (typeof Toast !== 'undefined') Toast.error('Network name is too long (max 32 bytes)');
                    return;
                }
                if (pass.length > 0 && pass.length < 8) {
                    if (typeof Toast !== 'undefined') Toast.error('Wi-Fi Password must be at least 8 characters');
                    return;
                }

                if (typeof MQTTClient === 'undefined' || !MQTTClient.connected || !BlindState.isOnline) {
                    if (typeof Toast !== 'undefined') Toast.error('Blind must be online to change Wi-Fi');
                    return;
                }

                selectedSSID = ssid;

                const body = modal.querySelector('#wifiModalBody');
                if (body) {
                    body.innerHTML = `
                        <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 50px 20px; gap: 20px; text-align: center;">
                            <div class="loader-logo" style="width: 48px; height: 48px; color: var(--blind-accent); animation: spin 2s linear infinite;">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                                    <circle cx="12" cy="12" r="10"/>
                                    <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
                                </svg>
                            </div>
                            <div style="display: flex; flex-direction: column; gap: 6px;">
                                <span style="font-weight: 700; font-size: 16px; color: var(--text-primary);">Configuring Blinds Wi-Fi...</span>
                                <span style="font-size: 13px; color: var(--text-secondary);">SSID: ${escapeHtml(ssid)}</span>
                            </div>
                            <p style="font-size: 12px; color: var(--text-tertiary); max-width: 280px; margin: 0; line-height: 1.4;">
                                Blinds are switching networks. This can take up to 60 seconds while it reconnects. Previous Wi-Fi is safely restored if it fails.
                            </p>
                        </div>
                    `;
                }

                const actionWrapper = modal.querySelector('.modal-actions');
                if (actionWrapper) actionWrapper.style.display = 'none';

                awaitingWifiChange = true;
                wifiChangeStartTs = Date.now();
                const sent = MQTTClient.publishConfig(BlindState.deviceId, {
                    cmd: "change_wifi",
                    ssid: ssid,
                    pass: pass
                }, { queue: false, localFallback: false });
                if (!sent) {
                    awaitingWifiChange = false;
                    handleWiFiChangeAck({ status: 'failed' });
                    return;
                }

                // Fallback only — the firmware sends an explicit success/failed
                // ack for both outcomes, AND we accept the blind reappearing on
                // the broker as success (see onMqttMessage). Widened from 22s so a
                // slow WiFi+broker reconnect can't trip a false "failed" while the
                // device is actually coming back online ("ghost connection").
                wifiChangeTimeout = setTimeout(() => {
                    wifiChangeTimeout = null;
                    awaitingWifiChange = false;
                    handleWiFiChangeAck({ status: 'failed' });
                }, 60000);
            };

            // Runs on EVERY close path via Modal's onClose (action buttons, ✕,
            // backdrop, ESC, back button, swipe-dismiss). The previous manual
            // wiring only covered ✕ and backdrop clicks, so closing with Cancel
            // or ESC leaked the onMessage handler and the topic subscriptions —
            // one extra ghost handler per modal open for the rest of the session.
            const cleanup = () => {
                if (wifiChangeTimeout) {
                    clearTimeout(wifiChangeTimeout);
                    wifiChangeTimeout = null;
                }
                if (scanTimeout) {
                    clearTimeout(scanTimeout);
                    scanTimeout = null;
                }
                MQTTClient.off('onMessage', onMqttMessage);
                MQTTClient.off('onConnect', onModalReconnect);

                if (typeof MQTTClient !== 'undefined' && MQTTClient.connected) {
                    try {
                        // Only the modal-specific topics — state/availability are
                        // owned by the page's own subscription.
                        MQTTClient.client.unsubscribe(scanTopic);
                        MQTTClient.client.unsubscribe(ackTopic);
                    } catch (e) {}
                }
            };

            const { modal, close } = Modal.create({
                title: 'Wi-Fi Connection Settings',
                content: initialContent,
                onClose: cleanup,
                actions: [
                    { label: 'Cancel', primary: false },
                    {
                        label: 'Apply & Connect',
                        primary: true,
                        onClick: () => {
                            applyWiFiCredentials();
                            return false;
                        }
                    }
                ]
            });

            modal.querySelector('#scanWiFiBtn')?.addEventListener('click', () => {
                triggerScan();
            });

            modal.querySelector('#toggleWifiPasswordBtn')?.addEventListener('click', () => {
                const passInput = modal.querySelector('#wifiPasswordInput');
                const eyeIcon = modal.querySelector('#eyeIcon');
                if (passInput) {
                    const show = passInput.type === 'password';
                    passInput.type = show ? 'text' : 'password';
                    if (eyeIcon) {
                        eyeIcon.innerHTML = show ? `
                            <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/>
                            <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/>
                            <path d="M6.61 6.61A13.52 13.52 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/>
                            <line x1="2" x2="22" y1="2" y2="22"/>
                        ` : `
                            <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0z"/>
                            <circle cx="12" cy="12" r="3"/>
                        `;
                    }
                }
            });

            MQTTClient.on('onMessage', onMqttMessage);
        });
    }

    // Remove device
    document.getElementById('removeDeviceBtn')?.addEventListener('click', () => {
        if (typeof Modal === 'undefined') return;
        Modal.confirm(
            'Remove Device',
            'Are you sure you want to remove this blind device? This cannot be undone.',
            async () => {
                // Remove from local storage
                const updated = DeviceList.getAll().filter(d => d.id !== BlindState.deviceId);
                Storage.set(DeviceList.STORAGE_KEY, updated);

                // Purge every cached artifact (state, sync queues, Matter
                // pairing caches, IPs, logs) so a future re-add starts clean.
                purgeDeviceLocalState(BlindState.deviceId);

                // Stop listening to a device we no longer own.
                try {
                    if (typeof MQTTClient !== 'undefined' && MQTTClient.unsubscribeDevice) {
                        MQTTClient.unsubscribeDevice(BlindState.deviceId);
                    }
                } catch (e) {}

                // Remove from Firebase
                try {
                    if (typeof Auth !== 'undefined' && typeof DeviceService !== 'undefined') {
                        const user = Auth.getUser();
                        if (user) {
                            await DeviceService.init();
                            await DeviceService.removeDevice(window.activeHomeId, BlindState.deviceId);
                        }
                    }
                } catch (e) {
                    console.error('[Blind] Failed to remove from Firebase:', e);
                }

                window.location.href = 'index.html';
            }
        );
    });

    // Factory Reset Device
    document.getElementById('factoryResetBtn')?.addEventListener('click', () => {
        if (typeof Modal === 'undefined') return;
        Modal.confirm(
            'Factory Reset Device',
            'Are you absolutely sure you want to completely erase the device? This will wipe WiFi credentials, calibration data, and all settings. The device will reboot into Setup Mode. This cannot be undone.',
            async () => {
                if (typeof MQTTClient !== 'undefined' && BlindState.isOnline) {
                    MQTTClient.publishConfig(BlindState.deviceId, {
                        cmd: 'factory_reset'
                    });
                    if (typeof Toast !== 'undefined') Toast.success('Factory reset command sent. Device is rebooting...');

                    // The device just wiped its Matter fabric, Wi-Fi and config —
                    // the app's caches for it are now ALL stale. At minimum clear
                    // the pairing/sync caches (a cached "Paired" badge for an
                    // erased fabric is a lie); then let the user decide whether
                    // the app entry itself should go too.
                    try { localStorage.setItem(`matter-commissioned-${BlindState.deviceId}`, '0'); } catch (e) {}
                    try { localStorage.removeItem(`blind-cfgsync-${BlindState.deviceId}`); } catch (e) {}
                    try { localStorage.removeItem(`blind-pending-sync-${BlindState.deviceId}`); } catch (e) {}

                    setTimeout(() => {
                        Modal.create({
                            title: 'Remove From App Too?',
                            content: '<p style="color: var(--text-secondary); white-space: pre-line;">The device was erased and will reboot into Setup Mode.\n\nRemove it from the app as well? Keep it if you plan to set the same blind up again.</p>',
                            actions: [
                                {
                                    label: 'Keep in App', primary: false,
                                    onClick: () => {
                                        window.location.href = 'index.html';
                                        return true;
                                    }
                                },
                                {
                                    label: 'Remove', primary: true,
                                    onClick: () => {
                                        try {
                                            const updated = DeviceList.getAll().filter(d => d.id !== BlindState.deviceId);
                                            Storage.set(DeviceList.STORAGE_KEY, updated);
                                            purgeDeviceLocalState(BlindState.deviceId);
                                            if (typeof MQTTClient !== 'undefined' && MQTTClient.unsubscribeDevice) {
                                                MQTTClient.unsubscribeDevice(BlindState.deviceId);
                                            }
                                            if (typeof Auth !== 'undefined' && typeof DeviceService !== 'undefined' && Auth.getUser()) {
                                                DeviceService.init().then(() =>
                                                    DeviceService.removeDevice(window.activeHomeId, BlindState.deviceId)
                                                ).catch(e => console.error('[Blind] Firebase removal failed:', e));
                                            }
                                        } catch (e) {
                                            console.error('[Blind] Post-reset removal failed:', e);
                                        }
                                        window.location.href = 'index.html';
                                        return true;
                                    }
                                }
                            ]
                        });
                    }, 1200);
                } else {
                    if (typeof Toast !== 'undefined') Toast.error('Cannot reset device: Not connected via MQTT.');
                }
            }
        );
    });

    // Angle Calibration Settings
    ['angle_on', 'angle_off'].forEach(setting => {
        document.querySelector(`[data-setting="${setting}"]`)?.addEventListener('click', () => {
            if (typeof Modal === 'undefined') return;

            // Quick check if this is a stepper device
            let isStepper = false;
            try {
                const device = (typeof DeviceList !== 'undefined') ? DeviceList.get(BlindState.deviceId) : null;
                if (device && (device.type === 'stepper' || device.type === 'blind')) {
                    isStepper = true;
                }
            } catch (e) { }

            if (isStepper) {
                // Stepper devices use the dedicated Recalibrate Limits modal
                if (typeof Toast !== 'undefined') Toast.info('Use "Recalibrate Limits" to adjust stepper positions');
                return;
            }

            const currentVal = BlindState.config[setting] !== undefined ? BlindState.config[setting] : (setting === 'angle_on' ? 90 : 0);
            const title = setting === 'angle_on' ? 'Fully Open Angle' : 'Fully Closed Angle';

            const { modal, close } = Modal.create({
                title: title,
                content: `
                    <div class="modal-value-display" id="${setting}Display">${currentVal}°</div>
                    <input type="range" id="${setting}Input" min="0" max="180" value="${currentVal}"
                        style="width: 100%; height: 8px; border-radius: 4px; -webkit-appearance: none; background: var(--bg-tertiary); outline: none;"
                        class="blind-slider">
                    <p style="color: var(--text-tertiary); font-size: 13px; margin-top: 16px; text-align: center;">
                        Drag to adjust the servo angle between 0° and 180°.
                    </p>
                `,
                actions: [
                    { label: 'Cancel', primary: false },
                    {
                        label: 'Save', primary: true,
                        onClick: () => {
                            const input = modal.querySelector(`#${setting}Input`);
                            const val = parseInt(input.value, 10);
                            BlindState.config[setting] = val;
                            updateConfigUI();
                            saveDeviceState();
                            return true;
                        }
                    }
                ]
            });

            // Live update display
            const inputEl = modal.querySelector(`#${setting}Input`);
            const displayEl = modal.querySelector(`#${setting}Display`);
            if (inputEl && displayEl) {
                inputEl.addEventListener('input', (e) => {
                    displayEl.textContent = `${e.target.value}°`;
                    if (typeof Haptic !== 'undefined') Haptic.light();
                });
            }
        });
    });



    // Unify click elements on recalibrate triggers to trigger the wizard
    console.log('[Wizard] Registering recalibrate limits click event listeners.');
    const recalibrateLimitsBtn = document.getElementById('recalibrateLimitsBtn');
    if (recalibrateLimitsBtn) {
        recalibrateLimitsBtn.addEventListener('click', (e) => {
            console.log('[Wizard] recalibrateLimitsBtn clicked.');
            openLimitsCalibrationWizard();
        });
    }

    const recalibrateStepperItem = document.getElementById('recalibrateStepperSettingsItem');
    if (recalibrateStepperItem) {
        console.log('[Wizard] Found recalibrateStepperSettingsItem, adding click listener.');
        recalibrateStepperItem.addEventListener('click', (e) => {
            console.log('[Wizard] recalibrateStepperSettingsItem clicked.');
            openLimitsCalibrationWizard();
        });
    } else {
        console.warn('[Wizard] recalibrateStepperSettingsItem not found during registration.');
    }

    const warningCalibrateBtn = document.getElementById('warningCalibrateBtn');
    if (warningCalibrateBtn) {
        console.log('[Wizard] Found warningCalibrateBtn, adding click listener.');
        warningCalibrateBtn.addEventListener('click', (e) => {
            console.log('[Wizard] warningCalibrateBtn clicked.');
            openLimitsCalibrationWizard();
        });
    } else {
        console.warn('[Wizard] warningCalibrateBtn not found during registration.');
    }

    // ── Stepper preset-picker modals (shared) ──────────────────────────────
    // One parameterised picker replaces five near-identical modal handlers
    // (opening/closing speed, motor hold, drop-back, braking). Each setting only
    // supplies its presets, value formatter and labels — behaviour is unchanged.
    function showStepperPresetModal(opts) {
        if (typeof Modal === 'undefined') return;
        const cfgKey = opts.settingKey;
        const presets = opts.presets;
        const subFmt = opts.subFmt;            // (value) => text shown inside the (parens)
        const displayId = cfgKey + 'Display';
        const currentVal = BlindState.config[cfgKey] !== undefined ? BlindState.config[cfgKey] : opts.defaultValue;

        let closestPreset = presets[0];
        let minDiff = Math.abs(currentVal - presets[0].value);
        for (const p of presets) {
            const diff = Math.abs(currentVal - p.value);
            if (diff < minDiff) { minDiff = diff; closestPreset = p; }
        }
        let selectedValue = closestPreset.value;

        const gridStyleAttr = opts.gridStyle ? ` style="${opts.gridStyle}"` : '';
        const cardStyleExtra = opts.cardStyle ? opts.cardStyle + ' ' : '';
        const descStyleAttr = opts.descStyle ? ` style="${opts.descStyle}"` : '';

        const { modal } = Modal.create({
            title: opts.title,
            content: `
                <div style="text-align: center; margin-bottom: 16px;">
                    <span class="modal-value-display" id="${displayId}" style="display:inline-block; margin-bottom:0;">${closestPreset.label}</span>
                    <span style="font-size: 14px; color: var(--text-tertiary); margin-left: 4px; font-weight:600;">(${subFmt(closestPreset.value)})</span>
                </div>
                <div class="modal-choice-grid"${gridStyleAttr}>
                    ${presets.map(p => {
                        const isSelected = p.value === closestPreset.value;
                        const barsHTML = (opts.showBars && p.bars)
                            ? `<div class="modal-choice-speed-bars">${p.bars.map((h, idx) => `<span style="height: ${h}px; opacity: ${idx < p.activeBarsCount ? '1' : '0.25'};"></span>`).join('')}</div>`
                            : '';
                        return `
                            <div class="modal-choice-card ${isSelected ? 'selected' : ''}" data-value="${p.value}" style="${cardStyleExtra}--card-selected-gradient: ${p.gradient}; --card-selected-glow: ${p.glow};">
                                <div class="modal-choice-icon">${p.icon}</div>
                                <div class="modal-choice-name">${p.label}</div>
                                <div class="modal-choice-desc"${descStyleAttr}>${p.desc}</div>
                                ${barsHTML}
                            </div>
                        `;
                    }).join('')}
                </div>
                <p style="color: var(--text-tertiary); font-size: 13px; margin-top: 16px; text-align: center; line-height: 1.4;">
                    ${opts.descPara}
                </p>
            `,
            actions: [
                { label: 'Cancel', primary: false },
                {
                    label: 'Save', primary: true,
                    onClick: () => {
                        BlindState.config[cfgKey] = selectedValue;
                        updateConfigUI();
                        saveDeviceState();
                        if (typeof Toast !== 'undefined') {
                            const sel = presets.find(p => p.value === selectedValue);
                            Toast.success(`${opts.toastLabel} set to ${sel ? sel.label : subFmt(selectedValue)}`);
                        }
                        return true;
                    }
                }
            ]
        });

        const cards = modal.querySelectorAll('.modal-choice-card');
        cards.forEach(card => {
            card.addEventListener('click', () => {
                if (typeof Haptic !== 'undefined') Haptic.selection();
                cards.forEach(c => c.classList.remove('selected'));
                card.classList.add('selected');
                selectedValue = parseInt(card.dataset.value, 10);
                const matched = presets.find(p => p.value === selectedValue);
                if (matched) {
                    const displayEl = modal.querySelector('#' + displayId);
                    if (displayEl) {
                        displayEl.textContent = matched.label;
                        const subDisplay = displayEl.nextElementSibling;
                        if (subDisplay) subDisplay.textContent = `(${subFmt(matched.value)})`;
                    }
                }
            });
        });
    }

    // Opening & Closing speed share the same 4 presets (with the speed-bar viz).
    const STEPPER_SPEED_PRESETS = [
        { value: 1000, label: 'Quiet', desc: 'Silent & smooth operation', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.7 7.7a2.5 2.5 0 1 1 1.8 4.3H2"/><path d="M9.6 4.6A2 2 0 1 1 11 8H2"/><path d="M12.6 19.4A2 2 0 1 0 14 16H2"/></svg>', bars: [3, 3, 3, 3], activeBarsCount: 1, gradient: 'linear-gradient(135deg, #059669 0%, #10b981 100%)', glow: 'rgba(16, 185, 129, 0.35)' },
        { value: 2000, label: 'Default', desc: 'Balanced speed & sound', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/></svg>', bars: [3, 6, 3, 3], activeBarsCount: 2, gradient: 'linear-gradient(135deg, #2563eb 0%, #3b82f6 100%)', glow: 'rgba(59, 130, 246, 0.35)' },
        { value: 3600, label: 'Fast', desc: 'High-speed positioning', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 19 22 12 13 5 13 19"/><polygon points="2 19 11 12 2 5 2 19"/></svg>', bars: [3, 6, 9, 3], activeBarsCount: 3, gradient: 'linear-gradient(135deg, #d97706 0%, #f59e0b 100%)', glow: 'rgba(245, 158, 11, 0.35)' },
        { value: 5000, label: 'Max Speed', desc: 'Maximum physical velocity', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>', bars: [3, 6, 9, 12], activeBarsCount: 4, gradient: 'linear-gradient(135deg, #7c3aed 0%, #ec4899 100%)', glow: 'rgba(124, 58, 237, 0.4)' }
    ];

    // Stepper Opening Speed Setting
    document.querySelector('[data-setting="stepperOpenSpeed"]')?.addEventListener('click', () => showStepperPresetModal({
        settingKey: 'stepperOpenSpeed', defaultValue: 2000, title: 'Opening Speed', toastLabel: 'Opening speed',
        showBars: true, subFmt: v => `${v} steps/s`, presets: STEPPER_SPEED_PRESETS,
        descPara: 'Fine-tune physical stepper opening velocity. Lower values run whisper-quiet, higher values complete movement instantly.'
    }));

    // Stepper Closing Speed Setting
    document.querySelector('[data-setting="stepperCloseSpeed"]')?.addEventListener('click', () => showStepperPresetModal({
        settingKey: 'stepperCloseSpeed', defaultValue: 2000, title: 'Closing Speed', toastLabel: 'Closing speed',
        showBars: true, subFmt: v => `${v} steps/s`, presets: STEPPER_SPEED_PRESETS,
        descPara: 'Fine-tune physical stepper closing velocity. Lower values run whisper-quiet, higher values complete movement instantly.'
    }));

    // Motor Hold Time (Stop Delay) Setting
    document.querySelector('[data-setting="stepperStopDelay"]')?.addEventListener('click', () => showStepperPresetModal({
        settingKey: 'stepperStopDelay', defaultValue: 3000, title: 'Motor Hold Time', toastLabel: 'Motor hold time',
        subFmt: v => `${(v / 1000).toFixed(1)}s`,
        gridStyle: 'grid-template-columns: repeat(auto-fit, minmax(80px, 1fr));',
        cardStyle: 'padding: 12px 6px;', descStyle: 'font-size: 10px; opacity: 0.75;',
        descPara: 'Configure how long the stepper motor stays energized to lock the blinds position in place after reaching the target.',
        presets: [
            { value: 500, label: 'Eco', desc: 'Releases instantly, saves power', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"/><path d="M2 21c0-3 1.85-5.36 5.08-6"/></svg>', gradient: 'linear-gradient(135deg, #0891b2 0%, #06b6d4 100%)', glow: 'rgba(6, 182, 212, 0.35)' },
            { value: 3000, label: 'Standard', desc: 'Holds to prevent drift', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="10" x2="14" y1="2" y2="2"/><line x1="12" x2="15" y1="14" y2="11"/><circle cx="12" cy="14" r="8"/></svg>', gradient: 'linear-gradient(135deg, #4f46e5 0%, #6366f1 100%)', glow: 'rgba(99, 102, 241, 0.35)' },
            { value: 10000, label: 'Continuous', desc: 'Extended lock after move', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>', gradient: 'linear-gradient(135deg, #db2777 0%, #ec4899 100%)', glow: 'rgba(236, 72, 153, 0.4)' }
        ]
    }));

    // Drop-Back Distance (Relax Steps) Setting
    document.querySelector('[data-setting="stepperRelaxSteps"]')?.addEventListener('click', () => showStepperPresetModal({
        settingKey: 'stepperRelaxSteps', defaultValue: 128, title: 'Drop-Back Distance', toastLabel: 'Drop-back distance',
        subFmt: v => `${v === 0 ? 'Disabled' : v + ' steps'}`,
        descPara: 'Reverses the motor slightly after opening to relieve continuous stress/cable tension on your brackets.',
        presets: [
            { value: 0, label: 'Tight', desc: 'No relax, keeps tension', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/></svg>', gradient: 'linear-gradient(135deg, #dc2626 0%, #ef4444 100%)', glow: 'rgba(239, 68, 68, 0.35)' },
            { value: 64, label: 'Short', desc: 'Minimal cord relief', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 8 22 12 18 16"/><polyline points="6 8 2 12 6 16"/><line x1="2" x2="22" y1="12" y2="12"/></svg>', gradient: 'linear-gradient(135deg, #4b5563 0%, #6b7280 100%)', glow: 'rgba(107, 114, 128, 0.35)' },
            { value: 128, label: 'Medium', desc: 'Standard optimal relief', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/></svg>', gradient: 'linear-gradient(135deg, #2563eb 0%, #3b82f6 100%)', glow: 'rgba(59, 130, 246, 0.35)' },
            { value: 256, label: 'Long', desc: 'Maximum cord relaxation', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>', gradient: 'linear-gradient(135deg, #7c3aed 0%, #8b5cf6 100%)', glow: 'rgba(139, 92, 246, 0.4)' }
        ]
    }));

    // Braking Speed (Acceleration) Setting
    document.querySelector('[data-setting="stepperAcceleration"]')?.addEventListener('click', () => showStepperPresetModal({
        settingKey: 'stepperAcceleration', defaultValue: 2000, title: 'Braking Speed', toastLabel: 'Braking speed',
        subFmt: v => `${v} steps/s²`,
        descPara: 'Configure the motor acceleration and deceleration ramps. Higher values yield immediate physical brakes, lower values gently slow down.',
        presets: [
            { value: 1000, label: 'Gentle', desc: 'Softest start & stop', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>', gradient: 'linear-gradient(135deg, #0891b2 0%, #06b6d4 100%)', glow: 'rgba(6, 182, 212, 0.35)' },
            { value: 2000, label: 'Moderate', desc: 'Standard controlled ramp', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/></svg>', gradient: 'linear-gradient(135deg, #2563eb 0%, #3b82f6 100%)', glow: 'rgba(59, 130, 246, 0.35)' },
            { value: 4000, label: 'Sport', desc: 'Aggressive & rapid braking', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>', gradient: 'linear-gradient(135deg, #ea580c 0%, #f97316 100%)', glow: 'rgba(249, 115, 22, 0.35)' },
            { value: 8000, label: 'Instant', desc: 'Immediate stop response', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>', gradient: 'linear-gradient(135deg, #be185d 0%, #db2777 100%)', glow: 'rgba(219, 39, 119, 0.4)' }
        ]
    }));

    // Linked Zaylo Lumibot setting
    document.getElementById('linkedSwitchSetting')?.addEventListener('click', showLinkedDevicePicker);
    document.getElementById('linkedDeviceCard')?.addEventListener('click', showLinkedDevicePicker);

    // TWT Setting Row click for popup diagnostic suite
    document.getElementById('twtSetting')?.addEventListener('click', (e) => {
        if (e.target.closest('#twtEnabled') || e.target.closest('.toggle')) {
            // Let the toggle switch handle its own event
            return;
        }
        showTwtDiagnosticModal();
    });

    // TWT Enabled Change listener
    document.getElementById('twtEnabled')?.addEventListener('change', (e) => {
        BlindState.config.twtEnabled = e.target.checked;
        saveDeviceState();
    });

    // Idle Hold (Anti-Droop) toggle. Keeps the stepper energized at rest so the
    // blind can't back-drive/slip down on non-self-locking mechanisms — the
    // user-facing fix for the "creeps down a little by itself" symptom. Off by
    // default (the TMC2209 runs in standalone mode and would heat up if held
    // permanently), so this is an explicit opt-in.
    const idleHoldSublabel = document.getElementById('stepperIdleHoldSublabel');
    document.getElementById('stepperIdleHold')?.addEventListener('change', (e) => {
        BlindState.config.stepperIdleHold = e.target.checked;
        if (idleHoldSublabel) {
            idleHoldSublabel.textContent = e.target.checked
                ? 'On — motor stays energized at rest (uses a little more power)'
                : "Keep the motor energized at rest so the blind can't slip down";
        }
        saveDeviceState();
        if (typeof Toast !== 'undefined') {
            Toast.success(e.target.checked ? 'Anti-droop hold enabled' : 'Anti-droop hold disabled');
        }
    });

function showTwtDiagnosticModal() {
    if (typeof Modal === 'undefined') return;

    const { modal, close } = Modal.create({
        title: 'TWT Compatibility Test',
        content: `
            <div style="text-align: center; margin-bottom: 8px;">
                <p style="color: var(--text-secondary); font-size: 13px; line-height: 1.4;">
                    Verify if your Wi-Fi router and device hardware support <strong>Target Wake Time (TWT)</strong>.
                </p>
            </div>

            <!-- Radar Scanner Loader -->
            <div class="twt-radar-loader" id="twtRadarContainer">
                <div class="twt-radar-wave"></div>
                <div class="twt-radar-wave"></div>
                <div class="twt-radar-wave"></div>
                <span style="font-size: 36px; z-index: 10; filter: drop-shadow(0 0 10px var(--blind-accent-glow));">📡</span>
            </div>

            <!-- Progress Checklist -->
            <div class="twt-diag-checklist">
                <div class="twt-diag-item pending" id="twtItem1">
                    <div class="twt-diag-item-ico" id="twtItemIco1">⏳</div>
                    <div class="twt-diag-item-lbl">Device Wi-Fi 6 (802.11ax) radio</div>
                </div>
                <div class="twt-diag-item pending" id="twtItem2">
                    <div class="twt-diag-item-ico" id="twtItemIco2">⏳</div>
                    <div class="twt-diag-item-lbl">Router Wi-Fi 6 (802.11ax) support</div>
                </div>
                <div class="twt-diag-item pending" id="twtItem3">
                    <div class="twt-diag-item-ico" id="twtItemIco3">⏳</div>
                    <div class="twt-diag-item-lbl">Target Wake Time agreement accepted</div>
                </div>
                <div class="twt-diag-item pending" id="twtItem4">
                    <div class="twt-diag-item-ico" id="twtItemIco4">⏳</div>
                    <div class="twt-diag-item-lbl">Signal strength for sleep cycles</div>
                </div>
            </div>

            <!-- Retro Console Logger -->
            <div class="twt-diag-console" id="twtConsole">
                <div class="twt-diag-line info">[SYSTEM] Diagnostics system ready. Click "Begin Compatibility Test" to start.</div>
            </div>

            <!-- Battery Projections Chart (Updated to Radio Airtime Overhead) -->
            <div class="twt-battery-comparison" id="twtBatteryChart" style="display: none; opacity: 0; transform: translateY(10px); transition: all 0.5s ease;">
                <div style="font-size: 13px; font-weight: 700; color: var(--text-primary); margin-bottom: 6px; text-align: center;">Wi-Fi Radio Airtime Congestion</div>
                <div class="twt-battery-row">
                    <div class="twt-battery-row-lbl">
                        <span>Without TWT (Constant Radio Polling)</span>
                        <span style="font-weight:700; color:#ef4444;" id="lblStandardDays">98% Active Overhead</span>
                    </div>
                    <div class="twt-battery-progress-bg">
                        <div class="twt-battery-progress-fill standard" id="twtBatteryStandard" style="width: 0%;"></div>
                    </div>
                </div>
                <div class="twt-battery-row">
                    <div class="twt-battery-row-lbl">
                        <span>With TWT Active (Wi-Fi 6 Coexistence)</span>
                        <span style="font-weight:700; color:#10b981;" id="lblTwtDays">1.5% Overhead</span>
                    </div>
                    <div class="twt-battery-progress-bg">
                        <div class="twt-battery-progress-fill twt" id="twtBatteryTwt" style="width: 0%;"></div>
                    </div>
                </div>
            </div>

            <button id="twtStartTestBtn" style="
                width: 100%; margin-top: 16px; background: var(--blind-accent-gradient);
                border: none; color: white; font-weight: 700; height: 44px;
                border-radius: 12px; cursor: pointer; display: flex;
                align-items: center; justify-content: center; gap: 8px;
                font-family: var(--font-family); transition: all 0.3s ease;
                box-shadow: 0 4px 12px var(--blind-accent-glow);
            ">Begin Compatibility Test</button>
        `,
        actions: [
            { label: 'Close', primary: false }
        ]
    });

    const startBtn = modal.querySelector('#twtStartTestBtn');
    const consoleEl = modal.querySelector('#twtConsole');
    const radarContainer = modal.querySelector('#twtRadarContainer');
    
    // Stop the default radar waves until test starts
    const radarWaves = radarContainer.querySelectorAll('.twt-radar-wave');
    radarWaves.forEach(w => w.style.animationPlayState = 'paused');

    const log = (text, type = '') => {
        const line = document.createElement('div');
        line.className = `twt-diag-line ${type}`;
        const time = new Date().toLocaleTimeString([], { hour12: false });
        line.textContent = `[${time}] ${text}`;
        consoleEl.appendChild(line);
        consoleEl.scrollTop = consoleEl.scrollHeight;
    };

    // ── REAL compatibility test ───────────────────────────────────────────────
    // Every verdict below is driven by the blind's ACTUAL reported radio state —
    // `wifi6` (did the router associate us in 802.11ax?) and `twtActive` (did the
    // router accept the TWT agreement?) — both freshly published by the firmware.
    // This matches the device-page TWT widget exactly, so the test can no longer
    // claim "100% compatible" while the widget says the router declined TWT.
    const setItem = (n, state, icon) => {
        const item = modal.querySelector('#twtItem' + n);
        const ico = modal.querySelector('#twtItemIco' + n);
        if (item) item.className = 'twt-diag-item ' + state;
        if (ico) ico.textContent = icon;
    };
    const resetItems = () => { [1, 2, 3, 4].forEach(n => setItem(n, 'pending', '⏳')); };

    // The blind must be online AND actually reporting telemetry for a live test.
    const deviceOnline = () => {
        if (typeof MQTTClient === 'undefined' || !MQTTClient.connected) return false;
        const st = MQTTClient.getDeviceState(BlindState.deviceId);
        return !!st && st._online !== false &&
               (st.position !== undefined || st.blindPosition !== undefined);
    };
    const liveState = () => (typeof MQTTClient !== 'undefined'
        ? (MQTTClient.getDeviceState(BlindState.deviceId) || {}) : {});
    const waitFor = (predicate, timeoutMs) => new Promise(resolve => {
        const start = Date.now();
        const tick = () => {
            if (predicate()) return resolve(true);
            if (Date.now() - start >= timeoutMs) return resolve(false);
            setTimeout(tick, 350);
        };
        tick();
    });

    const finish = ({ text, color, glow, toast, toastType, showBattery }) => {
        radarWaves.forEach(w => w.style.animationPlayState = 'paused');
        if (showBattery) {
            const chart = modal.querySelector('#twtBatteryChart');
            if (chart) {
                chart.style.display = 'block';
                setTimeout(() => {
                    chart.style.opacity = '1';
                    chart.style.transform = 'translateY(0)';
                    const s = modal.querySelector('#twtBatteryStandard');
                    const t = modal.querySelector('#twtBatteryTwt');
                    if (s) s.style.width = '98%';
                    if (t) t.style.width = '2%';
                }, 50);
            }
        }
        // Keep the settings widget and saved state in lock-step with the verdict.
        saveDeviceState(null, true);
        updateConfigUI();
        if (typeof updateTwtStatusLabel === 'function') updateTwtStatusLabel();
        startBtn.disabled = false;
        startBtn.style.opacity = '1';
        startBtn.style.cursor = 'pointer';
        startBtn.style.background = color || 'var(--blind-accent-gradient)';
        if (glow) startBtn.style.boxShadow = glow;
        startBtn.textContent = text;
        if (typeof Toast !== 'undefined' && toast) Toast[toastType || 'info'](toast);
    };

    if (startBtn) {
        startBtn.addEventListener('click', async () => {
            if (typeof Haptic !== 'undefined') Haptic.selection();
            startBtn.disabled = true;
            startBtn.style.opacity = '0.7';
            startBtn.style.cursor = 'not-allowed';
            startBtn.textContent = 'Running Compatibility Test...';
            startBtn.style.background = 'var(--blind-accent-gradient)';
            resetItems();
            radarWaves.forEach(w => w.style.animationPlayState = 'running');

            log('Starting live Wi-Fi 6 / TWT compatibility test…', 'info');

            // 0) Must be online to read the radio's real state.
            if (!deviceOnline()) {
                log('Blind is offline — cannot read live Wi-Fi 6 / TWT state.', 'error');
                [1, 2, 3, 4].forEach(n => setItem(n, 'failed', '❌'));
                finish({ text: 'Blind Offline — Try Again', color: 'linear-gradient(90deg,#6b7280,#4b5563)',
                         toast: 'Blind is offline — connect it first, then re-run the test', toastType: 'error' });
                return;
            }

            // 1) Device hardware — the ESP32-C6 is natively 802.11ax (Wi-Fi 6).
            setItem(1, 'running', '🌀');
            log("Querying the blind's Wi-Fi radio…", 'info');
            await new Promise(r => setTimeout(r, 500));
            setItem(1, 'success', '✅');
            log('ESP32-C6 transceiver: native 802.11ax (Wi-Fi 6) — supported.', 'success');
            if (typeof Haptic !== 'undefined') Haptic.light();

            // Ask the device to (re)attempt TWT and report fresh state.
            if (typeof MQTTClient !== 'undefined' && MQTTClient.connected) {
                BlindState.config.twtEnabled = true;
                saveDeviceState();
                pushFullConfigNow();
                MQTTClient.publishControl(BlindState.deviceId, { command: 'getState' });
            }

            // 2) Is the ROUTER Wi-Fi 6? Wait for a fresh report carrying `wifi6`.
            setItem(2, 'running', '🌀');
            log('Checking whether your router associated the blind in 802.11ax…', 'info');
            await waitFor(() => BlindState.config.wifi6 !== undefined, 4500);
            const wifi6 = BlindState.config.wifi6;
            const ssid = BlindState.ssid || liveState().ssid || '';
            const ssidTxt = ssid ? ` “${ssid}”` : '';

            if (wifi6 === undefined) {
                // Old firmware / no report — be honest rather than fake a pass.
                setItem(2, 'warning', '⚠️');
                setItem(3, 'pending', '—');
                setItem(4, 'pending', '—');
                log("Couldn't read the router's Wi-Fi 6 capability from the blind.", 'warn');
                log('Update the blind firmware to enable the live TWT test.', 'warn');
                finish({ text: 'Could Not Verify', color: 'linear-gradient(90deg,#f59e0b,#d97706)',
                         toast: "Couldn't read live Wi-Fi 6 state from the blind", toastType: 'info' });
                return;
            }
            if (!wifi6) {
                setItem(2, 'failed', '❌');
                setItem(3, 'failed', '❌');
                setItem(4, 'pending', '—');
                log(`Router${ssidTxt} is NOT Wi-Fi 6 (802.11ax) — TWT is not possible here.`, 'error');
                // Not Wi-Fi 6 → TWT can never run, so turn the preference back OFF so
                // the toggle doesn't imply a power saving that can't happen (matches
                // the setup wizard's behaviour).
                BlindState.config.twtEnabled = false;
                BlindState.config.twtActive = false;
                saveDeviceState();
                pushFullConfigNow();
                if (typeof Haptic !== 'undefined') Haptic.notification('warning');
                finish({ text: 'Not Compatible — Router isn’t Wi-Fi 6', color: 'linear-gradient(90deg,#ef4444,#dc2626)',
                         toast: `Your network${ssidTxt} isn’t Wi-Fi 6, so TWT can’t run`, toastType: 'error' });
                return;
            }
            setItem(2, 'success', '✅');
            log(`Router${ssidTxt} is Wi-Fi 6 (802.11ax). ✓`, 'success');
            if (typeof Haptic !== 'undefined') Haptic.light();

            // 3) Did the router ACCEPT the TWT agreement? (the real outcome)
            setItem(3, 'running', '🌀');
            log('Negotiating Target Wake Time with the router…', 'info');
            const accepted = await waitFor(() => BlindState.config.twtActive === true, 9000);
            if (accepted) {
                setItem(3, 'success', '✅');
                log('Router ACCEPTED the TWT agreement — power saving is live. ✓', 'success');
            } else {
                setItem(3, 'failed', '❌');
                log('Router is Wi-Fi 6 but DECLINED the TWT agreement.', 'error');
                log('Tip: enable “Target Wake Time / TWT” in your router’s Wi-Fi 6 settings, then re-run.', 'info');
            }

            // 4) Signal quality (informational — doesn't block compatibility).
            setItem(4, 'running', '🌀');
            const rssi = (BlindState.rssi !== undefined) ? BlindState.rssi : liveState().rssi;
            await new Promise(r => setTimeout(r, 400));
            if (rssi === undefined || rssi === null) {
                setItem(4, 'warning', '⚠️');
                log('Signal strength unavailable.', 'warn');
            } else if (rssi >= -70) {
                setItem(4, 'success', '✅');
                log(`Signal strength ${rssi} dBm — strong, ideal for TWT sleep cycles.`, 'success');
            } else {
                setItem(4, 'warning', '⚠️');
                log(`Signal strength ${rssi} dBm — weak; TWT sleep may see occasional wake retries.`, 'warn');
            }

            if (accepted) {
                log('Result: COMPATIBLE — TWT power saving is active. ✓', 'success');
                if (typeof Haptic !== 'undefined') Haptic.notification('success');
                finish({ text: 'Compatible — TWT Active!', color: 'linear-gradient(90deg,#10b981,#059669)',
                         glow: '0 4px 12px rgba(16,185,129,0.3)', showBattery: true,
                         toast: 'Compatible! TWT power saving is active.', toastType: 'success' });
            } else {
                log('Result: Wi-Fi 6 router, but TWT was declined — no power saving.', 'warn');
                if (typeof Haptic !== 'undefined') Haptic.notification('warning');
                finish({ text: 'Router Declined TWT', color: 'linear-gradient(90deg,#f59e0b,#d97706)',
                         toast: 'Your Wi-Fi 6 router declined TWT — no power saving', toastType: 'info' });
            }
        });
    }
}

    // Copy Matter manual code to clipboard
    document.getElementById('copyMatterCodeBtn')?.addEventListener('click', () => {
        const codeEl = document.getElementById('matterManualCode');
        if (codeEl) {
            const rawCode = codeEl.textContent.replace(/-/g, '');
            navigator.clipboard.writeText(rawCode).then(() => {
                if (typeof Toast !== 'undefined') Toast.success('Setup code copied!');
            }).catch(() => {
                if (typeof Toast !== 'undefined') Toast.error('Failed to copy');
            });
        }
        if (typeof Haptic !== 'undefined') Haptic.light();
    });

    // Reset Matter pairing credentials
    document.getElementById('resetMatterBtn')?.addEventListener('click', () => {
        const confirmReset = window.confirm("Are you sure you want to reset Matter pairing? This will disconnect the device from Apple/Google Home and reboot it.");
        if (confirmReset) {
            if (typeof MQTTClient !== 'undefined' && MQTTClient.connected) {
                MQTTClient.publishControl(BlindState.deviceId, { command: 'resetMatter' });
                if (typeof Toast !== 'undefined') Toast.success('Reset command sent. Rebooting device...');
            } else {
                if (typeof Toast !== 'undefined') Toast.error('Device offline or MQTT disconnected');
            }
        }
        if (typeof Haptic !== 'undefined') Haptic.medium();
    });

    // Add another smart home multi-admin pairing
    document.getElementById('addSmartHomeBtn')?.addEventListener('click', () => {
        if (typeof MQTTClient !== 'undefined' && MQTTClient.connected) {
            MQTTClient.publishControl(BlindState.deviceId, { command: 'openCommissioning' });
            if (typeof Toast !== 'undefined') Toast.success('Opening Matter pairing window...');
        } else {
            if (typeof Toast !== 'undefined') Toast.error('Device offline or MQTT disconnected');
        }
        if (typeof Haptic !== 'undefined') Haptic.medium();
    });
}

function showLinkedDevicePicker() {
    if (typeof Modal === 'undefined') return;

    const devices = (typeof DeviceList !== 'undefined') ? DeviceList.getAll() : [];
    // Filter out blinds/steppers, keeping Zaylo Lumibots (which may be saved as 'servo' or 'lumibot')
    const zayloLumibots = devices.filter(d => ['stepper', 'blind'].indexOf(d.type) === -1);

    if (zayloLumibots.length === 0) {
        if (typeof Toast !== 'undefined') Toast.info('no Zaylo Lumibot devices found');
        return;
    }

    const options = zayloLumibots.map(d => `
        <button class="link-option" data-device-id="${d.id}" style="
            display: flex; align-items: center; gap: 14px;
            padding: 14px 18px; width: 100%;
            background: ${d.id === BlindState.linkedDeviceId ? 'var(--blind-accent-gradient-subtle)' : 'var(--bg-glass)'};
            border: 1.5px solid ${d.id === BlindState.linkedDeviceId ? 'var(--blind-accent)' : 'var(--border-glass)'};
            border-radius: 14px; color: var(--text-primary);
            font-family: var(--font-family); cursor: pointer;
            transition: all 0.2s ease; margin-bottom: 8px;
        ">
            <span style="font-size: 24px;"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-lightbulb"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.9 1.2 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg></span>
            <div style="text-align: left;">
                <div style="font-weight: 700;">${escapeHtml(d.name || 'Zaylo-' + d.id)}</div>
                <div style="font-size: 12px; color: var(--text-tertiary);">ID: ${d.id}</div>
            </div>
            ${d.id === BlindState.linkedDeviceId ? '<span style="margin-left:auto; color: var(--blind-accent);">✓</span>' : ''}
        </button>
    `).join('');

    const { modal, close } = Modal.create({
        title: 'Link Zaylo Lumibot',
        content: `
            <p style="color: var(--text-secondary); margin-bottom: 16px;">
                Select a Zaylo Lumibot for presence detection via radar
            </p>
            <div>${options}</div>
            <button class="link-option" id="unlinkBtn" style="
                display: flex; align-items: center; gap: 14px;
                padding: 14px 18px; width: 100%;
                background: rgba(239, 68, 68, 0.06);
                border: 1.5px solid rgba(239, 68, 68, 0.2);
                border-radius: 14px; color: var(--danger);
                font-family: var(--font-family); cursor: pointer;
                font-weight: 600;
            ">Unlink Device</button>
                    `,
        actions: []
    });

    // Attach listeners
    modal.querySelectorAll('.link-option[data-device-id]').forEach(btn => {
        btn.addEventListener('click', () => {
            if (typeof MQTTClient !== 'undefined' && BlindState.linkedDeviceId) {
                if (MQTTClient.unsubscribeDevice) MQTTClient.unsubscribeDevice(BlindState.linkedDeviceId);
            }
            BlindState.linkedDeviceId = btn.dataset.deviceId;
            if (typeof MQTTClient !== 'undefined' && MQTTClient.connected) {
                MQTTClient.subscribeDevice(BlindState.linkedDeviceId);
            }
            updateLinkedDevice();
            saveDeviceState();
            close();
            if (typeof Toast !== 'undefined') Toast.success('Device linked');
        });
    });

    modal.querySelector('#unlinkBtn')?.addEventListener('click', () => {
        if (typeof MQTTClient !== 'undefined' && BlindState.linkedDeviceId) {
            if (MQTTClient.unsubscribeDevice) MQTTClient.unsubscribeDevice(BlindState.linkedDeviceId);
        }
        BlindState.linkedDeviceId = null;
        updateLinkedDevice();
        saveDeviceState();
        close();
        if (typeof Toast !== 'undefined') Toast.info('Device unlinked');
    });
}

function updateLinkedDevice() {
    const nameEl = document.getElementById('linkedDeviceName');
    const statusEl = document.getElementById('linkedDeviceStatus');
    const badgeEl = document.getElementById('linkedDeviceBadge');
    const settingValue = document.getElementById('linkedSwitchValue');

    if (BlindState.linkedDeviceId) {
        const linked = (typeof DeviceList !== 'undefined') ? DeviceList.get(BlindState.linkedDeviceId) : null;
        const name = linked?.name || `Zaylo - ${BlindState.linkedDeviceId}`;

        if (nameEl) nameEl.textContent = name;
        if (statusEl) statusEl.textContent = 'Radar presence detection active';
        if (badgeEl) { badgeEl.style.display = ''; badgeEl.textContent = 'Connected'; }
        if (settingValue) settingValue.textContent = name;
    } else {
        if (nameEl) nameEl.textContent = 'No device linked';
        if (statusEl) statusEl.textContent = 'Tap to link a Zaylo Lumibot for presence detection';
        if (badgeEl) badgeEl.style.display = 'none';
        if (settingValue) settingValue.textContent = 'None';
    }
}

// ============================================
// UI Update — Master Render
// ============================================
function updateUI() {
    // Revert pos back to targetPosition to stop UI toggle flickering
    // The visual state should reflect what the user set instantly,
    // while the animation organically catches up.
    const pos = BlindState.targetPosition;
    const targetPos = BlindState.targetPosition;
    const pendingIntent = refreshPendingIntentFromCache();

    // Animated position counter (starts loop)
    animatePositionLabel();

    // Sublabel (follows target position for immediate feedback)
    const sublabel = document.getElementById('positionSublabel');
    if (sublabel) {
        if (pendingIntent && BlindState.isMoving !== true) sublabel.textContent = `Queued to ${pendingIntent.target}%`;
        else if (pos === 0) sublabel.textContent = 'Closed';
        else if (pos === 100) sublabel.textContent = 'Fully Open';
        else if (pos <= 25) sublabel.textContent = 'Slightly Open';
        else if (pos <= 50) sublabel.textContent = 'Half Open';
        else if (pos <= 75) sublabel.textContent = 'Mostly Open';
        else sublabel.textContent = 'Almost Open';
    }

    // Slider (represents TARGET position)
    // Only update if not currently dragging to avoid fighting the user
    if (!BlindState.isDragging) {
        const slider = document.getElementById('positionSlider');
        if (slider && slider.value != targetPos) slider.value = targetPos;
        updateSliderGradient(targetPos);

        const sliderVal = document.getElementById('sliderValue');
        if (sliderVal) sliderVal.textContent = `${targetPos}% `;
    }

    // Visualization (follows real position with continuous smooth interpolation)
    animateVisualization();

    // Buttons (follow TARGET position to be instantly responsive)
    const openBtn = document.getElementById('openBtn');
    const closeBtn = document.getElementById('closeBtn');
    if (openBtn) openBtn.classList.toggle('active', targetPos === 100);
    if (closeBtn) closeBtn.classList.toggle('active', targetPos === 0);

    updatePresetActive(targetPos);
    updateActiveRulesCount();
}

// ============================================
// Persistence
// ============================================
function loadDeviceState() {
    const key = `blind-state-${BlindState.deviceId}`;
    try {
        const item = localStorage.getItem(key);
        if (!item) return false;
        const saved = JSON.parse(item);
        if (!saved || Object.keys(saved).length === 0) return false;

        if (saved.blindType && BLIND_TYPES.includes(saved.blindType)) BlindState.blindType = saved.blindType;
        if (saved.position !== undefined) BlindState.position = saved.position;
        // Only adopt a pending (unconfirmed) target if it's recent enough to
        // still be deliverable — matches BlindSync's POSITION_EXPIRY_MS (5 min).
        // A pending target without a timestamp can't be aged, so treat it as
        // stale and fall back to the last confirmed target.
        const pendingFresh = saved.pendingTargetPosition !== undefined &&
            saved.pendingCommandTs &&
            (Date.now() - Number(saved.pendingCommandTs)) < 5 * 60 * 1000;
        if (pendingFresh) {
            BlindState.pendingTargetPosition = Math.max(0, Math.min(100, Number(saved.pendingTargetPosition)));
            BlindState.pendingCommandStatus = saved.lastCommandStatus || 'pending';
            BlindState.pendingCommandTs = Number(saved.pendingCommandTs);
        }
        if (saved.targetPosition !== undefined) BlindState.targetPosition = saved.targetPosition;
        else BlindState.targetPosition = BlindState.position;
        BlindState._displayPos = BlindState.position;
        BlindState._visualPos = BlindState.position;
        BlindState._visualTargetPos = BlindState.position;
        if (saved.isOpen !== undefined) BlindState.isOpen = saved.isOpen;
        if (saved.isCalibrated === false || saved.calibrationRequired === true) BlindState.isCalibrated = false;
        if (saved.linkedDeviceId !== undefined) BlindState.linkedDeviceId = saved.linkedDeviceId;
        if (saved.calibration) Object.assign(BlindState.calibration, saved.calibration);
        if (saved.rules) {
            Object.assign(BlindState.rules, saved.rules);
            // Locally-saved rules exist → they came from the wizard, a user
            // toggle, or a previous device echo. They are explicit.
            BlindState._rulesProvisional = false;
        }
        if (saved.config) {
            Object.assign(BlindState.config, saved.config);
            // Migrate old single stepperSpeed to new open/close speeds
            if (saved.config.stepperSpeed !== undefined && saved.config.stepperOpenSpeed === undefined) {
                BlindState.config.stepperOpenSpeed = saved.config.stepperSpeed;
                BlindState.config.stepperCloseSpeed = saved.config.stepperSpeed;
            }
        }

        // Restore toggle states from saved rules
        Object.entries(BlindState.rules).forEach(([rule, enabled]) => {
            const toggle = document.querySelector(`[data-rule-toggle="${rule}"]`);
            if (toggle) {
                toggle.checked = enabled;
                const card = toggle.closest('.smart-rule-card');
                if (card) card.classList.toggle('active-rule', enabled);
            }
        });

        // Restore linked device UI
        updateLinkedDevice();

        // Restore device name
        const device = (typeof DeviceList !== 'undefined') ? DeviceList.get(BlindState.deviceId) : null;
        if (device) {
            const title = document.getElementById('deviceTitle');
            const nameVal = document.getElementById('deviceNameValue');
            const name = device.name || 'Smart Blinds';
            if (title) title.textContent = name;
            if (nameVal) nameVal.textContent = name;
        }

        updateConfigUI();
        return true;
    } catch (e) {
        console.error('[Blind] Failed to load state:', e);
        return false;
    }
}

// Reflect the REAL Target Wake Time status, not just the config flag. The
// firmware reports `twtActive` (whether the router actually accepted the TWT
// agreement) alongside `twtEnabled` (the saved preference). We only assert a
// live verdict when the blind is online and has reported a real state, so a
// router that doesn't genuinely support TWT is surfaced honestly instead of the
// toggle silently implying power saving that isn't happening.
function updateTwtStatusLabel() {
    const sub = document.querySelector('#twtSetting .setting-sublabel');
    if (!sub) return;
    const DEFAULT = 'Save battery (Requires WiFi 6 router)';
    const enabled = !!BlindState.config.twtEnabled;
    const active = !!BlindState.config.twtActive;
    const requested = !!BlindState.config.twtRequested;     // negotiation in flight
    const wifi6 = BlindState.config.wifi6;                  // AP is 802.11ax (may be undefined)
    const online = !!BlindState.isOnline;
    const hasLiveState = BlindState.config.twtActive !== undefined;

    if (!enabled || !online || !hasLiveState) {
        sub.textContent = DEFAULT;
        sub.style.color = '';
    } else if (active) {
        sub.textContent = 'Active — negotiated with your Wi-Fi 6 router';
        sub.style.color = 'var(--success)';
    } else if (requested) {
        // Request sent, awaiting the router's accept/reject — don't prematurely
        // claim failure during the ~1–2s negotiation window.
        sub.textContent = 'Negotiating TWT with your router…';
        sub.style.color = 'var(--text-secondary)';
    } else if (wifi6 === false) {
        // Honest, specific reason: the router isn't Wi-Fi 6 at all.
        sub.textContent = "Your router isn't Wi-Fi 6 — TWT can't run";
        sub.style.color = 'var(--warning)';
    } else {
        sub.textContent = "Enabled, but your router didn't accept TWT — no power saving";
        sub.style.color = 'var(--warning)';
    }
}

function _setHealthText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

function _setHealthMetric(metric, stateName, value, detail) {
    const item = document.querySelector(`[data-health-metric="${metric}"]`);
    if (item) {
        item.classList.remove('health-good', 'health-warn', 'health-bad', 'health-neutral');
        item.classList.add(`health-${stateName}`);
    }

    const name = metric.charAt(0).toUpperCase() + metric.slice(1);
    _setHealthText(`health${name}Value`, value);
    _setHealthText(`health${name}Detail`, detail);
}

function _formatHealthAge(ts) {
    if (!ts) return 'No live update';
    const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (seconds < 10) return 'Updated just now';
    if (seconds < 60) return `Updated ${seconds}s ago`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `Updated ${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    return `Updated ${hours}h ago`;
}

function _formatHealthFirmware() {
    const fw = BlindState.firmware || BlindState.config.firmware || BlindState.config.version;
    return fw ? String(fw) : '--';
}

function _isStepperBlindDevice(defaultValue = true) {
    try {
        const device = (typeof DeviceList !== 'undefined') ? DeviceList.get(BlindState.deviceId) : null;
        if (device && device.type && device.type !== 'stepper' && device.type !== 'blind') {
            return false;
        }
        if (device && (device.type === 'stepper' || device.type === 'blind')) {
            return true;
        }
    } catch (e) { /* best effort */ }
    return defaultValue;
}

function _formatStepValue(value, signed = false) {
    const num = _numberOrNull(value);
    if (num === null) return '--';
    const rounded = Math.round(num);
    const prefix = signed && rounded > 0 ? '+' : '';
    return `${prefix}${rounded.toLocaleString()} steps`;
}

function _formatConfidence(value) {
    const num = _numberOrNull(value);
    return num === null ? '--' : `${Math.round(Math.max(0, Math.min(100, num)))}%`;
}

function updateCalibrationTools() {
    const item = document.getElementById('calibrationToolsItem');
    if (!item) return;

    const isStepper = _isStepperBlindDevice(true);
    item.style.display = isStepper ? 'flex' : 'none';
    if (!isStepper) return;

    const c = BlindState.calibration || {};
    const confidence = _numberOrNull(c.confidence);
    const drift = _numberOrNull(c.driftSteps);
    const hasPowerLoss = c.powerLossDuringMove === true;
    const powerLossRecorded = hasPowerLoss || c.lastPowerLossRecorded === true;
    const eStopRecorded = c.lastEmergencyStopRecorded === true;

    _setHealthText('calConfidenceValue', _formatConfidence(confidence));
    _setHealthText('calDriftValue', _formatStepValue(drift, true));
    _setHealthText('calLastSavedValue', _formatStepValue(c.lastSavedPosition));
    _setHealthText('calLastEStopValue', eStopRecorded ? _formatStepValue(c.lastEmergencyStopPosition) : 'None recorded');
    _setHealthText('calPowerLossValue', powerLossRecorded ? _formatStepValue(c.lastPowerLossPosition) : 'None recorded');
    _setHealthText('calCurrentStepsValue', _formatStepValue(c.currentPosition));

    let status = 'Waiting for live position telemetry';
    if (BlindState.isCalibrated === false) {
        status = 'Limits need calibration';
    } else if (BlindState.isCalibrated !== true) {
        status = 'Checking calibration';
    } else if (confidence !== null) {
        status = confidence >= 90 ? 'Position model looks reliable'
            : confidence >= 70 ? 'Position model needs attention'
                : 'Position model is low confidence';
    } else if (BlindState.lastStateAt) {
        status = 'Firmware has not reported confidence yet';
    }
    _setHealthText('calibrationToolsStatus', status);

    const canNudge = BlindState.isOnline && !BlindState.isMoving && BlindState.isCalibrated === true;
    ['nudgePositionDownBtn', 'nudgePositionUpBtn'].forEach((id) => {
        const btn = document.getElementById(id);
        if (!btn) return;
        btn.disabled = !canNudge;
        btn.setAttribute('aria-disabled', canNudge ? 'false' : 'true');
    });
}

function sendPositionNudge(percent) {
    if (!BlindState.isOnline || typeof MQTTClient === 'undefined' || !MQTTClient.connected) {
        if (typeof Toast !== 'undefined') Toast.error("Can't nudge while offline");
        return false;
    }
    if (BlindState.isMoving) {
        if (typeof Toast !== 'undefined') Toast.error("Can't nudge while moving");
        return false;
    }
    if (BlindState.isCalibrated !== true) {
        if (typeof Toast !== 'undefined') Toast.error('Calibrate limits before nudging');
        return false;
    }

    const sent = MQTTClient.publishConfig(BlindState.deviceId, {
        cmd: 'nudge_position',
        percent
    });
    if (sent) {
        const label = percent > 0 ? `+${percent}%` : `${percent}%`;
        if (typeof Toast !== 'undefined') Toast.success(`Position nudged ${label}`);
        addLogEntry('↕', `Position nudged ${label}`);
    } else if (typeof Toast !== 'undefined') {
        Toast.error('Nudge failed to send');
    }
    return !!sent;
}

function setupCalibrationTools() {
    document.getElementById('nudgePositionDownBtn')?.addEventListener('click', () => sendPositionNudge(-0.5));
    document.getElementById('nudgePositionUpBtn')?.addEventListener('click', () => sendPositionNudge(0.5));
    updateCalibrationTools();
}

function updateHealthPanel() {
    const panel = document.getElementById('healthPanel');
    if (!panel) return;

    const hasLiveState = !!BlindState.lastStateAt;
    const online = !!BlindState.isOnline;
    let score = 100;
    const penalty = (amount) => { score -= amount; };

    const ageText = _formatHealthAge(BlindState.lastStateAt);
    const firmwareText = _formatHealthFirmware();
    const ssidText = BlindState.ssid ? ` - ${BlindState.ssid}` : '';

    if (!online) penalty(35);
    if (!hasLiveState) penalty(online ? 10 : 20);
    _setHealthMetric(
        'connection',
        online ? 'good' : 'bad',
        online ? 'Online' : 'Offline',
        ageText
    );

    const rssi = Number(BlindState.rssi);
    if (!online) {
        _setHealthMetric('wifi', 'neutral', 'Offline', BlindState.rssi ? `${BlindState.rssi} dBm last seen${ssidText}` : 'No live signal');
    } else if (!Number.isFinite(rssi)) {
        if (hasLiveState) penalty(5);
        _setHealthMetric('wifi', 'warn', 'Unknown', BlindState.ssid ? `Connected to ${BlindState.ssid}` : 'No signal reading');
    } else if (rssi >= -67) {
        _setHealthMetric('wifi', 'good', 'Strong', `${rssi} dBm${ssidText}`);
    } else if (rssi >= -75) {
        penalty(6);
        _setHealthMetric('wifi', 'warn', 'Fair', `${rssi} dBm${ssidText}`);
    } else {
        penalty(12);
        _setHealthMetric('wifi', 'bad', 'Weak', `${rssi} dBm${ssidText}`);
    }

    if (!hasLiveState) {
        _setHealthMetric('calibration', 'neutral', 'Unknown', 'Waiting for state');
    } else if (BlindState.isCalibrated === false) {
        penalty(25);
        _setHealthMetric('calibration', 'bad', 'Needed', 'Limits are not set');
    } else {
        const confidence = _numberOrNull(BlindState.calibration.confidence);
        const drift = Math.abs(_numberOrNull(BlindState.calibration.driftSteps) || 0);
        const powerLoss = BlindState.calibration.powerLossDuringMove === true;
        if (confidence !== null && confidence < 70) {
            penalty(18);
            _setHealthMetric('calibration', 'bad', `${Math.round(confidence)}%`, powerLoss ? 'Power loss during movement' : 'Position confidence is low');
        } else if ((confidence !== null && confidence < 90) || powerLoss) {
            penalty(powerLoss ? 12 : 6);
            const detail = powerLoss ? 'Power loss marker recorded' :
                (drift > 0 ? `${_formatStepValue(drift)} drift` : 'Position confidence reduced');
            _setHealthMetric('calibration', 'warn', confidence !== null ? `${Math.round(confidence)}%` : 'Check', detail);
        } else {
            _setHealthMetric('calibration', 'good', confidence !== null ? `${Math.round(confidence)}%` : 'Ready', 'Top and bottom limits set');
        }
    }

    if (!hasLiveState) {
        _setHealthMetric('motor', 'neutral', 'Unknown', 'Waiting for state');
    } else if (BlindState.stateTruncated) {
        penalty(20);
        const required = BlindState.requiredBytes || '?';
        const buffer = BlindState.bufferBytes || '?';
        _setHealthMetric('motor', 'bad', 'Limited state', `${buffer}/${required} bytes reported`);
    } else if (BlindState.isMoving) {
        _setHealthMetric('motor', 'good', 'Moving', `${Math.round(BlindState.position)}% to ${Math.round(BlindState.targetPosition)}%`);
    } else {
        _setHealthMetric('motor', 'good', 'Ready', `Position ${Math.round(BlindState.position)}%`);
    }

    if (!BlindState.matterCommissioned) {
        _setHealthMetric('matter', 'neutral', 'Not paired', 'Matter is optional');
    } else if (BlindState.matterReachable === false) {
        penalty(8);
        _setHealthMetric('matter', 'warn', 'Unreachable', `${BlindState.matterActiveFabrics || 0} fabric${BlindState.matterActiveFabrics === 1 ? '' : 's'}`);
    } else {
        _setHealthMetric('matter', 'good', 'Reachable', `${BlindState.matterActiveFabrics || 0} fabric${BlindState.matterActiveFabrics === 1 ? '' : 's'}`);
    }

    const twtEnabled = !!BlindState.config.twtEnabled;
    const twtActive = BlindState.config.twtActive;
    const twtRequested = !!BlindState.config.twtRequested;
    const wifi6 = BlindState.config.wifi6;
    if (!twtEnabled) {
        _setHealthMetric('power', 'neutral', 'Standard', 'TWT off');
    } else if (twtActive === true) {
        _setHealthMetric('power', 'good', 'TWT active', 'Router accepted power saving');
    } else if (twtRequested) {
        _setHealthMetric('power', 'neutral', 'Negotiating', 'Waiting for router response');
    } else if (wifi6 === false) {
        penalty(5);
        _setHealthMetric('power', 'warn', 'Unavailable', 'Router is not Wi-Fi 6');
    } else if (twtActive === false && hasLiveState) {
        penalty(5);
        _setHealthMetric('power', 'warn', 'Not active', 'Router did not accept TWT');
    } else {
        _setHealthMetric('power', 'neutral', 'Enabled', 'Waiting for router report');
    }

    score = Math.max(0, Math.min(100, Math.round(score)));

    let scoreState = 'neutral';
    let title = 'Waiting for state';
    if (hasLiveState || online) {
        if (score >= 85) {
            scoreState = 'good';
            title = 'Healthy';
        } else if (score >= 70) {
            scoreState = 'warn';
            title = 'Needs attention';
        } else {
            scoreState = 'bad';
            title = 'Check blind';
        }
    }

    const ring = document.getElementById('healthScoreRing');
    if (ring) {
        ring.classList.remove('health-good', 'health-warn', 'health-bad', 'health-neutral');
        ring.classList.add(`health-${scoreState}`);
    }

    _setHealthText('healthScore', (hasLiveState || online) ? String(score) : '--');
    _setHealthText('healthTitle', title);
    _setHealthText('healthSubtitle', `Firmware ${firmwareText}${ssidText} - ${ageText}`);

    const typeLabels = { roller: 'Roller', vertical: 'Vertical', zebra: 'Zebra' };
    _setHealthText('infoType', typeLabels[BlindState.blindType] || 'Blind');
    _setHealthText('infoFirmware', firmwareText);
    const infoStatus = BlindState.connectionStatus === 'checking'
        ? 'Waiting'
        : (online ? (BlindState.stateTruncated ? 'Limited' : 'Online') : 'Offline');
    _setHealthText('infoStatus', infoStatus);
}

function updateConfigUI() {
    // Update durations
    const openAngleVal = document.getElementById('openAngleValue');
    const closeAngleVal = document.getElementById('closeAngleValue');

    if (openAngleVal) openAngleVal.textContent = `${BlindState.config.angleOn || 90}°`;
    if (closeAngleVal) closeAngleVal.textContent = `${BlindState.config.angleOff || 0}°`;

    const openSpeedVal = document.getElementById('stepperOpenSpeedValue');
    const closeSpeedVal = document.getElementById('stepperCloseSpeedValue');
    if (openSpeedVal) openSpeedVal.textContent = `${BlindState.config.stepperOpenSpeed || 2000}`;
    if (closeSpeedVal) closeSpeedVal.textContent = `${BlindState.config.stepperCloseSpeed || 2000}`;

    const stopDelayVal = document.getElementById('stepperStopDelayValue');
    const relaxStepsVal = document.getElementById('stepperRelaxStepsValue');
    if (stopDelayVal) {
        const ms = BlindState.config.stepperStopDelay !== undefined ? BlindState.config.stepperStopDelay : 3000;
        stopDelayVal.textContent = `${(ms / 1000).toFixed(1)}s`;
    }
    if (relaxStepsVal) {
        const steps = BlindState.config.stepperRelaxSteps !== undefined ? BlindState.config.stepperRelaxSteps : 128;
        relaxStepsVal.textContent = steps === 0 ? 'Disabled' : `${steps}`;
    }

    const accelVal = document.getElementById('stepperAccelerationValue');
    if (accelVal) accelVal.textContent = `${BlindState.config.stepperAcceleration || 2000}`;

    const twtEnabledEl = document.getElementById('twtEnabled');
    if (twtEnabledEl) {
        twtEnabledEl.checked = BlindState.config.twtEnabled || false;
    }
    updateTwtStatusLabel();

    const idleHoldEl = document.getElementById('stepperIdleHold');
    if (idleHoldEl) {
        const held = BlindState.config.stepperIdleHold === true;
        idleHoldEl.checked = held;
        const idleSub = document.getElementById('stepperIdleHoldSublabel');
        if (idleSub) {
            idleSub.textContent = held
                ? 'On — motor stays energized at rest (uses a little more power)'
                : "Keep the motor energized at rest so the blind can't slip down";
        }
    }

    // Hide Angle settings if Stepper
    // This is the blinds device page, so the device is a stepper/blind by
    // definition — default true so the stepper settings render immediately rather
    // than flashing the servo-angle settings before DeviceList finishes loading.
    // Only flip to false if DeviceList explicitly reports a non-stepper type.
    let isStepper = _isStepperBlindDevice(true);

    const angleOnItem = document.getElementById('angleOnSettingItem');
    const angleOffItem = document.getElementById('angleOffSettingItem');
    const stepperOpenSpeedItem = document.getElementById('stepperOpenSpeedSettingItem');
    const stepperCloseSpeedItem = document.getElementById('stepperCloseSpeedSettingItem');
    const stepperStopDelayItem = document.getElementById('stepperStopDelaySettingItem');
    const stepperRelaxStepsItem = document.getElementById('stepperRelaxStepsSettingItem');
    const stepperAccelerationItem = document.getElementById('stepperAccelerationSettingItem');
    const stepperIdleHoldItem = document.getElementById('stepperIdleHoldSettingItem');
    const recalibrateStepperItem = document.getElementById('recalibrateStepperSettingsItem');
    const calibrationToolsItem = document.getElementById('calibrationToolsItem');

    if (angleOnItem) angleOnItem.style.display = isStepper ? 'none' : 'flex';
    if (angleOffItem) angleOffItem.style.display = isStepper ? 'none' : 'flex';
    if (stepperOpenSpeedItem) stepperOpenSpeedItem.style.display = isStepper ? 'flex' : 'none';
    if (stepperCloseSpeedItem) stepperCloseSpeedItem.style.display = isStepper ? 'flex' : 'none';
    if (stepperStopDelayItem) stepperStopDelayItem.style.display = isStepper ? 'flex' : 'none';
    if (stepperRelaxStepsItem) stepperRelaxStepsItem.style.display = isStepper ? 'flex' : 'none';
    if (stepperAccelerationItem) stepperAccelerationItem.style.display = isStepper ? 'flex' : 'none';
    if (stepperIdleHoldItem) stepperIdleHoldItem.style.display = isStepper ? 'flex' : 'none';
    if (recalibrateStepperItem) recalibrateStepperItem.style.display = isStepper ? 'flex' : 'none';
    if (calibrationToolsItem) calibrationToolsItem.style.display = isStepper ? 'flex' : 'none';

    // Smart Rules Displays
    const rConfig = BlindState.config;

    // Sunset
    const sunsetEl = document.getElementById('sunsetRuleDisplay');
    if (sunsetEl) {
        // Effective offset: this blind's per-device override if set, else the home-wide global.
        const globalOffset = parseInt(localStorage.getItem('zaylo-SunsetOffset') || '0', 10);
        const perDeviceOffset = Number(BlindState.config.sunsetOffset);
        const offset = (BlindState.config.sunsetOffset !== null && BlindState.config.sunsetOffset !== undefined && Number.isFinite(perDeviceOffset))
            ? perDeviceOffset : globalOffset;
        const offsetStr = offset >= 0 ? `+${offset}` : `${offset}`;

        // Attempt to format actual sunset time
        let sunsetValue = BlindState.sunsetTime;
        if ((sunsetValue === undefined || sunsetValue === null || sunsetValue === 0)
            && rConfig.sunsetMinute !== undefined) {
            sunsetValue = rConfig.sunsetMinute;
        }

        let sunsetTimeStr = '';
        let timeStr = '';
        if (sunsetValue) {
            let effectiveTime = sunsetValue;
            if (typeof sunsetValue === 'number' && sunsetValue > 100000) {
                const date = new Date(effectiveTime * 1000);
                sunsetTimeStr = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
                
                // Now calculate offset time for display
                effectiveTime += (offset * 60);
                const offsetDate = new Date(effectiveTime * 1000);
                timeStr = ` (${String(offsetDate.getHours()).padStart(2, '0')}:${String(offsetDate.getMinutes()).padStart(2, '0')})`;
            } else if (typeof sunsetValue === 'number') {
                sunsetTimeStr = `${String(Math.floor(effectiveTime / 60)).padStart(2, '0')}:${String(effectiveTime % 60).padStart(2, '0')}`;
                
                effectiveTime += offset;
                if (effectiveTime < 0) effectiveTime += 1440;
                if (effectiveTime >= 1440) effectiveTime -= 1440;
                timeStr = ` (${String(Math.floor(effectiveTime / 60)).padStart(2, '0')}:${String(effectiveTime % 60).padStart(2, '0')})`;
            }
        }

        const sunsetLabel = sunsetTimeStr ? `Sunset at ${sunsetTimeStr}` : `Sunset ${offsetStr} min`;
        // Show effective city: device-specific override first, then global home default.
        const effectiveCity = BlindState.config.city || localStorage.getItem('zaylo-LocationCity') || '';
        const locationSuffix = effectiveCity ? `<span style="opacity:0.7; font-size:0.9em; margin-left:4px;">• ${effectiveCity}</span>` : '';
        sunsetEl.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg> ${sunsetLabel}${timeStr}${locationSuffix}`;
    }

    // Presence
    const presenceEl = document.getElementById('presenceRuleDisplay');
    if (presenceEl) {
        const timeout = rConfig.motionTimeout !== undefined ? rConfig.motionTimeout : 5;
        const action = rConfig.presenceAction === 'open_close' ? 'Open/Close' : 'Close';
        
        let timeStr = '';
        if (rConfig.presenceTimeFilter === 'day') timeStr = ' (Day)';
        else if (rConfig.presenceTimeFilter === 'night') timeStr = ' (Night)';
        
        presenceEl.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg> ${timeout}m ${action}${timeStr}`;
    }

    const presenceDescEl = document.getElementById('presenceRuleDesc');
    if (presenceDescEl) {
        const timeout = rConfig.motionTimeout !== undefined ? rConfig.motionTimeout : 5;
        const actionStr = rConfig.presenceAction === 'open_close' ? 'Open/Close blinds' : 'Close blinds';
        presenceDescEl.textContent = `${actionStr} ${timeout} min after no motion detected`;
    }

    // Morning
    const morningEl = document.getElementById('morningRuleTimeDisplay');
    if (morningEl) {
        const days = rConfig.morningDays;
        let morningLabel = '';
        if (days && Array.isArray(days)) {
            const enabledDays = days.filter(d => d.enabled);
            const enabledCount = enabledDays.length;
            if (enabledCount === 0) {
                morningLabel = 'No days enabled';
            } else if (enabledCount === 7 && enabledDays.every(d => d.time === enabledDays[0].time)) {
                // All days same time
                morningLabel = enabledDays[0].time + ' — Every day';
            } else {
                const dayLetters = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
                const activeDayStr = days.map((d, i) => d.enabled ? dayLetters[i] : '·').join(' ');
                morningLabel = activeDayStr + ' — Custom';
            }
        } else {
            const mTime = rConfig.morningTime || '07:00';
            morningLabel = mTime + ' — Gradual';
        }
        morningEl.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg> ${morningLabel}`;
    }

    // Night Lock — reflect the per-day schedule (nightDays), exactly like the
    // Morning rule above. Previously this always rendered `nightTime — Daily`,
    // and nightTime is only the FIRST enabled day's time — so a custom time set
    // on a day could be missed in the UI summary.
    const nightEl = document.getElementById('nightRuleTimeDisplay');
    if (nightEl) {
        const days = rConfig.nightDays;
        let nightLabel;
        if (days && Array.isArray(days) && days.length === 7) {
            const dayLetters = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
            
            // Map days to simple objects { enabled, time } to unify processing
            const normalizedDays = days.map((d, i) => {
                if (d && typeof d === 'object') {
                    return { enabled: d.enabled !== false, time: d.time || rConfig.nightTime || '22:00' };
                }
                return { enabled: d === true, time: rConfig.nightTime || '22:00' };
            });

            const enabledDays = normalizedDays.filter(d => d.enabled);
            if (enabledDays.length === 0) {
                nightLabel = 'No days enabled';
            } else if (enabledDays.every(d => d.time === enabledDays[0].time)) {
                // One shared time across every enabled day → show that time.
                const t = enabledDays[0].time || rConfig.nightTime || '22:00';
                if (enabledDays.length === 7) {
                    nightLabel = `${t} — Every day`;
                } else {
                    const pattern = normalizedDays.map((d, i) => d.enabled ? dayLetters[i] : '·').join(' ');
                    nightLabel = `${t} · ${pattern}`;
                }
            } else {
                // Times differ per day → a single time can't represent it.
                const pattern = normalizedDays.map((d, i) => d.enabled ? dayLetters[i] : '·').join(' ');
                nightLabel = `${pattern} — Custom`;
            }
        } else {
            nightLabel = `${rConfig.nightTime || '22:00'} — Daily`;
        }
        nightEl.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg> ${nightLabel}`;
    }

    // Heat Protection
    const tempEl = document.getElementById('tempRuleDisplay');
    if (tempEl) {
        const _fmtTemp = (c) => (typeof BlindSchema !== 'undefined' && BlindSchema.formatTemp) ? BlindSchema.formatTemp(c) : `${c}°C`;
        const thresh = rConfig.tempThreshold !== undefined ? rConfig.tempThreshold : 30;
        // Surface the auto-reopen hysteresis when enabled so the summary reflects
        // the full close→reopen loop, not just the close threshold.
        let reopenStr = '';
        if (rConfig.tempReopenEnabled === true) {
            const rt = rConfig.tempReopenThreshold !== undefined ? rConfig.tempReopenThreshold : Math.max(0, thresh - 5);
            reopenStr = ` · reopens < ${_fmtTemp(rt)}`;
        }
        tempEl.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg> > ${_fmtTemp(thresh)}${reopenStr}`;
    }

    if (typeof updateUpcomingAutomations === 'function') updateUpcomingAutomations();
    updateHealthPanel();
    updateCalibrationTools();
}

// Builds a firmware-ready copy of BlindState.config: applies the UI→firmware unit
// conversions that the device expects (motionTimeout minutes→seconds, per-day
// schedule objects), pulls the globally-managed sunset offset, and stamps the
// current timezone. Use this anywhere config is pushed to the device so the
// conversions can never drift between code paths (the import path used to skip
// them entirely, sending minutes as seconds and objects where bools were expected).
function _buildFirmwareConfigCopy() {
    if (typeof BlindSchema !== 'undefined' && typeof BlindSchema.toFirmwareConfig === 'function') {
        return BlindSchema.toFirmwareConfig(BlindState.config);
    }

    const cfg = { ...BlindState.config };
    // Per-device sunset offset wins; null/undefined inherits the home-wide global.
    // (Matches BlindSchema.toFirmwareConfig; this fallback only runs if BlindSchema
    // is unavailable, but keep the resolution identical so they can't drift.)
    const _pdOffset = Number(cfg.sunsetOffset);
    cfg.sunsetOffset = (cfg.sunsetOffset !== null && cfg.sunsetOffset !== undefined && Number.isFinite(_pdOffset))
        ? _pdOffset
        : parseInt(localStorage.getItem('zaylo-SunsetOffset') || '0', 10);
    // Location inheritance: if no per-device lat/lon, use the home-wide global.
    // (Mirrors BlindSchema.toFirmwareConfig so they can never drift.)
    if (cfg.lat == null || cfg.lon == null) {
        const globalLat = localStorage.getItem('zaylo-LocationLat');
        const globalLon = localStorage.getItem('zaylo-LocationLon');
        if (globalLat && globalLon) {
            cfg.lat = parseFloat(globalLat);
            cfg.lon = parseFloat(globalLon);
        }
    }
    // UI stores motionTimeout in MINUTES; firmware expects SECONDS.
    if (cfg.motionTimeout !== undefined) {
        cfg.motionTimeout = (cfg.motionTimeout || 5) * 60;
    }
    // Per-day morning schedule → firmware object[] with all fields present.
    if (cfg.morningDays && Array.isArray(cfg.morningDays) && cfg.morningDays.length === 7) {
        cfg.morningDays = cfg.morningDays.map(d => ({
            enabled: d.enabled !== false,
            time: d.time || '07:00',
            duration: d.duration !== undefined ? d.duration : 30,
            target: d.target !== undefined ? d.target : 100
        }));
    }
    // Night days: send the full per-day object[] { enabled, time, target } so the
    // firmware (V14+) can honour per-day lock times — matching morningDays. The
    // firmware still accepts the legacy bool[] form for backward compatibility.
    if (cfg.nightDays && Array.isArray(cfg.nightDays) && cfg.nightDays.length === 7) {
        cfg.nightDays = cfg.nightDays.map(d => (typeof d === 'object' && d !== null) ? {
            enabled: d.enabled !== false,
            time: d.time || '22:00',
            target: d.target !== undefined ? d.target : 0
        } : { enabled: !!d, time: '22:00', target: 0 });
    }
    // Fresh timezone (handles DST transitions).
    if (typeof MQTTClient !== 'undefined' && typeof MQTTClient.getTimezonePayload === 'function') {
        const tz = MQTTClient.getTimezonePayload();
        cfg.gmtOffset = tz.gmtOffset;
        cfg.daylightOffset = tz.daylightOffset;
        if (tz.tzPosix) cfg.tzPosix = tz.tzPosix;
    }
    // Strip city — UI-only label the firmware doesn't need.
    delete cfg.city;
    return cfg;
}

let _saveDebounceTimer = null;

function pushFullConfigNow() {
    clearTimeout(_saveDebounceTimer);
    if (typeof ConfigSync !== 'undefined') {
        ConfigSync.push();
    }
}
// ============================================
// Reliable Config Sync — persistent, acked config delivery
// ============================================
// Config/rules changes used to publish only when MQTT was connected, and the
// setup one-shot cleared its pending flag the instant the BROKER accepted the
// publish — neither of which proves the DEVICE received and applied the change.
// Offline edits were silently dropped and "saved" settings could never reach the
// blind. ConfigSync fixes that:
//   • A single persisted pending config (survives reload). It's last-write-wins
//     because we always push the FULL current rules+config, which the firmware
//     applies idempotently — no need to merge partial edits.
//   • Each push carries a revision token (cfgRev) the firmware echoes back in its
//     state; a push is only "delivered" once that ack arrives.
//   • Retries while connected-but-unacked, and flushes automatically on reconnect.
//   • Surfaces a visible "pending sync" status (and only when actually pending —
//     healthy instant syncs stay silent).
const ConfigSync = {
    pendingRev: null,
    _retryTimer: null,
    _pillTimer: null,
    _pillShown: false,
    _attemptCount: 0,
    _publishedWhileConnected: false,
    RETRY_MS: 5000,
    MAX_ATTEMPTS: 8, // ~40s of active retries before backing off to reconnect/state-driven resume

    _key() { return `blind-cfgsync-${BlindState.deviceId || 'unknown'}`; },

    // Load any persisted pending config on startup so an offline edit made in a
    // previous session is still delivered.
    init() {
        try {
            const saved = JSON.parse(localStorage.getItem(this._key()) || 'null');
            if (saved && saved.rev && saved.payload && !saved.acked) {
                this.pendingRev = saved.rev;
                this._updateStatus('offline');
            }
        } catch (e) { /* ignore */ }
    },

    _buildPayload(rev) {
        // While the rules are still PROVISIONAL (no wizard choice, no device
        // echo, no user toggle yet) they are omitted from the payload entirely
        // — the firmware's containsKey-guarded parser then leaves its own rule
        // state untouched. This is what stops the app's optimistic defaults
        // from enabling automations on a device the user never configured.
        const rulesForPayload = BlindState._rulesProvisional ? null : BlindState.rules;

        if (typeof BlindSchema !== 'undefined' && typeof BlindSchema.buildConfigPayload === 'function') {
            return BlindSchema.buildConfigPayload(BlindState.deviceId, {
                rules: rulesForPayload,
                config: BlindState.config,
                linkedDeviceId: BlindState.linkedDeviceId
            }, rev);
        }

        const payload = {
            config: _buildFirmwareConfigCopy(),
            cfgRev: rev
        };
        if (rulesForPayload) {
            payload.rules = {
                sunset: BlindState.rules.sunset,
                presence: BlindState.rules.presence,
                morningOpen: BlindState.rules.morningOpen,
                nightLock: BlindState.rules.nightLock,
                temperature: BlindState.rules.temperature
            };
        }
        // Only include linkedDeviceId when set — a null/'' would make the firmware
        // CLEAR its linked device, so a transient null must never be echoed.
        if (BlindState.linkedDeviceId) payload.linkedDeviceId = BlindState.linkedDeviceId;
        return payload;
    },

    // Queue + deliver the current full config. Generates a fresh revision token.
    push() {
        if (!BlindState.deviceId) return;
        const rev = (typeof BlindSchema !== 'undefined' && typeof BlindSchema.nextRevision === 'function')
            ? BlindSchema.nextRevision(BlindState.deviceId)
            : Math.max(1, (Date.now() >>> 0) & 0x7ffffffe);
        const payload = this._buildPayload(rev);
        this.pendingRev = rev;
        this._attemptCount = 0;
        try {
            localStorage.setItem(this._key(), JSON.stringify({ rev, payload, acked: false }));
        } catch (e) { /* quota — the in-memory pendingRev still drives delivery */ }
        this._attempt();
    },

    // Try to deliver the stored pending payload. Never changes the rev, so a
    // retry/reconnect re-sends the exact token the device will ack. Retries are
    // capped so a truly-unreachable device doesn't republish forever — delivery
    // then resumes on the next reconnect (flush) or when the device's state
    // reappears (handleAck).
    _attempt() {
        clearTimeout(this._retryTimer);
        clearTimeout(this._pillTimer);
        if (this.pendingRev === null) return;

        let saved;
        try { saved = JSON.parse(localStorage.getItem(this._key()) || 'null'); } catch (e) { saved = null; }
        if (!saved || saved.acked || saved.rev !== this.pendingRev) return;

        if (typeof MQTTClient !== 'undefined' && MQTTClient.connected) {
            MQTTClient.publishConfig(BlindState.deviceId, saved.payload);
            this._publishedWhileConnected = true;
            this._attemptCount++;
            // Only surface the "syncing" pill if the device hasn't acked quickly —
            // a healthy online sync (acked in <1.5s) stays silent.
            this._pillTimer = setTimeout(() => {
                if (this.pendingRev !== null) this._updateStatus('syncing');
            }, 1500);
            if (this._attemptCount < this.MAX_ATTEMPTS) {
                this._retryTimer = setTimeout(() => this._attempt(), this.RETRY_MS);
            } else {
                // Backed off — keep the pending config persisted; it resumes on
                // reconnect or when the device's next state arrives.
                this._updateStatus('pending');
            }
        } else {
            // Offline — wait for reconnect (flush()).
            this._updateStatus('offline');
        }
    },

    // Called on MQTT (re)connect.
    flush() {
        if (this.pendingRev !== null) { this._attemptCount = 0; this._attempt(); }
    },

    _clearPending() {
        this.pendingRev = null;
        this._attemptCount = 0;
        clearTimeout(this._retryTimer);
        clearTimeout(this._pillTimer);
        try { localStorage.removeItem(this._key()); } catch (e) {}
        // A delivered config also satisfies the one-shot setup sync — its values
        // were part of the full payload — so clear that flag too.
        try { localStorage.removeItem(`blind-pending-sync-${BlindState.deviceId}`); } catch (e) {}
        if (this._pillShown) this._updateStatus('synced');
    },

    // Called from every incoming device state. Clears pending once the device
    // confirms it applied our revision (precise ack via the firmware cfgRev echo),
    // with a best-effort fallback for older firmware that doesn't echo cfgRev.
    handleAck(state) {
        if (this.pendingRev === null || !state) return;

        let echoed = state.cfgRev;
        if (echoed === undefined && state.config) echoed = state.config.cfgRev;

        if (echoed !== undefined && Number.isFinite(Number(echoed))) {
            // Current firmware: precise token ack. Do not use >= here; revision
            // sequences can wrap or restart, and a stale higher value must never
            // clear a newer pending payload.
            if (Number(echoed) === Number(this.pendingRev)) {
                this._clearPending();
            } else if (this._attemptCount >= this.MAX_ATTEMPTS &&
                       typeof MQTTClient !== 'undefined' && MQTTClient.connected) {
                // The device is alive (it just reported state) but hasn't applied
                // our revision yet — likely it was offline when we pushed. Resume.
                this._attemptCount = 0;
                this._attempt();
            }
            return;
        }

        // Older firmware that does NOT echo cfgRev: a full state snapshot means the
        // device is alive and processes inbound config/set, so once we've published
        // while connected, treat the next real state as delivery instead of
        // retrying / showing "Syncing…" forever. (Current firmware always includes
        // cfgRev, so a full state lacking it unambiguously means old firmware.)
        const isFullState = state.position !== undefined ||
                            state.blindPosition !== undefined || state.config !== undefined;
        if (isFullState && this._publishedWhileConnected) this._clearPending();
    },

    _updateStatus(stateName) {
        let pill = document.getElementById('configSyncPill');
        if (!pill) {
            if (stateName === 'synced') return;
            pill = document.createElement('div');
            pill.id = 'configSyncPill';
            pill.style.cssText = 'position:fixed; left:50%; transform:translateX(-50%); bottom:88px; z-index:9999; display:flex; align-items:center; gap:6px; padding:8px 14px; border-radius:999px; font-size:12px; font-weight:600; box-shadow:0 6px 22px rgba(0,0,0,0.28); transition:opacity .3s ease; pointer-events:none;';
            document.body.appendChild(pill);
        }
        if (stateName === 'synced') {
            this._pillShown = false;
            pill.style.background = 'rgba(16,185,129,0.16)';
            pill.style.color = '#10b981';
            pill.style.border = '1px solid rgba(16,185,129,0.4)';
            pill.textContent = '✓ Settings synced';
            setTimeout(() => { if (pill) pill.style.opacity = '0'; }, 1800);
            setTimeout(() => { if (pill && pill.parentNode) pill.parentNode.removeChild(pill); }, 2200);
            return;
        }
        this._pillShown = true;
        pill.style.opacity = '1';
        if (stateName === 'offline') {
            pill.style.background = 'rgba(245,158,11,0.16)';
            pill.style.color = '#f59e0b';
            pill.style.border = '1px solid rgba(245,158,11,0.4)';
            pill.textContent = '⚠ Settings pending — will sync when online';
        } else { // syncing
            pill.style.background = 'rgba(45,212,191,0.13)';
            pill.style.color = '#2dd4bf';
            pill.style.border = '1px solid rgba(45,212,191,0.35)';
            pill.textContent = '⟳ Syncing settings…';
        }
    }
};

// Push the full device state to Firestore — but only once the home context is
// ready. Calling DeviceService.updateDevice(undefined, ...) before activeHomeId
// resolves targets an invalid path and silently fails, so defer and flush via
// flushDeferredCloudSync() when the home becomes known.
function _cloudSyncDeviceState(stateObj) {
    if (typeof Auth === 'undefined' || typeof DeviceService === 'undefined') return;
    const user = Auth.getUser();
    if (!user) return;
    if (!window.activeHomeId) {
        window._blindCloudSyncDeferred = true;
        return;
    }
    // Firestore rejects `undefined` field values (DocumentReference.set "Unsupported
    // field value: undefined"). BlindState.config carries undefined defaults for
    // device-reported-only fields (twtActive, wifi6) until the blind first reports
    // them, which previously made the ENTIRE device document write fail. Strip
    // undefined values (JSON round-trip drops them) so the rest of the config still
    // persists to the cloud.
    let clean;
    try { clean = JSON.parse(JSON.stringify(stateObj)); } catch (e) { clean = stateObj; }
    DeviceService.init().then(() => {
        DeviceService.updateDevice(window.activeHomeId, BlindState.deviceId, clean);
    }).catch(e => console.error('[Blind] Firebase config sync failed:', e));
}

// Settings-only document for Firestore. Live telemetry (position, target,
// isOpen, calibration) deliberately stays OUT of the cloud doc: nothing reads
// it from Firestore (live state comes from MQTT/StateStore), and including it
// used to turn every 250 ms movement report into a Firestore write.
function _buildCloudDeviceDoc() {
    const doc = {
        blindType: BlindState.blindType,
        linkedDeviceId: BlindState.linkedDeviceId,
        config: BlindState.config
    };
    // Same explicitness rule as localStorage: provisional default rules must
    // never reach Firestore, or another signed-in phone would adopt them as
    // explicit and push them to the device.
    if (!BlindState._rulesProvisional) doc.rules = BlindState.rules;
    return doc;
}

let _cloudSyncDebounceTimer = null;

// Debounced settings push to Firestore — rapid edits coalesce into one write.
function _scheduleCloudSync() {
    clearTimeout(_cloudSyncDebounceTimer);
    _cloudSyncDebounceTimer = setTimeout(() => {
        _cloudSyncDeviceState(_buildCloudDeviceDoc());
    }, 2000);
}

function flushDeferredCloudSync() {
    if (window._blindCloudSyncDeferred && window.activeHomeId) {
        window._blindCloudSyncDeferred = false;
        _scheduleCloudSync(); // re-persist to cloud now that the home is known
    }
}

function saveDeviceState(_mqttPayload = null, skipDevicePublish = false) {
    const key = `blind-state-${BlindState.deviceId}`;
    const stateObj = {
        blindType: BlindState.blindType,
        position: BlindState.position,
        targetPosition: BlindState.targetPosition,
        isOpen: BlindState.isOpen,
        linkedDeviceId: BlindState.linkedDeviceId,
        calibration: BlindState.calibration,
        config: BlindState.config
    };
    // Persist rules ONLY once they are explicit. Writing the provisional
    // defaults here would make the next page load read them back as "saved
    // rules" and treat them as explicit — silently laundering the optimistic
    // defaults into real, pushable configuration.
    if (!BlindState._rulesProvisional) stateObj.rules = BlindState.rules;

    try {
        const previous = JSON.parse(localStorage.getItem(key) || '{}');
        ['pendingTargetPosition', 'pendingCommandId', 'pendingCommandTs', 'pendingCommandSource', 'lastCommandStatus', '_handledRejectSeq'].forEach(field => {
            if (previous[field] !== undefined) stateObj[field] = previous[field];
        });
    } catch (e) {}
    
    // Save to LocalStorage (Fast caching)
    try {
        localStorage.setItem(key, JSON.stringify(stateObj));
    } catch (e) {
        // Handle quota exceeded specifically — clear stale entries if possible
        if (e.name === 'QuotaExceededError' || e.code === 22) {
            console.warn('[Blind] localStorage quota exceeded — clearing old blind states');
            try {
                // Remove old blind states for other devices that might be stale
                for (let i = localStorage.length - 1; i >= 0; i--) {
                    const k = localStorage.key(i);
                    if (k && k.startsWith('blind-state-') && k !== key) {
                        localStorage.removeItem(k);
                    }
                }
                localStorage.setItem(key, JSON.stringify(stateObj));
            } catch (retryErr) {
                console.error('[Blind] Cannot save state even after cleanup:', retryErr);
            }
        } else {
            console.error('[Blind] Failed to save local state:', e);
        }
    }
    
    // Cloud + device delivery happen ONLY for user-initiated settings changes
    // (skipDevicePublish === false). Calls that merely persist incoming device
    // state locally (position updates arrive every 250 ms while moving) must
    // not write to Firestore — that was a write per state report — nor echo
    // config back at the device.
    if (!skipDevicePublish) {
        // Settings-only Firestore doc, debounced (see _scheduleCloudSync).
        _scheduleCloudSync();

        // Reliable, acked, offline-queued full rules+config sync via ConfigSync.
        // Debounced so rapid edits coalesce into a single push.
        clearTimeout(_saveDebounceTimer);
        _saveDebounceTimer = setTimeout(() => {
            if (typeof ConfigSync !== 'undefined') ConfigSync.push();
        }, 500);
    }
}

function syncPendingSetupConfig() {
    const pendingKey = `blind-pending-sync-${BlindState.deviceId}`;
    if (localStorage.getItem(pendingKey) !== '1') return false;

    console.log(`[BlindDevice] Syncing pending setup configuration for ${BlindState.deviceId}...`);

    // Overwrite-protection guard: ignore device config echoes briefly so a stale
    // device default can't clobber the just-set wizard config mid-sync.
    BlindState.ignoreIncomingConfig = true;
    setTimeout(() => {
        BlindState.ignoreIncomingConfig = false;
        console.log(`[BlindDevice] Sync guard cleared. Normal updates resumed.`);
    }, 3000);

    // Firebase backup (home-aware best-effort) — settings only, same shape as
    // every other cloud write.
    _cloudSyncDeviceState(_buildCloudDeviceDoc());

    // Deliver reliably via ConfigSync. The blind-pending-sync flag is deliberately
    // NOT cleared here — broker acceptance is not device delivery. ConfigSync
    // clears it only when the blind echoes the cfgRev back (a true ack), so a
    // setup config that never reaches an offline/still-booting blind is retried
    // on reconnect instead of being silently lost.
    ConfigSync.push();
    return true;
}

// ============================================
// Helpers
// ============================================

// Remove every locally-cached artifact for a device. "Remove Device" used to
// delete only the DeviceList/Firestore entry, leaving blind-state, config-sync
// queues, Matter pairing caches, cached IPs and activity logs behind — so a
// re-added (or factory-reset) device resurrected year-old settings and showed a
// stale "Paired" Matter badge for a fabric that no longer existed.
function purgeDeviceLocalState(id) {
    const cleanId = String(id || '').trim().toUpperCase();
    if (!cleanId) return;
    const lsKeys = [
        `blind-state-${cleanId}`,
        `blind-cfgsync-${cleanId}`,
        `blind-cfgsync-rev-${cleanId}`,
        `blind-pending-sync-${cleanId}`,
        `matter-qr-${cleanId}`,
        `matter-code-${cleanId}`,
        `matter-commissioned-${cleanId}`,
        `zaylo-local-ip-${cleanId}`,
        `blind-powerloss-ack-${cleanId}`
    ];
    lsKeys.forEach(k => { try { localStorage.removeItem(k); } catch (e) {} });
    try { sessionStorage.removeItem(`blind-activity-${cleanId}`); } catch (e) {}
    // Drop the device from the config-sync registry…
    try {
        const reg = JSON.parse(localStorage.getItem('blind-cfgsync-devices') || '[]');
        if (Array.isArray(reg)) {
            localStorage.setItem('blind-cfgsync-devices', JSON.stringify(reg.filter(x => x !== cleanId)));
        }
    } catch (e) {}
    // …and purge any of its queued commands so nothing replays after removal.
    try {
        const q = JSON.parse(localStorage.getItem('blind-command-queue-v2') || '[]');
        if (Array.isArray(q)) {
            localStorage.setItem('blind-command-queue-v2',
                JSON.stringify(q.filter(c => String(c.deviceId || '').toUpperCase() !== cleanId)));
        }
    } catch (e) {}
}

function getDeviceName() {
    if (typeof DeviceList !== 'undefined') {
        const device = DeviceList.get(BlindState.deviceId);
        return device?.name || 'Smart Blinds';
    }
    // Fallback: read from home-scoped storage via DeviceList helper
    try {
        const homeId = localStorage.getItem('zaylo-activeHomeId');
        const key = homeId ? 'zaylo-devices-' + homeId : 'zaylo-devices';
        const devices = JSON.parse(localStorage.getItem(key) || '[]');
        const device = devices.find(d => d.id === BlindState.deviceId);
        return device?.name || 'Smart Blinds';
    } catch(e) { return 'Smart Blinds'; }
}

function setDeviceName(name) {
    // Update local storage
    if (typeof DeviceList !== 'undefined') {
        DeviceList.update(BlindState.deviceId, { name });
    } else {
        // Fallback: write to home-scoped storage
        try {
            const homeId = localStorage.getItem('zaylo-activeHomeId');
            const key = homeId ? 'zaylo-devices-' + homeId : 'zaylo-devices';
            const devices = JSON.parse(localStorage.getItem(key) || '[]');
            const device = devices.find(d => d.id === BlindState.deviceId);
            if (device) {
                device.name = name;
                localStorage.setItem(key, JSON.stringify(devices));
            }
        } catch(e) { console.warn('[Blind] Fallback rename failed:', e); }
    }

    // Update Firebase
    if (typeof Auth !== 'undefined' && typeof DeviceService !== 'undefined') {
        const user = Auth.getUser();
        if (user) {
            DeviceService.init().then(() => {
                DeviceService.updateDevice(window.activeHomeId, BlindState.deviceId, { name });
            }).catch(e => console.error('[Blind] Firebase rename failed:', e));
        }
    }

    // Update UI
    const title = document.getElementById('deviceTitle');
    const nameVal = document.getElementById('deviceNameValue');
    if (title) title.textContent = name;
    if (nameVal) nameVal.textContent = name;

    if (typeof Toast !== 'undefined') Toast.success('Name updated');
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}


// ============================================
// NEW FEATURE: Automation Activity Log
// ============================================
const MAX_LOG_ENTRIES = 50;
const activityLog = [];

// Scope the activity log by device id. It used to be a single global
// 'blind-activity-log' sessionStorage key shared by every blind opened in the
// tab, so opening device B showed device A's history. The device id is
// globally unique (MAC-derived), so per-device scoping fully isolates each
// blind's log; the home id can only ever map to one device id, so it would add
// no further separation here.
function _activityLogKey() {
    return `blind-activity-${BlindState.deviceId || 'unknown'}`;
}

function _formatLogTime(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function addLogEntry(emoji, message, options = {}) {
    const ts = Number.isFinite(Number(options.ts)) ? Number(options.ts) : Date.now();
    const key = options.key || `${ts}:${emoji}:${message}`;
    if (activityLog.some(entry => entry.key === key)) return;

    activityLog.push({
        key,
        emoji,
        message,
        source: options.source || '',
        time: _formatLogTime(ts),
        ts
    });
    activityLog.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    if (activityLog.length > MAX_LOG_ENTRIES) activityLog.length = MAX_LOG_ENTRIES;
    renderActivityLog();
    // Persist to sessionStorage (device-scoped)
    try { sessionStorage.setItem(_activityLogKey(), JSON.stringify(activityLog)); } catch(e) {}
}

function renderActivityLog() {
    const container = document.getElementById('automationLog');
    const empty = document.getElementById('logEmpty');
    if (!container) return;

    if (activityLog.length === 0) {
        container.innerHTML = '<div class="log-empty" id="logEmpty">' +
            '<div class="log-empty-icon"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></div>' +
            '<div class="log-empty-title">No activity yet</div>' +
            '<div class="log-empty-sub">Firmware movement and automation events will appear here</div>' +
            '</div>';
        return;
    }
    if (empty) empty.style.display = 'none';

    container.innerHTML = activityLog.map(e =>
        `<div class="log-entry">
            <span class="log-emoji">${e.emoji}</span>
            <span class="log-msg">${escapeHtml(e.message)}</span>
            ${e.source ? `<span class="log-source">${escapeHtml(e.source)}</span>` : ''}
            <span class="log-time">${e.time}</span>
        </div>`
    ).join('');
}

function setupActivityLog() {
    // Restore from sessionStorage (device-scoped)
    try {
        const saved = sessionStorage.getItem(_activityLogKey());
        if (saved) {
            const entries = JSON.parse(saved);
            activityLog.push(...entries);
            renderActivityLog();
        }
    } catch(e) {}

    const clearBtn = document.getElementById('clearLogBtn');
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            activityLog.length = 0;
            sessionStorage.removeItem(_activityLogKey());
            renderActivityLog();
            if (typeof Toast !== 'undefined') Toast.success('Activity log cleared');
        });
    }

    const refreshBtn = document.getElementById('refreshLogBtn');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', () => {
            requestDiagnosticsSnapshot({ force: true });
            if (typeof Toast !== 'undefined') Toast.info('Refreshing diagnostics');
        });
    }

}

function _diagnosticEventTime(eventSeconds, uptimeSeconds) {
    const evt = Number(eventSeconds);
    const uptime = Number(uptimeSeconds);
    if (Number.isFinite(evt) && Number.isFinite(uptime) && uptime >= evt) {
        return Date.now() - Math.max(0, uptime - evt) * 1000;
    }
    return Date.now();
}

function _describeGeneralDiagnosticEvent(evt) {
    const cat = String(evt.cat || '').toUpperCase();
    const msg = String(evt.msg || '').trim();
    if (!msg) return null;
    const labels = {
        AUTO: 'Automation',
        CMD: 'Command',
        MOT: 'Motor',
        NET: 'Network',
        SYS: 'System'
    };
    return {
        icon: cat === 'AUTO' ? 'A' : (cat === 'CMD' ? 'C' : (cat === 'MOT' ? 'M' : 'i')),
        message: `${labels[cat] || cat || 'Event'}: ${msg}`
    };
}

function _describeStepperDiagnosticEvent(evt) {
    const type = String(evt.type || '').toUpperCase();
    const from = Number(evt.from);
    const to = Number(evt.to);
    const target = Number(evt.target);
    const dur = Number(evt.dur);
    if (type === 'MOVE') {
        const detail = Number.isFinite(dur) && dur > 0 ? ` in ${(dur / 1000).toFixed(1)}s` : '';
        return {
            icon: 'M',
            message: `Move completed: ${Number.isFinite(from) ? from : '?'} -> ${Number.isFinite(to) ? to : '?'} steps${detail}`
        };
    }
    if (type === 'E_STOP') {
        return { icon: '!', message: `Emergency stop recorded at ${Number.isFinite(to) ? to : target} steps` };
    }
    if (type === 'NUDGE') {
        return { icon: '+', message: `Stored position nudged: ${Number.isFinite(from) ? from : '?'} -> ${Number.isFinite(to) ? to : '?'} steps` };
    }
    if (type) {
        return { icon: 'M', message: `Motor event ${type}: target ${Number.isFinite(target) ? target : '?'}` };
    }
    return null;
}

function setupDiagnosticsSubscription() {
    if (typeof MQTTClient === 'undefined' || !BlindState.deviceId) return;
    if (_diagnosticsMessageHandler) {
        MQTTClient.off('onMessage', _diagnosticsMessageHandler);
        _diagnosticsMessageHandler = null;
    }
    _diagnosticsMessageHandler = (topic, payload) => {
        if (!topic || !topic.includes('/diagnostics')) return;
        if (!topic.includes(`/${BlindState.deviceId}/`)) return;
        handleDiagnosticsMessage(payload);
    };
    MQTTClient.on('onMessage', _diagnosticsMessageHandler);
}

function requestDiagnosticsSnapshot(options = {}) {
    if (typeof MQTTClient === 'undefined' || !MQTTClient.connected || !BlindState.deviceId) return false;
    const now = Date.now();
    const delay = Number(options.delay) || 0;
    if (!options.force && now - _lastDiagnosticsRequestAt < 15000) return false;
    _lastDiagnosticsRequestAt = now + delay;
    const send = () => {
        if (MQTTClient.connected) {
            MQTTClient.publishControl(BlindState.deviceId, { command: 'diagnostics', verbose: true });
        }
    };
    if (delay > 0) setTimeout(send, delay);
    else send();
    return true;
}

function handleDiagnosticsMessage(payload) {
    let diagnostics = payload;
    if (typeof payload === 'string') {
        try { diagnostics = JSON.parse(payload); } catch (err) { return; }
    }
    if (!diagnostics || typeof diagnostics !== 'object') return;

    if (diagnostics.diagnosticsTruncated) {
        addLogEntry('!', 'Diagnostics payload was truncated on the blind', {
            key: `diag-truncated:${diagnostics.requiredBytes || Date.now()}`,
            source: 'firmware'
        });
        return;
    }

    const stepper = diagnostics.stepper || {};
    const system = diagnostics.system || {};
    const uptimeSeconds = Number(system.uptime !== undefined ? system.uptime : diagnostics.timestamp);

    BlindState.maintenance.diagnosticsUpdatedAt = Date.now();
    BlindState.maintenance.uptime = Number.isFinite(uptimeSeconds) ? uptimeSeconds : null;
    BlindState.maintenance.totalMoves = stepper.totalMoves !== undefined ? Number(stepper.totalMoves) : BlindState.maintenance.totalMoves;
    BlindState.maintenance.motorCycles = stepper.motorCycles !== undefined ? Number(stepper.motorCycles) : BlindState.maintenance.motorCycles;
    BlindState.maintenance.positionModelAnomalies = stepper.positionModelAnomalies !== undefined
        ? Number(stepper.positionModelAnomalies)
        : (stepper.suspectedStalls !== undefined ? Number(stepper.suspectedStalls) : BlindState.maintenance.positionModelAnomalies);
    BlindState.maintenance.lastDiagnostics = diagnostics;

    if (stepper.calibration) {
        _mergeCalibrationTelemetry({ calibration: stepper.calibration, positionConfidence: stepper.calibration.confidence });
    }

    if (Array.isArray(diagnostics.events)) {
        diagnostics.events.forEach(evt => {
            const desc = _describeGeneralDiagnosticEvent(evt);
            if (!desc) return;
            addLogEntry(desc.icon, desc.message, {
                ts: _diagnosticEventTime(evt.t, uptimeSeconds),
                key: `diag-event:${evt.t}:${evt.cat}:${evt.msg}`,
                source: 'firmware'
            });
        });
    }

    if (Array.isArray(stepper.history)) {
        stepper.history.forEach(evt => {
            const desc = _describeStepperDiagnosticEvent(evt);
            if (!desc) return;
            if (!BlindState.maintenance.lastMove || Number(evt.t) >= Number(BlindState.maintenance.lastMove.t || 0)) {
                BlindState.maintenance.lastMove = evt;
            }
            addLogEntry(desc.icon, desc.message, {
                ts: _diagnosticEventTime(evt.t, uptimeSeconds),
                key: `stepper-event:${evt.t}:${evt.type}:${evt.from}:${evt.to}:${evt.target}`,
                source: 'firmware'
            });
        });
    }

    renderMaintenanceInsights();
    updateHealthPanel();
    updateCalibrationTools();
}

function renderMaintenanceInsights() {
    const moves = BlindState.maintenance.totalMoves;
    const cycles = BlindState.maintenance.motorCycles;
    const anomalies = BlindState.maintenance.positionModelAnomalies;
    const confidence = _numberOrNull(BlindState.calibration.confidence);
    const drift = _numberOrNull(BlindState.calibration.driftSteps);
    const powerLossPos = _numberOrNull(BlindState.calibration.lastPowerLossPosition);
    const eStopPos = _numberOrNull(BlindState.calibration.lastEmergencyStopPosition);

    _setHealthText('infoMoves', moves !== null && moves !== undefined && Number.isFinite(Number(moves)) ? String(moves) : '--');
    _setHealthText('infoCycles', cycles !== null && cycles !== undefined && Number.isFinite(Number(cycles)) ? String(cycles) : '--');
    _setHealthText('infoConfidence', confidence !== null ? `${Math.round(confidence)}%` : '--');
    _setHealthText('infoDrift', drift !== null ? _formatStepValue(drift) : '--');
    _setHealthText('infoPowerLoss', BlindState.calibration.lastPowerLossRecorded
        ? (powerLossPos !== null ? _formatStepValue(powerLossPos) : 'Recorded')
        : 'None');
    _setHealthText('infoLastStop', BlindState.calibration.lastEmergencyStopRecorded
        ? (eStopPos !== null ? _formatStepValue(eStopPos) : 'Recorded')
        : 'None');
    _setHealthText('infoStalls', anomalies !== null && anomalies !== undefined && Number.isFinite(Number(anomalies)) ? String(anomalies) : '--');
}

// ============================================
// NEW FEATURE: Morning Wake-Up Timeline
// ============================================
function updateMorningTimeline() {
    const section = document.getElementById('morningTimelineSection');
    const container = document.getElementById('morningTimeline');
    if (!section || !container) return;

    // Only show if morning rule is enabled and per-day data exists
    const days = BlindState.config.morningDays;
    if (!BlindState.rules.morningOpen || !days || !Array.isArray(days) || days.length !== 7) {
        section.style.display = 'none';
        return;
    }
    section.style.display = '';

    const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const todayIdx = new Date().getDay();

    container.innerHTML = days.map((d, i) => {
        const isToday = i === todayIdx;
        const enabled = typeof d === 'object' ? d.enabled : d;
        const time = typeof d === 'object' ? d.time : BlindState.config.morningTime;
        const cls = `timeline-day${isToday ? ' today' : ''}${!enabled ? ' disabled' : ''}`;
        return `<div class="${cls}">
            <div class="timeline-day-label">${dayLabels[i]}</div>
            <div class="timeline-day-time">${enabled ? (time || '\u2014') : 'Off'}</div>
        </div>`;
    }).join('');
}

// ============================================
// NEW FEATURE: "What Happens Next" \u2014 upcoming automation timeline
// ----------------------------------------------------------------------------
// A compact, always-visible-when-relevant strip showing the soonest scheduled
// fire for each enabled rule (morning open, night lock, sunset close) sorted by
// how soon it happens, plus the condition for the non-timed Heat Protection rule.
// Mirrors how the firmware decides what fires \u2014 all rules are firmware-executed,
// so this is a faithful preview of what the blind will do on its own.
// ============================================
function updateUpcomingAutomations() {
    const section = document.getElementById('upcomingAutomationsSection');
    const container = document.getElementById('upcomingAutomations');
    if (!section || !container) return;

    const rules = BlindState.rules || {};
    const cfg = BlindState.config || {};
    const now = new Date();
    const entries = [];

    // Soonest future occurrence of a per-day HH:MM schedule. `days` may be an
    // object[]/bool[] per-day array (index 0=Sun..6=Sat) or null (= every day).
    const nextPerDay = (days, fallbackTime) => {
        const hasPerDay = Array.isArray(days) && days.length === 7;
        for (let off = 0; off < 8; off++) {
            const d = new Date(now);
            d.setDate(now.getDate() + off);
            const dow = d.getDay();
            let enabled = true;
            let time = fallbackTime;
            if (hasPerDay) {
                const ds = days[dow];
                if (ds && typeof ds === 'object') { enabled = ds.enabled !== false; time = ds.time || fallbackTime; }
                else { enabled = ds === true; }
            }
            if (!enabled) continue;
            const parts = String(time || '').split(':');
            const h = parseInt(parts[0], 10), m = parseInt(parts[1], 10);
            if (!Number.isFinite(h) || !Number.isFinite(m)) continue;
            d.setHours(h, m, 0, 0);
            if (d.getTime() > now.getTime()) return d;
        }
        return null;
    };

    if (rules.morningOpen) {
        entries.push({ icon: '\ud83c\udf05', label: 'Morning Open', when: nextPerDay(cfg.morningDays, cfg.morningTime || '07:00'), detail: 'Gradually opens', accent: '#fbbf24' });
    }
    if (rules.nightLock) {
        entries.push({ icon: '\ud83c\udf19', label: 'Night Lock', when: nextPerDay(cfg.nightDays, cfg.nightTime || '22:00'), detail: 'Closes for the night', accent: '#a5b4fc' });
    }
    if (rules.sunset) {
        // Sunset time arrives from the device as minutes-of-day (or epoch seconds);
        // apply the effective per-device/global offset and roll to tomorrow if past.
        let when = null;
        const raw = Number(BlindState.sunsetTime);
        let baseMinutes = null;
        if (Number.isFinite(raw) && raw > 100000) { const d = new Date(raw * 1000); baseMinutes = d.getHours() * 60 + d.getMinutes(); }
        else if (Number.isFinite(raw) && raw > 0) { baseMinutes = raw; }
        const globalOffset = parseInt(localStorage.getItem('zaylo-SunsetOffset') || '0', 10);
        const perDevice = Number(cfg.sunsetOffset);
        const offset = (cfg.sunsetOffset !== null && cfg.sunsetOffset !== undefined && Number.isFinite(perDevice)) ? perDevice : globalOffset;
        if (baseMinutes !== null) {
            const d = new Date(now); d.setHours(0, baseMinutes + offset, 0, 0);
            if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
            when = d;
        }
        entries.push({ icon: '\ud83c\udf07', label: 'Sunset Close', when, detail: when ? 'Closes at sunset' : 'Waiting for sunset time', accent: '#fb923c' });
    }
    if (rules.temperature) {
        const _fmtTemp = (c) => (typeof BlindSchema !== 'undefined' && BlindSchema.formatTemp) ? BlindSchema.formatTemp(c) : `${c}\u00b0C`;
        const thresh = cfg.tempThreshold !== undefined ? cfg.tempThreshold : 30;
        let detail = `When outdoor temp > ${_fmtTemp(thresh)}`;
        if (cfg.tempReopenEnabled === true) {
            const rt = cfg.tempReopenThreshold !== undefined ? cfg.tempReopenThreshold : Math.max(0, thresh - 5);
            detail += ` \u00b7 reopens < ${_fmtTemp(rt)}`;
        }
        entries.push({ icon: '\ud83c\udf21\ufe0f', label: 'Heat Protection', when: null, detail, accent: '#f87171', conditional: true });
    }

    if (entries.length === 0) { section.style.display = 'none'; return; }
    section.style.display = '';

    // Timed entries first (soonest \u2192 latest), condition-based (Heat) last.
    entries.sort((a, b) => {
        if (a.when && b.when) return a.when - b.when;
        if (a.when) return -1;
        if (b.when) return 1;
        return 0;
    });

    const fmtWhen = (d) => {
        if (!d) return '\u2014';
        const mins = Math.round((d.getTime() - now.getTime()) / 60000);
        let rel;
        if (mins < 60) rel = `in ${Math.max(1, mins)}m`;
        else if (mins < 1440) rel = `in ${Math.floor(mins / 60)}h ${mins % 60}m`;
        else rel = `in ${Math.floor(mins / 1440)}d`;
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        const midnightNow = new Date(now); midnightNow.setHours(0, 0, 0, 0);
        const midnightD = new Date(d); midnightD.setHours(0, 0, 0, 0);
        const dayDiff = Math.round((midnightD - midnightNow) / 86400000);
        const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
        const dayLabel = dayDiff === 0 ? 'Today' : (dayDiff === 1 ? 'Tomorrow' : dow);
        return `${rel} \u00b7 ${hh}:${mm} ${dayLabel}`;
    };

    container.innerHTML = entries.map(e => `
        <div class="upcoming-row" style="display:flex; align-items:center; gap:12px; padding:12px 14px; border-radius:14px; background:var(--bg-glass); border:1px solid var(--border-glass); margin-bottom:8px;">
            <span style="font-size:20px; line-height:1;">${e.icon}</span>
            <div style="flex:1; min-width:0;">
                <div style="font-weight:700; font-size:14px; color:var(--text-primary);">${escapeHtml(e.label)}</div>
                <div style="font-size:12px; color:var(--text-tertiary);">${escapeHtml(e.detail)}</div>
            </div>
            <div style="text-align:right; flex-shrink:0; font-size:12px; font-weight:700; color:${e.conditional ? 'var(--text-tertiary)' : e.accent};">
                ${e.conditional ? 'When hot' : escapeHtml(fmtWhen(e.when))}
            </div>
        </div>
    `).join('');
}

// ============================================
// Offline Pending Badge
// --------------------------------------------
// BlindCommandQueue (blind-sync.js) is the ONE durable offline queue: it has
// expiry, retry caps, ack/rejection handling and a change event. The page used
// to keep a second localStorage queue ("blind-pending-commands-*") for the
// no-BlindCommandQueue fallback — with NO expiry, so commands queued days ago
// replayed on the next connect. That shadow queue is gone; the badge reflects
// the shared queue only.
// ============================================

// One-time migration hygiene: drop any commands stranded in the removed
// legacy queue (for EVERY device, not just this page's) so they can never
// replay and don't linger in localStorage.
function purgeLegacyPendingCommands() {
    try {
        const stale = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith('blind-pending-commands-')) stale.push(key);
        }
        stale.forEach(key => localStorage.removeItem(key));
    } catch (e) { /* best effort */ }
}

function refreshPendingIntentFromCache() {
    let pending = null;
    try {
        const saved = JSON.parse(localStorage.getItem(`blind-state-${BlindState.deviceId}`) || '{}');
        const target = Number(saved.pendingTargetPosition);
        const ts = Number(saved.pendingCommandTs);
        if (Number.isFinite(target) && Number.isFinite(ts) && Date.now() - ts < 5 * 60 * 1000) {
            pending = {
                target: Math.max(0, Math.min(100, Math.round(target))),
                status: saved.lastCommandStatus || 'pending',
                ts
            };
        }
    } catch (e) { /* best effort */ }

    BlindState.pendingTargetPosition = pending ? pending.target : null;
    BlindState.pendingCommandStatus = pending ? pending.status : null;
    BlindState.pendingCommandTs = pending ? pending.ts : null;
    return pending;
}

function updatePendingBadge() {
    const badge = document.getElementById('pendingBadge');
    const count = document.getElementById('pendingCount');
    if (!badge) return;
    const pendingIntent = refreshPendingIntentFromCache();
    let total = 0;
    if (typeof BlindCommandQueue !== 'undefined' && typeof BlindCommandQueue.getPending === 'function') {
        total = BlindCommandQueue.getPending()
            .filter(cmd => String(cmd.deviceId || '').toUpperCase() === BlindState.deviceId)
            .length;
    }
    if (total > 0) {
        badge.style.display = 'flex';
        badge.title = pendingIntent
            ? `Queued target: ${pendingIntent.target}%`
            : `${total} queued command${total === 1 ? '' : 's'}`;
        if (count) count.textContent = pendingIntent ? `${pendingIntent.target}%` : total;
    } else {
        badge.style.display = 'none';
        badge.removeAttribute('title');
    }
}

// ============================================
// NEW FEATURE: Settings Export / Import
// ============================================
function setupExportImport() {
    const exportBtn = document.getElementById('exportConfigBtn');
    const importBtn = document.getElementById('importConfigBtn');
    const fileInput = document.getElementById('importFileInput');

    if (exportBtn) {
        exportBtn.addEventListener('click', () => {
            const exportData = {
                _version: 1,
                _exportDate: new Date().toISOString(),
                _deviceId: BlindState.deviceId,
                blindType: BlindState.blindType,
                rules: BlindState.rules,
                config: BlindState.config,
                linkedDeviceId: BlindState.linkedDeviceId
            };
            const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `blinds-config-${BlindState.deviceId || 'unknown'}-${new Date().toISOString().slice(0,10)}.json`;
            a.click();
            URL.revokeObjectURL(url);
            if (typeof Toast !== 'undefined') Toast.success('Config exported');
            addLogEntry('📦', 'Configuration exported');
        });
    }

    if (importBtn && fileInput) {
        importBtn.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (evt) => {
                try {
                    const data = JSON.parse(evt.target.result);
                    if (!data._version || !data.config) {
                        if (typeof Toast !== 'undefined') Toast.error('Invalid config file');
                        return;
                    }
                    // Apply imported settings
                    if (data.blindType) BlindState.blindType = data.blindType;
                    if (data.rules) {
                        Object.assign(BlindState.rules, data.rules);
                        // Imported rules are an explicit user action.
                        BlindState._rulesProvisional = false;
                    }
                    if (data.config) {
                        // NEVER restore calibration (stepperTop/Bottom/current position):
                        // it is PHYSICAL, device-specific state. A stale backup would
                        // otherwise revert the device's limits and make reported position
                        // diverge from the real blind. The device's live calibration stays
                        // authoritative; only user settings are imported.
                        const importedCfg = { ...data.config };
                        delete importedCfg.stepperTop;
                        delete importedCfg.stepperBottom;
                        delete importedCfg.stepperCurrentPosition;
                        Object.assign(BlindState.config, importedCfg);
                    }
                    if (data.linkedDeviceId !== undefined) BlindState.linkedDeviceId = data.linkedDeviceId;

                    // Refresh UI and push through ConfigSync via saveDeviceState().
                    // ConfigSync applies the firmware unit conversions, queues while
                    // offline, and clears only after the device echoes cfgRev.
                    saveDeviceState();
                    generateVisualization();
                    updateVisualization(BlindState.position);
                    updateUI();
                    if (typeof updateConfigUI === 'function') updateConfigUI();
                    if (typeof updateLinkedDevice === 'function') updateLinkedDevice();

                    // Update rule toggles
                    Object.entries(BlindState.rules).forEach(([rule, enabled]) => {
                        const toggle = document.querySelector(`[data-rule-toggle="${rule}"]`);
                        if (toggle) {
                            toggle.checked = enabled;
                            const card = toggle.closest('.smart-rule-card');
                            if (card) card.classList.toggle('active-rule', enabled);
                        }
                    });

                    if (typeof Toast !== 'undefined') Toast.success('Config imported & applied');
                    addLogEntry('📥', 'Configuration imported from backup');
                } catch (err) {
                    console.error('[Import] Parse error:', err);
                    if (typeof Toast !== 'undefined') Toast.error('Failed to parse config file');
                }
            };
            reader.readAsText(file);
            fileInput.value = ''; // Reset so same file can be re-imported
        });
    }
}

let _presenceUnsubscribe = null;

function setupPresenceSubscription() {
    if (_presenceUnsubscribe) {
        _presenceUnsubscribe();
        _presenceUnsubscribe = null;
    }

    if (!BlindState.linkedDeviceId || typeof StateStore === 'undefined') return;

    _presenceUnsubscribe = StateStore.subscribe(BlindState.linkedDeviceId, (linkedState) => {
        if (!linkedState) return;
        const badge = document.getElementById('linkedDeviceBadge');
        if (badge) {
            badge.style.display = 'flex';
            if (linkedState.presence) {
                badge.className = 'linked-device-badge presence-badge occupied';
                badge.innerHTML = '<div class="presence-dot"></div>Occupied';
            } else {
                badge.className = 'linked-device-badge presence-badge empty';
                badge.innerHTML = '<div class="presence-dot"></div>Empty';
            }
        }
    });
}

// ============================================
// Initialize All New Features
// ============================================
function setupNewFeatures() {
    setupActivityLog();
    setupExportImport();
    setupCalibrationTools();
    updateMorningTimeline();
    purgeLegacyPendingCommands();
    updatePendingBadge();
    window.addEventListener('zaylo:blind-command-queue-change', updatePendingBadge);

    // NOTE: offline-command flushing on (re)connect is BlindCommandQueue's job
    // (blind-sync.js listens for the MQTT connect event itself).

    // Setup presence subscription for linked device
    setupPresenceSubscription();
}

// ============================================
// Page Cleanup: Prevent memory leaks on navigation
// ============================================
window.addEventListener('pagehide', (event) => {
    // Cancel any running animation frames
    if (_animFrameId) {
        cancelAnimationFrame(_animFrameId);
        _animFrameId = null;
    }
    if (_vizAnimFrameId) {
        cancelAnimationFrame(_vizAnimFrameId);
        _vizAnimFrameId = null;
    }

    if (event.persisted) return;

    // Unsubscribe presence watcher
    if (_presenceUnsubscribe) {
        _presenceUnsubscribe();
        _presenceUnsubscribe = null;
    }
    if (_blindStateUnsubscribe) {
        _blindStateUnsubscribe();
        _blindStateUnsubscribe = null;
    }
    if (_activityLogUnsubscribe) {
        _activityLogUnsubscribe();
        _activityLogUnsubscribe = null;
    }
});
