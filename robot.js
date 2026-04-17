/**
 * LumiBot — Robot Companion Interface Controller
 * Handles all interactive logic, animations, demo data, and MQTT integration
 * Version: 1.0.0
 */

// ============================================
// Initialization
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    Theme.init();
    Network.init();
    Toast.init();
    LumiBot.init();
});

const LumiBot = {
    currentTab: 'dashboard',
    radarAnimFrame: null,
    focusTimer: null,
    breathingTimer: null,
    demoInterval: null,
    touchStartX: 0,
    touchStartY: 0,
    tabs: ['dashboard', 'sensors', 'focus', 'control'],

    // Demo state
    demo: {
        battery: 80,
        latency: 24,
        temp: 42,
        uptime: 134, // minutes
        pitch: 2.4,
        roll: -0.8,
        yaw: 127,
        state: 'balancing',
        radarBlips: [],
        charging: false
    },

    // Focus state
    focus: {
        duration: 25 * 60,
        remaining: 25 * 60,
        running: false,
        selectedMinutes: 25
    },

    init() {
        this.setupTabs();
        this.setupSwipeNav();
        this.setupBackButton();
        this.setupJoystick();
        this.setupFocusTimer();
        this.setupBreathing();
        this.setupSoundControls();
        this.setupCommandTiles();
        this.setupEnvironmentNodes();
        this.setupTranscript();
        this.setupWaveformBars();
        this.startDemoData();
        this.generatePredictiveActions();

        // Check URL hash for direct tab navigation (e.g., robot.html#sensors)
        const hash = window.location.hash.replace('#', '');
        if (hash && this.tabs.includes(hash)) {
            this.switchTab(hash);
        }
    },

    // ============================================
    // Tab Navigation
    // ============================================
    setupTabs() {
        const tabs = document.querySelectorAll('.robot-tab');
        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                const target = tab.dataset.tab;
                if (target !== this.currentTab) {
                    Haptic.light();
                    this.switchTab(target);
                }
            });
        });
    },

    switchTab(tabName) {
        // Update tab buttons
        document.querySelectorAll('.robot-tab').forEach(t => t.classList.remove('active'));
        const btn = document.querySelector(`[data-tab="${tabName}"]`);
        if (btn) btn.classList.add('active');

        // Update panels
        document.querySelectorAll('.robot-tab-panel').forEach(p => p.classList.remove('active'));
        const panel = document.getElementById('panel' + tabName.charAt(0).toUpperCase() + tabName.slice(1));
        if (panel) {
            panel.classList.add('active');
            panel.scrollTop = 0;
        }

        this.currentTab = tabName;

        // Start/stop radar based on visibility
        if (tabName === 'sensors') {
            this.startRadar();
        } else {
            this.stopRadar();
        }
    },

    stopRadar() {
        if (this.radarAnimFrame) {
            cancelAnimationFrame(this.radarAnimFrame);
            this.radarAnimFrame = null;
        }
    },

    // ============================================
    // Swipe Navigation
    // ============================================
    setupSwipeNav() {
        const content = document.getElementById('robotContent');
        if (!content) return;

        content.addEventListener('touchstart', (e) => {
            this.touchStartX = e.touches[0].clientX;
            this.touchStartY = e.touches[0].clientY;
        }, { passive: true });

        content.addEventListener('touchend', (e) => {
            const dx = e.changedTouches[0].clientX - this.touchStartX;
            const dy = e.changedTouches[0].clientY - this.touchStartY;
            // Only swipe if horizontal > vertical and threshold met
            if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) {
                const idx = this.tabs.indexOf(this.currentTab);
                if (dx < 0 && idx < this.tabs.length - 1) {
                    Haptic.selection();
                    this.switchTab(this.tabs[idx + 1]);
                } else if (dx > 0 && idx > 0) {
                    Haptic.selection();
                    this.switchTab(this.tabs[idx - 1]);
                }
            }
        }, { passive: true });
    },

    // ============================================
    // Back Button
    // ============================================
    setupBackButton() {
        const btn = document.getElementById('btnBack');
        if (btn) {
            btn.addEventListener('click', () => {
                Haptic.light();
                window.location.href = 'index.html';
            });
        }
    },

    // ============================================
    // Radar Canvas Rendering
    // ============================================
    startRadar() {
        if (this.radarAnimFrame) cancelAnimationFrame(this.radarAnimFrame);
        const canvas = document.getElementById('radarCanvas');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const w = canvas.width, h = canvas.height;
        const cx = w / 2, cy = h / 2;
        const maxR = Math.min(cx, cy) - 4;
        let angle = 0;

        const draw = () => {
            ctx.clearRect(0, 0, w, h);

            // Background
            const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, maxR);
            bg.addColorStop(0, 'rgba(0,20,30,0.9)');
            bg.addColorStop(1, 'rgba(0,8,14,0.95)');
            ctx.fillStyle = bg;
            ctx.beginPath(); ctx.arc(cx, cy, maxR, 0, Math.PI * 2); ctx.fill();

            // Grid rings
            ctx.strokeStyle = 'rgba(0,240,255,0.08)';
            ctx.lineWidth = 1;
            for (let i = 1; i <= 4; i++) {
                const r = (maxR / 4) * i;
                ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
            }

            // Cross lines
            ctx.strokeStyle = 'rgba(0,240,255,0.06)';
            ctx.beginPath(); ctx.moveTo(cx, cy - maxR); ctx.lineTo(cx, cy + maxR); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(cx - maxR, cy); ctx.lineTo(cx + maxR, cy); ctx.stroke();

            // Distance labels
            ctx.fillStyle = 'rgba(0,240,255,0.25)';
            ctx.font = '600 18px Inter, sans-serif';
            ctx.textAlign = 'center';
            const labels = ['10cm', '25cm', '50cm', '100cm'];
            for (let i = 1; i <= 4; i++) {
                const r = (maxR / 4) * i;
                ctx.fillText(labels[i-1], cx, cy - r + 16);
            }

            // Sweep line
            ctx.save();
            ctx.translate(cx, cy);
            ctx.rotate(angle);
            const sweepGrad = ctx.createLinearGradient(0, 0, maxR, 0);
            sweepGrad.addColorStop(0, 'rgba(0,240,255,0.6)');
            sweepGrad.addColorStop(1, 'rgba(0,240,255,0)');
            ctx.strokeStyle = sweepGrad;
            ctx.lineWidth = 2;
            ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(maxR, 0); ctx.stroke();

            // Sweep trail (arc)
            const trailGrad = ctx.createConicGradient(0, 0, 0);
            trailGrad.addColorStop(0, 'rgba(0,240,255,0.12)');
            trailGrad.addColorStop(0.08, 'rgba(0,240,255,0)');
            trailGrad.addColorStop(1, 'rgba(0,240,255,0)');
            ctx.fillStyle = trailGrad;
            ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, maxR, 0, -0.5, true); ctx.closePath(); ctx.fill();
            ctx.restore();

            // Blips
            this.demo.radarBlips.forEach(blip => {
                const bx = cx + Math.cos(blip.angle) * blip.dist * maxR;
                const by = cy + Math.sin(blip.angle) * blip.dist * maxR;
                const alpha = blip.life / blip.maxLife;

                ctx.fillStyle = `rgba(0,240,255,${alpha * 0.8})`;
                ctx.shadowColor = 'rgba(0,240,255,0.6)';
                ctx.shadowBlur = 8;
                ctx.beginPath(); ctx.arc(bx, by, 4 + alpha * 3, 0, Math.PI * 2); ctx.fill();
                ctx.shadowBlur = 0;

                blip.life -= 0.5;
            });
            this.demo.radarBlips = this.demo.radarBlips.filter(b => b.life > 0);

            // Center dot (robot)
            ctx.fillStyle = '#00f0ff';
            ctx.shadowColor = 'rgba(0,240,255,0.8)';
            ctx.shadowBlur = 12;
            ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI * 2); ctx.fill();
            ctx.shadowBlur = 0;

            angle += 0.015;
            if (angle > Math.PI * 2) angle -= Math.PI * 2;

            // Randomly add blips for demo
            if (Math.random() < 0.03) {
                this.demo.radarBlips.push({
                    angle: Math.random() * Math.PI * 2,
                    dist: 0.2 + Math.random() * 0.7,
                    life: 60 + Math.random() * 40,
                    maxLife: 100
                });
            }

            this.radarAnimFrame = requestAnimationFrame(draw);
        };
        draw();
    },

    // ============================================
    // Joystick Controller
    // ============================================
    setupJoystick() {
        const container = document.getElementById('joystickContainer');
        const nub = document.getElementById('joystickNub');
        const output = document.getElementById('joystickOutput');
        const warning = document.getElementById('joystickWarning');
        if (!container || !nub) return;

        let active = false;
        const maxDist = 60;

        const updateNub = (clientX, clientY) => {
            const rect = container.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            let dx = clientX - cx;
            let dy = clientY - cy;
            const dist = Math.sqrt(dx * dx + dy * dy);

            if (dist > maxDist) {
                dx = (dx / dist) * maxDist;
                dy = (dy / dist) * maxDist;
            }

            nub.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;

            const pctX = Math.round((dx / maxDist) * 100);
            const pctY = Math.round((-dy / maxDist) * 100);
            if (output) output.textContent = `Drive — ${pctY}%, ${pctX}%`;

            // Edge warning demo
            if (warning) {
                if (pctY > 70) warning.classList.add('edge-detected');
                else warning.classList.remove('edge-detected');
            }
        };

        const resetNub = () => {
            nub.style.transform = 'translate(-50%, -50%)';
            nub.classList.remove('active');
            if (output) output.textContent = 'Idle — 0%, 0%';
            if (warning) warning.classList.remove('edge-detected');
        };

        container.addEventListener('touchstart', (e) => {
            e.preventDefault();
            active = true;
            nub.classList.add('active');
            Haptic.light();
            updateNub(e.touches[0].clientX, e.touches[0].clientY);
        }, { passive: false });

        container.addEventListener('touchmove', (e) => {
            if (!active) return;
            e.preventDefault();
            updateNub(e.touches[0].clientX, e.touches[0].clientY);
        }, { passive: false });

        container.addEventListener('touchend', () => { active = false; resetNub(); });
        container.addEventListener('touchcancel', () => { active = false; resetNub(); });

        // Mouse fallback for desktop
        container.addEventListener('mousedown', (e) => {
            active = true; nub.classList.add('active');
            updateNub(e.clientX, e.clientY);
        });
        document.addEventListener('mousemove', (e) => { if (active) updateNub(e.clientX, e.clientY); });
        document.addEventListener('mouseup', () => { if (active) { active = false; resetNub(); } });
    },

    // ============================================
    // Focus Timer
    // ============================================
    setupFocusTimer() {
        // Preset buttons
        document.querySelectorAll('.focus-preset-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                if (this.focus.running) return;
                Haptic.selection();
                document.querySelectorAll('.focus-preset-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.focus.selectedMinutes = parseInt(btn.dataset.minutes);
                this.focus.duration = this.focus.selectedMinutes * 60;
                this.focus.remaining = this.focus.duration;
                this.updateFocusDisplay();
            });
        });

        // Start/Stop
        const startBtn = document.getElementById('focusStartBtn');
        if (startBtn) {
            startBtn.addEventListener('click', () => {
                Haptic.medium();
                if (this.focus.running) {
                    this.stopFocusTimer();
                } else {
                    this.startFocusTimer();
                }
            });
        }
    },

    startFocusTimer() {
        this.focus.running = true;
        this.focus.remaining = this.focus.duration;
        const btn = document.getElementById('focusStartBtn');
        const label = document.getElementById('focusStartLabel');
        if (btn) btn.classList.add('running');
        if (label) label.textContent = 'Stop Session';
        document.getElementById('focusTimeLabel').textContent = 'Focused';

        Toast.success('Focus session started — environment syncing...');

        this.focusTimer = setInterval(() => {
            this.focus.remaining--;
            this.updateFocusDisplay();

            if (this.focus.remaining <= 0) {
                this.stopFocusTimer();
                this.triggerBreakMode();
            }
        }, 1000);
    },

    stopFocusTimer() {
        this.focus.running = false;
        clearInterval(this.focusTimer);
        const btn = document.getElementById('focusStartBtn');
        const label = document.getElementById('focusStartLabel');
        if (btn) btn.classList.remove('running');
        if (label) label.textContent = 'Start Focus Session';
        document.getElementById('focusTimeLabel').textContent = 'Ready';
        this.focus.remaining = this.focus.duration;
        this.updateFocusDisplay();
    },

    updateFocusDisplay() {
        const mins = Math.floor(this.focus.remaining / 60);
        const secs = this.focus.remaining % 60;
        const display = document.getElementById('focusTimeValue');
        if (display) display.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

        // Update ring
        const circumference = 879.65;
        const progress = 1 - (this.focus.remaining / this.focus.duration);
        const offset = circumference * (1 - progress);
        const fill = document.getElementById('focusRingFill');
        const glow = document.getElementById('focusRingGlow');
        if (fill) fill.style.strokeDashoffset = offset;
        if (glow) glow.style.strokeDashoffset = offset;
    },

    triggerBreakMode() {
        Toast.info('Focus session complete! Time for a break.');
        Haptic.success();
        setTimeout(() => this.showBreathing(), 1500);
    },

    // ============================================
    // Breathing Exercise
    // ============================================
    setupBreathing() {
        const close = document.getElementById('breathingClose');
        if (close) {
            close.addEventListener('click', () => {
                this.hideBreathing();
                Haptic.light();
            });
        }
    },

    showBreathing() {
        const overlay = document.getElementById('breathingOverlay');
        if (overlay) overlay.classList.add('active');

        let phase = 'inhale';
        const ring = document.getElementById('breathingRing');
        const text = document.getElementById('breathingText');
        const instruction = document.getElementById('breathingInstruction');

        const cycle = () => {
            if (!overlay.classList.contains('active')) return;
            if (phase === 'inhale') {
                ring.className = 'breathing-ring inhale';
                text.textContent = 'Breathe In';
                instruction.textContent = 'Inhale slowly through your nose...';
                phase = 'hold';
                this.breathingTimer = setTimeout(cycle, 4000);
            } else if (phase === 'hold') {
                text.textContent = 'Hold';
                instruction.textContent = 'Hold your breath gently...';
                phase = 'exhale';
                this.breathingTimer = setTimeout(cycle, 7000);
            } else {
                ring.className = 'breathing-ring exhale';
                text.textContent = 'Breathe Out';
                instruction.textContent = 'Exhale slowly through your mouth...';
                phase = 'inhale';
                this.breathingTimer = setTimeout(cycle, 8000);
            }
        };
        cycle();
    },

    hideBreathing() {
        document.getElementById('breathingOverlay')?.classList.remove('active');
        clearTimeout(this.breathingTimer);
    },

    // ============================================
    // Sound Controls
    // ============================================
    setupSoundControls() {
        document.querySelectorAll('.sound-genre-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                Haptic.selection();
                document.querySelectorAll('.sound-genre-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                Toast.info(`Playing: ${btn.textContent}`);
            });
        });
    },

    setupWaveformBars() {
        const display = document.getElementById('waveformDisplay');
        if (!display) return;
        let html = '';
        for (let i = 0; i < 32; i++) {
            const delay = (Math.random() * 1.2).toFixed(2);
            const h = 10 + Math.random() * 30;
            html += `<div class="waveform-bar active" style="height:${h}%;animation-delay:${delay}s;animation-duration:${0.8 + Math.random() * 0.8}s;"></div>`;
        }
        display.innerHTML = html;
    },

    // ============================================
    // Command Tiles
    // ============================================
    setupCommandTiles() {
        document.querySelectorAll('.command-tile').forEach(tile => {
            tile.addEventListener('click', () => {
                Haptic.medium();
                const cmd = tile.dataset.cmd;
                Toast.success(`Command sent: ${tile.querySelector('.command-tile-label')?.textContent || cmd}`);
                // Flash the tile
                tile.style.borderColor = 'var(--cyber-cyan)';
                tile.style.boxShadow = '0 0 16px var(--cyber-cyan-glow)';
                setTimeout(() => {
                    tile.style.borderColor = '';
                    tile.style.boxShadow = '';
                }, 600);
            });
        });
    },

    // ============================================
    // Environment Nodes
    // ============================================
    setupEnvironmentNodes() {
        // Toggle switches
        document.querySelectorAll('.cyber-toggle').forEach(toggle => {
            toggle.addEventListener('click', () => {
                Haptic.medium();
                toggle.classList.toggle('on');
                const device = toggle.dataset.device;
                const isOn = toggle.classList.contains('on');

                // Update node visual
                const node = document.getElementById('node' + device.charAt(0).toUpperCase() + device.slice(1));
                if (node) node.classList.toggle('active', isOn);

                // Update state text
                if (device === 'lights') {
                    document.getElementById('lightsState').textContent = isOn ? 'On' : 'Off';
                } else if (device === 'blinds') {
                    document.getElementById('blindsState').textContent = isOn ? 'Open' : 'Closed';
                }

                Toast.info(`${device.charAt(0).toUpperCase() + device.slice(1)}: ${isOn ? 'On' : 'Off'}`);
            });
        });

        // Tappable nodes
        document.querySelectorAll('.env-node[data-device]').forEach(node => {
            node.addEventListener('click', () => {
                Haptic.light();
                const device = node.dataset.device;
                node.classList.toggle('active');
            });
        });

        // Draw SVG connection lines
        this.drawNodeLines();
    },

    drawNodeLines() {
        const svg = document.getElementById('nodesLines');
        if (!svg) return;
        // Use percentages for responsiveness
        svg.innerHTML = `
            <line class="node-line active" x1="50%" y1="50%" x2="18%" y2="25%"/>
            <line class="node-line active" x1="50%" y1="50%" x2="82%" y2="25%"/>
            <line class="node-line" x1="50%" y1="50%" x2="18%" y2="82%"/>
            <line class="node-line" x1="50%" y1="50%" x2="82%" y2="82%"/>
        `;
    },

    // ============================================
    // Transcript Chat
    // ============================================
    setupTranscript() {
        const input = document.getElementById('transcriptInput');
        const sendBtn = document.getElementById('transcriptSend');
        const feed = document.getElementById('transcriptFeed');

        const send = () => {
            if (!input || !feed || !input.value.trim()) return;
            const text = input.value.trim();
            input.value = '';

            const bubble = document.createElement('div');
            bubble.className = 'transcript-bubble user';
            const now = new Date();
            bubble.innerHTML = `<span>${this.escapeHtml(text)}</span><div class="transcript-time">${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}</div>`;
            feed.appendChild(bubble);
            feed.scrollTop = feed.scrollHeight;

            Haptic.light();
            Toast.info('Sent to robot speaker');
        };

        if (sendBtn) sendBtn.addEventListener('click', send);
        if (input) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
    },

    // ============================================
    // Predictive Actions
    // ============================================
    generatePredictiveActions() {
        const container = document.getElementById('actionCards');
        if (!container) return;

        const hour = new Date().getHours();
        let actions = [];

        if (hour >= 21 || hour < 6) {
            actions.push({ icon: '🌙', title: 'Good night routine', sub: 'Dock robot, turn off lights, close blinds', action: 'night-routine' });
        } else if (hour >= 6 && hour < 10) {
            actions.push({ icon: '☀️', title: 'Morning setup', sub: 'Open blinds, start LumiBot patrol', action: 'morning' });
        } else if (hour >= 10 && hour < 12) {
            actions.push({ icon: '🧠', title: 'Deep focus time', sub: 'Start 45-min focus session', action: 'deep-focus' });
        } else if (hour >= 14 && hour < 16) {
            actions.push({ icon: '☕', title: 'Afternoon break', sub: 'Guided breathing + stretch reminder', action: 'break' });
        }

        actions.push({ icon: '📡', title: 'Scan workspace', sub: 'Map desk with ToF sensors', action: 'scan-desk' });

        container.innerHTML = actions.map(a => `
            <div class="action-card" data-action="${a.action}">
                <div class="action-icon">${a.icon}</div>
                <div class="action-text">
                    <div class="action-text-main">${a.title}</div>
                    <div class="action-text-sub">${a.sub}</div>
                </div>
                <div class="action-go">Run</div>
            </div>
        `).join('');

        container.querySelectorAll('.action-card').forEach(card => {
            card.addEventListener('click', () => {
                Haptic.medium();
                Toast.success(`Running: ${card.querySelector('.action-text-main')?.textContent}`);
            });
        });
    },

    // ============================================
    // Demo Data Simulator
    // ============================================
    startDemoData() {
        // Initial update
        this.updateDemoVitals();

        // Update every 2 seconds
        this.demoInterval = setInterval(() => {
            // Fluctuate values
            this.demo.battery = Math.max(5, Math.min(100, this.demo.battery + (Math.random() - 0.52) * 0.5));
            this.demo.latency = Math.max(8, Math.min(300, this.demo.latency + (Math.random() - 0.5) * 10));
            this.demo.temp = Math.max(30, Math.min(75, this.demo.temp + (Math.random() - 0.5) * 1));
            this.demo.uptime += 1 / 30;
            this.demo.pitch = parseFloat((this.demo.pitch + (Math.random() - 0.5) * 0.8).toFixed(1));
            this.demo.roll = parseFloat((this.demo.roll + (Math.random() - 0.5) * 0.5).toFixed(1));
            this.demo.yaw = Math.round(this.demo.yaw + (Math.random() - 0.5) * 3) % 360;
            if (this.demo.yaw < 0) this.demo.yaw += 360;

            this.updateDemoVitals();
        }, 2000);
    },

    updateDemoVitals() {
        const batt = Math.round(this.demo.battery);
        const battText = document.getElementById('batteryText');
        if (battText) battText.textContent = batt + '%';

        // Battery ring
        const circumference = 138.23;
        const offset = circumference * (1 - batt / 100);
        const ring = document.getElementById('batteryRing');
        if (ring) {
            ring.style.strokeDashoffset = offset;
            ring.style.stroke = batt > 30 ? 'var(--cyber-cyan)' : batt > 15 ? 'var(--cyber-amber)' : 'var(--cyber-red)';
        }

        const battStatus = document.getElementById('batteryStatus');
        if (battStatus) battStatus.textContent = batt > 60 ? 'Healthy' : batt > 30 ? 'Moderate' : 'Low';

        // Latency
        const lat = Math.round(this.demo.latency);
        const latEl = document.getElementById('latencyValue');
        if (latEl) latEl.textContent = lat;
        const latBar = document.getElementById('latencyBar');
        if (latBar) latBar.style.width = Math.min(100, lat / 3) + '%';

        // Temp
        const tempEl = document.getElementById('tempValue');
        if (tempEl) tempEl.textContent = Math.round(this.demo.temp);
        const tempBar = document.getElementById('tempBar');
        if (tempBar) tempBar.style.width = Math.round(this.demo.temp) + '%';

        // Uptime
        const mins = Math.floor(this.demo.uptime);
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        const uptimeEl = document.getElementById('uptimeValue');
        if (uptimeEl) uptimeEl.textContent = `${h}h ${m}m`;

        // HUD gauges
        const pitch = document.getElementById('hudPitch');
        if (pitch) pitch.textContent = this.demo.pitch.toFixed(1);
        const roll = document.getElementById('hudRoll');
        if (roll) roll.textContent = this.demo.roll.toFixed(1);
        const yaw = document.getElementById('hudYaw');
        if (yaw) yaw.textContent = this.demo.yaw;
    },

    // ============================================
    // Utilities
    // ============================================
    escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }
};
