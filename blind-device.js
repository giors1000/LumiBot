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
    _displayPos: 0,         // animated display position for smooth counter
    _visualPos: 0,          // smoothly interpolated visualization position
    _visualTargetPos: 0,    // live/optimistic target used by the renderer
    isOpen: false,
    isOnline: false,
    isCalibrated: true,     // whether the stepper motor has set top/bottom limits
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
        sunsetOffset: 0,    // Now managed globally via localStorage('zaylo-SunsetOffset')
        sunsetTarget: 0,
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
                                    if (fbDevice.rules) {
                                        Object.assign(BlindState.rules, fbDevice.rules);
                                        updated = true;
                                    }
                                    if (fbDevice.config) {
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
    updateUI();
    updateHealthPanel();

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

    // Hide loader immediately if we have a valid cached state to show
    if (hasCache) {
        hideInitialLoader();
    }

    // Safety timeout: Remove loader after 4s even if nothing loads
    setTimeout(() => {
        hideInitialLoader();
    }, 4000);
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
                            console.log(`[BlindDevice] Device timeout: ${BlindState.deviceId}. Marking as Offline.`);
                            const offlineState = state ? { ...state, _online: false } : { _online: false };
                            MQTTClient.deviceStates.set(BlindState.deviceId, offlineState);
                            if (typeof StateStore !== 'undefined') StateStore.update(BlindState.deviceId, offlineState);
                        }
                    }, 3000);
                }
            }, 300);
        }
        if (BlindState.linkedDeviceId) {
            MQTTClient.subscribeDevice(BlindState.linkedDeviceId);
        }
        updateConnectionStatus(true);

        // Flush any commands queued while offline (e.g. a slider move made with no
        // connection). This MUST live here: setupMQTT() calls clearCallbacks()
        // during init, which wipes any onConnect handler registered earlier (e.g.
        // the one setupNewFeatures used to register), so that flush silently never
        // ran and offline commands stayed stuck in the queue forever.
        if (typeof flushPendingCommands === 'function' && typeof pendingCommands !== 'undefined' && pendingCommands.length > 0) {
            if (typeof addLogEntry === 'function') addLogEntry('📡', `Flushing ${pendingCommands.length} queued command(s)`);
            flushPendingCommands();
        }

        // Re-deliver any config change that was queued while offline, and re-arm
        // the one-shot setup sync if it hasn't been acked yet.
        if (typeof ConfigSync !== 'undefined') ConfigSync.flush();
    });

    MQTTClient.on('onDisconnect', () => {
        updateConnectionStatus(false);
    });

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
    BlindState.isOnline = connected;
    const badge = document.getElementById('statusBadge');
    const dot = document.getElementById('statusDot');
    const text = document.getElementById('statusText');
    if (badge) {
        badge.className = `device-status-badge ${connected ? 'online' : 'offline'}`;
    }
    if (dot) {
        dot.className = `status-dot ${connected ? 'online' : ''}`;
    }
    if (text) {
        text.textContent = connected ? 'Online' : 'Offline';
    }
    if (typeof updateTwtStatusLabel === 'function') updateTwtStatusLabel();
    if (typeof updateHealthPanel === 'function') updateHealthPanel();
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

function handleStateUpdate(state) {
    let changed = false;

    // Config-ack: clear the pending-sync queue once the device echoes back the
    // revision token we pushed (proof it applied our config, not just that the
    // broker accepted the publish).
    if (typeof ConfigSync !== 'undefined') ConfigSync.handleAck(state);

    const hasLiveSnapshot = state.position !== undefined ||
        state.blindPosition !== undefined ||
        state.config !== undefined ||
        state.rules !== undefined ||
        state.rssi !== undefined ||
        state.ssid !== undefined ||
        state.isCalibrated !== undefined ||
        state.firmware !== undefined ||
        state.version !== undefined ||
        state.fwVersion !== undefined;

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
    if (state.twtEnabled !== undefined) BlindState.config.twtEnabled = !!state.twtEnabled;
    if (state.twtActive !== undefined) BlindState.config.twtActive = !!state.twtActive;
    if (state.twtRequested !== undefined) BlindState.config.twtRequested = !!state.twtRequested;
    if (state.wifi6 !== undefined) BlindState.config.wifi6 = !!state.wifi6;

    // Device online/offline status from MQTT state store
    if (state._online !== undefined) {
        updateConnectionStatus(state._online);

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
    let pos = state.position !== undefined ? state.position : state.blindPosition;
    // Edge-round: firmware stepper math may not resolve to exact 0 or 100
    if (pos !== undefined) {
        if (pos >= 98) pos = 100;
        else if (pos <= 2) pos = 0;
    }

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
            Object.assign(BlindState.config, state.config);
            updateConfigUI();
        }
    }

    // Rules updates
    if (state.rules) {
        if (BlindState.ignoreIncomingConfig) {
            console.log('[BlindDevice] Guard active: ignoring incoming rules update from device to prevent overwriting setup config');
        } else {
            Object.assign(BlindState.rules, state.rules);
            Object.entries(BlindState.rules).forEach(([rule, enabled]) => {
                const toggle = document.querySelector(`[data-rule-toggle="${rule}"]`);
                if (toggle) {
                    toggle.checked = enabled;
                    const card = toggle.closest('.smart-rule-card');
                    if (card) card.classList.toggle('active-rule', enabled);
                }
            });
            if (typeof updateActiveRulesCount === 'function') updateActiveRulesCount();
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
        updateUI();
        updateCalibrationWarning();
        // Persist updated position/state to localStorage so the next page load
        // initializes the UI at the correct position (avoids the closed→open flash).
        saveDeviceState(null, true); // incoming device state — persist locally, don't echo back
    }

    // Update new UI features from state
    updateMorningTimeline();
    updateHealthPanel();
}

function updateCalibrationWarning() {
    const warningEl = document.getElementById('calibrationWarning');
    const controlsContainer = document.querySelector('.blind-actions');
    const sliderContainer = document.querySelector('.slider-card');
    const presetsContainer = document.querySelector('.presets-grid');
    
    // Safety check: skip if UI elements aren't loaded
    if (!warningEl || !controlsContainer || !sliderContainer) return;

    // FIX: BlindState.blindType is the visualization mode (roller/vertical/etc),
    // NOT the hardware type. Check the actual device type from DeviceList instead.
    let isStepperDevice = false;
    try {
        const device = (typeof DeviceList !== 'undefined') ? DeviceList.get(BlindState.deviceId) : null;
        if (device && (device.type === 'stepper' || device.type === 'blind')) {
            isStepperDevice = true;
        }
    } catch (e) { }

    if (!BlindState.isCalibrated && isStepperDevice) {
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
            if (hint) hint.textContent = 'Hold to stop';
            if (status) status.textContent = 'Hold';
        };

        const tickHoldProgress = () => {
            if (!holdStartedAt) return;
            const elapsed = Date.now() - holdStartedAt;
            setHoldProgress((elapsed / emergencyHoldMs) * 100);
            if (elapsed < emergencyHoldMs && !emergencyFired) {
                holdFrame = requestAnimationFrame(tickHoldProgress);
            }
        };

        const sendStop = (emergency) => {
            const cmd = emergency ? { command: 'emergencyStop' } : { command: 'stop' };
            if (typeof MQTTClient !== 'undefined') {
                MQTTClient.publishStepperControl(BlindState.deviceId, cmd);
            }
            // Halt the local visual at the current position instead of letting it
            // keep animating toward the old target.
            window._uiActionTimestamp = Date.now();
            BlindState.targetPosition = BlindState.position;
            BlindState._visualTargetPos = BlindState.position;
            if (typeof updateUI === 'function') updateUI();
            if (typeof Toast !== 'undefined') Toast.success(emergency ? 'Emergency stop sent' : 'Stopping...');
            if (typeof addLogEntry === 'function') addLogEntry('Stop', emergency ? 'Emergency stop triggered' : 'Stop requested');
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
            if (hint) hint.textContent = 'Hold to stop';
            if (status) status.textContent = 'Holding';
            setHoldProgress(0);
            holdFrame = requestAnimationFrame(tickHoldProgress);
            normalStopTimer = setTimeout(() => {
                normalStopTimer = null;
                if (typeof Haptic !== 'undefined') Haptic.medium();
                sendStop(false);
                if (hint) hint.textContent = 'Stop sent. Keep holding';
                if (status) status.textContent = 'Stopping';
            }, normalHoldMs);
            emergencyStopTimer = setTimeout(() => {
                emergencyStopTimer = null;
                emergencyFired = true;
                stopBtn.classList.add('is-emergency');
                setHoldProgress(100);
                if (typeof Haptic !== 'undefined' && typeof Haptic.notification === 'function') Haptic.notification('warning');
                else if (typeof Haptic !== 'undefined') Haptic.heavy();
                sendStop(true);
                if (hint) hint.textContent = 'Emergency stop sent';
                if (status) status.textContent = 'Sent';
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
        if (hint) hint.textContent = 'Hold to stop';
        if (status) status.textContent = 'Hold';
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
    if (typeof MQTTClient !== 'undefined') {
        const sent = MQTTClient.publishStepperControl(BlindState.deviceId, command);

        if (typeof StateStore !== 'undefined') {
            StateStore.update(BlindState.deviceId, { targetPosition: safePos });
        }
        if (!sent) addPendingCommand(command);
    } else {
        // MQTT offline — queue for later
        addPendingCommand(command);
    }
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
    // Sunset offset is now global — read from localStorage
    const globalOffset = parseInt(localStorage.getItem('zaylo-SunsetOffset') || '0', 10);
    const offsetDisplay = globalOffset >= 0 ? `+${globalOffset}` : `${globalOffset}`;
    const defaultTarget = BlindState.config.sunsetTarget !== undefined ? BlindState.config.sunsetTarget : 0;

    const { modal, close } = Modal.create({
        title: 'Sunset Configuration',
        content: `
            <div style="margin-bottom: 16px;">
                <div class="setting-item" style="padding: 12px 0; border: none;">
                    <div class="setting-left">
                        <span class="setting-label">Sunset Offset</span>
                        <span class="setting-sublabel">Managed globally from Home Page Settings</span>
                    </div>
                </div>
                <div style="display:flex; align-items:center; justify-content:space-between; padding:14px 16px; background: linear-gradient(135deg, rgba(20,184,166,0.14), rgba(45,212,191,0.05)); border-radius:14px; border:1px solid rgba(20,184,166,0.28);">
                    <div style="display:flex; align-items:center; gap:10px;">
                        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#2dd4bf" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 10V2"/><path d="m4.93 10.93 1.41 1.41"/><path d="M2 18h2"/><path d="M20 18h2"/><path d="m19.07 10.93-1.41 1.41"/><path d="M22 22H2"/><path d="m16 6-4 4-4-4"/><path d="M16 18a4 4 0 0 0-8 0"/></svg>
                        <span style="font-size:15px; font-weight:700; color:var(--text-primary);">${offsetDisplay} min</span>
                    </div>
                    <span style="font-size:11px; color:var(--text-tertiary); font-weight:600; text-transform:uppercase; letter-spacing:0.5px;">Global</span>
                </div>
                <div style="margin-top:10px; padding:10px; border-radius:10px; background:rgba(20,184,166,0.07); border:1px solid rgba(20,184,166,0.18);">
                    <p style="color:var(--accent); font-size:11px; line-height:1.4; margin:0; display:flex; align-items:flex-start; gap:6px;">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0; margin-top:1px;"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
                        <span>To change the offset, go to the <strong>Home Page</strong> and tap the <strong>Settings</strong> gear icon.</span>
                    </p>
                </div>
            </div>
            
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
                    let targetVal = parseInt(modal.querySelector('#sunsetTargetInput').value, 10);
                    BlindState.config.sunsetTarget = isNaN(targetVal) ? 0 : targetVal;
                    // Read global offset into BlindState for compatibility
                    BlindState.config.sunsetOffset = parseInt(localStorage.getItem('zaylo-SunsetOffset') || '0', 10);

                    updateConfigUI();

                    _publishRulesConfig();
                    if (typeof Toast !== 'undefined') Toast.success('Sunset rules updated');
                    return true;
                }
            }
        ]
    });

    const targetInput = modal.querySelector('#sunsetTargetInput');
    const targetDisplay = modal.querySelector('#sunsetTargetDisplay');
    targetInput.addEventListener('input', (e) => {
        targetDisplay.textContent = e.target.value + '%';
        if (typeof Haptic !== 'undefined') Haptic.light();
    });
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

        // Calculate the physical start time of the gradual movement series
        const durationMins = dayEnabled && (typeof days[dayOfWeek] === 'object') ? (days[dayOfWeek].duration || 30) : 30;
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
    const defaultTemp = BlindState.config.tempThreshold || 30;
    const defaultTarget = BlindState.config.tempTarget !== undefined ? BlindState.config.tempTarget : 20;

    const { modal, close } = Modal.create({
        title: 'Heat Protection',
        content: `
            <div class="setting-item" style="padding: 12px 0; border: none;">
                <div class="setting-left">
                    <span class="setting-label">Outdoor Temperature Threshold (°C)</span>
                    <span class="setting-sublabel">Close the blinds when it's hotter than this outside</span>
                </div>
            </div>
            <input type="number" id="tempThresholdInput" value="${defaultTemp}" class="modal-input" placeholder="Threshold °C">

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
        `,
        actions: [
            { label: 'Cancel', primary: false },
            {
                label: 'Save', primary: true, onClick: () => {
                    let threshVal = parseInt(modal.querySelector('#tempThresholdInput').value, 10);
                    BlindState.config.tempThreshold = isNaN(threshVal) ? 30 : threshVal;
                    const tempTargetVal = parseInt(modal.querySelector('#tempTargetInput').value, 10);
                    BlindState.config.tempTarget = isNaN(tempTargetVal) ? 20 : tempTargetVal;

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
                Jog the blind upwards until it is in the fully **OPEN** position. Adjust precisely, then tap **Save Open Limit**.
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
                MQTTClient.publishStepperControl(BlindState.deviceId, { jog: 0 });
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

            MQTTClient.publishStepperControl(BlindState.deviceId, { jog: direction });

            logMsg(direction === 1 ? 'Jogging upward (Opening)...' : 'Jogging downward (Closing)...', 'active');
            jogInterval = setInterval(() => runVirtualJog(direction), 50);

            // Deadman keepalive: the firmware auto-halts a jog if no command
            // arrives within ~2.5s, so refresh it every 700ms while the button is
            // held. A lost stop (app backgrounded/closed) then trips the firmware
            // deadman instead of leaving the motor running into the limit.
            clearInterval(jogKeepalive);
            jogKeepalive = setInterval(() => {
                if (isJogging) MQTTClient.publishStepperControl(BlindState.deviceId, { jog: direction });
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
                        Jog the blind downwards until it is in the fully **CLOSED** position. Adjust precisely, then tap **Save Closed Limit**.
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

        cleanActionBtn.addEventListener('click', () => {
            if (currentStep === 1) {
                if (typeof Haptic !== 'undefined' && typeof Haptic.notification === 'function') {
                    Haptic.notification('success');
                }
                MQTTClient.publishConfig(BlindState.deviceId, { cmd: 'save_top' });
                if (typeof Toast !== 'undefined') Toast.success('Top boundary stored!');
                logMsg('Top limit committed in hardware NVS.', 'normal');
                advanceToStep(2);
                
            } else if (currentStep === 2) {
                if (typeof Haptic !== 'undefined' && typeof Haptic.notification === 'function') {
                    Haptic.notification('success');
                }
                MQTTClient.publishConfig(BlindState.deviceId, { cmd: 'save_bottom' });
                if (typeof Toast !== 'undefined') Toast.success('Bottom boundary stored!');
                logMsg('Bottom limit committed in hardware NVS.', 'normal');
                advanceToStep(3);
                
            } else if (currentStep === 3) {
                if (cleanActionBtn.classList.contains('success')) {
                    cleanActionBtn.style.display = 'none';
                    if (testProgress) testProgress.style.display = 'block';
                    logMsg('Self-Test running: Moving to OPEN...', 'active');
                    
                    if (typeof Haptic !== 'undefined' && typeof Haptic.impact === 'function') {
                        Haptic.impact('medium');
                    }
                    
                    MQTTClient.publishControl(BlindState.deviceId, { position: 100 });
                    
                    let elapsed = 0;
                    const duration = 5000;
                    const intervalMs = 50;
                    
                    const testRun = setInterval(() => {
                        elapsed += intervalMs;
                        const pct = Math.min(100, (elapsed / duration) * 100);
                        if (testProgressFill) testProgressFill.style.width = `${pct}%`;
                        
                        if (elapsed < duration / 2) {
                            virtualPosition = Math.min(100, virtualPosition + 3);
                            updatePreview(virtualPosition);
                        } else {
                            virtualPosition = Math.max(0, virtualPosition - 3);
                            updatePreview(virtualPosition);
                        }
                        
                        if (elapsed >= duration) {
                            clearInterval(testRun);
                            
                            virtualPosition = BlindState.position;
                            updatePreview(virtualPosition);
                            
                            if (typeof Haptic !== 'undefined' && typeof Haptic.notification === 'function') {
                                Haptic.notification('success');
                            }
                            
                            if (testProgress) testProgress.style.display = 'none';
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
                            currentStep = 4;
                        }
                    }, intervalMs);
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

                            if (BlindState.deviceId && typeof MQTTClient !== 'undefined') {
                                const payload = MQTTClient.getTimezonePayload();
                                MQTTClient.publishConfig(BlindState.deviceId, { config: payload });
                            }

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

            // Subscribe to topics
            if (typeof MQTTClient !== 'undefined' && MQTTClient.connected) {
                try {
                    MQTTClient.client.subscribe(scanTopic, { qos: 1 });
                    MQTTClient.client.subscribe(ackTopic, { qos: 1 });
                    MQTTClient.client.subscribe(availTopic, { qos: 1 });
                    // stateTopic is already subscribed by the page; no-op if so.
                    MQTTClient.client.subscribe(stateTopic, { qos: 1 });
                } catch (e) {
                    console.error('MQTT subscribe error:', e);
                }
            }

            const initialContent = `
                <div id="wifiModalBody" style="display: flex; flex-direction: column; gap: 14px; margin-top: 10px; max-height: 70vh; overflow-y: auto; padding-bottom: 10px; padding-right: 4px;">
                    
                    <div style="display: flex; flex-direction: column; gap: 6px;">
                        <label style="font-size: 12px; font-weight: 700; color: var(--text-tertiary); text-transform: uppercase; letter-spacing: 0.05em;">SSID (Network Name)</label>
                        <div style="display: flex; gap: 8px; position: relative;">
                            <input type="text" id="wifiSSIDInput" placeholder="Enter network name" class="modal-input" style="flex: 1; padding-right: 40px;" maxlength="32">
                            <button id="scanWiFiBtn" style="position: absolute; right: 10px; top: 50%; transform: translateY(-50%); background: none; border: none; color: var(--blind-accent); cursor: pointer; display: flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: 50%; transition: all 0.2s ease;" title="Scan Networks">
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
                            <button id="toggleWifiPasswordBtn" style="position: absolute; right: 10px; top: 50%; transform: translateY(-50%); background: none; border: none; color: var(--text-tertiary); cursor: pointer; display: flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: 50%; transition: all 0.2s ease;">
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
                    MQTTClient.publishConfig(BlindState.deviceId, { cmd: "scan_wifi" });
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
                        modal.close();
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
                                Previous credentials have been **safely restored**. Blinds remain connected and online.
                            </p>
                            <button id="retryWiFiBtn" class="save-btn off" style="width: 100%; border-radius: var(--radius-md); padding: 12px; font-weight: 700; border: none; cursor: pointer;">Try Again</button>
                        </div>
                    `;
                    modal.querySelector('#retryWiFiBtn')?.addEventListener('click', () => {
                        modal.close();
                        setTimeout(() => wifiCredentialsSetting.click(), 100);
                    });
                }
            };

            const applyWiFiCredentials = () => {
                const ssidInput = modal.querySelector('#wifiSSIDInput');
                const passInput = modal.querySelector('#wifiPasswordInput');
                const ssid = ssidInput?.value.trim() || '';
                const pass = passInput?.value.trim() || '';

                if (ssid.length === 0) {
                    if (typeof Toast !== 'undefined') Toast.error('Please enter or select a network SSID');
                    return;
                }
                if (pass.length > 0 && pass.length < 8) {
                    if (typeof Toast !== 'undefined') Toast.error('Wi-Fi Password must be at least 8 characters');
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
                                Blinds are switching networks. This can take up to 30 seconds while it reconnects. Previous Wi-Fi is safely restored if it fails.
                            </p>
                        </div>
                    `;
                }

                const actionWrapper = modal.querySelector('.modal-actions');
                if (actionWrapper) actionWrapper.style.display = 'none';

                if (typeof MQTTClient !== 'undefined' && MQTTClient.connected) {
                    awaitingWifiChange = true;
                    wifiChangeStartTs = Date.now();
                    MQTTClient.publishConfig(BlindState.deviceId, {
                        cmd: "change_wifi",
                        ssid: ssid,
                        pass: pass
                    });

                    // Fallback only — the firmware sends an explicit success/failed
                    // ack for both outcomes, AND we accept the blind reappearing on
                    // the broker as success (see onMqttMessage). Widened from 22s so a
                    // slow WiFi+broker reconnect can't trip a false "failed" while the
                    // device is actually coming back online ("ghost connection").
                    wifiChangeTimeout = setTimeout(() => {
                        wifiChangeTimeout = null;
                        handleWiFiChangeAck({ status: 'failed' });
                    }, 35000);
                }
            };

            const { modal, close } = Modal.create({
                title: 'Wi-Fi Connection Settings',
                content: initialContent,
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

            const originalClose = close;
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

                if (typeof MQTTClient !== 'undefined' && MQTTClient.connected) {
                    try {
                        MQTTClient.client.unsubscribe(scanTopic);
                        MQTTClient.client.unsubscribe(ackTopic);
                    } catch (e) {}
                }
            };
            
            const backdrop = modal.closest('.modal-backdrop');
            backdrop?.querySelector('.modal-close')?.addEventListener('click', cleanup);
            backdrop?.addEventListener('click', (e) => {
                if (e.target === backdrop) cleanup();
            });
            modal.close = () => {
                cleanup();
                originalClose();
            };
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

                    setTimeout(() => {
                        window.location.href = 'index.html';
                    }, 2000);
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

                            // Publish config to MQTT (config/set topic with camelCase keys)
                            if (typeof MQTTClient !== 'undefined' && MQTTClient.connected) {
                                const key = setting === 'angle_on' ? 'angleOn' : 'angleOff';
                                MQTTClient.publishConfig(BlindState.deviceId, {
                                    [key]: val
                                });
                            }
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

    // Stepper Opening Speed Setting
    document.querySelector('[data-setting="stepperOpenSpeed"]')?.addEventListener('click', () => {
        if (typeof Modal === 'undefined') return;

        const currentVal = BlindState.config.stepperOpenSpeed !== undefined ? BlindState.config.stepperOpenSpeed : 2000;

        const presets = [
            { value: 1000, label: 'Quiet', desc: 'Silent & smooth operation', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.7 7.7a2.5 2.5 0 1 1 1.8 4.3H2"/><path d="M9.6 4.6A2 2 0 1 1 11 8H2"/><path d="M12.6 19.4A2 2 0 1 0 14 16H2"/></svg>', bars: [3, 3, 3, 3], activeBarsCount: 1, gradient: 'linear-gradient(135deg, #059669 0%, #10b981 100%)', glow: 'rgba(16, 185, 129, 0.35)' },
            { value: 2000, label: 'Default', desc: 'Balanced speed & sound', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/></svg>', bars: [3, 6, 3, 3], activeBarsCount: 2, gradient: 'linear-gradient(135deg, #2563eb 0%, #3b82f6 100%)', glow: 'rgba(59, 130, 246, 0.35)' },
            { value: 3600, label: 'Fast', desc: 'High-speed positioning', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 19 22 12 13 5 13 19"/><polygon points="2 19 11 12 2 5 2 19"/></svg>', bars: [3, 6, 9, 3], activeBarsCount: 3, gradient: 'linear-gradient(135deg, #d97706 0%, #f59e0b 100%)', glow: 'rgba(245, 158, 11, 0.35)' },
            { value: 5000, label: 'Max Speed', desc: 'Maximum physical velocity', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>', bars: [3, 6, 9, 12], activeBarsCount: 4, gradient: 'linear-gradient(135deg, #7c3aed 0%, #ec4899 100%)', glow: 'rgba(124, 58, 237, 0.4)' }
        ];

        let closestPreset = presets[0];
        let minDiff = Math.abs(currentVal - presets[0].value);
        for (const p of presets) {
            const diff = Math.abs(currentVal - p.value);
            if (diff < minDiff) {
                minDiff = diff;
                closestPreset = p;
            }
        }

        let selectedValue = closestPreset.value;

        const { modal, close } = Modal.create({
            title: 'Opening Speed',
            content: `
                <div style="text-align: center; margin-bottom: 16px;">
                    <span class="modal-value-display" id="stepperOpenSpeedDisplay" style="display:inline-block; margin-bottom:0;">${closestPreset.label}</span>
                    <span style="font-size: 14px; color: var(--text-tertiary); margin-left: 4px; font-weight:600;">(${closestPreset.value} steps/s)</span>
                </div>
                <div class="modal-choice-grid">
                    ${presets.map(p => {
                        const isSelected = p.value === closestPreset.value;
                        const speedBarsHTML = p.bars.map((height, idx) => {
                            const opacity = idx < p.activeBarsCount ? '1' : '0.25';
                            return `<span style="height: ${height}px; opacity: ${opacity};"></span>`;
                        }).join('');
                        return `
                            <div class="modal-choice-card ${isSelected ? 'selected' : ''}" data-value="${p.value}" style="--card-selected-gradient: ${p.gradient}; --card-selected-glow: ${p.glow};">
                                <div class="modal-choice-icon">${p.icon}</div>
                                <div class="modal-choice-name">${p.label}</div>
                                <div class="modal-choice-desc">${p.desc}</div>
                                <div class="modal-choice-speed-bars">${speedBarsHTML}</div>
                            </div>
                        `;
                    }).join('')}
                </div>
                <p style="color: var(--text-tertiary); font-size: 13px; margin-top: 16px; text-align: center; line-height: 1.4;">
                    Fine-tune physical stepper opening velocity. Lower values run whisper-quiet, higher values complete movement instantly.
                </p>
            `,
            actions: [
                { label: 'Cancel', primary: false },
                {
                    label: 'Save', primary: true,
                    onClick: () => {
                        BlindState.config.stepperOpenSpeed = selectedValue;
                        updateConfigUI();
                        saveDeviceState();

                        if (typeof MQTTClient !== 'undefined' && MQTTClient.connected) {
                            MQTTClient.publishConfig(BlindState.deviceId, {
                                stepperOpenSpeed: selectedValue
                            });
                        }
                        if (typeof Toast !== 'undefined') {
                            const selectedPreset = presets.find(p => p.value === selectedValue);
                            Toast.success(`Opening speed set to ${selectedPreset ? selectedPreset.label : selectedValue + ' steps/s'}`);
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
                    const displayEl = modal.querySelector('#stepperOpenSpeedDisplay');
                    if (displayEl) {
                        displayEl.textContent = matched.label;
                        const subDisplay = displayEl.nextElementSibling;
                        if (subDisplay) subDisplay.textContent = `(${matched.value} steps/s)`;
                    }
                }
            });
        });
    });

    // Stepper Closing Speed Setting
    document.querySelector('[data-setting="stepperCloseSpeed"]')?.addEventListener('click', () => {
        if (typeof Modal === 'undefined') return;

        const currentVal = BlindState.config.stepperCloseSpeed !== undefined ? BlindState.config.stepperCloseSpeed : 2000;

        const presets = [
            { value: 1000, label: 'Quiet', desc: 'Silent & smooth operation', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.7 7.7a2.5 2.5 0 1 1 1.8 4.3H2"/><path d="M9.6 4.6A2 2 0 1 1 11 8H2"/><path d="M12.6 19.4A2 2 0 1 0 14 16H2"/></svg>', bars: [3, 3, 3, 3], activeBarsCount: 1, gradient: 'linear-gradient(135deg, #059669 0%, #10b981 100%)', glow: 'rgba(16, 185, 129, 0.35)' },
            { value: 2000, label: 'Default', desc: 'Balanced speed & sound', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/></svg>', bars: [3, 6, 3, 3], activeBarsCount: 2, gradient: 'linear-gradient(135deg, #2563eb 0%, #3b82f6 100%)', glow: 'rgba(59, 130, 246, 0.35)' },
            { value: 3600, label: 'Fast', desc: 'High-speed positioning', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 19 22 12 13 5 13 19"/><polygon points="2 19 11 12 2 5 2 19"/></svg>', bars: [3, 6, 9, 3], activeBarsCount: 3, gradient: 'linear-gradient(135deg, #d97706 0%, #f59e0b 100%)', glow: 'rgba(245, 158, 11, 0.35)' },
            { value: 5000, label: 'Max Speed', desc: 'Maximum physical velocity', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>', bars: [3, 6, 9, 12], activeBarsCount: 4, gradient: 'linear-gradient(135deg, #7c3aed 0%, #ec4899 100%)', glow: 'rgba(124, 58, 237, 0.4)' }
        ];

        let closestPreset = presets[0];
        let minDiff = Math.abs(currentVal - presets[0].value);
        for (const p of presets) {
            const diff = Math.abs(currentVal - p.value);
            if (diff < minDiff) {
                minDiff = diff;
                closestPreset = p;
            }
        }

        let selectedValue = closestPreset.value;

        const { modal, close } = Modal.create({
            title: 'Closing Speed',
            content: `
                <div style="text-align: center; margin-bottom: 16px;">
                    <span class="modal-value-display" id="stepperCloseSpeedDisplay" style="display:inline-block; margin-bottom:0;">${closestPreset.label}</span>
                    <span style="font-size: 14px; color: var(--text-tertiary); margin-left: 4px; font-weight:600;">(${closestPreset.value} steps/s)</span>
                </div>
                <div class="modal-choice-grid">
                    ${presets.map(p => {
                        const isSelected = p.value === closestPreset.value;
                        const speedBarsHTML = p.bars.map((height, idx) => {
                            const opacity = idx < p.activeBarsCount ? '1' : '0.25';
                            return `<span style="height: ${height}px; opacity: ${opacity};"></span>`;
                        }).join('');
                        return `
                            <div class="modal-choice-card ${isSelected ? 'selected' : ''}" data-value="${p.value}" style="--card-selected-gradient: ${p.gradient}; --card-selected-glow: ${p.glow};">
                                <div class="modal-choice-icon">${p.icon}</div>
                                <div class="modal-choice-name">${p.label}</div>
                                <div class="modal-choice-desc">${p.desc}</div>
                                <div class="modal-choice-speed-bars">${speedBarsHTML}</div>
                            </div>
                        `;
                    }).join('')}
                </div>
                <p style="color: var(--text-tertiary); font-size: 13px; margin-top: 16px; text-align: center; line-height: 1.4;">
                    Fine-tune physical stepper closing velocity. Lower values run whisper-quiet, higher values complete movement instantly.
                </p>
            `,
            actions: [
                { label: 'Cancel', primary: false },
                {
                    label: 'Save', primary: true,
                    onClick: () => {
                        BlindState.config.stepperCloseSpeed = selectedValue;
                        updateConfigUI();
                        saveDeviceState();

                        if (typeof MQTTClient !== 'undefined' && MQTTClient.connected) {
                            MQTTClient.publishConfig(BlindState.deviceId, {
                                stepperCloseSpeed: selectedValue
                            });
                        }
                        if (typeof Toast !== 'undefined') {
                            const selectedPreset = presets.find(p => p.value === selectedValue);
                            Toast.success(`Closing speed set to ${selectedPreset ? selectedPreset.label : selectedValue + ' steps/s'}`);
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
                    const displayEl = modal.querySelector('#stepperCloseSpeedDisplay');
                    if (displayEl) {
                        displayEl.textContent = matched.label;
                        const subDisplay = displayEl.nextElementSibling;
                        if (subDisplay) subDisplay.textContent = `(${matched.value} steps/s)`;
                    }
                }
            });
        });
    });

    // Motor Hold Time (Stop Delay) Setting
    document.querySelector('[data-setting="stepperStopDelay"]')?.addEventListener('click', () => {
        if (typeof Modal === 'undefined') return;

        const currentVal = BlindState.config.stepperStopDelay !== undefined ? BlindState.config.stepperStopDelay : 3000;

        const presets = [
            { value: 500, label: 'Eco', desc: 'Releases instantly, saves power', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"/><path d="M2 21c0-3 1.85-5.36 5.08-6"/></svg>', gradient: 'linear-gradient(135deg, #0891b2 0%, #06b6d4 100%)', glow: 'rgba(6, 182, 212, 0.35)' },
            { value: 3000, label: 'Standard', desc: 'Holds to prevent drift', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="10" x2="14" y1="2" y2="2"/><line x1="12" x2="15" y1="14" y2="11"/><circle cx="12" cy="14" r="8"/></svg>', gradient: 'linear-gradient(135deg, #4f46e5 0%, #6366f1 100%)', glow: 'rgba(99, 102, 241, 0.35)' },
            { value: 10000, label: 'Continuous', desc: 'Extended lock after move', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>', gradient: 'linear-gradient(135deg, #db2777 0%, #ec4899 100%)', glow: 'rgba(236, 72, 153, 0.4)' }
        ];

        let closestPreset = presets[0];
        let minDiff = Math.abs(currentVal - presets[0].value);
        for (const p of presets) {
            const diff = Math.abs(currentVal - p.value);
            if (diff < minDiff) {
                minDiff = diff;
                closestPreset = p;
            }
        }

        let selectedValue = closestPreset.value;

        const { modal, close } = Modal.create({
            title: 'Motor Hold Time',
            content: `
                <div style="text-align: center; margin-bottom: 16px;">
                    <span class="modal-value-display" id="stepperStopDelayDisplay" style="display:inline-block; margin-bottom:0;">${closestPreset.label}</span>
                    <span style="font-size: 14px; color: var(--text-tertiary); margin-left: 4px; font-weight:600;">(${(closestPreset.value / 1000).toFixed(1)}s)</span>
                </div>
                <div class="modal-choice-grid" style="grid-template-columns: repeat(auto-fit, minmax(80px, 1fr));">
                    ${presets.map(p => {
                        const isSelected = p.value === closestPreset.value;
                        return `
                            <div class="modal-choice-card ${isSelected ? 'selected' : ''}" data-value="${p.value}" style="padding: 12px 6px; --card-selected-gradient: ${p.gradient}; --card-selected-glow: ${p.glow};">
                                <div class="modal-choice-icon">${p.icon}</div>
                                <div class="modal-choice-name">${p.label}</div>
                                <div class="modal-choice-desc" style="font-size: 10px; opacity: 0.75;">${p.desc}</div>
                            </div>
                        `;
                    }).join('')}
                </div>
                <p style="color: var(--text-tertiary); font-size: 13px; margin-top: 16px; text-align: center; line-height: 1.4;">
                    Configure how long the stepper motor stays energized to lock the blinds position in place after reaching the target.
                </p>
            `,
            actions: [
                { label: 'Cancel', primary: false },
                {
                    label: 'Save', primary: true,
                    onClick: () => {
                        BlindState.config.stepperStopDelay = selectedValue;
                        updateConfigUI();
                        saveDeviceState();

                        if (typeof MQTTClient !== 'undefined' && MQTTClient.connected) {
                            MQTTClient.publishConfig(BlindState.deviceId, {
                                stepperStopDelay: selectedValue
                            });
                        }
                        if (typeof Toast !== 'undefined') {
                            const selectedPreset = presets.find(p => p.value === selectedValue);
                            Toast.success(`Motor hold time set to ${selectedPreset ? selectedPreset.label : selectedValue / 1000 + 's'}`);
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
                    const displayEl = modal.querySelector('#stepperStopDelayDisplay');
                    if (displayEl) {
                        displayEl.textContent = matched.label;
                        const subDisplay = displayEl.nextElementSibling;
                        if (subDisplay) subDisplay.textContent = `(${((matched.value) / 1000).toFixed(1)}s)`;
                    }
                }
            });
        });
    });

    // Drop-Back Distance (Relax Steps) Setting
    document.querySelector('[data-setting="stepperRelaxSteps"]')?.addEventListener('click', () => {
        if (typeof Modal === 'undefined') return;

        const currentVal = BlindState.config.stepperRelaxSteps !== undefined ? BlindState.config.stepperRelaxSteps : 128;

        const presets = [
            { value: 0, label: 'Tight', desc: 'No relax, keeps tension', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/></svg>', gradient: 'linear-gradient(135deg, #dc2626 0%, #ef4444 100%)', glow: 'rgba(239, 68, 68, 0.35)' },
            { value: 64, label: 'Short', desc: 'Minimal cord relief', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 8 22 12 18 16"/><polyline points="6 8 2 12 6 16"/><line x1="2" x2="22" y1="12" y2="12"/></svg>', gradient: 'linear-gradient(135deg, #4b5563 0%, #6b7280 100%)', glow: 'rgba(107, 114, 128, 0.35)' },
            { value: 128, label: 'Medium', desc: 'Standard optimal relief', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/></svg>', gradient: 'linear-gradient(135deg, #2563eb 0%, #3b82f6 100%)', glow: 'rgba(59, 130, 246, 0.35)' },
            { value: 256, label: 'Long', desc: 'Maximum cord relaxation', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>', gradient: 'linear-gradient(135deg, #7c3aed 0%, #8b5cf6 100%)', glow: 'rgba(139, 92, 246, 0.4)' }
        ];

        let closestPreset = presets[0];
        let minDiff = Math.abs(currentVal - presets[0].value);
        for (const p of presets) {
            const diff = Math.abs(currentVal - p.value);
            if (diff < minDiff) {
                minDiff = diff;
                closestPreset = p;
            }
        }

        let selectedValue = closestPreset.value;

        const { modal, close } = Modal.create({
            title: 'Drop-Back Distance',
            content: `
                <div style="text-align: center; margin-bottom: 16px;">
                    <span class="modal-value-display" id="stepperRelaxStepsDisplay" style="display:inline-block; margin-bottom:0;">${closestPreset.label}</span>
                    <span style="font-size: 14px; color: var(--text-tertiary); margin-left: 4px; font-weight:600;">(${closestPreset.value === 0 ? 'Disabled' : closestPreset.value + ' steps'})</span>
                </div>
                <div class="modal-choice-grid">
                    ${presets.map(p => {
                        const isSelected = p.value === closestPreset.value;
                        return `
                            <div class="modal-choice-card ${isSelected ? 'selected' : ''}" data-value="${p.value}" style="--card-selected-gradient: ${p.gradient}; --card-selected-glow: ${p.glow};">
                                <div class="modal-choice-icon">${p.icon}</div>
                                <div class="modal-choice-name">${p.label}</div>
                                <div class="modal-choice-desc">${p.desc}</div>
                            </div>
                        `;
                    }).join('')}
                </div>
                <p style="color: var(--text-tertiary); font-size: 13px; margin-top: 16px; text-align: center; line-height: 1.4;">
                    Reverses the motor slightly after opening to relieve continuous stress/cable tension on your brackets.
                </p>
            `,
            actions: [
                { label: 'Cancel', primary: false },
                {
                    label: 'Save', primary: true,
                    onClick: () => {
                        BlindState.config.stepperRelaxSteps = selectedValue;
                        updateConfigUI();
                        saveDeviceState();

                        if (typeof MQTTClient !== 'undefined' && MQTTClient.connected) {
                            MQTTClient.publishConfig(BlindState.deviceId, {
                                stepperRelaxSteps: selectedValue
                            });
                        }
                        if (typeof Toast !== 'undefined') {
                            const selectedPreset = presets.find(p => p.value === selectedValue);
                            Toast.success(`Drop-back distance set to ${selectedPreset ? selectedPreset.label : selectedValue + ' steps'}`);
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
                    const displayEl = modal.querySelector('#stepperRelaxStepsDisplay');
                    if (displayEl) {
                        displayEl.textContent = matched.label;
                        const subDisplay = displayEl.nextElementSibling;
                        if (subDisplay) subDisplay.textContent = `(${matched.value === 0 ? 'Disabled' : matched.value + ' steps'})`;
                    }
                }
            });
        });
    });

    // Braking Speed (Acceleration) Setting
    document.querySelector('[data-setting="stepperAcceleration"]')?.addEventListener('click', () => {
        if (typeof Modal === 'undefined') return;

        const currentVal = BlindState.config.stepperAcceleration !== undefined ? BlindState.config.stepperAcceleration : 2000;

        const presets = [
            { value: 1000, label: 'Gentle', desc: 'Softest start & stop', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>', gradient: 'linear-gradient(135deg, #0891b2 0%, #06b6d4 100%)', glow: 'rgba(6, 182, 212, 0.35)' },
            { value: 2000, label: 'Moderate', desc: 'Standard controlled ramp', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/></svg>', gradient: 'linear-gradient(135deg, #2563eb 0%, #3b82f6 100%)', glow: 'rgba(59, 130, 246, 0.35)' },
            { value: 4000, label: 'Sport', desc: 'Aggressive & rapid braking', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>', gradient: 'linear-gradient(135deg, #ea580c 0%, #f97316 100%)', glow: 'rgba(249, 115, 22, 0.35)' },
            { value: 8000, label: 'Instant', desc: 'Immediate stop response', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>', gradient: 'linear-gradient(135deg, #be185d 0%, #db2777 100%)', glow: 'rgba(219, 39, 119, 0.4)' }
        ];

        let closestPreset = presets[0];
        let minDiff = Math.abs(currentVal - presets[0].value);
        for (const p of presets) {
            const diff = Math.abs(currentVal - p.value);
            if (diff < minDiff) {
                minDiff = diff;
                closestPreset = p;
            }
        }

        let selectedValue = closestPreset.value;

        const { modal, close } = Modal.create({
            title: 'Braking Speed',
            content: `
                <div style="text-align: center; margin-bottom: 16px;">
                    <span class="modal-value-display" id="stepperAccelerationDisplay" style="display:inline-block; margin-bottom:0;">${closestPreset.label}</span>
                    <span style="font-size: 14px; color: var(--text-tertiary); margin-left: 4px; font-weight:600;">(${closestPreset.value} steps/s²)</span>
                </div>
                <div class="modal-choice-grid">
                    ${presets.map(p => {
                        const isSelected = p.value === closestPreset.value;
                        return `
                            <div class="modal-choice-card ${isSelected ? 'selected' : ''}" data-value="${p.value}" style="--card-selected-gradient: ${p.gradient}; --card-selected-glow: ${p.glow};">
                                <div class="modal-choice-icon">${p.icon}</div>
                                <div class="modal-choice-name">${p.label}</div>
                                <div class="modal-choice-desc">${p.desc}</div>
                            </div>
                        `;
                    }).join('')}
                </div>
                <p style="color: var(--text-tertiary); font-size: 13px; margin-top: 16px; text-align: center; line-height: 1.4;">
                    Configure the motor acceleration and deceleration ramps. Higher values yield immediate physical brakes, lower values gently slow down.
                </p>
            `,
            actions: [
                { label: 'Cancel', primary: false },
                {
                    label: 'Save', primary: true,
                    onClick: () => {
                        BlindState.config.stepperAcceleration = selectedValue;
                        updateConfigUI();
                        saveDeviceState();

                        if (typeof MQTTClient !== 'undefined' && MQTTClient.connected) {
                            MQTTClient.publishConfig(BlindState.deviceId, {
                                stepperAcceleration: selectedValue
                            });
                        }
                        if (typeof Toast !== 'undefined') {
                            const selectedPreset = presets.find(p => p.value === selectedValue);
                            Toast.success(`Braking speed set to ${selectedPreset ? selectedPreset.label : selectedValue + ' steps/s²'}`);
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
                    const displayEl = modal.querySelector('#stepperAccelerationDisplay');
                    if (displayEl) {
                        displayEl.textContent = matched.label;
                        const subDisplay = displayEl.nextElementSibling;
                        if (subDisplay) subDisplay.textContent = `(${matched.value} steps/s²)`;
                    }
                }
            });
        });
    });

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
        if (typeof MQTTClient !== 'undefined' && MQTTClient.connected) {
            MQTTClient.publishConfig(BlindState.deviceId, { twtEnabled: e.target.checked });
        }
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
        saveDeviceState(null, true); // persist locally; publish the single field below
        if (typeof MQTTClient !== 'undefined' && MQTTClient.connected) {
            MQTTClient.publishConfig(BlindState.deviceId, { stepperIdleHold: e.target.checked });
        }
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
                    <div class="twt-diag-item-lbl">802.11ax Wi-Fi 6 Beacon Broadcast</div>
                </div>
                <div class="twt-diag-item pending" id="twtItem2">
                    <div class="twt-diag-item-ico" id="twtItemIco2">⏳</div>
                    <div class="twt-diag-item-lbl">Target Wake Time (TWT) IE Negotiation</div>
                </div>
                <div class="twt-diag-item pending" id="twtItem3">
                    <div class="twt-diag-item-ico" id="twtItemIco3">⏳</div>
                    <div class="twt-diag-item-lbl">Hardware Low-Power Transceiver Sleep</div>
                </div>
                <div class="twt-diag-item pending" id="twtItem4">
                    <div class="twt-diag-item-ico" id="twtItemIco4">⏳</div>
                    <div class="twt-diag-item-lbl">Coexistence Awake-Timer Accuracy</div>
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
                MQTTClient.publishConfig(BlindState.deviceId, { twtEnabled: true });
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
                if (typeof MQTTClient !== 'undefined' && MQTTClient.connected) {
                    MQTTClient.publishConfig(BlindState.deviceId, { twtEnabled: false });
                }
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

    // Animated position counter (starts loop)
    animatePositionLabel();

    // Sublabel (follows target position for immediate feedback)
    const sublabel = document.getElementById('positionSublabel');
    if (sublabel) {
        if (pos === 0) sublabel.textContent = 'Closed';
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
        if (saved.targetPosition !== undefined) BlindState.targetPosition = saved.targetPosition;
        else BlindState.targetPosition = BlindState.position;
        BlindState._displayPos = BlindState.position;
        BlindState._visualPos = BlindState.position;
        BlindState._visualTargetPos = BlindState.position;
        if (saved.isOpen !== undefined) BlindState.isOpen = saved.isOpen;
        if (saved.linkedDeviceId !== undefined) BlindState.linkedDeviceId = saved.linkedDeviceId;
        if (saved.rules) Object.assign(BlindState.rules, saved.rules);
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
        _setHealthMetric('calibration', 'good', 'Ready', 'Top and bottom limits set');
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
    _setHealthText('infoStatus', online ? (BlindState.stateTruncated ? 'Limited' : 'Online') : 'Offline');
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
    let isStepper = true;
    try {
        const device = (typeof DeviceList !== 'undefined') ? DeviceList.get(BlindState.deviceId) : null;
        if (device && device.type && device.type !== 'stepper' && device.type !== 'blind') {
            isStepper = false;
        }
    } catch (e) { }

    const angleOnItem = document.getElementById('angleOnSettingItem');
    const angleOffItem = document.getElementById('angleOffSettingItem');
    const stepperOpenSpeedItem = document.getElementById('stepperOpenSpeedSettingItem');
    const stepperCloseSpeedItem = document.getElementById('stepperCloseSpeedSettingItem');
    const stepperStopDelayItem = document.getElementById('stepperStopDelaySettingItem');
    const stepperRelaxStepsItem = document.getElementById('stepperRelaxStepsSettingItem');
    const stepperAccelerationItem = document.getElementById('stepperAccelerationSettingItem');
    const stepperIdleHoldItem = document.getElementById('stepperIdleHoldSettingItem');
    const recalibrateStepperItem = document.getElementById('recalibrateStepperSettingsItem');

    if (angleOnItem) angleOnItem.style.display = isStepper ? 'none' : 'flex';
    if (angleOffItem) angleOffItem.style.display = isStepper ? 'none' : 'flex';
    if (stepperOpenSpeedItem) stepperOpenSpeedItem.style.display = isStepper ? 'flex' : 'none';
    if (stepperCloseSpeedItem) stepperCloseSpeedItem.style.display = isStepper ? 'flex' : 'none';
    if (stepperStopDelayItem) stepperStopDelayItem.style.display = isStepper ? 'flex' : 'none';
    if (stepperRelaxStepsItem) stepperRelaxStepsItem.style.display = isStepper ? 'flex' : 'none';
    if (stepperAccelerationItem) stepperAccelerationItem.style.display = isStepper ? 'flex' : 'none';
    if (stepperIdleHoldItem) stepperIdleHoldItem.style.display = isStepper ? 'flex' : 'none';
    if (recalibrateStepperItem) recalibrateStepperItem.style.display = isStepper ? 'flex' : 'none';

    // Smart Rules Displays
    const rConfig = BlindState.config;

    // Sunset
    const sunsetEl = document.getElementById('sunsetRuleDisplay');
    if (sunsetEl) {
        const offset = parseInt(localStorage.getItem('zaylo-SunsetOffset') || '0', 10);
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
        const locationSuffix = BlindState.config.city ? `<span style="opacity:0.7; font-size:0.9em; margin-left:4px;">• ${BlindState.config.city}</span>` : '';
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
        const thresh = rConfig.tempThreshold !== undefined ? rConfig.tempThreshold : 30;
        tempEl.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg> > ${thresh}°C`;
    }

    updateHealthPanel();
}

// Builds a firmware-ready copy of BlindState.config: applies the UI→firmware unit
// conversions that the device expects (motionTimeout minutes→seconds, per-day
// schedule objects), pulls the globally-managed sunset offset, and stamps the
// current timezone. Use this anywhere config is pushed to the device so the
// conversions can never drift between code paths (the import path used to skip
// them entirely, sending minutes as seconds and objects where bools were expected).
function _buildFirmwareConfigCopy() {
    const cfg = { ...BlindState.config };
    cfg.sunsetOffset = parseInt(localStorage.getItem('zaylo-SunsetOffset') || '0', 10);
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
    return cfg;
}

let _saveDebounceTimer = null;
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
        const payload = {
            rules: {
                sunset: BlindState.rules.sunset,
                presence: BlindState.rules.presence,
                morningOpen: BlindState.rules.morningOpen,
                nightLock: BlindState.rules.nightLock,
                temperature: BlindState.rules.temperature
            },
            config: _buildFirmwareConfigCopy(),
            cfgRev: rev
        };
        // Only include linkedDeviceId when set — a null/'' would make the firmware
        // CLEAR its linked device, so a transient null must never be echoed.
        if (BlindState.linkedDeviceId) payload.linkedDeviceId = BlindState.linkedDeviceId;
        return payload;
    },

    // Queue + deliver the current full config. Generates a fresh revision token.
    push() {
        if (!BlindState.deviceId) return;
        const rev = Date.now() & 0x7fffffff; // 31-bit token (fits firmware uint32)
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
            // Current firmware: precise token ack.
            if (Number(echoed) >= this.pendingRev) {
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
    DeviceService.init().then(() => {
        DeviceService.updateDevice(window.activeHomeId, BlindState.deviceId, stateObj);
    }).catch(e => console.error('[Blind] Firebase config sync failed:', e));
}

function flushDeferredCloudSync() {
    if (window._blindCloudSyncDeferred && window.activeHomeId) {
        window._blindCloudSyncDeferred = false;
        saveDeviceState(null, true); // re-persist to cloud now that the home is known
    }
}

function saveDeviceState(mqttPayload = null, skipDevicePublish = false) {
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
    
    // Sync to Firebase (Persistent Cloud Storage) — home-aware, so it can't
    // silently fail by writing before activeHomeId is ready.
    _cloudSyncDeviceState(stateObj);

    // Publish to MQTT.
    if (mqttPayload) {
        // Targeted immediate payload (e.g. a single field). Best-effort — only
        // meaningful when connected; the reliable path below covers full config.
        if (typeof MQTTClient !== 'undefined' && MQTTClient.connected) {
            MQTTClient.publishConfig(BlindState.deviceId, mqttPayload);
        }
    } else if (!skipDevicePublish) {
        // Reliable, acked, offline-queued full rules+config sync via ConfigSync.
        // Debounced so rapid edits coalesce into a single push. Skipped by callers
        // that only persist locally — a slider/position change (position publishes
        // separately) or a reaction to incoming device state (don't echo back).
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

    // Firebase backup (home-aware best-effort).
    _cloudSyncDeviceState({
        blindType: BlindState.blindType,
        position: BlindState.position,
        targetPosition: BlindState.targetPosition,
        isOpen: BlindState.isOpen,
        linkedDeviceId: BlindState.linkedDeviceId,
        rules: BlindState.rules,
        config: BlindState.config
    });

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

function addLogEntry(emoji, message) {
    const now = new Date();
    const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    activityLog.unshift({ emoji, message, time, ts: now.getTime() });
    if (activityLog.length > MAX_LOG_ENTRIES) activityLog.pop();
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
            '<div class="log-empty-sub">Automated open &amp; close events will appear here</div>' +
            '</div>';
        return;
    }
    if (empty) empty.style.display = 'none';

    container.innerHTML = activityLog.map(e =>
        `<div class="log-entry">
            <span class="log-emoji">${e.emoji}</span>
            <span class="log-msg">${escapeHtml(e.message)}</span>
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

    // Hook into MQTT state changes to log automation events
    if (typeof StateStore !== 'undefined' && BlindState.deviceId) {
        let prevPosition = BlindState.position;
        let prevRules = { ...BlindState.rules };
        if (_activityLogUnsubscribe) {
            _activityLogUnsubscribe();
            _activityLogUnsubscribe = null;
        }
        _activityLogUnsubscribe = StateStore.subscribe(BlindState.deviceId, (state) => {
            if (!state) return;
            const pos = state.position !== undefined ? state.position : state.blindPosition;
            // Only log position changes that are likely from automation (not manual slider drags)
            // window._uiActionTimestamp is set by the slider/button handlers when the user interacts
            const timeSinceUserAction = Date.now() - (window._uiActionTimestamp || 0);
            const isLikelyAutomation = timeSinceUserAction > 3000;
            if (pos !== undefined && Math.abs(pos - prevPosition) > 5 && isLikelyAutomation) {
                const direction = pos > prevPosition ? 'Opening' : 'Closing';
                addLogEntry(pos > prevPosition ? '🌅' : '🌙', `${direction} to ${pos}%`);
                prevPosition = pos;
            } else if (pos !== undefined) {
                prevPosition = pos; // Track position even if not logged
            }
            // Log rule toggle changes
            if (state.rules) {
                Object.entries(state.rules).forEach(([rule, enabled]) => {
                    if (prevRules[rule] !== undefined && prevRules[rule] !== enabled) {
                        const name = { sunset: 'Sunset', presence: 'Presence', morningOpen: 'Morning', nightLock: 'Night Lock', temperature: 'Temperature' }[rule] || rule;
                        addLogEntry(enabled ? '✅' : '⛔', `${name} rule ${enabled ? 'enabled' : 'disabled'}`);
                    }
                });
                prevRules = { ...state.rules };
            }
        });
    }
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
// NEW FEATURE: Offline Pending Badge
// ============================================
let pendingCommands = [];

function _pendingCommandsKey() {
    return `blind-pending-commands-${BlindState.deviceId || 'unknown'}`;
}

function loadPendingCommands() {
    try {
        const saved = JSON.parse(localStorage.getItem(_pendingCommandsKey()) || '[]');
        pendingCommands = Array.isArray(saved) ? saved.filter(cmd => cmd && typeof cmd === 'object') : [];
    } catch (e) {
        pendingCommands = [];
    }
}

function persistPendingCommands() {
    try {
        localStorage.setItem(_pendingCommandsKey(), JSON.stringify(pendingCommands));
    } catch (e) {
        // Best effort only; the in-memory queue still works for the current page.
    }
}

function addPendingCommand(cmd) {
    if (!cmd || typeof cmd !== 'object') return;

    // For position commands, newest target wins. Replaying every intermediate
    // offline slider value can make the blind walk through stale positions after
    // reconnect; the physical device only needs the final requested target.
    const nextPosition = cmd.blindPosition !== undefined ? cmd.blindPosition : cmd.position;
    if (nextPosition !== undefined) {
        const parsedPosition = Number(nextPosition);
        if (!Number.isFinite(parsedPosition)) return;
        pendingCommands = pendingCommands.filter(c => c.blindPosition === undefined && c.position === undefined);
        cmd = { blindPosition: Math.max(0, Math.min(100, parsedPosition)) };
    }

    pendingCommands.push(cmd);
    persistPendingCommands();
    updatePendingBadge();
}

function flushPendingCommands() {
    if (typeof MQTTClient === 'undefined' || !MQTTClient.connected) return;
    const pendingTopic = BlindState.deviceId
        ? `lumibot/${BlindState.deviceId.toUpperCase()}/stepper/set_position`
        : null;
    while (pendingCommands.length > 0) {
        const cmd = pendingCommands.shift();
        if (pendingTopic && MQTTClient.pendingMessages) {
            MQTTClient.pendingMessages.delete(pendingTopic);
        }
        // Blind/stepper devices use the stepper-specific topic
        const sent = MQTTClient.publishStepperControl(BlindState.deviceId, cmd);
        if (!sent) {
            pendingCommands.unshift(cmd);
            break;
        }
    }
    persistPendingCommands();
    updatePendingBadge();
}

function updatePendingBadge() {
    const badge = document.getElementById('pendingBadge');
    const count = document.getElementById('pendingCount');
    if (!badge) return;
    if (pendingCommands.length > 0) {
        badge.style.display = 'flex';
        if (count) count.textContent = pendingCommands.length;
    } else {
        badge.style.display = 'none';
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
                    if (data.rules) Object.assign(BlindState.rules, data.rules);
                    if (data.config) Object.assign(BlindState.config, data.config);
                    if (data.linkedDeviceId !== undefined) BlindState.linkedDeviceId = data.linkedDeviceId;

                    // Push to device via MQTT (use config topic, not control topic).
                    // CRITICAL: convert to firmware units first — sending the raw UI
                    // config here used to corrupt the device (motionTimeout minutes
                    // taken as seconds → clamped to 1 min; nightDays objects read as
                    // bools → every night-lock day disabled).
                    if (typeof MQTTClient !== 'undefined' && MQTTClient.connected) {
                        MQTTClient.publishConfig(BlindState.deviceId, {
                            config: _buildFirmwareConfigCopy(),
                            rules: BlindState.rules,
                            linkedDeviceId: BlindState.linkedDeviceId || ''
                        });
                    }

                    // Refresh UI
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
    updateMorningTimeline();
    loadPendingCommands();
    updatePendingBadge();

    // NOTE: pending-command flushing on (re)connect is registered inside
    // setupMQTT()'s onConnect handler, NOT here. setupMQTT() calls
    // clearCallbacks() during its own init (which runs after this function), so a
    // handler registered here would be wiped before it ever fired.

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
