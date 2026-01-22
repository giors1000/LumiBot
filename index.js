/**
 * LumiBot - Index Page Logic
 * Manages device list, MQTT connections, quick controls, and context menu
 */

// ============================================
// MQTT Configuration
// ============================================
// MQTT credentials are centralized in MQTTClient.config (mqtt.js)
// Do NOT duplicate config here - it causes maintenance issues and
// can lead to connection failures if configs get out of sync.

// ============================================
// Long Press Detection
// ============================================
class LongPressHandler {
  constructor(element, callback, duration = 500) {
    this.element = element;
    this.callback = callback;
    this.duration = duration;
    this.timer = null;
    this.isLongPress = false;

    this.element.addEventListener('touchstart', (e) => this.start(e), { passive: true });
    this.element.addEventListener('touchend', () => this.cancel());
    this.element.addEventListener('touchmove', () => this.cancel());
    this.element.addEventListener('mousedown', (e) => this.start(e));
    this.element.addEventListener('mouseup', () => this.cancel());
    this.element.addEventListener('mouseleave', () => this.cancel());
  }

  start(e) {
    this.isLongPress = false;
    this.element.classList.add('long-press-active');

    this.timer = setTimeout(() => {
      this.isLongPress = true;
      this.element.classList.remove('long-press-active');

      // Vibrate if supported
      if (navigator.vibrate) {
        navigator.vibrate(50);
      }

      this.callback(e);
    }, this.duration);
  }

  cancel() {
    this.element.classList.remove('long-press-active');
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  wasLongPress() {
    return this.isLongPress;
  }
}

// ============================================
// Context Menu with Swipe-to-Dismiss
// ============================================
const ContextMenu = {
  currentDeviceId: null,
  backdrop: null,
  menu: null,
  startY: 0,
  currentY: 0,
  isDragging: false,

  init() {
    this.backdrop = document.getElementById('contextMenuBackdrop');
    this.menu = document.getElementById('contextMenu');

    if (!this.backdrop || !this.menu) return;

    // Close on backdrop click
    this.backdrop.addEventListener('click', (e) => {
      if (e.target === this.backdrop) {
        this.close();
      }
    });

    // Cancel button
    document.getElementById('contextMenuCancel')?.addEventListener('click', () => {
      this.close();
    });

    // Option buttons
    this.menu.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        this.handleAction(action);
      });
    });

    // Swipe-to-dismiss on handle
    const handle = this.menu.querySelector('.context-menu-handle');
    if (handle) {
      handle.addEventListener('touchstart', (e) => this.onTouchStart(e), { passive: true });
      this.menu.addEventListener('touchmove', (e) => this.onTouchMove(e), { passive: false });
      this.menu.addEventListener('touchend', () => this.onTouchEnd());
    }
  },

  onTouchStart(e) {
    this.startY = e.touches[0].clientY;
    this.currentY = this.startY;
    this.isDragging = true;
    this.menu.style.transition = 'none';
  },

  onTouchMove(e) {
    if (!this.isDragging) return;

    this.currentY = e.touches[0].clientY;
    const diff = this.currentY - this.startY;

    // Only allow dragging down
    if (diff > 0) {
      this.menu.style.transform = `translateY(${diff}px)`;
      // Fade backdrop based on drag distance
      const opacity = Math.max(0, 1 - diff / 300);
      this.backdrop.style.backgroundColor = `rgba(0, 0, 0, ${opacity * 0.5})`;
    }
  },

  onTouchEnd() {
    if (!this.isDragging) return;
    this.isDragging = false;

    this.menu.style.transition = '';
    this.backdrop.style.transition = '';

    const diff = this.currentY - this.startY;

    // If dragged more than 100px, close
    if (diff > 100) {
      this.close();
    } else {
      // Snap back
      this.menu.style.transform = '';
      this.backdrop.style.backgroundColor = '';
    }
  },

  show(deviceId) {
    this.currentDeviceId = deviceId;
    const device = DeviceList.get(deviceId);
    const state = MQTTClient.getDeviceState(deviceId);

    if (!device) return;

    // Update menu content
    document.getElementById('contextMenuTitle').textContent = device.name || `LumiBot-${deviceId}`;
    document.getElementById('contextMenuSubtitle').textContent = state?._online ? 'Online' : 'Offline';

    // Reset any drag state
    this.menu.style.transform = '';
    this.backdrop.style.backgroundColor = '';

    // Show menu
    this.backdrop.classList.add('visible');

    // Haptic feedback
    if (navigator.vibrate) {
      navigator.vibrate(50);
    }
  },

  close() {
    if (this.backdrop) {
      this.backdrop.classList.remove('visible');
      // Reset styles after animation
      setTimeout(() => {
        this.menu.style.transform = '';
        this.backdrop.style.backgroundColor = '';
      }, 400);
    }
    this.currentDeviceId = null;
  },

  handleAction(action) {
    const deviceId = this.currentDeviceId;
    if (!deviceId) return;

    this.close();

    switch (action) {
      case 'rename':
        this.showRenameModal(deviceId);
        break;
      case 'settings':
        window.location.href = `device.html?id=${deviceId}`;
        break;
      case 'remove':
        this.showRemoveConfirmation(deviceId);
        break;
    }
  },

  showRenameModal(deviceId) {
    const device = DeviceList.get(deviceId);
    if (!device) return;

    Modal.input({
      title: 'Rename Device',
      placeholder: 'Enter device name',
      value: device.name || '',
      onSubmit: async (newName) => {
        if (newName.trim()) {
          // Update local storage
          DeviceList.update(deviceId, { name: newName.trim() });

          // Sync to Firebase if authenticated
          const user = Auth.getUser();
          if (user) {
            await DeviceService.updateDevice(user.uid, deviceId, { name: newName.trim() });
          }

          renderDevices();
          Toast.success('Device renamed');
        }
      }
    });
  },

  showRemoveConfirmation(deviceId) {
    const device = DeviceList.get(deviceId);
    const deviceName = device?.name || `Device ${deviceId}`;

    Modal.confirm(
      'Remove Device',
      `Are you sure you want to remove "${deviceName}"? You can add it back later.`,
      async () => {
        // Remove from local storage
        DeviceList.remove(deviceId);
        MQTTClient.unsubscribeDevice?.(deviceId);

        // Remove from Firebase if authenticated
        const user = Auth.getUser();
        if (user) {
          await DeviceService.removeDevice(user.uid, deviceId);
        }

        renderDevices();
        Toast.success('Device removed');
      }
    );
  }
};

// ============================================
// Device Card Template
// ============================================
function createDeviceCard(device, state = null, index = 0) {
  const isOnline = state?._online ?? false;
  const lightOn = state?.light ?? false;
  const mode = state?.mode ?? 0;
  const alarmEnabled = state?.config?.alarmEnabled ?? false;
  const alarmHour = state?.config?.alarmHour ?? 7;
  const alarmMin = state?.config?.alarmMin ?? 0;

  // Mode values MUST match firmware: 0=AUTO, 1=MANUAL, 4=LOCKED, 3=BEDTIME(Sleep)
  // NOTE: Mode 2 is ALARM in firmware (not exposed in UI)
  const modes = [
    { value: 0, icon: '🔄', label: 'Auto' },
    { value: 1, icon: '✋', label: 'Manual' },
    { value: 4, icon: '🔒', label: 'Lock' },    // CRITICAL: Firmware MODE_LOCKED = 4
    { value: 3, icon: '🌙', label: 'Sleep' }    // Firmware MODE_BEDTIME = 3
  ];

  const card = document.createElement('div');
  card.className = `device-card ${isOnline ? 'online' : ''}`;
  card.id = `device-${device.id}`;
  card.dataset.deviceId = device.id;
  card.style.animationDelay = `${index * 0.1}s`;

  card.innerHTML = `
        <div class="device-header">
            <div class="device-info" data-action="navigate">
                <div class="device-icon ${lightOn ? 'on' : ''}">
                    💡
                    <div class="status-dot ${isOnline ? 'online' : ''}"></div>
                </div>
                <div class="device-details">
                    <div class="device-name">${device.name || 'LumiBot-' + device.id}</div>
                    <div class="device-status">${isOnline ? 'Online' : 'Offline'} • ${lightOn ? 'On' : 'Off'}</div>
                </div>
            </div>
            <button class="power-btn ${lightOn ? 'active' : ''}" data-action="power">⏻</button>
        </div>
        
        <div class="mode-row">
            ${modes.map(m => `
                <button class="mode-btn ${mode === m.value ? 'active' : ''}" data-mode="${m.value}">
                    <span class="mode-icon">${m.icon}</span>
                    <span class="mode-label">${m.label}</span>
                </button>
            `).join('')}
        </div>
        
        <div class="quick-row">
            <div class="quick-info">
                <span class="quick-icon">⏰</span>
                <div class="quick-text">
                    <span class="quick-label">Alarm</span>
                    <span class="quick-value">${String(alarmHour).padStart(2, '0')}:${String(alarmMin).padStart(2, '0')}</span>
                </div>
            </div>
            <div class="toggle-mini ${alarmEnabled ? 'active' : ''}" data-action="alarm">
                <div class="thumb"></div>
            </div>
        </div>
    `;

  // Setup long press handler for context menu
  new LongPressHandler(card, () => {
    ContextMenu.show(device.id);
  });

  return card;
}

// ============================================
// Add Device Card
// ============================================
function createAddDeviceCard() {
  const card = document.createElement('div');
  card.className = 'add-card';
  card.id = 'addCard';
  card.innerHTML = `
    <div class="add-icon">+</div>
    <div class="add-title">Add Device</div>
    <div class="add-subtitle">Setup a new LumiBot</div>
  `;
  card.addEventListener('click', showAddDeviceModal);
  return card;
}

// ============================================
// Render Devices - Loads from Firebase when authenticated
// ============================================
async function renderDevices() {
  const list = document.getElementById('deviceList');
  const emptyState = document.getElementById('emptyState');
  const countEl = document.getElementById('deviceCount');

  let devices = [];

  // Wait for Auth to be ready (non-blocking, resolves immediately when auth state is known)
  await Auth.waitForAuthReady();

  // Try to load from Firebase if authenticated
  const user = Auth.getUser();
  if (user) {
    console.log('[Index] Auth ready, loading devices for user:', user.uid);
    try {
      // Initialize DeviceService if not already
      await DeviceService.init();

      // Sync local devices to Firebase (first-time migration)
      await DeviceService.syncFromLocalStorage(user.uid);

      // Load devices from Firebase
      devices = await DeviceService.getDevices(user.uid);
      console.log('[Index] Loaded', devices.length, 'devices from Firebase');

      // Also update local storage for quick loading next time
      Storage.set('LumiBot-devices', devices);
    } catch (error) {
      console.error('[Index] Firebase load error, falling back to local:', error);
      devices = DeviceList.getAll();
    }
  } else {
    console.warn('[Index] No authenticated user after waiting, using local storage');
    // Not authenticated, use local storage
    devices = DeviceList.getAll();
  }

  list.innerHTML = '';

  if (devices.length === 0) {
    // No devices - show empty state
    if (emptyState) emptyState.classList.remove('hidden');
  } else {
    // Has devices - hide empty state
    if (emptyState) emptyState.classList.add('hidden');

    // Render device cards
    devices.forEach((device, index) => {
      const state = MQTTClient.getDeviceState(device.id);
      const card = createDeviceCard(device, state, index);
      list.appendChild(card);
    });

    // Add the "Add Device" card at the bottom
    const addCard = createAddDeviceCard();
    addCard.style.animationDelay = `${devices.length * 0.1}s`;
    list.appendChild(addCard);
  }

  if (countEl) {
    countEl.textContent = `${devices.length} device${devices.length !== 1 ? 's' : ''}`;
  }
}

// ============================================
// Update Device Card
// ============================================
function updateDeviceCard(deviceId, state) {
  const card = document.getElementById(`device-${deviceId}`);
  if (!card) return;

  const isOnline = state?._online ?? false;
  const lightOn = state?.light ?? false;
  const mode = state?.mode ?? 0;

  card.classList.toggle('online', isOnline);

  const icon = card.querySelector('.device-icon');
  if (icon) icon.classList.toggle('on', lightOn);

  const dot = card.querySelector('.status-dot');
  if (dot) dot.classList.toggle('online', isOnline);

  const status = card.querySelector('.device-status');
  if (status) status.textContent = `${isOnline ? 'Online' : 'Offline'} • ${lightOn ? 'On' : 'Off'}`;

  const powerBtn = card.querySelector('[data-action="power"]');
  if (powerBtn) powerBtn.classList.toggle('active', lightOn);

  card.querySelectorAll('[data-mode]').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.mode) === mode);
  });

  if (state?.config) {
    const alarmValue = card.querySelector('.quick-value');
    const alarmToggle = card.querySelector('[data-action="alarm"]');

    if (alarmValue) {
      const h = state.config.alarmHour ?? 7;
      const m = state.config.alarmMin ?? 0;
      alarmValue.textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }

    if (alarmToggle) {
      alarmToggle.classList.toggle('active', state.config.alarmEnabled ?? false);
    }
  }
}

// ============================================
// Card Actions
// ============================================
function setupCardActions() {
  const list = document.getElementById('deviceList');
  if (!list) return;

  list.addEventListener('click', (e) => {
    const card = e.target.closest('.device-card');
    if (!card) return;

    const deviceId = card.dataset.deviceId;

    // Navigate to device page (only if not long-press)
    if (e.target.closest('[data-action="navigate"]')) {
      // Small delay to check if it was a long press
      setTimeout(() => {
        if (!card.classList.contains('long-press-active')) {
          window.location.href = `device.html?id=${deviceId}`;
        }
      }, 50);
      return;
    }

    // Power toggle
    if (e.target.closest('[data-action="power"]')) {
      // Check if MQTT is connected
      if (!MQTTClient.connected) {
        console.warn('[Index] Cannot toggle power - MQTT not connected');
        Toast.error('Not connected. Please wait...');
        return;
      }

      const currentState = MQTTClient.getDeviceState(deviceId);
      const newState = !(currentState?.light ?? false);
      console.log(`[Index] Toggling power for ${deviceId}: ${newState}`);
      MQTTClient.publishControl(deviceId, { light: newState });

      const btn = card.querySelector('[data-action="power"]');
      if (btn) {
        btn.classList.toggle('active', newState);
        btn.style.transform = 'scale(0.85)';
        setTimeout(() => btn.style.transform = '', 200);
      }
      return;
    }

    // Mode buttons
    if (e.target.closest('[data-mode]')) {
      // Check if MQTT is connected
      if (!MQTTClient.connected) {
        console.warn('[Index] Cannot change mode - MQTT not connected');
        Toast.error('Not connected. Please wait...');
        return;
      }

      const btn = e.target.closest('[data-mode]');
      const mode = parseInt(btn.dataset.mode);
      console.log(`[Index] Setting mode for ${deviceId}: ${mode}`);
      MQTTClient.publishControl(deviceId, { mode });

      card.querySelectorAll('[data-mode]').forEach(b => {
        b.classList.toggle('active', parseInt(b.dataset.mode) === mode);
      });
      return;
    }

    // Alarm toggle
    if (e.target.closest('[data-action="alarm"]')) {
      // Check if MQTT is connected
      if (!MQTTClient.connected) {
        console.warn('[Index] Cannot toggle alarm - MQTT not connected');
        Toast.error('Not connected. Please wait...');
        return;
      }

      const toggle = e.target.closest('[data-action="alarm"]');
      const enabled = !toggle.classList.contains('active');
      toggle.classList.toggle('active', enabled);
      console.log(`[Index] Setting alarm for ${deviceId}: ${enabled}`);
      MQTTClient.publishConfig(deviceId, { alarmEnabled: enabled });
      return;
    }
  });
}

// ============================================
// Add Device Modal
// ============================================
function showAddDeviceModal() {
  Modal.create({
    title: 'Add Device',
    content: `
            <div style="text-align: center; margin-bottom: 24px;">
                <p style="color: var(--text-secondary); margin-bottom: 24px;">
                    Choose how you'd like to add a device
                </p>
                
                <div style="display: flex; flex-direction: column; gap: 12px;">
                    <button class="modal-option-btn" id="setupNewBtn" style="
                        display: flex;
                        align-items: center;
                        gap: 16px;
                        padding: 16px 20px;
                        background: rgba(99, 102, 241, 0.1);
                        border: 2px solid var(--accent);
                        border-radius: 16px;
                        color: var(--text-primary);
                        font-family: var(--font-family);
                        font-size: 16px;
                        cursor: pointer;
                        transition: all 0.2s ease;
                        width: 100%;
                        text-align: left;
                    ">
                        <span style="font-size: 24px;">🆕</span>
                        <div>
                            <div style="font-weight: 700;">Setup New Device</div>
                            <div style="font-size: 12px; color: var(--text-tertiary);">Configure a brand new LumiBot</div>
                        </div>
                    </button>
                    
                    <button class="modal-option-btn" id="addExistingBtn" style="
                        display: flex;
                        align-items: center;
                        gap: 16px;
                        padding: 16px 20px;
                        background: var(--bg-glass);
                        border: 2px solid var(--border-glass);
                        border-radius: 16px;
                        color: var(--text-primary);
                        font-family: var(--font-family);
                        font-size: 16px;
                        cursor: pointer;
                        transition: all 0.2s ease;
                        width: 100%;
                        text-align: left;
                    ">
                        <span style="font-size: 24px;">➕</span>
                        <div>
                            <div style="font-weight: 700;">Add Existing Device</div>
                            <div style="font-size: 12px; color: var(--text-tertiary);">Enter a device ID manually</div>
                        </div>
                    </button>
                </div>
            </div>
        `,
    actions: []
  });

  // Wait for modal to render
  setTimeout(() => {
    document.getElementById('setupNewBtn')?.addEventListener('click', () => {
      Modal.close();
      window.location.href = 'setup.html';
    });

    document.getElementById('addExistingBtn')?.addEventListener('click', () => {
      Modal.close();
      showAddExistingModal();
    });
  }, 100);
}

function showAddExistingModal() {
  Modal.create({
    title: 'Add Existing Device',
    content: `
            <p style="color: var(--text-secondary); margin-bottom: 20px;">
                Enter the 4-character Device ID shown on your LumiBot
            </p>
            <div style="margin-bottom: 16px;">
                <input 
                    type="text" 
                    id="deviceIdInput"
                    placeholder="A1B2" 
                    maxlength="4"
                    style="
                        width: 100%;
                        padding: 16px;
                        background: var(--bg-glass);
                        border: 2px solid var(--border-glass);
                        border-radius: 12px;
                        color: var(--text-primary);
                        font-size: 24px;
                        font-family: monospace;
                        text-align: center;
                        text-transform: uppercase;
                        letter-spacing: 8px;
                    "
                >
            </div>
            <div>
                <input 
                    type="text" 
                    id="deviceNameInput"
                    placeholder="Device nickname (optional)" 
                    style="
                        width: 100%;
                        padding: 14px;
                        background: var(--bg-glass);
                        border: 1px solid var(--border-glass);
                        border-radius: 10px;
                        color: var(--text-primary);
                        font-size: 14px;
                        font-family: var(--font-family);
                    "
                >
            </div>
        `,
    actions: [
      { label: 'Cancel', primary: false },
      {
        label: 'Add Device',
        primary: true,
        onClick: async () => {
          const idInput = document.getElementById('deviceIdInput');
          const nameInput = document.getElementById('deviceNameInput');

          const id = idInput?.value.trim().toUpperCase() || '';
          const name = nameInput?.value.trim() || '';

          if (!/^[A-F0-9]{4}$/.test(id)) {
            Toast.error('Please enter a valid 4-character ID');
            return false;
          }

          // Add to local storage
          const added = DeviceList.add({
            id,
            name: name || `LumiBot-${id}`
          });

          if (!added) {
            Toast.warning('Device already exists');
            return false;
          }

          // Add to Firebase if authenticated
          const user = Auth.getUser();
          if (user) {
            const btn = Modal.modal.querySelector('.btn-primary'); // Get the button from current modal
            if (btn) {
              btn.textContent = 'Adding...';
              btn.disabled = true;
            }

            try {
              await DeviceService.init();
              await DeviceService.addDevice(user.uid, { id, name: name || `LumiBot-${id}` });
            } catch (error) {
              console.error('[Index] Failed to add device to Firebase:', error);
              Toast.error('Saved locally, but sync failed');
            }
          }

          MQTTClient.subscribeDevice(id);
          renderDevices();
          Toast.success('Device added!');
          return true;
        }
      }
    ]
  });

  // Focus and format input
  setTimeout(() => {
    const input = document.getElementById('deviceIdInput');
    if (input) {
      input.focus();
      input.addEventListener('input', (e) => {
        e.target.value = e.target.value.toUpperCase().replace(/[^A-F0-9]/g, '');
      });
    }
  }, 100);
}

// ============================================
// MQTT Status
// ============================================
function updateMQTTStatus(connected) {
  const status = document.getElementById('mqttStatus');
  const text = document.getElementById('mqttText');

  if (status) {
    status.classList.toggle('connected', connected);
    status.classList.add('visible');

    if (text) text.textContent = connected ? 'Connected' : 'Disconnected';

    if (connected) {
      setTimeout(() => status.classList.remove('visible'), 3000);
    }
  }
}

// ============================================
// MQTT Connection
// ============================================
let mqttInitialized = false; // Guard against duplicate initialization

async function initMQTT() {
  // Prevent duplicate initialization
  if (mqttInitialized) {
    console.log('[Index] MQTT already initialized, skipping');
    return;
  }
  mqttInitialized = true;

  try {
    // CRITICAL: Full reset of MQTT client state for fresh page load
    MQTTClient.clearCallbacks();
    MQTTClient.subscriptions.clear(); // Clear stale subscription tracking
    MQTTClient.deviceStates.clear();  // Clear stale device states
    MQTTClient.reconnectAttempts = 0;
    MQTTClient.reconnectDelay = 1000;

    MQTTClient.on('onConnect', () => {
      console.log('[Index] MQTT Connected');
      updateMQTTStatus(true);
      // Note: NOT subscribing here to avoid Code 8 disconnect
      // Device updates will be fetched when user opens device page
    });

    MQTTClient.on('onDisconnect', () => {
      console.log('[Index] MQTT Disconnected');
      updateMQTTStatus(false);
    });

    MQTTClient.on('onStateUpdate', (deviceId, state) => {
      updateDeviceCard(deviceId, MQTTClient.getDeviceState(deviceId));
    });

    MQTTClient.on('onError', (error) => {
      console.error('[Index] MQTT Error:', error);
    });

    await MQTTClient.connect(); // Uses MQTTClient.config internally

  } catch (error) {
    console.error('[Index] Failed to connect:', error);
    updateMQTTStatus(false);
  }
}

// ============================================
// Initialize
// ============================================
document.addEventListener('DOMContentLoaded', async () => {
  // Theme
  Theme.init();
  const themeBtn = document.getElementById('themeToggle');
  if (themeBtn) {
    themeBtn.textContent = Theme.get() === 'dark' ? '🌙' : '☀️';
    themeBtn.addEventListener('click', () => {
      const newTheme = Theme.toggle();
      themeBtn.textContent = newTheme === 'dark' ? '🌙' : '☀️';
    });
  }

  // Initialize context menu
  ContextMenu.init();

  // Empty state add button
  document.getElementById('emptyAddBtn')?.addEventListener('click', showAddDeviceModal);

  // Setup card actions
  setupCardActions();

  // Setup logout button
  document.getElementById('logoutBtn')?.addEventListener('click', () => {
    Modal.confirm(
      'Sign Out',
      'Are you sure you want to sign out?',
      async () => {
        try {
          await Auth.signOut();
          // Redirect handled by auth state change listener
        } catch (error) {
          console.error('[Index] Logout error:', error);
          Toast.error('Failed to sign out');
        }
      }
    );
  });

  // Render devices (async - loads from Firebase if authenticated)
  await renderDevices();

  // Connect MQTT after devices are loaded
  initMQTT();
});
