/**
 * Zaylo - Blind Rendering Engine (v2)
 * ----------------------------------------------------------------------------
 * Physically-grounded DOM/SVG visualisation for roller, vertical and zebra
 * blinds. A single animation authority (the requestAnimationFrame loop in
 * `animateVisualization`) drives ALL motion during moves; CSS transitions are
 * never used on per-frame-updated elements, so the JS and CSS engines can
 * never fight each other.
 *
 * Position convention (matches firmware): 0 = fully closed, 100 = fully open.
 *
 * Public contract (consumed by blind-device.js / setup.js):
 *   generateVisualization()                 build DOM for BlindState.blindType
 *   updateVisualization(position)           apply position + ambient effects
 *   animateVisualization()                  start the motor-speed RAF loop
 *   _applyVisualization(position, container) apply instantly, optional scope
 *   generate/update{Roller,Vertical,Zebra}  per-type primitives
 *
 * Globals expected on window: BlindState, BLIND_TYPE_LABELS, SLAT_COUNT,
 * VERTICAL_SLAT_COUNT, _vizAnimFrameId.
 */

// ============================================================================
// Geometry / motion tuning constants
// ============================================================================
// Vertical: vanes first TILT open about their vertical axis, then TRAVERSE
// (slide + stack) to one side — exactly how a real motorised vertical blind
// behaves. The split below is the fraction of the 0→100 range spent tilting.
const V_TILT_END_PCT = 32;       // 0..32%  = tilt;  32..100% = traverse
const V_MAX_TILT_DEG = 78;       // edge-on angle at full tilt (keeps a sliver visible)
const V_STACK_ORIGIN_PCT = 3.5;  // left edge the stack collects toward (% of track)
const V_STACK_PITCH_PCT = 2.4;   // gap between bunched vanes when fully drawn (% of track)

// Zebra: stripes first ALIGN (blackout → see-through) then the blind ROLLS UP.
const Z_ALIGN_END_PCT = 30;      // 0..30% = stripe alignment; 30..100% = roll-up
const Z_MAX_LIFT_PCT = 90;       // how far the bottom bar climbs at full open (% of frame)
const Z_BAND_FALLBACK_PX = 22;   // used only until the real rendered height is measured

// Cached zebra band height (single source of truth shared with CSS via the
// rendered element — NEVER hardcoded in the motion math). Re-measured on resize.
let _zebraBandHeightPx = Z_BAND_FALLBACK_PX;

// Cached DOM references to avoid layout thrashing and selector matching overhead on every animation frame.
// Purged when elements are regenerated to prevent memory leaks with detached nodes.
const _vizElements = {};

// ============================================================================
// Dispatcher
// ============================================================================
// Preserve the sp-blinds-inner class on the setup-page container while resetting.
function setContainerClass(container, subClass) {
    const isSp = container.classList.contains('sp-blinds-inner');
    container.className = (isSp ? 'sp-blinds-inner ' : '') + 'blinds-inner' + (subClass ? ' ' + subClass : '');
}

function generateVisualization() {
    const container = document.getElementById('blindsSlats');
    if (!container) return;
    container.innerHTML = '';
    setContainerClass(container); // resets classes while preserving sp-blinds-inner

    // Clear element cache to prevent memory leaks or stale references to detached nodes
    for (const key in _vizElements) {
        delete _vizElements[key];
    }

    switch (BlindState.blindType) {
        case 'roller': generateRoller(container); break;
        case 'vertical': generateVertical(container); break;
        case 'zebra': generateZebra(container); break;
        default: generateRoller(container);
    }
    const badge = document.getElementById('typeBadge');
    if (badge) badge.textContent = BLIND_TYPE_LABELS[BlindState.blindType] || 'Blind';
}

function _getAtmosphericTimeClass() {
    const hour = new Date().getHours();
    if (hour >= 5 && hour < 9) return 'dawn';
    if (hour >= 9 && hour < 17) return 'noon';
    if (hour >= 17 && hour < 20) return 'dusk';
    return 'night';
}

/**
 * Ambient layer (frame "open" glow + atmospheric sunlight beams). Centralised
 * so the slider path, the RAF loop and the first-position snap all stay in
 * perfect agreement instead of each re-deriving it (previously duplicated 3×).
 */
function _applyAmbient(position) {
    const frame = _vizElements.blindsFrame || (_vizElements.blindsFrame = document.getElementById('blindsFrame') || document.getElementById('spBlindsFrame'));
    if (frame) frame.classList.toggle('open', position > 20);

    const beams = _vizElements.sunlightBeams || (_vizElements.sunlightBeams = document.getElementById('sunlightBeams'));
    if (beams) {
        const timeClass = _getAtmosphericTimeClass();
        if (!beams.classList.contains(timeClass)) {
            beams.classList.remove('dawn', 'noon', 'dusk', 'night');
            beams.classList.add(timeClass);
        }
        // Light only spills in once the blind is meaningfully open.
        const beamOpacity = Math.max(0, Math.min(0.95, (position - 10) / 90));
        beams.style.opacity = beamOpacity;
        beams.classList.toggle('active', beamOpacity > 0.05);
    }
}

function updateVisualization(position) {
    _applyVisualization(position);
    _applyAmbient(position);
}

/** Apply the visualization directly at a given position (no animation). */
function _applyVisualization(position, container = null) {
    switch (BlindState.blindType) {
        case 'roller': updateRoller(position, container); break;
        case 'vertical': updateVertical(position, container); break;
        case 'zebra': updateZebra(position, container); break;
    }
}

/**
 * Animation speed in percent-per-millisecond derived from the stepper's
 * physical configuration. When config is available the on-screen blind moves
 * at the exact constant speed of the real hardware.
 * @param {number} diff signed (target − current) in percent
 * @returns {number} speed in %/ms (always positive)
 */
function _calculateAnimationSpeed(diff) {
    const FALLBACK_FULL_TRAVEL_MS = 1500; // 1.5s for a full 0→100 when uncalibrated

    if (!BlindState.config || BlindState.config.stepperTop === undefined || BlindState.config.stepperBottom === undefined) {
        return 100 / FALLBACK_FULL_TRAVEL_MS;
    }

    const range = Math.abs(BlindState.config.stepperTop - BlindState.config.stepperBottom);
    if (range === 0) return 100 / FALLBACK_FULL_TRAVEL_MS;

    const movingUp = diff > 0; // opening
    const stepsPerSecond = movingUp ? BlindState.config.stepperOpenSpeed : BlindState.config.stepperCloseSpeed;
    if (!stepsPerSecond || stepsPerSecond <= 0) return 100 / FALLBACK_FULL_TRAVEL_MS;

    const fullTravelMs = (range / stepsPerSecond) * 1000;
    return 100 / fullTravelMs;
}

function _getVisualizationTarget() {
    const rawTarget = BlindState._visualTargetPos !== undefined
        ? BlindState._visualTargetPos
        : (BlindState.targetPosition !== undefined ? BlindState.targetPosition : BlindState.position);
    const target = Number(rawTarget);
    return Number.isFinite(target) ? Math.max(0, Math.min(100, target)) : 0;
}

/**
 * Strict motor-speed interpolation engine.
 *
 * Animates BlindState._visualPos toward the live visual target at the physical
 * motor speed, so the on-screen blind tracks the real device's constant-velocity
 * travel and smoothly bridges the 1 Hz MQTT position snapshots without waiting
 * for the move to finish. This is the
 * SOLE driver of motion during a move — no element animated here carries a CSS
 * transition, so there is no double-animation/desync.
 */
function animateVisualization() {
    if (_vizAnimFrameId) return; // loop already running

    let lastTime = performance.now();

    function tick(now) {
        if (BlindState.isDragging) { _vizAnimFrameId = null; return; }

        const dt = Math.min(now - lastTime, 50); // clamp big gaps (tab was backgrounded)
        lastTime = now;

        const target = _getVisualizationTarget();
        const diff = target - BlindState._visualPos;

        if (Math.abs(diff) < 0.1) {
            BlindState._visualPos = target;
            _applyVisualization(target);
            _applyAmbient(target);
            _vizAnimFrameId = null; // caught up to confirmed hardware state
            return;
        }

        const maxStep = _calculateAnimationSpeed(diff) * dt;
        if (maxStep >= Math.abs(diff)) {
            BlindState._visualPos = target;
        } else {
            BlindState._visualPos += Math.sign(diff) * maxStep;
        }

        _applyVisualization(BlindState._visualPos);
        _applyAmbient(BlindState._visualPos);

        _vizAnimFrameId = requestAnimationFrame(tick);
    }

    _vizAnimFrameId = requestAnimationFrame(tick);
}

// ============================================================================
// Roller blind — a single fabric sheet retracting up onto the tube.
// ============================================================================
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
function updateRoller(position, container = null) {
    const wrapper = container 
        ? container.querySelector('.roller-wrapper') 
        : (_vizElements.rollerWrapper || (_vizElements.rollerWrapper = document.querySelector('.roller-wrapper')));
    if (!wrapper) return;
    // 0 = closed (fabric fully down); 100 = open (fabric retracted up onto tube).
    wrapper.style.transform = `translateY(-${position}%)`;
}

// ============================================================================
// Vertical blind — vanes hang from a top track. Two real DOFs:
//   1. TILT  : each vane rotates about its own vertical axis (face-on → edge-on)
//   2. TRAVERSE: vanes slide and stack toward one side, clearing the window.
// Geometry note: each .vertical-slat is a flex child of width (100/N)% of the
// track, so a translateX of p% of the slat's own width moves it p/N % of the
// track. We therefore multiply a track-percentage displacement by N to express
// it in the slat's own coordinate space. No scaleX is applied — the container's
// CSS `perspective` provides true 3D foreshortening from rotateY alone.
// ============================================================================
function generateVertical(container) {
    container.innerHTML = '';
    setContainerClass(container, 'vertical-mode');

    const track = document.createElement('div');
    track.className = 'vertical-track';
    container.appendChild(track);

    // SVG for the beaded stabiliser chains linking the vane bottoms.
    const chainsSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    chainsSvg.setAttribute('class', 'vertical-chains-svg');
    chainsSvg.setAttribute('viewBox', '0 0 100 100');
    chainsSvg.setAttribute('preserveAspectRatio', 'none');
    chainsSvg.style.position = 'absolute';
    chainsSvg.style.inset = '0';
    chainsSvg.style.pointerEvents = 'none';
    chainsSvg.style.zIndex = '2';

    const backPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    backPath.setAttribute('class', 'vertical-bead-chain back');
    backPath.setAttribute('fill', 'none');
    const frontPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    frontPath.setAttribute('class', 'vertical-bead-chain front');
    frontPath.setAttribute('fill', 'none');
    chainsSvg.appendChild(backPath);  // behind the vanes
    chainsSvg.appendChild(frontPath); // in front of the vanes
    container.appendChild(chainsSvg);

    for (let i = 0; i < VERTICAL_SLAT_COUNT; i++) {
        const slat = document.createElement('div');
        slat.className = 'vertical-slat';

        const clip = document.createElement('div');
        clip.className = 'vertical-hanger-clip';
        slat.appendChild(clip);

        const inner = document.createElement('div');
        inner.className = 'vertical-slat-inner';
        slat.appendChild(inner);

        const weight = document.createElement('div');
        weight.className = 'vertical-bottom-weight';
        slat.appendChild(weight);

        container.appendChild(slat);
    }
}

function updateVertical(position, container = null) {
    const slats = container 
        ? container.querySelectorAll('.vertical-slat') 
        : (_vizElements.verticalSlats || (_vizElements.verticalSlats = document.querySelectorAll('.vertical-slat')));
    const n = slats.length;
    if (!n) return;

    // Phase 1 — tilt (0 → V_TILT_END_PCT): 0° (closed, vanes overlapping, opaque)
    // to V_MAX_TILT_DEG (edge-on, light pours between).
    const tiltProgress = Math.min(1, position / V_TILT_END_PCT);
    const tiltDeg = tiltProgress * V_MAX_TILT_DEG;
    const cosTilt = Math.cos(tiltDeg * Math.PI / 180);

    // Phase 2 — traverse (V_TILT_END_PCT → 100): vanes slide left and bunch.
    const traverse = Math.max(0, (position - V_TILT_END_PCT) / (100 - V_TILT_END_PCT));

    const cellPct = 100 / n;                 // each vane occupies this % of the track
    const halfVanePct = cellPct / 2;         // half-width of a vane in track %

    // Per-vane horizontal centres (track %) — single source of truth reused by
    // both the vane transforms and the stabiliser-chain path below.
    const centers = new Array(n);

    slats.forEach((slat, i) => {
        const baseCenter = (i + 0.5) * cellPct;                 // spread evenly across the track
        const stackCenter = V_STACK_ORIGIN_PCT + i * V_STACK_PITCH_PCT; // bunched toward the left
        const trackDelta = traverse * (stackCenter - baseCenter); // displacement in track %
        centers[i] = baseCenter + trackDelta;

        // Express the track-% displacement in the slat's own width units (×N).
        const slatTranslatePct = trackDelta * n;
        slat.style.transform = `translateX(${slatTranslatePct}%) rotateY(${tiltDeg}deg)`;

        // Shadow softens and the cast offset shrinks as the vane turns edge-on.
        const shadowOpacity = 0.35 - tiltProgress * 0.25;
        const shadowX = 3 * (1 - tiltProgress);
        slat.style.boxShadow = `${shadowX}px 0 6px rgba(0,0,0,${shadowOpacity.toFixed(3)})`;
        // Front vanes (closer to the stack side) sit above their neighbours when bunched.
        slat.style.zIndex = String(10 + i);
    });

    // Stabiliser chains: two beaded lines threading the front and back lower
    // corners of every vane. The corners separate by ±halfVane·cos(tilt), so the
    // chains visibly spread as the vanes turn edge-on. Derived entirely from the
    // shared `centers[]` so the chain can never drift from the vanes.
    const yBottom = 92; // % down the viewBox
    let frontPath = '';
    let backPath = '';
    for (let i = 0; i < n; i++) {
        const fx = centers[i] - halfVanePct * cosTilt;
        const bx = centers[i] + halfVanePct * cosTilt;
        if (i === 0) {
            frontPath += `M ${fx.toFixed(2)} ${yBottom} `;
            backPath += `M ${bx.toFixed(2)} ${yBottom} `;
        } else {
            const fxPrev = centers[i - 1] - halfVanePct * cosTilt;
            const bxPrev = centers[i - 1] + halfVanePct * cosTilt;
            // Slight gravitational sag between adjacent vanes; vanishes when bunched.
            const sag = Math.max(0, 2.2 * (Math.abs(fx - fxPrev) / cellPct));
            frontPath += `Q ${((fxPrev + fx) / 2).toFixed(2)} ${(yBottom + sag).toFixed(2)} ${fx.toFixed(2)} ${yBottom} `;
            backPath += `Q ${((bxPrev + bx) / 2).toFixed(2)} ${(yBottom + sag).toFixed(2)} ${bx.toFixed(2)} ${yBottom} `;
        }
    }
    const frontEl = container 
        ? container.querySelector('.vertical-bead-chain.front') 
        : (_vizElements.verticalChainsFront || (_vizElements.verticalChainsFront = document.querySelector('.vertical-bead-chain.front')));
    const backEl = container 
        ? container.querySelector('.vertical-bead-chain.back') 
        : (_vizElements.verticalChainsBack || (_vizElements.verticalChainsBack = document.querySelector('.vertical-bead-chain.back')));
    if (frontEl) frontEl.setAttribute('d', frontPath);
    if (backEl) backEl.setAttribute('d', backPath);
}

// ============================================================================
// Zebra / day-night blind — two stacked layers of alternating opaque/sheer
// horizontal stripes. Real DOFs:
//   1. ALIGN : shift the front layer by one band so opaque-over-opaque
//              (see-through) ↔ opaque-over-sheer (blackout).
//   2. LIFT  : roll the whole assembly up onto the top cassette.
//
// The stripes are painted as a CSS `repeating-linear-gradient` on each layer —
// NOT as dozens of <div> bands with per-element backdrop-filter blur. The old
// 48-div + stacked-blur approach pinned the compositor (a screenshot of it
// never settled). Gradient stripes are resolution-independent, need zero extra
// nodes, and shift purely via `background-position-y` (a GPU-friendly paint).
//
// Band height is the single source of truth in CSS (custom property
// `--zebra-band-h`); JS reads it back so the alignment shift can never drift —
// no hardcoded pixel constant, and it tracks any responsive override.
// ============================================================================
function generateZebra(container) {
    container.innerHTML = '';
    setContainerClass(container, 'zebra-mode');

    const cassette = document.createElement('div');
    cassette.className = 'zebra-cassette';
    container.appendChild(cassette);

    const fabricBack = document.createElement('div');
    fabricBack.className = 'zebra-fabric-container back';
    const layer1 = document.createElement('div');
    layer1.className = 'zebra-layer zebra-layer-1'; // painted via CSS gradient
    fabricBack.appendChild(layer1);

    const fabricFront = document.createElement('div');
    fabricFront.className = 'zebra-fabric-container front';
    const layer0 = document.createElement('div');
    layer0.className = 'zebra-layer zebra-layer-0';
    fabricFront.appendChild(layer0);

    container.appendChild(fabricBack);
    const bottomBar = document.createElement('div');
    bottomBar.className = 'zebra-bottom-bar';
    container.appendChild(bottomBar);
    container.appendChild(fabricFront);

    _measureZebraBandHeight(layer0);
}

/** Read the band height (px) from the CSS custom property. Cheap; off the hot path. */
function _measureZebraBandHeight(refEl) {
    const el = refEl || document.querySelector('.zebra-layer');
    if (!el) return;
    const v = parseFloat(getComputedStyle(el).getPropertyValue('--zebra-band-h'));
    if (v > 0) _zebraBandHeightPx = v;
}

function updateZebra(position, container = null) {
    const fabricBack = container 
        ? container.querySelector('.zebra-fabric-container.back') 
        : (_vizElements.zebraFabricBack || (_vizElements.zebraFabricBack = document.querySelector('.zebra-fabric-container.back')));
    const fabricFront = container 
        ? container.querySelector('.zebra-fabric-container.front') 
        : (_vizElements.zebraFabricFront || (_vizElements.zebraFabricFront = document.querySelector('.zebra-fabric-container.front')));
    const bottomBar = container 
        ? container.querySelector('.zebra-bottom-bar') 
        : (_vizElements.zebraBottomBar || (_vizElements.zebraBottomBar = document.querySelector('.zebra-bottom-bar')));
    const layer0 = container 
        ? container.querySelector('.zebra-layer-0') 
        : (_vizElements.zebraLayer0 || (_vizElements.zebraLayer0 = document.querySelector('.zebra-layer-0')));
    const layer1 = container 
        ? container.querySelector('.zebra-layer-1') 
        : (_vizElements.zebraLayer1 || (_vizElements.zebraLayer1 = document.querySelector('.zebra-layer-1')));
    if (!fabricBack || !fabricFront || !layer0 || !layer1) return;

    const bandH = _zebraBandHeightPx;

    // Phase 1 — alignment (0 → Z_ALIGN_END_PCT). At closed the front layer is
    // shifted one band so its opaque stripes cover the back's sheer gaps
    // (blackout). Opening slides that offset to zero → opaque-over-opaque, so the
    // sheer gaps line up and light passes through.
    const alignProgress = Math.min(1, position / Z_ALIGN_END_PCT);
    const frontShiftPx = (1 - alignProgress) * bandH;

    // Phase 2 — roll-up (Z_ALIGN_END_PCT → 100). The bottom bar climbs and the
    // fabric is clipped to just above it; stripes stay registered to the top, so
    // it reads as fabric winding onto the cassette. Alignment is held constant
    // (the previous 2×Y scroll coupling was physically wrong).
    const liftProgress = Math.max(0, (position - Z_ALIGN_END_PCT) / (100 - Z_ALIGN_END_PCT));
    const liftPct = liftProgress * Z_MAX_LIFT_PCT;

    if (bottomBar) bottomBar.style.bottom = `${liftPct}%`;

    const fabricBottom = `calc(${liftPct}% + 8px)`; // sit the fabric just atop the bar
    fabricBack.style.bottom = fabricBottom;
    fabricFront.style.bottom = fabricBottom;

    // Alignment shift via background-position (infinite tiling → no edge seams).
    layer1.style.backgroundPositionY = '0px';
    layer0.style.backgroundPositionY = `${frontShiftPx.toFixed(2)}px`;
}

// Re-measure band height on resize so alignment stays pixel-accurate across
// screen sizes (the previous engine assumed a fixed 24px and broke when scaled).
if (typeof window !== 'undefined') {
    let _zebraResizeRaf = 0;
    window.addEventListener('resize', () => {
        if (_zebraResizeRaf) return;
        _zebraResizeRaf = requestAnimationFrame(() => {
            _zebraResizeRaf = 0;
            // Pass no element so the helper falls back to querySelector('.zebra-layer').
            // Passing `document` here made getComputedStyle(document) throw (document
            // is not an Element), so the re-measure + re-apply below never ran on resize.
            _measureZebraBandHeight();
            // Re-apply current frame so the new geometry takes effect immediately.
            if (typeof BlindState !== 'undefined' && BlindState && BlindState.blindType === 'zebra') {
                _applyVisualization(BlindState._visualPos !== undefined ? BlindState._visualPos : 0);
            }
        });
    });
}
