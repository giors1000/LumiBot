/**
 * Zaylo — Smart Blind Device Page Logic
 * Premium blind control with smart automations
 * Supports: Roller, Venetian, Vertical, Zebra blind types
 */

// ============================================
// Constants
// ============================================
const BLIND_TYPES = ['roller', 'venetian', 'vertical', 'zebra'];
const BLIND_TYPE_LABELS = { roller: 'Roller Blind', venetian: 'Venetian Blind', vertical: 'Vertical Blind', zebra: 'Zebra Blind' };
const BLIND_TYPE_ICONS = { roller: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-blinds"><path d="M3 3h18"/><path d="M20 7H8"/><path d="M20 11H8"/><path d="M10 19h10"/><path d="M8 15h12"/><path d="M4 3v14"/><circle cx="4" cy="19" r="2"/></svg>', venetian: '📐', vertical: '📏', zebra: '🦓' };
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
    blindType: 'roller',    // roller | venetian | vertical | zebra
    position: 0,            // 0 = closed, 100 = fully open (from MQTT)
    targetPosition: 0,      // destination, used for buttons
    _displayPos: 0,         // animated display position for smooth counter
    _visualPos: 0,          // smoothly interpolated visualization position
    isOpen: false,
    isOnline: false,
    isCalibrated: true,     // whether the stepper motor has set top/bottom limits
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
        twtEnabled: false
    },
    isDragging: false      // Prevent incoming MQTT state updates from jumping slider
};

// Track whether we've received the first position from MQTT.
// The first update should snap instantly (no animation) to prevent
// the closed→open flash when blinds are already in position.
let _firstPositionReceived = false;

// ============================================
// Initialization
// ============================================
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
    loadDeviceState();

    // Resolve Home first (for scoped localStorage & Firebase paths)
    const initHome = async () => {
        try {
            if (typeof HomeService !== 'undefined' && typeof Auth !== 'undefined') {
                let retries = 0;
                while (!Auth.getUser() && retries < 10) {
                    await new Promise(r => setTimeout(r, 300));
                    retries++;
                }
                const user = Auth.getUser();
                if (user) {
                    await HomeService.init();
                    const homeId = await HomeService.getActiveHome(user.uid);
                    if (typeof DeviceList !== 'undefined') DeviceList.setHome(homeId);
                }
            }
        } catch (e) {
            console.error('[Blind] HomeService init failed:', e);
        }
    };
    initHome();

    // Sync with Firebase (slow, but ensures cross-device persistence)
    if (typeof Auth !== 'undefined' && typeof DeviceService !== 'undefined') {
        const syncFirebase = async () => {
            let retries = 0;
            while (!Auth.getUser() && retries < 10) {
                await new Promise(resolve => setTimeout(resolve, 300));
                retries++;
            }
            const user = Auth.getUser();
            if (user) {
                await DeviceService.init();
                const homeId = window.activeHomeId;
                if (!homeId) { console.warn('[Blind] No activeHomeId, skipping Firebase sync'); return; }
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
        };
        syncFirebase();
    }

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
    
    // Add resize listener to keep pill aligned
    window.addEventListener('resize', () => {
        if (typeof updateTypePill === 'function') updateTypePill();
    });

    // Setup MQTT
    setupMQTT();

    // Hide loader
    setTimeout(() => {
        const loader = document.getElementById('initialLoader');
        if (loader) {
            loader.style.opacity = '0';
            loader.style.visibility = 'hidden';
            setTimeout(() => loader.remove(), 400);
        }
    }, 800);
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
                    MQTTClient.publishControl(BlindState.deviceId, { command: 'getState' });

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
    });

    MQTTClient.on('onDisconnect', () => {
        updateConnectionStatus(false);
    });

    // Connect to broker AFTER callbacks are registered
    MQTTClient.connect();

    // Use Centralized StateStore
    StateStore.subscribe(BlindState.deviceId, (state) => {
        if (state) {
            handleStateUpdate(state);
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
}

function handleStateUpdate(state) {
    let changed = false;

    // Device online/offline status from MQTT state store
    if (state._online !== undefined) {
        updateConnectionStatus(state._online);
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
        const label = document.getElementById('positionLabel');
        if (label) {
            label.classList.toggle('is-moving', state.isMoving);
        }
        
        // Critical Fix: If the physical device reports it has stopped moving,
        // we MUST align our local targetPosition with its actual position.
        // We only do this if we haven't JUST commanded a move, to prevent instantly
        // reverting if the device sends an ack packet before it starts moving.
        if (!ignoreIncomingTarget && state.isMoving === false && BlindState.position !== undefined) {
            if (BlindState.targetPosition !== BlindState.position) {
                BlindState.targetPosition = BlindState.position;
                changed = true;
            }
        }
    }

    // Config updates (e.g., calibration angles)
    if (state.config) {
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
        // Same conversion for nightDays
        if (state.config.nightDays && Array.isArray(state.config.nightDays) &&
            state.config.nightDays.length === 7 && typeof state.config.nightDays[0] === 'boolean') {
            const existingDays = BlindState.config.nightDays;
            const fallbackTime = state.config.nightTime || BlindState.config.nightTime || '22:00';
            const fallbackTarget = state.config.nightTarget !== undefined ? state.config.nightTarget :
                (BlindState.config.nightTarget !== undefined ? BlindState.config.nightTarget : 0);
            state.config.nightDays = state.config.nightDays.map((enabled, i) => {
                if (existingDays && existingDays[i] && typeof existingDays[i] === 'object') {
                    return { ...existingDays[i], enabled: enabled };
                }
                return { enabled, time: fallbackTime, target: fallbackTarget };
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

    // Rules updates
    if (state.rules) {
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
        saveDeviceState();
    }

    if (changed) {
        updateUI();
        updateCalibrationWarning();
        // Persist updated position/state to localStorage so the next page load
        // initializes the UI at the correct position (avoids the closed→open flash).
        saveDeviceState();
    }

    // Update new UI features from state
    updateMorningTimeline();
}

function updateCalibrationWarning() {
    const warningEl = document.getElementById('calibrationWarning');
    const controlsContainer = document.querySelector('.blind-actions');
    const sliderContainer = document.querySelector('.slider-card');
    const presetsContainer = document.querySelector('.presets-grid');
    
    // Safety check: skip if UI elements aren't loaded
    if (!warningEl || !controlsContainer || !sliderContainer) return;

    // FIX: BlindState.blindType is the visualization mode (roller/venetian/etc),
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

    btns.forEach((btn, idx) => {
        // Set initial active
        if (btn.dataset.type === BlindState.blindType) {
            btn.classList.add('active');
            if (pill) moveTypePill(idx);
        }

        btn.addEventListener('click', () => {
            if (btn.dataset.type === BlindState.blindType) return;
            BlindState.blindType = btn.dataset.type;

            // Update active state
            btns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            if (pill) moveTypePill(idx);

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
}

function moveTypePill(idx) {
    const pill = document.getElementById('typePill');
    if (!pill) return;
    const btns = document.querySelectorAll('.type-btn');
    if (!btns[idx]) return;
    
    // Fallback: If elements are hidden (display:none), boundingClientRect returns 0 width
    // In that case, we don't attempt to move the pill to prevent it from disappearing.
    const btnRect = btns[idx].getBoundingClientRect();
    if (btnRect.width === 0) return;
    
    const parentRect = pill.parentElement.getBoundingClientRect();
    pill.style.width = `${btnRect.width}px`;
    pill.style.transform = `translateX(${btnRect.left - parentRect.left}px)`;
}

function updateTypePill() {
    const btns = document.querySelectorAll('.type-btn');
    if (!btns.length) return;
    
    btns.forEach((btn, idx) => {
        if (btn.dataset.type === BlindState.blindType) {
            btns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            moveTypePill(idx);
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

        // STRICT TRACKING: Only track actual physically confirmed position
        const target = BlindState.position !== undefined ? BlindState.position : 0;
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
    updateUI();
    saveDeviceState();

    // Send position command via MQTT.
    // Stepper devices use a dedicated topic (stepper/set_position).
    if (typeof MQTTClient !== 'undefined' && MQTTClient.connected) {
        MQTTClient.publishStepperControl(BlindState.deviceId, {
            blindPosition: safePos
        });

        if (typeof StateStore !== 'undefined') {
            StateStore.update(BlindState.deviceId, { targetPosition: safePos });
        }
    } else {
        // MQTT offline — queue for later
        addPendingCommand({ blindPosition: safePos });
    }
}

// ============================================
// Position Slider
// ============================================
function setupSlider() {
    const slider = document.getElementById('positionSlider');
    if (!slider) return;

    slider.addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10);
        // Only update the slider visual (gradient + value label) while dragging.
        updateSliderGradient(val);
        const sliderVal = document.getElementById('sliderValue');
        if (sliderVal) sliderVal.textContent = `${val}% `;

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
        setPosition(val);
    });
}

function updateSliderGradient(value) {
    const slider = document.getElementById('positionSlider');
    if (!slider) return;
    const pct = value;
    slider.style.background = `linear-gradient(90deg, var(--blind-accent) ${pct}%, var(--bg-tertiary) ${pct}%)`;
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
            saveDeviceState();

            // Send updated rules to MQTT
            if (typeof MQTTClient !== 'undefined' && MQTTClient.connected) {
                MQTTClient.publishConfig(BlindState.deviceId, {
                    rules: BlindState.rules
                });
            }

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
    const count = Object.values(BlindState.rules).filter(v => v).length;
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
    saveDeviceState();

    // Trigger engine to immediately re-evaluate with new config
    if (typeof AutomationEngine !== 'undefined' && AutomationEngine.evaluate) {
        AutomationEngine.evaluate();
    }

    // Publish to MQTT so other connected clients can sync
    if (typeof MQTTClient !== 'undefined' && MQTTClient.connected) {
        // Use the shared timezone utility from mqtt.js for consistency
        // This correctly handles DST transitions across all pages
        const tz = MQTTClient.getTimezonePayload();
        
        MQTTClient.publishConfig(BlindState.deviceId, {
            rules: {
                sunset: BlindState.rules.sunset,
                presence: BlindState.rules.presence,
                morningOpen: BlindState.rules.morningOpen,
                nightLock: BlindState.rules.nightLock,
                temperature: BlindState.rules.temperature
            },
            config: {
                sunsetOffset: parseInt(localStorage.getItem('zaylo-SunsetOffset') || '0', 10),
                sunsetTarget: BlindState.config.sunsetTarget,
                // motionTimeout: UI stores in MINUTES for user-friendliness,
                // but firmware expects SECONDS (config.motion_timeout * 1000UL = ms)
                motionTimeout: (BlindState.config.motionTimeout || 5) * 60,
                presenceTarget: BlindState.config.presenceTarget,
                presenceAction: BlindState.config.presenceAction,
                presenceOpenTarget: BlindState.config.presenceOpenTarget,
                presenceTimeFilter: BlindState.config.presenceTimeFilter,
                morningDays: BlindState.config.morningDays ? BlindState.config.morningDays.map(d => ({
                    enabled: d.enabled !== false,
                    time: d.time || '07:00',
                    duration: d.duration !== undefined ? d.duration : 30,
                    target: d.target !== undefined ? d.target : 100
                })) : null,
                nightTime: BlindState.config.nightTime,
                nightTarget: BlindState.config.nightTarget,
                nightDays: BlindState.config.nightDays ? BlindState.config.nightDays.map(d => d.enabled) : null,
                tempThreshold: BlindState.config.tempThreshold,
                tempTarget: BlindState.config.tempTarget,
                lat: BlindState.config.lat,
                lon: BlindState.config.lon,
                gmtOffset: tz.gmtOffset,
                daylightOffset: tz.daylightOffset,
                ...(tz.tzPosix ? { tzPosix: tz.tzPosix } : {})
            }
        });
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
                <div style="display:flex; align-items:center; justify-content:space-between; padding:14px 16px; background: linear-gradient(135deg, rgba(124,58,237,0.12), rgba(168,85,247,0.05)); border-radius:14px; border:1px solid rgba(124,58,237,0.2);">
                    <div style="display:flex; align-items:center; gap:10px;">
                        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#a855f7" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 10V2"/><path d="m4.93 10.93 1.41 1.41"/><path d="M2 18h2"/><path d="M20 18h2"/><path d="m19.07 10.93-1.41 1.41"/><path d="M22 22H2"/><path d="m16 6-4 4-4-4"/><path d="M16 18a4 4 0 0 0-8 0"/></svg>
                        <span style="font-size:15px; font-weight:700; color:var(--text-primary);">${offsetDisplay} min</span>
                    </div>
                    <span style="font-size:11px; color:var(--text-tertiary); font-weight:600; text-transform:uppercase; letter-spacing:0.5px;">Global</span>
                </div>
                <div style="margin-top:10px; padding:10px; border-radius:10px; background:rgba(99,102,241,0.08); border:1px solid rgba(99,102,241,0.15);">
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

        if (days && Array.isArray(days) && days.length === 7) {
            const ds = days[dayOfWeek];
            if (typeof ds === 'object') {
                dayEnabled = ds.enabled;
                dayTime = ds.time || fallbackTime;
            } else if (typeof ds === 'boolean') {
                dayEnabled = ds;
            }
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

            <button id="morningApplyAllBtn" style="width:100%; margin-top:16px; padding:12px; border-radius:12px; border:1px solid var(--border-glass); background:var(--bg-glass); color:var(--text-secondary); font-family:var(--font-family); font-size:13px; font-weight:600; cursor:pointer; transition:all 0.2s ease;">
                📋 Apply to All Days
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
    const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const fallbackTime = BlindState.config.nightTime || '22:00';
    const fallbackTarget = BlindState.config.nightTarget !== undefined ? BlindState.config.nightTarget : 0;

    const existingDays = BlindState.config.nightDays;
    const daySchedule = [];
    for (let i = 0; i < 7; i++) {
        if (existingDays && existingDays[i]) {
            daySchedule.push({
                enabled: existingDays[i].enabled !== false,
                time: existingDays[i].time || fallbackTime,
                target: existingDays[i].target !== undefined ? existingDays[i].target : fallbackTarget
            });
        } else {
            daySchedule.push({
                enabled: true,
                time: fallbackTime,
                target: fallbackTarget
            });
        }
    }

    let selectedDay = new Date().getDay();

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
                    <span class="setting-sublabel" id="nightEnabledDesc">Lock active on this day</span>
                </div>
                <label class="toggle">
                    <input type="checkbox" id="nightDayEnabled" ${daySchedule[selectedDay].enabled ? 'checked' : ''}>
                    <div class="toggle-track"><div class="toggle-thumb"></div></div>
                </label>
            </div>

            <div id="nightDayFields" style="opacity: ${daySchedule[selectedDay].enabled ? '1' : '0.4'}; pointer-events: ${daySchedule[selectedDay].enabled ? 'all' : 'none'};">
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
                    </div>
                </div>
                <input type="range" id="nightTargetInput" min="0" max="100" value="${daySchedule[selectedDay].target}" class="blind-slider" style="width: 100%; height: 8px; border-radius: 4px; -webkit-appearance: none; background: var(--bg-tertiary); outline: none;">
                <div class="modal-value-display" id="nightTargetDisplay">${daySchedule[selectedDay].target}%</div>
            </div>

            <button id="nightApplyAllBtn" style="width:100%; margin-top:16px; padding:12px; border-radius:12px; border:1px solid var(--border-glass); background:var(--bg-glass); color:var(--text-secondary); font-family:var(--font-family); font-size:13px; font-weight:600; cursor:pointer; transition:all 0.2s ease;">
                📋 Apply to All Days
            </button>
        `,
        actions: [
            { label: 'Cancel', primary: false },
            {
                label: 'Save', primary: true, onClick: () => {
                    _flushCurrentNightDayInputs();

                    BlindState.config.nightDays = daySchedule.map(d => ({ ...d }));

                    const firstEnabled = daySchedule.find(d => d.enabled);
                    if (firstEnabled) {
                        BlindState.config.nightTime = firstEnabled.time;
                        BlindState.config.nightTarget = firstEnabled.target;
                    }

                    updateConfigUI();
                    _publishRulesConfig();
                    if (typeof Toast !== 'undefined') Toast.success('Night lock schedule updated');
                    return true;
                }
            }
        ]
    });

    function _flushCurrentNightDayInputs() {
        const timeEl = modal.querySelector('#nightTimeInput');
        const tgtEl = modal.querySelector('#nightTargetInput');
        const enEl = modal.querySelector('#nightDayEnabled');
        if (!timeEl) return;
        daySchedule[selectedDay].time = timeEl.value || '22:00';
        const tv = parseInt(tgtEl.value, 10);
        daySchedule[selectedDay].target = isNaN(tv) ? 0 : tv;
        daySchedule[selectedDay].enabled = enEl.checked;
    }

    function _loadNightDayInputs(dayIdx) {
        const ds = daySchedule[dayIdx];
        modal.querySelector('#nightTimeInput').value = ds.time;
        modal.querySelector('#nightTargetInput').value = ds.target;
        modal.querySelector('#nightTargetDisplay').textContent = ds.target + '%';
        modal.querySelector('#nightDayEnabled').checked = ds.enabled;
        modal.querySelector('#nightDayFields').style.opacity = ds.enabled ? '1' : '0.4';
        modal.querySelector('#nightDayFields').style.pointerEvents = ds.enabled ? 'all' : 'none';
    }

    modal.querySelectorAll('.day-pill.night').forEach(pill => {
        pill.addEventListener('click', () => {
            _flushCurrentNightDayInputs();
            selectedDay = parseInt(pill.dataset.day, 10);

            modal.querySelectorAll('.day-pill.night').forEach((p, i) => {
                p.classList.toggle('selected', i === selectedDay);
                p.classList.toggle('disabled', !daySchedule[i].enabled);
            });

            _loadNightDayInputs(selectedDay);
            if (typeof Haptic !== 'undefined') Haptic.selection();
        });
    });

    const enabledToggle = modal.querySelector('#nightDayEnabled');
    enabledToggle.addEventListener('change', () => {
        daySchedule[selectedDay].enabled = enabledToggle.checked;
        modal.querySelector('#nightDayFields').style.opacity = enabledToggle.checked ? '1' : '0.4';
        modal.querySelector('#nightDayFields').style.pointerEvents = enabledToggle.checked ? 'all' : 'none';

        const pill = modal.querySelector(`.day-pill.night[data-day="${selectedDay}"]`);
        if (pill) pill.classList.toggle('disabled', !enabledToggle.checked);

        if (typeof Haptic !== 'undefined') Haptic.selection();
    });

    modal.querySelector('#nightApplyAllBtn').addEventListener('click', () => {
        _flushCurrentNightDayInputs();
        const src = daySchedule[selectedDay];
        for (let i = 0; i < 7; i++) {
            daySchedule[i].time = src.time;
            daySchedule[i].target = src.target;
            daySchedule[i].enabled = src.enabled;
        }
        modal.querySelectorAll('.day-pill.night').forEach((p, i) => {
            p.classList.toggle('disabled', !daySchedule[i].enabled);
        });
        if (typeof Haptic !== 'undefined') Haptic.notification('success');
        if (typeof Toast !== 'undefined') Toast.success('Applied to all days');
    });

    const targetInput = modal.querySelector('#nightTargetInput');
    const targetDisplay = modal.querySelector('#nightTargetDisplay');
    targetInput.addEventListener('input', (e) => {
        targetDisplay.textContent = e.target.value + '%';
        if (typeof Haptic !== 'undefined') Haptic.light();
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
                    <span class="setting-label">Temperature Threshold (°C)</span>
                    <span class="setting-sublabel">Trigger when temp exceeds this</span>
                </div>
            </div>
            <input type="number" id="tempThresholdInput" value="${defaultTemp}" class="modal-input" placeholder="Threshold °C">
            
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

                            if (BlindState.deviceId && typeof MQTTClient !== 'undefined') {
                                const payload = MQTTClient.getTimezonePayload();
                                MQTTClient.publishConfig(BlindState.deviceId, payload);
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

    // Stepper Recalibration Modal
    document.getElementById('recalibrateStepperSettingsItem')?.addEventListener('click', () => {
        if (typeof Modal === 'undefined' || typeof MQTTClient === 'undefined') return;

        const { modal, close } = Modal.create({
            title: 'Recalibrate Limits',
            content: `
                <div class="jog-controls-modern">
                    <h3 class="jog-title">Precision Jog</h3>
                    <p class="jog-desc">Press and hold to move</p>
                    <div class="jog-buttons-wrapper">
                        <button class="jog-motor-btn up" id="deviceJogUpBtn">
                            <span class="jog-icon">▲</span>
                        </button>
                        <div class="jog-motor-divider"></div>
                        <button class="jog-motor-btn down" id="deviceJogDownBtn">
                            <span class="jog-icon">▼</span>
                        </button>
                    </div>
                    <div class="jog-feedback-modern" id="deviceJogFeedback">Idle</div>
                </div>

                <div class="save-positions">
                    <button class="save-btn off" id="deviceSaveStepperTopBtn">
                        <span class="icon"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-arrow-up"><path d="m5 12 7-7 7 7"/><path d="M12 19V5"/></svg></span>
                        <span>Save Fully OPEN</span>
                        <span class="angle">Top Limit</span>
                    </button>
                    <button class="save-btn on" id="deviceSaveStepperBottomBtn">
                        <span class="icon"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-arrow-down"><path d="M12 5v14"/><path d="m19 12-7 7-7-7"/></svg></span>
                        <span>Save Fully CLOSED</span>
                        <span class="angle">Bottom Limit</span>
                    </button>
                </div>
            `,
            actions: [
                { label: 'Done', primary: true, onClick: () => true }
            ]
        });

        const feedbackEl = modal.querySelector('#deviceJogFeedback');

        // Helper to send jog command
        const sendJog = (direction) => {
            MQTTClient.publishStepperControl(BlindState.deviceId, { jog: direction });

            if (direction === -1) feedbackEl.textContent = 'Moving OPEN ▲';
            else if (direction === 1) feedbackEl.textContent = 'Moving CLOSE ▼';
            else feedbackEl.textContent = 'Idle';
        };

        // Jog Up
        const upBtn = modal.querySelector('#deviceJogUpBtn');
        if (upBtn) {
            upBtn.addEventListener('pointerdown', (e) => {
                e.preventDefault();
                sendJog(-1);
                if (typeof Haptic !== 'undefined') Haptic.light();
            });
            const stopUp = (e) => { e.preventDefault(); sendJog(0); };
            upBtn.addEventListener('pointerup', stopUp);
            upBtn.addEventListener('pointerleave', stopUp);
            upBtn.addEventListener('pointercancel', stopUp);
        }

        // Jog Down
        const downBtn = modal.querySelector('#deviceJogDownBtn');
        if (downBtn) {
            downBtn.addEventListener('pointerdown', (e) => {
                e.preventDefault();
                sendJog(1);
                if (typeof Haptic !== 'undefined') Haptic.light();
            });
            const stopDown = (e) => { e.preventDefault(); sendJog(0); };
            downBtn.addEventListener('pointerup', stopDown);
            downBtn.addEventListener('pointerleave', stopDown);
            downBtn.addEventListener('pointercancel', stopDown);
        }

        // Save Positions
        const saveTopBtn = modal.querySelector('#deviceSaveStepperTopBtn');
        if (saveTopBtn) {
            saveTopBtn.addEventListener('click', () => {
                MQTTClient.publishConfig(BlindState.deviceId, { cmd: 'save_top' });
                if (typeof Haptic !== 'undefined') Haptic.heavy();
                if (typeof Toast !== 'undefined') Toast.success('Top limit saved!');
            });
        }

        const saveBottomBtn = modal.querySelector('#deviceSaveStepperBottomBtn');
        if (saveBottomBtn) {
            saveBottomBtn.addEventListener('click', () => {
                MQTTClient.publishConfig(BlindState.deviceId, { cmd: 'save_bottom' });
                if (typeof Haptic !== 'undefined') Haptic.heavy();
                if (typeof Toast !== 'undefined') Toast.success('Bottom limit saved!');
            });
        }
    });

    // Stepper Opening Speed Setting
    document.querySelector('[data-setting="stepperOpenSpeed"]')?.addEventListener('click', () => {
        if (typeof Modal === 'undefined') return;

        const currentVal = BlindState.config.stepperOpenSpeed !== undefined ? BlindState.config.stepperOpenSpeed : 2000;

        const { modal, close } = Modal.create({
            title: 'Opening Speed',
            content: `
                <div style="text-align: center; margin-bottom: 20px;">
                    <span class="modal-value-display" id="stepperOpenSpeedDisplay" style="display:inline-block; margin-bottom:0;">${currentVal}</span>
                    <span style="font-size: 14px; color: var(--text-tertiary); margin-left: 4px; font-weight:600;">steps/s</span>
                </div>
                <input type="range" id="stepperOpenSpeedInput" min="100" max="5000" step="100" value="${currentVal}"
                    style="width: 100%; height: 8px; border-radius: 4px; -webkit-appearance: none; background: var(--bg-tertiary); outline: none;"
                    class="blind-slider">
                <div style="display: flex; justify-content: space-between; margin-top: 12px; color: var(--text-tertiary); font-size: 12px; font-weight: 500;">
                    <span>Slower</span>
                    <span>Faster</span>
                </div>
                <p style="color: var(--text-tertiary); font-size: 13px; margin-top: 16px; text-align: center;">
                    Speed when the blinds are opening.
                </p>
            `,
            actions: [
                { label: 'Cancel', primary: false },
                {
                    label: 'Save', primary: true,
                    onClick: () => {
                        const input = modal.querySelector('#stepperOpenSpeedInput');
                        const val = parseInt(input.value, 10);
                        BlindState.config.stepperOpenSpeed = val;
                        updateConfigUI();
                        saveDeviceState();

                        if (typeof MQTTClient !== 'undefined' && MQTTClient.connected) {
                            MQTTClient.publishConfig(BlindState.deviceId, {
                                stepperOpenSpeed: val
                            });
                        }
                        return true;
                    }
                }
            ]
        });

        const inputEl = modal.querySelector('#stepperOpenSpeedInput');
        const displayEl = modal.querySelector('#stepperOpenSpeedDisplay');
        if (inputEl && displayEl) {
            inputEl.addEventListener('input', (e) => {
                displayEl.textContent = `${e.target.value}`;
                if (typeof Haptic !== 'undefined') Haptic.light();
            });
        }
    });

    // Stepper Closing Speed Setting
    document.querySelector('[data-setting="stepperCloseSpeed"]')?.addEventListener('click', () => {
        if (typeof Modal === 'undefined') return;

        const currentVal = BlindState.config.stepperCloseSpeed !== undefined ? BlindState.config.stepperCloseSpeed : 2000;

        const { modal, close } = Modal.create({
            title: 'Closing Speed',
            content: `
                <div style="text-align: center; margin-bottom: 20px;">
                    <span id="stepperCloseSpeedDisplay" style="font-size: 32px; font-weight: 800; color: var(--blind-accent);">${currentVal}</span>
                    <span style="font-size: 14px; color: var(--text-tertiary); margin-left: 4px;">steps/s</span>
                </div>
                <input type="range" id="stepperCloseSpeedInput" min="100" max="5000" step="100" value="${currentVal}"
                    style="width: 100%; height: 8px; border-radius: 4px; -webkit-appearance: none; background: var(--bg-tertiary); outline: none;"
                    class="blind-slider">
                <div style="display: flex; justify-content: space-between; margin-top: 12px; color: var(--text-tertiary); font-size: 12px; font-weight: 500;">
                    <span>Slower</span>
                    <span>Faster</span>
                </div>
                <p style="color: var(--text-tertiary); font-size: 13px; margin-top: 16px; text-align: center;">
                    Speed when the blinds are closing.
                </p>
            `,
            actions: [
                { label: 'Cancel', primary: false },
                {
                    label: 'Save', primary: true,
                    onClick: () => {
                        const input = modal.querySelector('#stepperCloseSpeedInput');
                        const val = parseInt(input.value, 10);
                        BlindState.config.stepperCloseSpeed = val;
                        updateConfigUI();
                        saveDeviceState();

                        if (typeof MQTTClient !== 'undefined' && MQTTClient.connected) {
                            MQTTClient.publishConfig(BlindState.deviceId, {
                                stepperCloseSpeed: val
                            });
                        }
                        return true;
                    }
                }
            ]
        });

        const inputEl = modal.querySelector('#stepperCloseSpeedInput');
        const displayEl = modal.querySelector('#stepperCloseSpeedDisplay');
        if (inputEl && displayEl) {
            inputEl.addEventListener('input', (e) => {
                displayEl.textContent = `${e.target.value}`;
                if (typeof Haptic !== 'undefined') Haptic.light();
            });
        }
    });

    // Motor Hold Time (Stop Delay) Setting
    document.querySelector('[data-setting="stepperStopDelay"]')?.addEventListener('click', () => {
        if (typeof Modal === 'undefined') return;

        const currentVal = BlindState.config.stepperStopDelay !== undefined ? BlindState.config.stepperStopDelay : 3000;

        const { modal, close } = Modal.create({
            title: 'Motor Hold Time',
            content: `
                <div style="text-align: center; margin-bottom: 20px;">
                    <span class="modal-value-display" id="stepperStopDelayDisplay" style="display:inline-block; margin-bottom:0;">${(currentVal / 1000).toFixed(1)}</span>
                    <span style="font-size: 14px; color: var(--text-tertiary); margin-left: 4px; font-weight:600;">seconds</span>
                </div>
                <input type="range" id="stepperStopDelayInput" min="500" max="10000" step="500" value="${currentVal}"
                    style="width: 100%; height: 8px; border-radius: 4px; -webkit-appearance: none; background: var(--bg-tertiary); outline: none;"
                    class="blind-slider">
                <div style="display: flex; justify-content: space-between; margin-top: 12px; color: var(--text-tertiary); font-size: 12px; font-weight: 500;">
                    <span>0.5s</span>
                    <span>10s</span>
                </div>
                <p style="color: var(--text-tertiary); font-size: 13px; margin-top: 16px; text-align: center;">
                    How long the motor stays energised after reaching its target. Shorter = releases faster.
                </p>
                <div style="text-align: center; margin-top: 12px;">
                    <button type="button" id="stepperStopDelayDefault" style="background: none; border: 1.5px solid var(--text-tertiary); color: var(--text-secondary); padding: 4px 14px; border-radius: 20px; font-size: 12px; font-weight: 600; cursor: pointer; opacity: 0.7; transition: opacity 0.2s;">Default</button>
                </div>
            `,
            actions: [
                { label: 'Cancel', primary: false },
                {
                    label: 'Save', primary: true,
                    onClick: () => {
                        const input = modal.querySelector('#stepperStopDelayInput');
                        const val = parseInt(input.value, 10);
                        if (isNaN(val)) return true;
                        BlindState.config.stepperStopDelay = val;
                        updateConfigUI();
                        saveDeviceState();

                        if (typeof MQTTClient !== 'undefined' && MQTTClient.connected) {
                            MQTTClient.publishConfig(BlindState.deviceId, {
                                stepperStopDelay: val
                            });
                        }
                        if (typeof Toast !== 'undefined') Toast.success('Motor hold time updated');
                        return true;
                    }
                }
            ]
        });

        const inputEl = modal.querySelector('#stepperStopDelayInput');
        const displayEl = modal.querySelector('#stepperStopDelayDisplay');
        if (inputEl && displayEl) {
            inputEl.addEventListener('input', (e) => {
                displayEl.textContent = `${(parseInt(e.target.value, 10) / 1000).toFixed(1)}`;
                if (typeof Haptic !== 'undefined') Haptic.light();
            });
        }
        const defaultBtn = modal.querySelector('#stepperStopDelayDefault');
        if (defaultBtn) {
            defaultBtn.addEventListener('click', () => {
                if (inputEl) { inputEl.value = 3000; inputEl.dispatchEvent(new Event('input')); }
                if (typeof Haptic !== 'undefined') Haptic.light();
            });
        }
    });

    // Drop-Back Distance (Relax Steps) Setting
    document.querySelector('[data-setting="stepperRelaxSteps"]')?.addEventListener('click', () => {
        if (typeof Modal === 'undefined') return;

        const currentVal = BlindState.config.stepperRelaxSteps !== undefined ? BlindState.config.stepperRelaxSteps : 128;

        const { modal, close } = Modal.create({
            title: 'Drop-Back Distance',
            content: `
                <div style="text-align: center; margin-bottom: 20px;">
                    <span class="modal-value-display" id="stepperRelaxStepsDisplay" style="display:inline-block; margin-bottom:0;">${currentVal}</span>
                    <span style="font-size: 14px; color: var(--text-tertiary); margin-left: 4px; font-weight:600;">steps</span>
                </div>
                <input type="range" id="stepperRelaxStepsInput" min="0" max="500" step="10" value="${currentVal}"
                    style="width: 100%; height: 8px; border-radius: 4px; -webkit-appearance: none; background: var(--bg-tertiary); outline: none;"
                    class="blind-slider">
                <div style="display: flex; justify-content: space-between; margin-top: 12px; color: var(--text-tertiary); font-size: 12px; font-weight: 500;">
                    <span>None</span>
                    <span>500</span>
                </div>
                <p style="color: var(--text-tertiary); font-size: 13px; margin-top: 16px; text-align: center;">
                    After opening, the motor reverses this many steps to relieve cable tension.
                    Set to 0 to disable.
                </p>
                <div style="text-align: center; margin-top: 12px;">
                    <button type="button" id="stepperRelaxStepsDefault" style="background: none; border: 1.5px solid var(--text-tertiary); color: var(--text-secondary); padding: 4px 14px; border-radius: 20px; font-size: 12px; font-weight: 600; cursor: pointer; opacity: 0.7; transition: opacity 0.2s;">Default</button>
                </div>
            `,
            actions: [
                { label: 'Cancel', primary: false },
                {
                    label: 'Save', primary: true,
                    onClick: () => {
                        const input = modal.querySelector('#stepperRelaxStepsInput');
                        const val = parseInt(input.value, 10);
                        if (isNaN(val)) return true;
                        BlindState.config.stepperRelaxSteps = val;
                        updateConfigUI();
                        saveDeviceState();

                        if (typeof MQTTClient !== 'undefined' && MQTTClient.connected) {
                            MQTTClient.publishConfig(BlindState.deviceId, {
                                stepperRelaxSteps: val
                            });
                        }
                        if (typeof Toast !== 'undefined') Toast.success(val === 0 ? 'Drop-back disabled' : 'Drop-back distance updated');
                        return true;
                    }
                }
            ]
        });

        const inputEl = modal.querySelector('#stepperRelaxStepsInput');
        const displayEl = modal.querySelector('#stepperRelaxStepsDisplay');
        if (inputEl && displayEl) {
            inputEl.addEventListener('input', (e) => {
                const v = parseInt(e.target.value, 10);
                displayEl.textContent = v === 0 ? 'Disabled' : `${v}`;
                if (typeof Haptic !== 'undefined') Haptic.light();
            });
        }
        const defaultBtn2 = modal.querySelector('#stepperRelaxStepsDefault');
        if (defaultBtn2) {
            defaultBtn2.addEventListener('click', () => {
                if (inputEl) { inputEl.value = 128; inputEl.dispatchEvent(new Event('input')); }
                if (typeof Haptic !== 'undefined') Haptic.light();
            });
        }
    });

    // Braking Speed (Acceleration) Setting
    document.querySelector('[data-setting="stepperAcceleration"]')?.addEventListener('click', () => {
        if (typeof Modal === 'undefined') return;

        const currentVal = BlindState.config.stepperAcceleration !== undefined ? BlindState.config.stepperAcceleration : 2000;

        const getBrakingLabel = (v) => {
            if (v <= 500) return 'Very Gentle';
            if (v <= 1000) return 'Gentle';
            if (v <= 2500) return 'Moderate';
            if (v <= 5000) return 'Fast';
            return 'Aggressive';
        };

        const { modal, close } = Modal.create({
            title: 'Braking Speed',
            content: `
                <div style="text-align: center; margin-bottom: 20px;">
                    <span class="modal-value-display" id="stepperAccelerationDisplay" style="display:inline-block; margin-bottom:0;">${currentVal}</span>
                    <span style="font-size: 14px; color: var(--text-tertiary); margin-left: 4px; font-weight:600;">steps/s²</span>
                </div>
                <div style="text-align: center; margin-bottom: 16px;">
                    <span id="stepperAccelerationLabel" style="font-size: 13px; color: var(--accent); font-weight: 600;">${getBrakingLabel(currentVal)}</span>
                </div>
                <input type="range" id="stepperAccelerationInput" min="200" max="8000" step="200" value="${currentVal}"
                    style="width: 100%; height: 8px; border-radius: 4px; -webkit-appearance: none; background: var(--bg-tertiary); outline: none;"
                    class="blind-slider">
                <div style="display: flex; justify-content: space-between; margin-top: 12px; color: var(--text-tertiary); font-size: 12px; font-weight: 500;">
                    <span>Gentle</span>
                    <span>Aggressive</span>
                </div>
                <p style="color: var(--text-tertiary); font-size: 13px; margin-top: 16px; text-align: center;">
                    Controls how quickly the blinds accelerate and brake. Higher values = sharper, faster stops.
                </p>
                <div style="text-align: center; margin-top: 12px;">
                    <button type="button" id="stepperAccelerationDefault" style="background: none; border: 1.5px solid var(--text-tertiary); color: var(--text-secondary); padding: 4px 14px; border-radius: 20px; font-size: 12px; font-weight: 600; cursor: pointer; opacity: 0.7; transition: opacity 0.2s;">Default</button>
                </div>
            `,
            actions: [
                { label: 'Cancel', primary: false },
                {
                    label: 'Save', primary: true,
                    onClick: () => {
                        const input = modal.querySelector('#stepperAccelerationInput');
                        const val = parseInt(input.value, 10);
                        if (isNaN(val)) return true;
                        BlindState.config.stepperAcceleration = val;
                        updateConfigUI();
                        saveDeviceState();

                        if (typeof MQTTClient !== 'undefined' && MQTTClient.connected) {
                            MQTTClient.publishConfig(BlindState.deviceId, {
                                stepperAcceleration: val
                            });
                        }
                        if (typeof Toast !== 'undefined') Toast.success('Braking speed updated');
                        return true;
                    }
                }
            ]
        });

        const inputEl = modal.querySelector('#stepperAccelerationInput');
        const displayEl = modal.querySelector('#stepperAccelerationDisplay');
        const labelEl = modal.querySelector('#stepperAccelerationLabel');
        if (inputEl && displayEl) {
            inputEl.addEventListener('input', (e) => {
                const v = parseInt(e.target.value, 10);
                displayEl.textContent = `${v}`;
                if (labelEl) labelEl.textContent = getBrakingLabel(v);
                if (typeof Haptic !== 'undefined') Haptic.light();
            });
        }
        const defaultBtn3 = modal.querySelector('#stepperAccelerationDefault');
        if (defaultBtn3) {
            defaultBtn3.addEventListener('click', () => {
                if (inputEl) { inputEl.value = 2000; inputEl.dispatchEvent(new Event('input')); }
                if (typeof Haptic !== 'undefined') Haptic.light();
            });
        }
    });

    // Linked Zaylo Lumibot setting
    document.getElementById('linkedSwitchSetting')?.addEventListener('click', showLinkedDevicePicker);
    document.getElementById('linkedDeviceCard')?.addEventListener('click', showLinkedDevicePicker);

    // TWT Setting
    document.getElementById('twtEnabled')?.addEventListener('change', (e) => {
        BlindState.config.twtEnabled = e.target.checked;
        saveDeviceState();
        if (typeof MQTTClient !== 'undefined' && MQTTClient.connected) {
            MQTTClient.publishConfig(BlindState.deviceId, { twtEnabled: e.target.checked });
        }
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
        const saved = JSON.parse(localStorage.getItem(key) || '{}');
        if (saved.blindType && BLIND_TYPES.includes(saved.blindType)) BlindState.blindType = saved.blindType;
        if (saved.position !== undefined) BlindState.position = saved.position;
        if (saved.targetPosition !== undefined) BlindState.targetPosition = saved.targetPosition;
        else BlindState.targetPosition = BlindState.position;
        BlindState._displayPos = BlindState.position;
        BlindState._visualPos = BlindState.position;
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
    } catch (e) {
        console.error('[Blind] Failed to load state:', e);
    }
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

    // Hide Angle settings if Stepper
    let isStepper = false;
    try {
        const device = (typeof DeviceList !== 'undefined') ? DeviceList.get(BlindState.deviceId) : null;
        if (device && (device.type === 'stepper' || device.type === 'blind')) {
            isStepper = true;
        }
    } catch (e) { }

    const angleOnItem = document.getElementById('angleOnSettingItem');
    const angleOffItem = document.getElementById('angleOffSettingItem');
    const stepperOpenSpeedItem = document.getElementById('stepperOpenSpeedSettingItem');
    const stepperCloseSpeedItem = document.getElementById('stepperCloseSpeedSettingItem');
    const stepperStopDelayItem = document.getElementById('stepperStopDelaySettingItem');
    const stepperRelaxStepsItem = document.getElementById('stepperRelaxStepsSettingItem');
    const stepperAccelerationItem = document.getElementById('stepperAccelerationSettingItem');
    const recalibrateStepperItem = document.getElementById('recalibrateStepperSettingsItem');

    if (angleOnItem) angleOnItem.style.display = isStepper ? 'none' : 'flex';
    if (angleOffItem) angleOffItem.style.display = isStepper ? 'none' : 'flex';
    if (stepperOpenSpeedItem) stepperOpenSpeedItem.style.display = isStepper ? 'flex' : 'none';
    if (stepperCloseSpeedItem) stepperCloseSpeedItem.style.display = isStepper ? 'flex' : 'none';
    if (stepperStopDelayItem) stepperStopDelayItem.style.display = isStepper ? 'flex' : 'none';
    if (stepperRelaxStepsItem) stepperRelaxStepsItem.style.display = isStepper ? 'flex' : 'none';
    if (stepperAccelerationItem) stepperAccelerationItem.style.display = isStepper ? 'flex' : 'none';
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

    // Night Lock
    const nightEl = document.getElementById('nightRuleTimeDisplay');
    if (nightEl) {
        const nTime = rConfig.nightTime || '22:00';
        nightEl.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg> ${nTime} — Daily`;
    }

    // Heat Protection
    const tempEl = document.getElementById('tempRuleDisplay');
    if (tempEl) {
        const thresh = rConfig.tempThreshold !== undefined ? rConfig.tempThreshold : 30;
        tempEl.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg> > ${thresh}°C`;
    }
}

let _saveDebounceTimer = null;
function saveDeviceState(mqttPayload = null) {
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
    
    // Sync to Firebase (Persistent Cloud Storage)
    if (typeof Auth !== 'undefined' && typeof DeviceService !== 'undefined') {
        const user = Auth.getUser();
        if (user) {
            DeviceService.init().then(() => {
                DeviceService.updateDevice(window.activeHomeId, BlindState.deviceId, stateObj);
            }).catch(e => console.error('[Blind] Firebase config sync failed:', e));
        }
    }
    
    // Publish to MQTT (Instant Sync to Zaylo Slide Firmware)
    if (typeof MQTTClient !== 'undefined' && MQTTClient.connected) {
        // Publish only what changed, or debounce the full sync
        if (mqttPayload) {
            MQTTClient.publishConfig(BlindState.deviceId, mqttPayload);
        } else {
            clearTimeout(_saveDebounceTimer);
            _saveDebounceTimer = setTimeout(() => {
                // Ensure sunsetOffset uses global value (managed from index page)
                const configCopy = { ...stateObj.config };
                configCopy.sunsetOffset = parseInt(localStorage.getItem('zaylo-SunsetOffset') || '0', 10);
                // CRITICAL: motionTimeout is stored in UI as MINUTES, firmware expects SECONDS.
                // This matches the same conversion in _publishRulesConfig() (line 1168).
                if (configCopy.motionTimeout !== undefined) {
                    configCopy.motionTimeout = (configCopy.motionTimeout || 5) * 60;
                }
                // nightDays: UI stores as [{enabled: bool}, ...], firmware expects [bool, ...]
                if (configCopy.nightDays && Array.isArray(configCopy.nightDays) && configCopy.nightDays.length === 7) {
                    if (typeof configCopy.nightDays[0] === 'object') {
                        configCopy.nightDays = configCopy.nightDays.map(d => d.enabled);
                    }
                }
                // Always send fresh timezone (matches _publishRulesConfig behavior)
                if (typeof MQTTClient.getTimezonePayload === 'function') {
                    const tz = MQTTClient.getTimezonePayload();
                    configCopy.gmtOffset = tz.gmtOffset;
                    configCopy.daylightOffset = tz.daylightOffset;
                }
                MQTTClient.publishConfig(BlindState.deviceId, {
                    rules: stateObj.rules,
                    config: configCopy,
                    linkedDeviceId: stateObj.linkedDeviceId
                });
            }, 500);
        }
    }
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

function addLogEntry(emoji, message) {
    const now = new Date();
    const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    activityLog.unshift({ emoji, message, time, ts: now.getTime() });
    if (activityLog.length > MAX_LOG_ENTRIES) activityLog.pop();
    renderActivityLog();
    // Persist to sessionStorage
    try { sessionStorage.setItem('blind-activity-log', JSON.stringify(activityLog)); } catch(e) {}
}

function renderActivityLog() {
    const container = document.getElementById('automationLog');
    const empty = document.getElementById('logEmpty');
    if (!container) return;

    if (activityLog.length === 0) {
        container.innerHTML = '<div class="log-empty" id="logEmpty">No automation events yet</div>';
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
    // Restore from sessionStorage
    try {
        const saved = sessionStorage.getItem('blind-activity-log');
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
            sessionStorage.removeItem('blind-activity-log');
            renderActivityLog();
            if (typeof Toast !== 'undefined') Toast.success('Activity log cleared');
        });
    }

    // Hook into MQTT state changes to log automation events
    if (typeof StateStore !== 'undefined' && BlindState.deviceId) {
        let prevPosition = BlindState.position;
        let prevRules = { ...BlindState.rules };
        StateStore.subscribe(BlindState.deviceId, (state) => {
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

function addPendingCommand(cmd) {
    pendingCommands.push(cmd);
    updatePendingBadge();
}

function flushPendingCommands() {
    if (typeof MQTTClient === 'undefined' || !MQTTClient.connected) return;
    while (pendingCommands.length > 0) {
        const cmd = pendingCommands.shift();
        // Blind/stepper devices use the stepper-specific topic
        MQTTClient.publishStepperControl(BlindState.deviceId, cmd);
    }
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

                    // Push to device via MQTT (use config topic, not control topic)
                    if (typeof MQTTClient !== 'undefined' && MQTTClient.connected) {
                        MQTTClient.publishConfig(BlindState.deviceId, {
                            config: BlindState.config,
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
    updatePendingBadge();

    // Flush pending commands when MQTT reconnects
    if (typeof MQTTClient !== 'undefined') {
        MQTTClient.on('onConnect', () => {
            if (pendingCommands.length > 0) {
                addLogEntry('📡', `Flushing ${pendingCommands.length} queued command(s)`);
                flushPendingCommands();
            }
        });
    }

    // Setup presence subscription for linked device
    setupPresenceSubscription();
}

// ============================================
// Page Cleanup: Prevent memory leaks on navigation
// ============================================
window.addEventListener('pagehide', () => {
    // Cancel any running animation frames
    if (_animFrameId) {
        cancelAnimationFrame(_animFrameId);
        _animFrameId = null;
    }
    if (_vizAnimFrameId) {
        cancelAnimationFrame(_vizAnimFrameId);
        _vizAnimFrameId = null;
    }
    // Unsubscribe presence watcher
    if (_presenceUnsubscribe) {
        _presenceUnsubscribe();
        _presenceUnsubscribe = null;
    }
});
