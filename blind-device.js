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
    deviceId: null,
    blindType: 'roller',    // roller | venetian | vertical | zebra
    position: 0,            // 0 = closed, 100 = fully open
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
    config: {
        openDuration: 15,
        closeDuration: 15,
        sunsetOffset: 15,
        presenceTimeout: 5,
        morningTime: '07:00',
        nightTime: '22:00',
        tempThreshold: 30
    }
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
        updateConnectionStatus(true);
    });

    MQTTClient.on('onDisconnect', () => {
        updateConnectionStatus(false);
    });

    MQTTClient.on('onStateUpdate', (id, state) => {
        if (id === BlindState.deviceId && state) {
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

    if (state.position !== undefined && state.position !== BlindState.position) {
        BlindState.position = state.position;
        BlindState.isOpen = state.position > 0;
        changed = true;
    }

    // Handle other state properties if needed (e.g. calibration)

    if (changed) {
        updateUI();
        // Don't save to localStorage on every update to avoid thrashing
        // saveDeviceState(); 
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
            if (typeof Haptic !== 'undefined') Haptic.medium();
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
    BlindState.position = Math.max(0, Math.min(100, pos));
    BlindState.isOpen = BlindState.position > 0;
    updateUI();
    saveDeviceState();

    // Publish via MQTT if available
    if (typeof MQTTClient !== 'undefined' && MQTTClient.connected) {
        MQTTClient.publishControl(BlindState.deviceId, {
            blindPosition: BlindState.position,
            blindOpen: BlindState.isOpen
        });
    }
}

// ============================================
// Position Slider
// ============================================
function setupSlider() {
    const slider = document.getElementById('positionSlider');
    if (!slider) return;

    let isDragging = false;

    slider.addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10);
        BlindState.position = val;
        BlindState.isOpen = val > 0;
        updateUI();

        if (!isDragging) {
            isDragging = true;
            document.body.classList.add('no-transition');
            if (typeof Haptic !== 'undefined') Haptic.light();
        }
    });

    slider.addEventListener('change', (e) => {
        isDragging = false;
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

function updatePresetActive(position) {
    document.querySelectorAll('.preset-btn').forEach(btn => {
        const preset = parseInt(btn.dataset.preset, 10);
        btn.classList.toggle('active', preset === position);
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
                    style="width:100%; padding:14px; background:var(--bg-glass); border:1px solid var(--border-glass);
                    border-radius:12px; color:var(--text-primary); font-family:var(--font-family); font-size:16px;"
                    maxlength="24" placeholder="Smart Blinds">
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

    // Linked SwitchMote setting
    document.getElementById('linkedSwitchSetting')?.addEventListener('click', showLinkedDevicePicker);
    document.getElementById('linkedDeviceCard')?.addEventListener('click', showLinkedDevicePicker);
}

function showLinkedDevicePicker() {
    if (typeof Modal === 'undefined') return;

    const devices = JSON.parse(localStorage.getItem('LumiBot-devices') || '[]');
    const switchmotes = devices.filter(d => (d.type || 'lumibot') === 'lumibot');

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
            BlindState.linkedDeviceId = btn.dataset.deviceId;
            updateLinkedDevice();
            saveDeviceState();
            close();
            if (typeof Toast !== 'undefined') Toast.success('Device linked');
        });
    });

    modal.querySelector('#unlinkBtn')?.addEventListener('click', () => {
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
        const name = linked?.name || `LumiBot-${BlindState.linkedDeviceId}`;

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

    // Animated position counter
    animatePositionLabel(pos);

    // Sublabel
    const sublabel = document.getElementById('positionSublabel');
    if (sublabel) {
        if (pos === 0) sublabel.textContent = 'Closed';
        else if (pos === 100) sublabel.textContent = 'Fully Open';
        else if (pos <= 25) sublabel.textContent = 'Slightly Open';
        else if (pos <= 50) sublabel.textContent = 'Half Open';
        else if (pos <= 75) sublabel.textContent = 'Mostly Open';
        else sublabel.textContent = 'Almost Open';
    }

    // Slider
    const slider = document.getElementById('positionSlider');
    if (slider && slider.value != pos) slider.value = pos;
    updateSliderGradient(pos);

    const sliderVal = document.getElementById('sliderValue');
    if (sliderVal) sliderVal.textContent = `${pos}%`;

    // Visualization
    updateVisualization(pos);

    // Buttons
    const openBtn = document.getElementById('openBtn');
    const closeBtn = document.getElementById('closeBtn');
    if (openBtn) openBtn.classList.toggle('active', pos === 100);
    if (closeBtn) closeBtn.classList.toggle('active', pos === 0);

    updatePresetActive(pos);
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
        BlindState._displayPos = BlindState.position;
        if (saved.isOpen !== undefined) BlindState.isOpen = saved.isOpen;
        if (saved.linkedDeviceId !== undefined) BlindState.linkedDeviceId = saved.linkedDeviceId;
        if (saved.rules) Object.assign(BlindState.rules, saved.rules);
        if (saved.config) Object.assign(BlindState.config, saved.config);

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
    } catch (e) {
        console.error('[Blind] Failed to load state:', e);
    }
}

function saveDeviceState() {
    const key = `blind-state-${BlindState.deviceId}`;
    try {
        localStorage.setItem(key, JSON.stringify({
            blindType: BlindState.blindType,
            position: BlindState.position,
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
