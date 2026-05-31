/**
 * Zaylo - Blind Rendering Engine
 * Handles SVG/DOM animation interpolation and physics constraints for blind types.
 * Requires BlindState, BLIND_TYPE_LABELS, SLAT_COUNT, VERTICAL_SLAT_COUNT, and _vizAnimFrameId to be defined in global scope.
 */

// ============================================
// Multi-Type Visualization Dispatcher
// ============================================
// Helper to preserve sp-blinds-inner class on setup page container while resetting
function setContainerClass(container, subClass) {
    const isSp = container.classList.contains('sp-blinds-inner');
    container.className = (isSp ? 'sp-blinds-inner ' : '') + 'blinds-inner' + (subClass ? ' ' + subClass : '');
}

function generateVisualization() {
    const container = document.getElementById('blindsSlats');
    if (!container) return;
    container.innerHTML = '';
    setContainerClass(container); // resets classes while preserving sp-blinds-inner

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
    _applyVisualization(position);
    const frame = document.getElementById('blindsFrame') || document.getElementById('spBlindsFrame');
    if (frame) frame.classList.toggle('open', position > 20);
}

/** Apply the visualization directly at a given position (no animation). */
function _applyVisualization(position) {
    switch (BlindState.blindType) {
        case 'roller': updateRoller(position); break;
        case 'venetian': updateVenetian(position); break;
        case 'vertical': updateVertical(position); break;
        case 'zebra': updateZebra(position); break;
    }
}

/**
 * Calculates the animation speed in percent-per-millisecond based on the
 * stepper motor's physical configuration. When config is available, the
 * animation moves at the exact same constant speed as the real blind.
 *
 * @param {number} diff - The signed difference (target − current) in percent.
 * @returns {number} Speed in %/ms (always positive).
 */
function _calculateAnimationSpeed(diff) {
    const FALLBACK_FULL_TRAVEL_MS = 1500; // 1.5s for full 0→100 when uncalibrated

    if (!BlindState.config || BlindState.config.stepperTop === undefined || BlindState.config.stepperBottom === undefined) {
        return 100 / FALLBACK_FULL_TRAVEL_MS;
    }

    const range = Math.abs(BlindState.config.stepperTop - BlindState.config.stepperBottom);
    if (range === 0) return 100 / FALLBACK_FULL_TRAVEL_MS;

    // Pick the correct motor speed for the direction of travel
    const movingUp = diff > 0;
    const stepsPerSecond = movingUp
        ? BlindState.config.stepperOpenSpeed
        : BlindState.config.stepperCloseSpeed;

    if (!stepsPerSecond || stepsPerSecond <= 0) return 100 / FALLBACK_FULL_TRAVEL_MS;

    // Full travel time in milliseconds
    const fullTravelMs = (range / stepsPerSecond) * 1000;

    return 100 / fullTravelMs;
}

/**
 * Extrapolated Strict MQTT Animation Engine
 * 
 * Animates the visuals STRICTLY towards `BlindState.position` (the confirmed
 * physical state from the hardware). It NEVER animates toward `targetPosition`.
 * Because the hardware only publishes position every 1 second while moving,
 * this engine uses physical motor speed to smoothly interpolate visual frames
 * between those 1-second MQTT snapshots, ensuring perfect smoothness without
 * ever predicting unconfirmed future states.
 */
function animateVisualization() {
    if (_vizAnimFrameId) return; // tick loop already running

    let lastTime = performance.now();

    function tick(now) {
        if (BlindState.isDragging) {
            _vizAnimFrameId = null;
            return;
        }

        const dt = Math.min(now - lastTime, 50); // cap to 50 ms
        lastTime = now;

        // The only truth is the actual confirmed hardware position
        const target = BlindState.position !== undefined ? BlindState.position : 0;
        const diff = target - BlindState._visualPos;

        if (Math.abs(diff) < 0.1) {
            BlindState._visualPos = target;
            _applyVisualization(target);
            const frame = document.getElementById('blindsFrame') || document.getElementById('spBlindsFrame');
            if (frame) frame.classList.toggle('open', target > 20);
            
            // Loop stops when we visually catch up to the confirmed hardware state
            _vizAnimFrameId = null;
            return;
        }

        // Calculate maximum physical speed the motor could be moving
        const maxSpeedPerMs = _calculateAnimationSpeed(diff);
        const maxStep = maxSpeedPerMs * dt;
        
        // Move _visualPos toward target, capped at the physical motor's speed
        if (maxStep >= Math.abs(diff)) {
            BlindState._visualPos = target;
        } else {
            BlindState._visualPos += Math.sign(diff) * maxStep;
        }

        _applyVisualization(BlindState._visualPos);

        const frame = document.getElementById('blindsFrame') || document.getElementById('spBlindsFrame');
        if (frame) frame.classList.toggle('open', BlindState._visualPos > 20);

        _vizAnimFrameId = requestAnimationFrame(tick);
    }

    _vizAnimFrameId = requestAnimationFrame(tick);
}

// --- Roller Blind ---
function generateRoller(container) {
    container.innerHTML = `
        <div class="roller-tube">
            <div class="roller-tube-end-l"></div>
            <div class="roller-tube-end-r"></div>
        </div>
        <div class="roller-sheet" id="rollerSheet">
            <div class="roller-wrapper" style="position: absolute; inset: 0;">
                <div class="roller-fabric"></div>
                <div class="roller-texture"></div>
                <div class="roller-bottom-bar"></div>
            </div>
        </div>
    `;
}
function updateRoller(position) {
    const wrapper = document.querySelector('#rollerSheet .roller-wrapper');
    if (!wrapper) return;
    
    // position 0 = fully closed (translateY 0%)
    // position 100 = fully open (translateY -100%, fabric retracted to top)
    const openPercent = position;
    
    // Move the entire wrapper up together so the fabric and bottom bar stay aligned
    wrapper.style.transform = `translateY(-${openPercent}%)`;
}

// --- Venetian Blind ---
function generateVenetian(container) {
    container.innerHTML = '';
    setContainerClass(container, 'venetian-mode');
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
    setContainerClass(container, 'vertical-mode');
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
    setContainerClass(container, 'zebra-mode');
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
