/**
 * SwitchMote — Smart Blind Device Page Logic
 * Premium blind control with smart automations
 * Supports: Roller, Venetian, Vertical, Zebra blind types
 */

// ============================================
// Constants
// ============================================
const BLIND_TYPES = ['roller', 'venetian', 'vertical', 'zebra'];
const BLIND_TYPE_LABELS = { roller: 'Roller Blind', venetian: 'Venetian Blind', vertical: 'Vertical Blind', zebra: 'Zebra Blind' };
const BLIND_TYPE_ICONS = { roller: '🪟', venetian: '📐', vertical: '📏', zebra: '🦓' };
const SLAT_COUNT = 12;
const VERTICAL_SLAT_COUNT = 8;
let _animFrameId = null;

// ============================================
// State
// ============================================
const BlindState = {
    deviceId: new URLSearchParams(window.location.search).get('id'),
    blindType: 'roller',    // roller | venetian | vertical | zebra
    position: 0,            // 0 = closed, 100 = fully open
    targetPosition: 0,      // destination, used for buttons
    _displayPos: 0,         // animated display position for smooth counter
    isOpen: false,
    isOnline: false,
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
        sunsetOffset: 15,
        sunsetTarget: 0,
        motionTimeout: 5,
        presenceTarget: 0,
        morningTime: '07:00',
        morningDuration: 30,
        morningTarget: 100,
        nightTime: '22:00',
        nightTarget: 0,
        tempThreshold: 30,
        tempTarget: 20,
        angleOn: 90,           // Default value for "open" servo angle
        angleOff: 0,           // Default value for "closed" servo angle
        stepperOpenSpeed: 2000, // steps/s when opening
        stepperCloseSpeed: 2000 // steps/s when closing
    },
    isDragging: false      // Prevent incoming MQTT state updates from jumping slider
};

// ============================================
// Initialization
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    const params = new URLSearchParams(window.location.search);
    BlindState.deviceId = params.get('id');

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

    // Setup UI
    generateVisualization();
    setupDock();
    setupControls();
    setupSlider();
    setupPresets();
    setupRuleToggles();
    setupRuleConfigModals();
    setupTypeSelector();
    setupSettings();
    updateUI();

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

    // Initialize PWA visibility handler for background reconnection
    MQTTClient.initVisibilityHandler();

    // Connect to broker
    MQTTClient.connect();

    // Subscribe to callbacks
    MQTTClient.on('onConnect', () => {
        if (BlindState.deviceId) {
            MQTTClient.subscribeDevice(BlindState.deviceId);
        }
        if (BlindState.linkedDeviceId) {
            MQTTClient.subscribeDevice(BlindState.linkedDeviceId);
        }
        updateConnectionStatus(true);
    });

    MQTTClient.on('onDisconnect', () => {
        updateConnectionStatus(false);
    });

    // Use Centralized StateStore
    StateStore.subscribe(BlindState.deviceId, (state) => {
        if (state) {
            handleStateUpdate(state);
        }
    });
}

function updateConnectionStatus(connected) {
    BlindState.isOnline = connected;
    const badge = document.getElementById('connectionBadge');
    if (badge) {
        badge.className = `device-status-badge ${connected ? 'online' : 'offline'}`;
        badge.innerHTML = `
            <div class="status-dot ${connected ? 'online' : ''}"></div>
            ${connected ? 'Online' : 'Offline'}
        `;
    }
}

function handleStateUpdate(state) {
    let changed = false;

    // Position updates — firmware sends 'blindPosition' and 'position'
    // Ignore updates if the user is actively dragging the position slider to prevent jumping
    const pos = state.position !== undefined ? state.position : state.blindPosition;
    if (pos !== undefined && pos !== BlindState.position && !BlindState.isDragging) {
        BlindState.position = pos;
        BlindState.isOpen = pos > 0;
        changed = true;
    }

    if (state.targetPosition !== undefined && state.targetPosition !== BlindState.targetPosition) {
        BlindState.targetPosition = state.targetPosition;
        changed = true;
    } else if (state.targetPosition === undefined && pos !== undefined && pos !== BlindState.targetPosition) {
        // Fallback if firmware isn't sending targetPosition yet
        BlindState.targetPosition = pos;
        changed = true;
    }

    // Moving state
    if (state.isMoving !== undefined) {
        const label = document.getElementById('positionLabel');
        if (label) {
            label.classList.toggle('is-moving', state.isMoving);
        }
    }

    // Config updates (e.g., calibration angles)
    if (state.config) {
        Object.assign(BlindState.config, state.config);
        updateConfigUI();
    }

    // Rules updates
    if (state.rules) {
        Object.assign(BlindState.rules, state.rules);
        // Refresh rule toggles in UI
        Object.entries(BlindState.rules).forEach(([rule, enabled]) => {
            const toggle = document.querySelector(`[data-rule-toggle="${rule}"]`);
            if (toggle) {
                toggle.checked = enabled;
                const card = toggle.closest('.smart-rule-card');
                if (card) card.classList.toggle('active-rule', enabled);
            }
        });
    }

    if (changed) {
        updateUI();
    }
}

// ============================================
// Multi-Type Visualization Dispatcher
// ============================================
function generateVisualization() {
    const container = document.getElementById('blindsSlats');
    if (!container) return;
    container.innerHTML = '';
    container.className = 'blinds-inner'; // reset classes

    switch (BlindState.blindType) {
        case 'roller': generateRoller(container); break;
        case 'venetian': generateVenetian(container); break;
        case 'vertical': generateVertical(container); break;
        case 'zebra': generateZebra(container); break;
        default: generateRoller(container);
    }
    // Update type badge
    const badge = document.getElementById('typeBadge');
    if (badge) badge.textContent = BLIND_TYPE_LABELS[BlindState.blindType] || 'Blind';
}

function updateVisualization(position) {
    switch (BlindState.blindType) {
        case 'roller': updateRoller(position); break;
        case 'venetian': updateVenetian(position); break;
        case 'vertical': updateVertical(position); break;
        case 'zebra': updateZebra(position); break;
    }
    const frame = document.getElementById('blindsFrame');
    if (frame) frame.classList.toggle('open', position > 20);
}

// --- Roller Blind ---
function generateRoller(container) {
    container.innerHTML = `
        <div class="roller-tube">
            <div class="roller-tube-end-l"></div>
            <div class="roller-tube-end-r"></div>
        </div>
        <div class="roller-sheet" id="rollerSheet">
            <div class="roller-fabric"></div>
            <div class="roller-texture"></div>
            <div class="roller-bottom-bar"></div>
        </div>
    `;
}
function updateRoller(position) {
    const sheet = document.getElementById('rollerSheet');
    if (!sheet) return;
    // position 0 = fully closed (bottom: 0, sheet fills frame)
    // position 100 = fully open (bottom: 100%, sheet retracted to top)
    const openPercent = position;
    sheet.style.bottom = `${openPercent}%`;
}

// --- Venetian Blind ---
function generateVenetian(container) {
    container.innerHTML = '';
    container.className = 'blinds-inner venetian-mode';
    for (let i = 0; i < SLAT_COUNT; i++) {
        const slat = document.createElement('div');
        slat.className = 'blind-slat';
        slat.style.transitionDelay = `${i * 0.025}s`;
        container.appendChild(slat);
    }
}
function updateVenetian(position) {
    const slats = document.querySelectorAll('.blind-slat');
    const openFraction = position / 100;
    slats.forEach((slat, i) => {
        // Progressive reveal from top to bottom
        const progress = Math.max(0, Math.min(1,
            (openFraction - (i / SLAT_COUNT) * 0.4) / 0.6
        ));
        // Slats rotate to let light through (0° = flat/closed, 80° = open)
        const rotateX = progress * 80;
        // Shrink height as they rotate to simulate 3D perspective
        const scaleY = 1 - (progress * 0.82);
        // Fade as they open to reveal sky
        const opacity = 1 - (progress * 0.85);
        // Shadow decreases as slats open
        const shadowBlur = 3 - (progress * 2.5);
        slat.style.transform = `rotateX(${rotateX}deg) scaleY(${scaleY})`;
        slat.style.opacity = Math.max(0, opacity);
        slat.style.boxShadow = `0 1px ${Math.max(0, shadowBlur)}px rgba(0,0,0,${0.25 - progress * 0.2})`;
    });
}

// --- Vertical Blind ---
function generateVertical(container) {
    container.innerHTML = '';
    container.className = 'blinds-inner vertical-mode';
    // Add track rail
    const track = document.createElement('div');
    track.className = 'vertical-track';
    container.appendChild(track);
    for (let i = 0; i < VERTICAL_SLAT_COUNT; i++) {
        const slat = document.createElement('div');
        slat.className = 'vertical-slat';
        slat.style.transitionDelay = `${i * 0.035}s`;
        container.appendChild(slat);
    }
}
function updateVertical(position) {
    const slats = document.querySelectorAll('.vertical-slat');
    const openFraction = position / 100;
    slats.forEach((slat, i) => {
        // Left-to-right progressive open
        const progress = Math.max(0, Math.min(1,
            (openFraction - (i / VERTICAL_SLAT_COUNT) * 0.5) / 0.5
        ));
        // Rotate on Y axis (0° = flat facing forward, 88° = edge-on)
        const rotateY = progress * 88;
        // Also narrow the slat as it rotates to simulate perspective
        const scaleX = 1 - (progress * 0.85);
        // Fade to reveal the sky behind
        const opacity = 1 - (progress * 0.9);
        slat.style.transform = `rotateY(${rotateY}deg) scaleX(${scaleX})`;
        slat.style.opacity = Math.max(0, opacity);
    });
}

// --- Zebra / Day-Night Blind ---
function generateZebra(container) {
    container.innerHTML = '';
    container.className = 'blinds-inner zebra-mode';
    const bandCount = 14; // enough to fill the container
    for (let layer = 0; layer < 2; layer++) {
        const layerEl = document.createElement('div');
        layerEl.className = `zebra-layer zebra-layer-${layer}`;
        layerEl.id = `zebraLayer${layer}`;
        for (let i = 0; i < bandCount; i++) {
            const band = document.createElement('div');
            band.className = i % 2 === 0 ? 'zebra-band opaque' : 'zebra-band sheer';
            layerEl.appendChild(band);
        }
        container.appendChild(layerEl);
    }
}
function updateZebra(position) {
    const layer1 = document.getElementById('zebraLayer1');
    if (!layer1) return;
    // Shift second layer: at 0% opaque bands align (fully closed), 
    // at 100% shift one full band height (24px) so opaque aligns over sheer = open
    const shift = (position / 100) * 24;
    layer1.style.transform = `translateY(${shift}px)`;
}

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
    const parentRect = pill.parentElement.getBoundingClientRect();
    const btnRect = btns[idx].getBoundingClientRect();
    pill.style.width = `${btnRect.width}px`;
    pill.style.transform = `translateX(${btnRect.left - parentRect.left}px)`;
}

// ============================================
// Animated Position Counter
// ============================================
function animatePositionLabel(to) {
    if (_animFrameId) cancelAnimationFrame(_animFrameId);
    const label = document.getElementById('positionLabel');
    if (!label) return;

    const from = BlindState._displayPos;
    const duration = 350;
    const start = performance.now();

    function tick(now) {
        const elapsed = now - start;
        const t = Math.min(elapsed / duration, 1);
        // Ease out quad
        const ease = t * (2 - t);
        const current = Math.round(from + (to - from) * ease);
        label.textContent = `${current}%`;
        BlindState._displayPos = current;
        if (t < 1) {
            _animFrameId = requestAnimationFrame(tick);
        } else {
            _animFrameId = null;
        }
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
            switchTab(btn.dataset.tab, index);
            if (typeof Haptic !== 'undefined') Haptic.selection();
        });
    });
    moveDockPill(0);
}

function switchTab(tabName, btnIndex) {
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    const panel = document.getElementById(`${tabName}-panel`);
    if (panel) panel.classList.add('active');

    document.querySelectorAll('.dock-btn').forEach(b => b.classList.remove('active'));
    const activeBtn = document.querySelector(`[data-tab="${tabName}"]`);
    if (activeBtn) activeBtn.classList.add('active');
    moveDockPill(btnIndex);
}

function moveDockPill(index) {
    const pill = document.getElementById('dockPill');
    if (!pill) return;
    pill.style.transform = `translateX(${index * 52}px)`;
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
            if (typeof Haptic !== 'undefined') Haptic.heavy();
        });
    }

    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            setPosition(0);
            if (typeof Haptic !== 'undefined') Haptic.medium();
        });
    }
}

function setPosition(pos) {
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
        // Do NOT update BlindState.position — that drives the animation/text
        // and should only change when the device actually moves.
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
        toggle.addEventListener('change', () => {
            const rule = toggle.dataset.ruleToggle;
            BlindState.rules[rule] = toggle.checked;

            // Toggle active-rule class on card
            const card = toggle.closest('.smart-rule-card');
            if (card) card.classList.toggle('active-rule', toggle.checked);

            updateActiveRulesCount();
            saveDeviceState();

            // Tell the engine rules changed so it re-evaluates immediately
            if (typeof AutomationEngine !== 'undefined' && AutomationEngine.evaluate) {
                AutomationEngine.evaluate();
            }

            if (typeof Haptic !== 'undefined') Haptic.selection();
            if (typeof Toast !== 'undefined') {
                Toast.success(`${toggle.checked ? 'Enabled' : 'Disabled'} rule`);
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
        MQTTClient.publishConfig(BlindState.deviceId, {
            sunsetOffset: BlindState.config.sunsetOffset,
            sunsetTarget: BlindState.config.sunsetTarget,
            motionTimeout: BlindState.config.motionTimeout,
            presenceTarget: BlindState.config.presenceTarget,
            presenceAction: BlindState.config.presenceAction,
            presenceOpenTarget: BlindState.config.presenceOpenTarget,
            presenceTimeFilter: BlindState.config.presenceTimeFilter,
            morningTime: BlindState.config.morningTime,
            morningDuration: BlindState.config.morningDuration,
            morningTarget: BlindState.config.morningTarget,
            nightTime: BlindState.config.nightTime,
            nightTarget: BlindState.config.nightTarget,
            tempThreshold: BlindState.config.tempThreshold,
            tempTarget: BlindState.config.tempTarget
        });
    }
}

function showSunsetConfigModal() {
    const defaultOffset = BlindState.config.sunsetOffset !== undefined ? BlindState.config.sunsetOffset : 15;
    const defaultTarget = BlindState.config.sunsetTarget !== undefined ? BlindState.config.sunsetTarget : 0;

    const { modal, close } = Modal.create({
        title: 'Sunset Configuration',
        content: `
            <div class="setting-item" style="padding: 12px 0; border: none;">
                <div class="setting-left">
                    <span class="setting-label">Time Offset (Minutes)</span>
                    <span class="setting-sublabel">Close after sunset (+) or before (-)</span>
                </div>
            </div>
            <input type="number" id="sunsetOffsetInput" value="${defaultOffset}" class="modal-input" placeholder="Minutes">
            
            <div class="setting-item" style="padding: 16px 0 12px 0; border: none; margin-top: 12px;">
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
                    BlindState.config.sunsetOffset = isNaN(offsetVal) ? 15 : offsetVal;
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

function showMorningConfigModal() {
    const defaultTime = BlindState.config.morningTime || '07:00';
    const defaultDuration = BlindState.config.morningDuration || 30;
    const defaultTarget = BlindState.config.morningTarget !== undefined ? BlindState.config.morningTarget : 100;

    const { modal, close } = Modal.create({
        title: 'Morning Wake-Up',
        content: `
            <div class="setting-item" style="padding: 12px 0; border: none;">
                <div class="setting-left">
                    <span class="setting-label">Wake-up Time</span>
                    <span class="setting-sublabel">When should the routine finish?</span>
                </div>
            </div>
            <input type="time" id="morningTimeInput" value="${defaultTime}" class="modal-input">
            
            <div class="setting-item" style="padding: 16px 0 12px 0; border: none; margin-top: 12px;">
                <div class="setting-left">
                    <span class="setting-label">Gradual Duration (Minutes)</span>
                    <span class="setting-sublabel">How long to slowly open</span>
                </div>
            </div>
            <input type="number" id="morningDurationInput" value="${defaultDuration}" min="1" max="120" class="modal-input" placeholder="Minutes">

            <div class="setting-item" style="padding: 16px 0 12px 0; border: none; margin-top: 12px;">
                <div class="setting-left">
                    <span class="setting-label">Target Open Position (%)</span>
                </div>
            </div>
            <input type="range" id="morningTargetInput" min="0" max="100" value="${defaultTarget}" class="blind-slider" style="width: 100%; height: 8px; border-radius: 4px; -webkit-appearance: none; background: var(--bg-tertiary); outline: none;">
            <div class="modal-value-display" id="morningTargetDisplay">${defaultTarget}%</div>
        `,
        actions: [
            { label: 'Cancel', primary: false },
            {
                label: 'Save', primary: true, onClick: () => {
                    BlindState.config.morningTime = modal.querySelector('#morningTimeInput').value || '07:00';
                    let durVal = parseInt(modal.querySelector('#morningDurationInput').value, 10);
                    BlindState.config.morningDuration = isNaN(durVal) ? 30 : Math.max(1, durVal);
                    const morningTargetVal = parseInt(modal.querySelector('#morningTargetInput').value, 10);
                    BlindState.config.morningTarget = isNaN(morningTargetVal) ? 100 : morningTargetVal;

                    updateConfigUI();

                    _publishRulesConfig();
                    if (typeof Toast !== 'undefined') Toast.success('Morning routine updated');
                    return true;
                }
            }
        ]
    });

    const targetInput = modal.querySelector('#morningTargetInput');
    const targetDisplay = modal.querySelector('#morningTargetDisplay');
    targetInput.addEventListener('input', (e) => {
        targetDisplay.textContent = e.target.value + '%';
        if (typeof Haptic !== 'undefined') Haptic.light();
    });
}

function showNightLockConfigModal() {
    const defaultTime = BlindState.config.nightTime || '22:00';
    const defaultTarget = BlindState.config.nightTarget !== undefined ? BlindState.config.nightTarget : 0;

    const { modal, close } = Modal.create({
        title: 'Night Lock',
        content: `
            <div class="setting-item" style="padding: 12px 0; border: none;">
                <div class="setting-left">
                    <span class="setting-label">Lock Time</span>
                    <span class="setting-sublabel">When should the blinds close?</span>
                </div>
            </div>
            <input type="time" id="nightTimeInput" value="${defaultTime}" class="modal-input">
            
            <div class="setting-item" style="padding: 16px 0 12px 0; border: none; margin-top: 12px;">
                <div class="setting-left">
                    <span class="setting-label">Target Position (%)</span>
                </div>
            </div>
            <input type="range" id="nightTargetInput" min="0" max="100" value="${defaultTarget}" class="blind-slider" style="width: 100%; height: 8px; border-radius: 4px; -webkit-appearance: none; background: var(--bg-tertiary); outline: none;">
            <div class="modal-value-display" id="nightTargetDisplay">${defaultTarget}%</div>
        `,
        actions: [
            { label: 'Cancel', primary: false },
            {
                label: 'Save', primary: true, onClick: () => {
                    BlindState.config.nightTime = modal.querySelector('#nightTimeInput').value || '22:00';
                    let nightTargetVal = parseInt(modal.querySelector('#nightTargetInput').value, 10);
                    BlindState.config.nightTarget = isNaN(nightTargetVal) ? 0 : nightTargetVal;

                    updateConfigUI();

                    _publishRulesConfig();
                    if (typeof Toast !== 'undefined') Toast.success('Night lock updated');
                    return true;
                }
            }
        ]
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

    // Remove device
    document.getElementById('removeDeviceBtn')?.addEventListener('click', () => {
        if (typeof Modal === 'undefined') return;
        Modal.confirm(
            'Remove Device',
            'Are you sure you want to remove this blind device? This cannot be undone.',
            async () => {
                // Remove from local storage
                const devices = JSON.parse(localStorage.getItem('LumiBot-devices') || '[]');
                const updated = devices.filter(d => d.id !== BlindState.deviceId);
                localStorage.setItem('LumiBot-devices', JSON.stringify(updated));

                // Remove from Firebase
                try {
                    if (typeof Auth !== 'undefined' && typeof DeviceService !== 'undefined') {
                        const user = Auth.getUser();
                        if (user) {
                            await DeviceService.init();
                            await DeviceService.removeDevice(user.uid, BlindState.deviceId);
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
                if (typeof MQTTClient !== 'undefined' && MQTTClient.connected) {
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
                const devices = JSON.parse(localStorage.getItem('LumiBot-devices') || '[]');
                const device = devices.find(d => d.id === BlindState.deviceId);
                if (device && device.type === 'stepper') {
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
                        <span class="icon">⬆️</span>
                        <span>Save Fully OPEN</span>
                        <span class="angle">Top Limit</span>
                    </button>
                    <button class="save-btn on" id="deviceSaveStepperBottomBtn">
                        <span class="icon">⬇️</span>
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

            if (direction === 1) feedbackEl.textContent = 'Moving OPEN ▲';
            else if (direction === -1) feedbackEl.textContent = 'Moving CLOSE ▼';
            else feedbackEl.textContent = 'Idle';
        };

        // Jog Up
        const upBtn = modal.querySelector('#deviceJogUpBtn');
        if (upBtn) {
            upBtn.addEventListener('pointerdown', (e) => {
                e.preventDefault();
                sendJog(1);
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
                sendJog(-1);
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

    // Linked SwitchMote setting
    document.getElementById('linkedSwitchSetting')?.addEventListener('click', showLinkedDevicePicker);
    document.getElementById('linkedDeviceCard')?.addEventListener('click', showLinkedDevicePicker);
}

function showLinkedDevicePicker() {
    if (typeof Modal === 'undefined') return;

    const devices = JSON.parse(localStorage.getItem('LumiBot-devices') || '[]');
    // Filter out blinds/steppers, keeping switchmotes (which may be saved as 'servo' or 'lumibot')
    const switchmotes = devices.filter(d => ['stepper', 'blind'].indexOf(d.type) === -1);

    if (switchmotes.length === 0) {
        if (typeof Toast !== 'undefined') Toast.info('No SwitchMote devices found');
        return;
    }

    const options = switchmotes.map(d => `
        <button class="link-option" data-device-id="${d.id}" style="
            display: flex; align-items: center; gap: 14px;
            padding: 14px 18px; width: 100%;
            background: ${d.id === BlindState.linkedDeviceId ? 'var(--blind-accent-gradient-subtle)' : 'var(--bg-glass)'};
            border: 1.5px solid ${d.id === BlindState.linkedDeviceId ? 'var(--blind-accent)' : 'var(--border-glass)'};
            border-radius: 14px; color: var(--text-primary);
            font-family: var(--font-family); cursor: pointer;
            transition: all 0.2s ease; margin-bottom: 8px;
        ">
            <span style="font-size: 24px;">💡</span>
            <div style="text-align: left;">
                <div style="font-weight: 700;">${escapeHtml(d.name || 'LumiBot-' + d.id)}</div>
                <div style="font-size: 12px; color: var(--text-tertiary);">ID: ${d.id}</div>
            </div>
            ${d.id === BlindState.linkedDeviceId ? '<span style="margin-left:auto; color: var(--blind-accent);">✓</span>' : ''}
        </button>
    `).join('');

    const { modal, close } = Modal.create({
        title: 'Link SwitchMote',
        content: `
            <p style="color: var(--text-secondary); margin-bottom: 16px;">
                Select a SwitchMote for presence detection via radar
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
        const devices = JSON.parse(localStorage.getItem('LumiBot-devices') || '[]');
        const linked = devices.find(d => d.id === BlindState.linkedDeviceId);
        const name = linked?.name || `LumiBot - ${BlindState.linkedDeviceId} `;

        if (nameEl) nameEl.textContent = name;
        if (statusEl) statusEl.textContent = 'Radar presence detection active';
        if (badgeEl) { badgeEl.style.display = ''; badgeEl.textContent = 'Connected'; }
        if (settingValue) settingValue.textContent = name;
    } else {
        if (nameEl) nameEl.textContent = 'No device linked';
        if (statusEl) statusEl.textContent = 'Tap to link a SwitchMote for presence detection';
        if (badgeEl) badgeEl.style.display = 'none';
        if (settingValue) settingValue.textContent = 'None';
    }
}

// ============================================
// UI Update — Master Render
// ============================================
function updateUI() {
    const pos = BlindState.position;
    const targetPos = BlindState.targetPosition;

    // Animated position counter (follows real position)
    animatePositionLabel(pos);

    // Sublabel (follows real position)
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

    // Visualization (follows real position)
    updateVisualization(pos);

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
        const devices = JSON.parse(localStorage.getItem('LumiBot-devices') || '[]');
        const device = devices.find(d => d.id === BlindState.deviceId);
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

    // Hide Angle settings if Stepper
    let isStepper = false;
    try {
        const devices = JSON.parse(localStorage.getItem('LumiBot-devices') || '[]');
        const device = devices.find(d => d.id === BlindState.deviceId);
        if (device && device.type === 'stepper') {
            isStepper = true;
        }
    } catch (e) { }

    const angleOnItem = document.getElementById('angleOnSettingItem');
    const angleOffItem = document.getElementById('angleOffSettingItem');
    const stepperOpenSpeedItem = document.getElementById('stepperOpenSpeedSettingItem');
    const stepperCloseSpeedItem = document.getElementById('stepperCloseSpeedSettingItem');
    const recalibrateStepperItem = document.getElementById('recalibrateStepperSettingsItem');

    if (angleOnItem) angleOnItem.style.display = isStepper ? 'none' : 'flex';
    if (angleOffItem) angleOffItem.style.display = isStepper ? 'none' : 'flex';
    if (stepperOpenSpeedItem) stepperOpenSpeedItem.style.display = isStepper ? 'flex' : 'none';
    if (stepperCloseSpeedItem) stepperCloseSpeedItem.style.display = isStepper ? 'flex' : 'none';
    if (recalibrateStepperItem) recalibrateStepperItem.style.display = isStepper ? 'flex' : 'none';

    // Smart Rules Displays
    const rConfig = BlindState.config;

    // Sunset
    const sunsetEl = document.getElementById('sunsetRuleDisplay');
    if (sunsetEl) {
        const offset = rConfig.sunsetOffset !== undefined ? rConfig.sunsetOffset : 15;
        const offsetStr = offset >= 0 ? `+${offset}` : `${offset}`;
        sunsetEl.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg> Sunset ${offsetStr} min`;
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

    // Morning
    const morningEl = document.getElementById('morningRuleTimeDisplay');
    if (morningEl) {
        const mTime = rConfig.morningTime || '07:00';
        morningEl.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg> ${mTime} — Gradual`;
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

function saveDeviceState() {
    const key = `blind-state-${BlindState.deviceId}`;
    try {
        localStorage.setItem(key, JSON.stringify({
            blindType: BlindState.blindType,
            position: BlindState.position,
            targetPosition: BlindState.targetPosition,
            isOpen: BlindState.isOpen,
            linkedDeviceId: BlindState.linkedDeviceId,
            rules: BlindState.rules,
            config: BlindState.config
        }));
    } catch (e) {
        console.error('[Blind] Failed to save state:', e);
    }
}

// ============================================
// Helpers
// ============================================
function getDeviceName() {
    const devices = JSON.parse(localStorage.getItem('LumiBot-devices') || '[]');
    const device = devices.find(d => d.id === BlindState.deviceId);
    return device?.name || 'Smart Blinds';
}

function setDeviceName(name) {
    // Update local storage
    const devices = JSON.parse(localStorage.getItem('LumiBot-devices') || '[]');
    const device = devices.find(d => d.id === BlindState.deviceId);
    if (device) {
        device.name = name;
        localStorage.setItem('LumiBot-devices', JSON.stringify(devices));
    }

    // Update Firebase
    if (typeof Auth !== 'undefined' && typeof DeviceService !== 'undefined') {
        const user = Auth.getUser();
        if (user) {
            DeviceService.init().then(() => {
                DeviceService.updateDevice(user.uid, BlindState.deviceId, { name });
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
