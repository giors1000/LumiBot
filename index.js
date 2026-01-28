/**
 * LumiBot - Index Page Logic
 * Manages device list, MQTT connections, quick controls, and context menu
 */

// ============================================
// MQTT Configuration
// ============================================
// MQTT credentials are centralized in MQTTClient.config (mqtt.js)

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
        try {
          const user = Auth.getUser();

          // ============================================
          // STEP 1: Remove from Firebase (if authenticated)
          // ============================================
          if (user) {
            console.log('[Index] 🗑️ Removing device from Firebase:', deviceId);

            // Wait for DeviceService to be initialized
            await DeviceService.init();

            const success = await DeviceService.removeDevice(user.uid, deviceId);

            if (!success) {
              console.error('[Index] ❌ Firebase removal failed for device:', deviceId);
              Toast.error('Failed to remove device from cloud');
              return; // Don't remove locally if cloud removal fails
            }

            console.log('[Index] ✅ Device removed from Firebase successfully');

            // Verify removal by checking if device still exists
            const stillExists = await DeviceService.deviceExists(user.uid, deviceId);
            if (stillExists) {
              console.error('[Index] ⚠️ Device still exists in Firebase after deletion!');
              Toast.error('Device removal may have failed. Please try again.');
              return;
            }
            console.log('[Index] ✅ Verified: Device no longer exists in Firebase');
          }

          // ============================================
          // STEP 2: Remove from local storage
          // ============================================
          console.log('[Index] 🗑️ Removing device from local storage:', deviceId);
          const removed = DeviceList.remove(deviceId);

          if (!removed) {
            console.warn('[Index] Device was not in local storage:', deviceId);
          } else {
            console.log('[Index] ✅ Device removed from local storage');
          }

          // ============================================
          // STEP 3: Cleanup MQTT subscription
          // ============================================
          if (MQTTClient.unsubscribeDevice) {
            console.log('[Index] Unsubscribing from MQTT for device:', deviceId);
            MQTTClient.unsubscribeDevice(deviceId);
          }

          // ============================================
          // STEP 4: Re-render device list (do NOT trigger background sync)
          // ============================================
          const list = document.getElementById('deviceList');
          const emptyState = document.getElementById('emptyState');
          const countEl = document.getElementById('deviceCount');
          const currentDevices = DeviceList.getAll();
          renderDeviceList(currentDevices, list, emptyState, countEl);

          Toast.success('Device removed');
          console.log('[Index] ✅ Device removal complete:', deviceId);

        } catch (error) {
          console.error('[Index] ❌ Failed to remove device:', error);
          Toast.error('Failed to remove device: ' + (error.message || 'Unknown error'));
        }
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
  const modes = [
    { value: 0, icon: '🔄', label: 'Auto' },
    { value: 1, icon: '✋', label: 'Manual' },
    { value: 4, icon: '🔒', label: 'Lock' },
    { value: 3, icon: '🌙', label: 'Sleep' }
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
            <button class="power-btn ${lightOn ? 'active' : ''}" data-action="power">
                <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
                    <path d="M12 3v9"/>
                    <path d="M18.36 6.64A9 9 0 1 1 5.64 6.64"/>
                </svg>
            </button>
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
// Render Devices - Fast local load with background Firebase sync
// ============================================
async function renderDevices() {
  const list = document.getElementById('deviceList');
  const emptyState = document.getElementById('emptyState');
  const countEl = document.getElementById('deviceCount');

  // FAST PATH: Render from local storage immediately (no await)
  const localDevices = DeviceList.getAll();

  // Show skeleton loader if no local devices found (waiting for Firebase)
  // This prevents flash of "No devices" empty state on first load
  if (localDevices.length === 0) {
    renderSkeletonLoader(list);
  } else {
    renderDeviceList(localDevices, list, emptyState, countEl);
  }

  // BACKGROUND: Sync with Firebase (non-blocking)
  loadFirebaseDevicesInBackground(list, emptyState, countEl);
}

// Skeleton Loader
function renderSkeletonLoader(list) {
  list.innerHTML = '';
  // Generate 3 skeleton cards with staggered animation
  for (let i = 0; i < 3; i++) {
    const skeleton = document.createElement('div');
    skeleton.className = 'device-card skeleton';
    skeleton.style.animationDelay = `${i * 0.1}s`;
    skeleton.innerHTML = `
            <div class="device-header">
                <div class="device-info">
                    <div class="device-icon" style="background: var(--bg-glass-strong); border: none;"></div>
                    <div class="device-details">
                        <div class="device-name" style="width: 120px; height: 18px; background: var(--bg-glass-strong); border-radius: 4px; margin-bottom: 8px;"></div>
                        <div class="device-status" style="width: 80px; height: 14px; background: var(--bg-glass-strong); border-radius: 4px;"></div>
                    </div>
                </div>
                <div class="power-btn" style="background: var(--bg-glass-strong); border: none;"></div>
            </div>
            <div class="mode-row">
                ${[1, 2, 3, 4].map(() => `
                <div class="mode-btn" style="background: var(--bg-glass-strong); border: none; height: 60px;"></div>
                `).join('')}
            </div>
        `;
    list.appendChild(skeleton);
  }
}

// Helper function to render device list without blocking
function renderDeviceList(devices, list, emptyState, countEl) {
  list.innerHTML = '';

  if (devices.length === 0) {
    if (emptyState) emptyState.classList.remove('hidden');
  } else {
    if (emptyState) emptyState.classList.add('hidden');

    devices.forEach((device, index) => {
      const state = MQTTClient.getDeviceState(device.id);
      const card = createDeviceCard(device, state, index);
      list.appendChild(card);
    });

    const addCard = createAddDeviceCard();
    addCard.style.animationDelay = `${devices.length * 0.1}s`;
    list.appendChild(addCard);
  }

  if (countEl) {
    countEl.textContent = `${devices.length} device${devices.length !== 1 ? 's' : ''}`;
  }
}

// Background Firebase sync - runs after initial render
// CRITICAL: Firebase is the SOURCE OF TRUTH for device list
async function loadFirebaseDevicesInBackground(list, emptyState, countEl) {
  try {
    await Auth.waitForAuthReady();
    const user = Auth.getUser();
    if (!user) return;

    console.log('[Index] Background sync: Firebase is source of truth');
    await DeviceService.init();

    // STEP 1: Fetch Firebase devices FIRST (source of truth)
    // DO NOT call syncFromLocalStorage - it re-adds deleted devices!
    const firebaseDevices = await DeviceService.getDevices(user.uid);
    console.log('[Index] Firebase devices:', firebaseDevices.length);

    // STEP 2: Get local devices for comparison
    const localDevices = DeviceList.getAll();
    const firebaseIds = new Set(firebaseDevices.map(d => d.id));
    const localIds = new Set(localDevices.map(d => d.id));

    // STEP 3: Handle devices that exist locally but NOT in Firebase
    // These could be:
    //   A) Devices deleted from Firebase (should NOT be re-added)
    //   B) Devices added offline (should be synced UP to Firebase)
    const localOnlyIds = [...localIds].filter(id => !firebaseIds.has(id));

    for (const id of localOnlyIds) {
      const localDevice = localDevices.find(d => d.id === id);
      if (!localDevice) continue;

      // Only sync devices added very recently (within last 5 minutes)
      // This handles offline device additions while preventing re-adding deleted devices
      const addedAt = localDevice.addedAt || 0;
      const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
      const addedRecently = addedAt > fiveMinutesAgo;

      if (addedRecently) {
        console.log('[Index] Syncing recently added local device to Firebase:', id);
        const success = await DeviceService.addDevice(user.uid, localDevice);
        if (success) {
          // Add to our firebaseDevices array so it shows up in the render
          firebaseDevices.push(localDevice);
        }
      } else {
        console.log('[Index] Removing stale local device (deleted from Firebase):', id);
        // This device was deleted from Firebase - don't re-add it
      }
    }

    // STEP 4: Check if local storage needs updating
    const hasNewDevices = [...firebaseIds].some(id => !localIds.has(id));
    const hasRemovedDevices = localOnlyIds.length > 0;
    const needsUpdate = hasNewDevices || hasRemovedDevices;

    if (needsUpdate) {
      console.log('[Index] Updating local storage with Firebase data');
      // CRITICAL: Overwrite local storage with Firebase devices (source of truth)
      Storage.set('LumiBot-devices', firebaseDevices);
      renderDeviceList(firebaseDevices, list, emptyState, countEl);
    } else {
      console.log('[Index] Local storage matches Firebase, no update needed');
    }
  } catch (error) {
    console.error('[Index] Background Firebase sync error:', error);
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
      if (!MQTTClient.connected) {
        console.warn(`[Index] Cannot toggle power - MQTT not connected (State: ${MQTTClient.connectionState})`);
        Toast.error('Not connected. Reconnecting...');
        MQTTClient.connect(); // Force reconnect attempt
        return;
      }

      const currentState = MQTTClient.getDeviceState(deviceId);
      const newState = !(currentState?.light ?? false);
      console.log(`[Index] Toggling power for ${deviceId}: ${newState}`);
      MQTTClient.publishControl(deviceId, { light: newState });

      // Optimistic update
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
      if (!MQTTClient.connected) {
        console.warn(`[Index] Cannot change mode - MQTT not connected (State: ${MQTTClient.connectionState})`);
        Toast.error('Not connected. Reconnecting...');
        MQTTClient.connect(); // Force reconnect attempt
        return;
      }

      const btn = e.target.closest('[data-mode]');
      const mode = parseInt(btn.dataset.mode);
      console.log(`[Index] Setting mode for ${deviceId}: ${mode}`);
      MQTTClient.publishControl(deviceId, { mode });

      // Optimistic update
      card.querySelectorAll('[data-mode]').forEach(b => {
        b.classList.toggle('active', parseInt(b.dataset.mode) === mode);
      });
      return;
    }

    // Alarm toggle
    if (e.target.closest('[data-action="alarm"]')) {
      if (!MQTTClient.connected) {
        console.warn(`[Index] Cannot toggle alarm - MQTT not connected (State: ${MQTTClient.connectionState})`);
        Toast.error('Not connected. Reconnecting...');
        MQTTClient.connect(); // Force reconnect attempt
        return;
      }

      const toggle = e.target.closest('[data-action="alarm"]');
      const enabled = !toggle.classList.contains('active');

      // Optimistic update
      toggle.classList.toggle('active', enabled);
      console.log(`[Index] Setting alarm for ${deviceId}: ${enabled}`);
      MQTTClient.publishConfig(deviceId, { alarmEnabled: enabled });
      return;
    }
  });
}


function showAddDeviceModal() {
  const { modal, close } = Modal.create({
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

  // Attach listeners using the modal instance directly
  modal.querySelector('#setupNewBtn')?.addEventListener('click', () => {
    close();
    window.location.href = 'setup.html';
  });

  modal.querySelector('#addExistingBtn')?.addEventListener('click', () => {
    close();
    showAddExistingModal();
  });
}

function showAddExistingModal() {
  const { modal, close } = Modal.create({
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
          const idInput = modal.querySelector('#deviceIdInput');
          const nameInput = modal.querySelector('#deviceNameInput');

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
            const btn = modal.querySelector('.btn-primary'); // Get the button from current modal
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
  const input = modal.querySelector('#deviceIdInput');
  if (input) {
    setTimeout(() => input.focus(), 50); // Small delay to ensure focus works after animation
    input.addEventListener('input', (e) => {
      e.target.value = e.target.value.toUpperCase().replace(/[^A-F0-9]/g, '');
    });
  }
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
let mqttInitialized = false; // Guard

async function initMQTT() {
  if (mqttInitialized) return;
  mqttInitialized = true;

  // Clear previous listeners to prevent duplicates on hot-reload
  MQTTClient.clearCallbacks();

  // CRITICAL FIX: Reset reconnect state for fresh page load (same as device.js)
  // This prevents stale state from causing Code 8 disconnects
  MQTTClient.reconnectAttempts = 0;
  MQTTClient.reconnectDelay = 1000;

  // ============================================
  // CRITICAL: Clean up invalid devices BEFORE connecting
  // Invalid device IDs in localStorage can cause broker rejection
  // ============================================
  const devices = DeviceList.getAll();
  const validDevices = devices.filter(d => {
    if (!d.id) return false;
    const cleanId = d.id.toString().replace(/[^A-Fa-f0-9]/g, '').toUpperCase();
    const isValid = /^[A-F0-9]{4}$/.test(cleanId);
    if (!isValid) {
      console.warn(`[Index] ⚠️ BEFORE CONNECT: Removing invalid device: "${d.id}"`);
    } else if (d.id !== cleanId) {
      d.id = cleanId;
      console.log(`[Index] Auto-corrected device ID: "${d.id}" -> "${cleanId}"`);
    }
    return isValid;
  });

  if (devices.length !== validDevices.length) {
    console.warn(`[Index] ⚠️ Cleaned ${devices.length - validDevices.length} invalid device(s) from localStorage`);
    Storage.set('LumiBot-devices', validDevices);
  }

  MQTTClient.on('onConnect', async () => {
    updateMQTTStatus(true);
    console.log('[Index] MQTT Connected. Subscribing to lumibot/#...');

    // Subscribe to wildcard topic first to receive all device messages
    if (MQTTClient.connected && MQTTClient.client) {
      try {
        MQTTClient.client.subscribe('lumibot/#', { qos: 0 });
        console.log('[Index] ✅ Subscribed to lumibot/#');
      } catch (e) {
        console.warn('[Index] Failed to subscribe to lumibot/#:', e.message || e);
      }
    }

    // Get the already-cleaned device list (cleaned before connect)
    const deviceList = DeviceList.getAll();

    if (deviceList.length === 0) {
      console.log('[Index] No devices to subscribe to.');
      return;
    }

    // Stagger subscriptions to avoid flooding the socket
    deviceList.forEach((device, index) => {
      setTimeout(() => {
        if (MQTTClient.connected) {
          console.log(`[Index] Subscribing to device: ${device.id}`);
          MQTTClient.subscribeDevice(device.id);
          // Request current state
          MQTTClient.publishControl(device.id, { command: 'getState' });
        }
      }, index * 300 + 500); // 500ms initial delay, then 300ms between each
    });
  });

  MQTTClient.on('onDisconnect', () => {
    updateMQTTStatus(false);
  });

  MQTTClient.on('onStateUpdate', (deviceId, state) => {
    updateDeviceCard(deviceId, state);

    // PERSIST: Save state to cache so device page loads instantly
    // Only cache what we need for the UI to be responsive
    const stateToCache = {
      light: state.light,
      mode: state.mode,
      _online: state._online,
      isSleeping: state.isSleeping,
      config: state.config
    };
    DeviceList.update(deviceId, { state: stateToCache });
  });

  // Start connection
  await MQTTClient.connect();
}

// ============================================
// Initialize
// ============================================
document.addEventListener('DOMContentLoaded', async () => {
  // Protocol Check
  if (window.location.protocol === 'file:') {
    const warning = document.createElement('div');
    warning.style.cssText = `
          position: fixed; top: 0; left: 0; right: 0; background: #ef4444; color: white;
          padding: 12px; text-align: center; z-index: 9999; font-weight: bold;
          box-shadow: 0 2px 10px rgba(0,0,0,0.2);
      `;
    warning.innerHTML = `
          ⚠️ Running via file:// protocol. Connection issues expected. 
          <br><span style="font-weight: normal; font-size: 0.9em;">Please run "start_server.bat" to fix.</span>
      `;
    document.body.appendChild(warning);
    setTimeout(() => warning.remove(), 10000);
  }

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

  // Setup Settings Button
  document.getElementById('settingsBtn')?.addEventListener('click', () => {
    const currentIP = localStorage.getItem('LumiBot-BrokerIP') || 'ernesto-heptamerous-lourdes.ngrok-free.dev';
    const currentPort = localStorage.getItem('LumiBot-BrokerPort') || '443';

    const { modal, close } = Modal.create({
      title: 'Connection Settings',
      content: `
        <div style="margin-bottom: 16px;">
          <label style="display:block; color:var(--text-secondary); margin-bottom:8px; font-size:14px;">MQTT Broker (Ngrok URL)</label>
          <input type="text" id="brokerIpInput" value="${currentIP}" style="width:100%; padding:12px; background:var(--bg-glass); border:1px solid var(--border-glass); border-radius:12px; color:var(--text-primary); font-family:monospace; font-size:12px;">
          <p style="font-size:12px; color:var(--text-tertiary); margin-top:6px;">Default: ernesto-heptamerous-lourdes.ngrok-free.dev</p>
        </div>
        <div style="margin-bottom: 16px;">
          <label style="display:block; color:var(--text-secondary); margin-bottom:8px; font-size:14px;">WSS Port</label>
          <input type="number" id="brokerPortInput" value="${currentPort}" style="width:100%; padding:12px; background:var(--bg-glass); border:1px solid var(--border-glass); border-radius:12px; color:var(--text-primary); font-family:monospace;">
          <p style="font-size:12px; color:var(--text-tertiary); margin-top:6px;">Default: 443 (Secure WebSockets via Ngrok)</p>
        </div>
        <div style="padding:12px; background:rgba(99,102,241,0.1); border-radius:12px; border:1px solid rgba(99,102,241,0.2);">
           <p style="color:var(--accent); font-size:12px; line-height:1.4;">🔒 Using secure tunnel via Ngrok. Connection is encrypted.</p>
        </div>
      `,
      actions: [
        { label: 'Cancel', primary: false },
        {
          label: 'Save & Reload',
          primary: true,
          onClick: () => {
            const ip = modal.querySelector('#brokerIpInput').value.trim();
            const port = modal.querySelector('#brokerPortInput').value.trim();

            if (ip) {
              localStorage.setItem('LumiBot-BrokerIP', ip);
              localStorage.setItem('LumiBot-BrokerPort', port || '443');
              Toast.success('Settings saved. Reloading...');
              setTimeout(() => location.reload(), 1000);
            }
          }
        }
      ]
    });
  });

  // Render devices (async - loads from Firebase if authenticated)
  await renderDevices();

  // Connect MQTT after devices are loaded
  initMQTT();
});
