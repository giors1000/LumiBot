/**
 * Zaylo - Index Page Logic
 * Manages device list, MQTT connections, quick controls, and context menu
 */

// ============================================
// MQTT Configuration
// ============================================
// MQTT credentials are centralized in MQTTClient.config (mqtt.js)

// ============================================
// Pull-to-Refresh
// ============================================
class PullToRefresh {
  constructor(container, onRefresh) {
    this.container = container;
    this.onRefresh = onRefresh;
    this.indicator = document.getElementById('ptrIndicator');
    this.spinner = this.indicator?.querySelector('.ptr-spinner');
    this.startY = 0;
    this.currentY = 0;
    this.pulling = false;
    this.refreshing = false;
    this.threshold = 80;

    this._onTouchStart = this._onTouchStart.bind(this);
    this._onTouchMove = this._onTouchMove.bind(this);
    this._onTouchEnd = this._onTouchEnd.bind(this);

    container.addEventListener('touchstart', this._onTouchStart, { passive: true });
    container.addEventListener('touchmove', this._onTouchMove, { passive: false });
    container.addEventListener('touchend', this._onTouchEnd, { passive: true });
    this.startX = 0; // Add X tracking
  }

  _onTouchStart(e) {
    if (this.refreshing) return;
    if (this.container.scrollTop > 0) return; // Strict top check

    // CRITICAL: Don't start pull-to-refresh if user is holding a card to drag
    if (CardReorder && CardReorder.state !== 'IDLE') return;

    this.startY = e.touches[0].clientY;
    this.startX = e.touches[0].clientX;
    this.currentY = e.touches[0].clientY; // Reset to prevent phantom triggers
    this.pulling = true;
  }

  _onTouchMove(e) {
    if (!this.pulling || this.refreshing) return;

    // CRITICAL: Abort if drag started during the move
    if (CardReorder && CardReorder.state !== 'IDLE') {
      this.pulling = false;
      this._reset();
      return;
    }

    const y = e.touches[0].clientY;
    const x = e.touches[0].clientX;
    const diff = y - this.startY;
    const diffX = Math.abs(x - this.startX);

    // Lock: If scrolling down or moving horizontally more than vertically, ignore
    if (diffX > Math.abs(diff) || this.container.scrollTop > 0) {
      this.pulling = false;
      return;
    }

    this.currentY = y;

    if (diff > 0 && this.container.scrollTop <= 0) {
      e.preventDefault();
      const progress = Math.min(diff / this.threshold, 1);
      const translateY = Math.min(diff * 0.5, 60);

      if (this.indicator) {
        this.indicator.classList.add('visible');
        this.indicator.style.transform = `translateX(-50%) translateY(${translateY}px)`;
      }
      if (this.spinner) {
        this.spinner.style.transform = `rotate(${progress * 360}deg)`;
      }
    }
  }

  _onTouchEnd() {
    if (!this.pulling || this.refreshing) return;
    this.pulling = false;
    const diff = this.currentY - this.startY;

    if (diff > this.threshold) {
      this._doRefresh();
    } else {
      this._reset();
    }
  }

  async _doRefresh() {
    this.refreshing = true;
    Haptic.medium();

    if (this.indicator) {
      this.indicator.classList.add('refreshing');
      this.indicator.style.transform = 'translateX(-50%) translateY(0)';
    }

    try {
      await this.onRefresh();
    } catch (e) {
      console.error('[PTR] Refresh error:', e);
    }

    setTimeout(() => {
      this._reset();
      this.refreshing = false;
    }, 600);
  }

  _reset() {
    if (this.indicator) {
      this.indicator.classList.remove('visible', 'refreshing');
      this.indicator.style.transform = '';
    }
    if (this.spinner) {
      this.spinner.style.transform = '';
    }
  }
}

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

      Haptic.heavy();
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
// Pending Deletion Tracking
// Prevents merge logic from re-adding devices during async delete
// ============================================
const _pendingDeletions = new Set();

// ============================================
// Blind Target Tracking
// Preserves optimistic UI during MQTT state updates
// ============================================
const _blindTargetLock = new Map(); // deviceId -> { target: 0|50|100, timestamp: number }
const HOME_WIDGET_ALL_BLINDS_ID = '__all_blinds__';

// ============================================
// Home Widget Layout Preference
// ============================================
const WidgetLayout = {
  STORAGE_KEY: 'zaylo-widget-layout',
  HOLD_NAV_DELAY: 560,
  MOVE_CANCEL_THRESHOLD: 10,
  _press: null,
  _suppressClickUntil: 0,

  init() {
    this.apply();
    this.bindCompactHoldNavigation();

    const doneBtn = document.getElementById('compactReorderDone');
    if (doneBtn) {
      doneBtn.addEventListener('click', () => {
        this.setCompactReorderMode(false);
        if (typeof Haptic !== 'undefined') Haptic.medium();
        if (typeof Toast !== 'undefined') Toast.success('Widget order saved');
      });
    }
  },

  getLayout() {
    try {
      return localStorage.getItem(this.STORAGE_KEY) === 'compact' ? 'compact' : 'large';
    } catch (e) {
      return 'large';
    }
  },

  isCompact() {
    return this.getLayout() === 'compact';
  },

  setLayout(layout) {
    const next = layout === 'compact' ? 'compact' : 'large';
    try {
      localStorage.setItem(this.STORAGE_KEY, next);
    } catch (e) { /* ignore */ }

    if (next !== 'compact') {
      this.setCompactReorderMode(false);
    }

    this.apply();
    rerenderHomeWidgets();
  },

  apply() {
    const layout = this.getLayout();
    document.documentElement.setAttribute('data-widget-layout', layout);
    if (layout !== 'compact') {
      document.documentElement.setAttribute('data-compact-reorder', 'false');
    }
    this.updateReorderChrome();
  },

  isCompactReorderMode() {
    return this.isCompact() && document.documentElement.getAttribute('data-compact-reorder') === 'true';
  },

  setCompactReorderMode(active) {
    const enabled = Boolean(active && this.isCompact());
    document.documentElement.setAttribute('data-compact-reorder', enabled ? 'true' : 'false');
    const list = document.getElementById('deviceList');
    if (list) list.classList.toggle('is-compact-reordering', enabled);

    if (!enabled && typeof CardReorder !== 'undefined' && CardReorder.state !== 'IDLE') {
      CardReorder.reset();
    }

    this.updateReorderChrome();
  },

  updateReorderChrome() {
    const enabled = this.isCompactReorderMode();
    document.getElementById('compactReorderBar')?.classList.toggle('visible', enabled);
    document.getElementById('reorderBanner')?.classList.toggle('visible', false);
  },

  shouldSuppressCompactClick() {
    return Date.now() < this._suppressClickUntil;
  },

  bindCompactHoldNavigation() {
    const list = document.getElementById('deviceList');
    if (!list || list.dataset.compactHoldBound === '1') return;
    list.dataset.compactHoldBound = '1';

    list.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    document.addEventListener('pointermove', (e) => this.onPointerMove(e));
    document.addEventListener('pointerup', () => this.cancelPress());
    document.addEventListener('pointercancel', () => this.cancelPress());
  },

  onPointerDown(e) {
    if (!this.isCompact() || this.isCompactReorderMode()) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    const card = e.target.closest('.device-card[data-device-id], .device-card[data-widget-id]');
    if (!card) return;
    if (e.target.closest('button, .toggle-mini, .power-btn, .mode-btn, [data-mode], .blind-quick-btn')) return;

    this.cancelPress();
    this._press = {
      card,
      startX: e.clientX,
      startY: e.clientY,
      pointerId: e.pointerId,
      fired: false,
      timer: setTimeout(() => {
        if (!this._press || this._press.card !== card) return;
        this._press.fired = true;
        this._suppressClickUntil = Date.now() + 900;
        card.classList.remove('compact-pressing');
        card.classList.add('compact-hold-fired');
        if (typeof Haptic !== 'undefined') Haptic.medium();
        this.navigateFromCard(card);
      }, this.HOLD_NAV_DELAY)
    };

    card.classList.add('compact-pressing');
  },

  onPointerMove(e) {
    if (!this._press || this._press.pointerId !== e.pointerId) return;
    const dx = e.clientX - this._press.startX;
    const dy = e.clientY - this._press.startY;
    if (Math.hypot(dx, dy) > this.MOVE_CANCEL_THRESHOLD) {
      this.cancelPress();
    }
  },

  cancelPress() {
    if (!this._press) return;
    clearTimeout(this._press.timer);
    this._press.card?.classList.remove('compact-pressing');
    this._press = null;
  },

  navigateFromCard(card) {
    if (!card) return;
    const widgetId = card.dataset.widgetId;
    if (widgetId === HOME_WIDGET_ALL_BLINDS_ID) {
      window.location.href = 'groups.html';
      return;
    }

    const deviceId = (card.dataset.deviceId || '').trim();
    if (!deviceId) return;
    const type = card.dataset.deviceType;
    const isBlindOrStepper = type === 'blind' || type === 'stepper';
    window.location.href = isBlindOrStepper
      ? `blind-device.html?id=${deviceId}`
      : `device.html?id=${deviceId}`;
  }
};

// ============================================
// Device Rescue & Diagnostics (Web Bluetooth)
// ============================================
const DeviceRescue = {
  // Service & Char UUIDs (Must match firmware)
  SERVICE_UUID: "12345678-1234-5678-1234-56789abcdef0",
  CHAR_STATUS_UUID: "12345678-1234-5678-1234-56789abcdef4",
  CHAR_WIFI_SCAN_UUID: "12345678-1234-5678-1234-56789abcdef6",
  CHAR_WIFI_RESULTS_UUID: "12345678-1234-5678-1234-56789abcdef7",
  CHAR_SERIAL_OUTPUT_UUID: "12345678-1234-5678-1234-56789abcdef9",
  CHAR_COMMAND_UUID: "12345678-1234-5678-1234-56789abcdefa",
  CHAR_DIAGNOSTICS_UUID: "12345678-1234-5678-1234-56789abcdefb",

  // State
  deviceId: null,
  bleDevice: null,
  bleServer: null,
  bleService: null,
  chars: {},
  diagBuffer: "",
  isConnected: false,
  isSerialPaused: false,
  serialLineCount: 0,
  
  init() {
    // Bind UI elements
    this.els = {
      overlay: document.getElementById('rescueOverlay'),
      title: document.getElementById('rescueTitle'),
      subtitle: document.getElementById('rescueSubtitle'),
      statusDot: document.querySelector('.rescue-ble-dot'),
      
      connectPanel: document.getElementById('rescueConnectPanel'),
      tabsNav: document.getElementById('rescueTabs'),
      contentArea: document.getElementById('rescueContent'),
      
      // Buttons
      backBtn: document.getElementById('rescueBackBtn'),
      connectBtn: document.getElementById('rescueConnectBtn'),
      
      // WiFi
      wifiScanBtn: document.getElementById('rescueWifiScanBtn'),
      wifiList: document.getElementById('rescueWifiList'),
      wifiCreds: document.getElementById('rescueWifiCreds'),
      wifiPass: document.getElementById('rescueWifiPass'),
      wifiConnectBtn: document.getElementById('rescueWifiConnectBtn'),
      selectedSSID: document.getElementById('rescueSelectedSSID'),
      currentSSID: document.getElementById('rescueCurrentSSID'),
      
      // Diagnostics
      diagRefreshBtn: document.getElementById('rescueDiagRefreshBtn'),
      autoDiagnoseBtn: document.getElementById('rescueAutoDiagnoseBtn'),
      diagOutput: document.getElementById('rescueDiagOutput'),
      
      // Serial
      serialConsole: document.getElementById('rescueSerialConsole'),
      serialClearBtn: document.getElementById('rescueSerialClearBtn'),
      serialPauseBtn: document.getElementById('rescueSerialPauseBtn'),
      serialCopyBtn: document.getElementById('rescueSerialCopyBtn'),
      serialCount: document.getElementById('rescueSerialCount'),
      
      // OTA
      otaUrl: document.getElementById('rescueOtaUrl'),
      otaStartBtn: document.getElementById('rescueOtaStartBtn'),
      otaProgressSec: document.getElementById('rescueOtaProgressSection'),
      otaFill: document.getElementById('rescueOtaFill'),
      otaPct: document.getElementById('rescueOtaPct'),
      otaStatus: document.getElementById('rescueOtaStatus'),
      fwVersion: document.getElementById('rescueFwVersion'),
      
      // Settings
      rebootBtn: document.getElementById('rescueRebootBtn'),
      factoryResetBtn: document.getElementById('rescueFactoryResetBtn'),
      saveConfigBtn: document.getElementById('rescueSaveConfigBtn'),
      
      // Info spans
      devId: document.getElementById('rescueDeviceId'),
      devFw: document.getElementById('rescueDeviceFw'),
      devSsid: document.getElementById('rescueDeviceSsid'),
      devWifiStatus: document.getElementById('rescueDeviceWifiStatus'),
      devCalibrated: document.getElementById('rescueDeviceCalibrated')
    };

    if (!this.els.overlay) return;

    // Bind WebBluetooth event handlers once to prevent memory leaks
    this._handleStatusUpdate = this.handleStatusUpdate.bind(this);
    this._handleSerialData = this.handleSerialData.bind(this);
    this._handleDiagnosticsData = this.handleDiagnosticsData.bind(this);
    this._handleWifiResults = this.handleWifiResults.bind(this);
    this._onDisconnected = this.onDisconnected.bind(this);

    this.bindEvents();
  },

  bindEvents() {
    this.els.backBtn.addEventListener('click', () => this.close());
    this.els.connectBtn.addEventListener('click', () => this.connect());
    
    // Tabs
    document.querySelectorAll('.rescue-tab').forEach(tab => {
      tab.addEventListener('click', (e) => this.switchTab(e.currentTarget.dataset.tab));
    });

    // WiFi
    this.els.wifiScanBtn.addEventListener('click', () => this.startWifiScan());
    this.els.wifiConnectBtn.addEventListener('click', () => this.sendWifiCredentials());
    this.els.wifiPass.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.sendWifiCredentials();
      }
    });

    // Diagnostics
    this.els.diagRefreshBtn.addEventListener('click', () => {
      this.diagBuffer = ""; // Reset buffer for fresh incoming chunks
      this.els.diagOutput.innerHTML = '<div class="rescue-diag-placeholder">Refreshing telemetry...</div>';
      this.sendCommand({cmd: "getDiagnostics"});
    });
    this.els.autoDiagnoseBtn.addEventListener('click', () => this.runAutoDiagnose());

    // Serial
    this.els.serialClearBtn.addEventListener('click', () => {
      this.els.serialConsole.innerHTML = '';
      this.serialLineCount = 0;
      this.updateSerialCount();
    });
    this.els.serialPauseBtn.addEventListener('click', () => {
      this.isSerialPaused = !this.isSerialPaused;
      this.els.serialPauseBtn.classList.toggle('active', this.isSerialPaused);
    });
    this.els.serialCopyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(this.els.serialConsole.innerText);
      Toast.success("Copied to clipboard");
    });

    // OTA
    this.els.otaStartBtn.addEventListener('click', () => {
      const url = this.els.otaUrl.value.trim();
      if (!url) return Toast.error("Please enter a URL to the firmware binary (.bin)");
      this.els.otaProgressSec.style.display = 'block';
      this.els.otaFill.style.width = '0%';
      this.els.otaPct.textContent = '0%';
      this.els.otaStatus.textContent = 'Preparing update...';
      this.sendCommand({cmd: "otaUrl", url});
    });

    // Settings
    this.els.rebootBtn.addEventListener('click', () => {
      if(confirm("Reboot device?")) this.sendCommand({cmd: "reboot"});
    });
    this.els.factoryResetBtn.addEventListener('click', () => {
      if(confirm("WARNING: Factory Reset will erase all settings, WiFi credentials, and motor calibration!\nAre you really sure?")) {
        this.sendCommand({cmd: "factoryReset"});
      }
    });
    this.els.saveConfigBtn.addEventListener('click', () => this.saveMotorConfig());
  },

  switchTab(tabId) {
    document.querySelectorAll('.rescue-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.rescue-tab-content').forEach(c => c.classList.remove('active'));
    document.querySelector(`.rescue-tab[data-tab="${tabId}"]`).classList.add('active');
    document.getElementById(`rescueTab${tabId.charAt(0).toUpperCase() + tabId.slice(1)}`).classList.add('active');
  },

  open(deviceId) {
    this.deviceId = deviceId;
    const device = DeviceList.get(deviceId);
    
    this.els.title.textContent = "Rescue: " + (device?.name || "Device");
    this.els.subtitle.textContent = "Not connected";
    this.els.statusDot.className = 'rescue-ble-dot';
    
    // Reset UI
    this.els.connectPanel.style.display = 'flex';
    this.els.tabsNav.style.display = 'none';
    this.els.contentArea.style.display = 'none';
    this.diagBuffer = "";
    
    this.els.overlay.style.display = 'block';
    document.body.style.overflow = 'hidden';
  },

  close() {
    this.disconnect();
    this.els.overlay.style.animation = 'rescueFadeOut 0.3s ease forwards';
    setTimeout(() => {
      this.els.overlay.style.display = 'none';
      this.els.overlay.style.animation = '';
      document.body.style.overflow = '';
    }, 300);
  },

  async connect() {
    if (!navigator.bluetooth) {
      Toast.error("Web Bluetooth is not supported on this browser.");
      return;
    }

    try {
      this.els.connectBtn.disabled = true;
      this.els.connectBtn.classList.add('loading');
      this.els.connectBtn.innerHTML = "Scanning...";

      this.bleDevice = await navigator.bluetooth.requestDevice({
        filters: [{ services: [this.SERVICE_UUID] }]
      });

      // Ensure we don't duplicate listeners on the same object
      this.bleDevice.removeEventListener('gattserverdisconnected', this._onDisconnected);
      this.bleDevice.addEventListener('gattserverdisconnected', this._onDisconnected);

      this.els.subtitle.textContent = "Connecting to " + this.bleDevice.name + "...";
      this.els.statusDot.className = 'rescue-ble-dot connecting';

      this.bleServer = await this.bleDevice.gatt.connect();
      this.bleService = await this.bleServer.getPrimaryService(this.SERVICE_UUID);

      // Get characteristics
      const getChar = async (uuid) => {
        try { return await this.bleService.getCharacteristic(uuid); } 
        catch (e) { console.warn("Optional char missing:", uuid); return null; }
      };

      this.chars.status = await getChar(this.CHAR_STATUS_UUID);
      this.chars.serial = await getChar(this.CHAR_SERIAL_OUTPUT_UUID);
      this.chars.command = await getChar(this.CHAR_COMMAND_UUID);
      this.chars.diagnostics = await getChar(this.CHAR_DIAGNOSTICS_UUID);
      this.chars.wifiScan = await getChar(this.CHAR_WIFI_SCAN_UUID);
      this.chars.wifiResults = await getChar(this.CHAR_WIFI_RESULTS_UUID);

      // Setup Notifications
      if (this.chars.status) {
        await this.chars.status.startNotifications();
        this.chars.status.removeEventListener('characteristicvaluechanged', this._handleStatusUpdate);
        this.chars.status.addEventListener('characteristicvaluechanged', this._handleStatusUpdate);
      }

      if (this.chars.serial) {
        await this.chars.serial.startNotifications();
        this.chars.serial.removeEventListener('characteristicvaluechanged', this._handleSerialData);
        this.chars.serial.addEventListener('characteristicvaluechanged', this._handleSerialData);
      }

      if (this.chars.diagnostics) {
        await this.chars.diagnostics.startNotifications();
        this.chars.diagnostics.removeEventListener('characteristicvaluechanged', this._handleDiagnosticsData);
        this.chars.diagnostics.addEventListener('characteristicvaluechanged', this._handleDiagnosticsData);
      }
      
      if (this.chars.wifiResults) {
        await this.chars.wifiResults.startNotifications();
        this.chars.wifiResults.removeEventListener('characteristicvaluechanged', this._handleWifiResults);
        this.chars.wifiResults.addEventListener('characteristicvaluechanged', this._handleWifiResults);
      }

      this.onConnected();
    } catch (e) {
      console.error(e);
      // NotFoundError fires both when the user dismisses the chooser AND when the
      // chooser opened but no matching device was advertising. The latter is the
      // common "nothing to connect to" case the user hit: the blind hasn't entered
      // BLE rescue yet. Give actionable guidance instead of a raw error string.
      if (e && e.name === 'NotFoundError') {
        Toast.info("No blind found. If it just lost Wi-Fi, wait ~60s for Bluetooth rescue to switch on, then tap Scan again.");
        this.els.subtitle.textContent = "No device found â€” waiting for rescue mode";
      } else if (e && e.name === 'SecurityError') {
        Toast.error("Bluetooth needs a secure (https) connection or a user tap.");
        this.els.subtitle.textContent = "Connection blocked";
      } else {
        Toast.error("Connection failed: " + (e?.message || e));
        this.els.subtitle.textContent = "Connection failed";
      }
      this.els.statusDot.className = 'rescue-ble-dot';
      this.els.connectBtn.disabled = false;
      this.els.connectBtn.classList.remove('loading');
      this.els.connectBtn.innerHTML = "Scan & Connect";
    }
  },

  onConnected() {
    this.isConnected = true;
    this.els.subtitle.textContent = "Connected via BLE";
    this.els.statusDot.className = 'rescue-ble-dot connected';
    
    this.els.connectPanel.style.display = 'none';
    this.els.tabsNav.style.display = 'flex';
    this.els.contentArea.style.display = 'block';

    Toast.success("Connected to device");
    
    // Clear initial states
    this.els.serialConsole.innerHTML = '<div class="rescue-serial-line rescue-serial-info">--- Connected to Rescue Shell ---</div>';
    this.serialLineCount = 0;
    
    // Request initial data
    setTimeout(() => this.sendCommand({cmd: "getConfig"}), 500);
  },

  onDisconnected() {
    this.isConnected = false;
    this.els.subtitle.textContent = "Disconnected";
    this.els.statusDot.className = 'rescue-ble-dot';
    
    // Return to connect panel gently
    setTimeout(() => {
      this.els.connectPanel.style.display = 'flex';
      this.els.tabsNav.style.display = 'none';
      this.els.contentArea.style.display = 'none';
      
      this.els.connectBtn.disabled = false;
      this.els.connectBtn.classList.remove('loading');
      this.els.connectBtn.innerHTML = "Scan & Connect";
    }, 1000);
    
    Toast.error("Device disconnected");
  },

  disconnect() {
    if (this.bleDevice && this.bleDevice.gatt.connected) {
      this.bleDevice.gatt.disconnect();
    }
  },

  async sendCommand(obj) {
    if (!this.isConnected || !this.chars.command) {
      Toast.error("Not connected or command char missing");
      return;
    }
    try {
      const json = JSON.stringify(obj);
      const encoder = new TextEncoder();
      await this.chars.command.writeValueWithoutResponse(encoder.encode(json));
      console.debug("Sent rescue command:", obj.cmd);
    } catch (e) {
      console.error("Failed to send rescue command:", e);
      Toast.error("Failed to send command");
    }
  },

  // ===== Handlers =====

  handleStatusUpdate(e) {
    const value = e.target.value;
    if (value.byteLength === 0) return;
    const status = value.getUint8(0);
    
    // OTA Progress format: [BLE_STATUS_OTA_PROGRESS, percent]
    if (status === 10) { // BLE_STATUS_OTA_PROGRESS
      const pct = value.byteLength > 1 ? value.getUint8(1) : 0;
      this.els.otaFill.style.width = pct + '%';
      this.els.otaPct.textContent = pct + '%';
      if (pct === 100) this.els.otaStatus.textContent = "Success! Verifying and rebooting...";
    } else if (status === 11) { // OTA_SUCCESS
      this.els.otaStatus.textContent = "Update Successful! Device rebooting...";
    } else if (status === 12) { // OTA_FAIL
      this.els.otaStatus.textContent = "Update Failed. Check serial console.";
      this.els.otaFill.style.background = 'var(--danger)';
    } else if (status === 3) { // CONNECTED (WiFi)
      Toast.success("WiFi Connected!");
      this.sendCommand({cmd: "getConfig"});
    } else if (status === 5) { // WIFI_FAIL
      Toast.error("WiFi connection failed");
    }
  },

  handleSerialData(e) {
    if (this.isSerialPaused) return;
    
    const decoder = new TextDecoder();
    const str = decoder.decode(e.target.value);
    
    // Fast append
    const lineEl = document.createElement('div');
    lineEl.className = 'rescue-serial-line';
    
    // Some basic styling based on content
    const lowerStr = str.toLowerCase();
    if (str.includes('[E]') || lowerStr.includes('error') || lowerStr.includes('fail')) {
      lineEl.classList.add('rescue-serial-error');
    } else if (str.includes('[W]') || lowerStr.includes('warn')) {
      lineEl.classList.add('rescue-serial-warn');
    } else if (str.includes('[BLE]') || str.includes('[RESCUE]') || str.includes('[OTA]')) {
      lineEl.classList.add('rescue-serial-rescue');
    } else if (str.includes('[WiFi]') || str.includes('[MQTT]')) {
      lineEl.classList.add('rescue-serial-info');
    }
    
    lineEl.textContent = str;
    this.els.serialConsole.appendChild(lineEl);
    this.serialLineCount++;
    
    // Throttle UI count update for performance
    if (this.serialLineCount % 5 === 0) this.updateSerialCount();

    // Auto scroll if near bottom
    if (this.els.serialConsole.scrollHeight - this.els.serialConsole.scrollTop < this.els.serialConsole.clientHeight + 150) {
      this.els.serialConsole.scrollTop = this.els.serialConsole.scrollHeight;
    }
    
    // Prune if over 800 lines to save memory
    if (this.serialLineCount > 800 && this.els.serialConsole.firstChild) {
      this.els.serialConsole.removeChild(this.els.serialConsole.firstChild);
      this.serialLineCount--;
    }
  },

  updateSerialCount() {
    this.els.serialCount.textContent = this.serialLineCount + " lines";
  },

  handleDiagnosticsData(e) {
    const decoder = new TextDecoder();
    const str = decoder.decode(e.target.value);
    
    this.diagBuffer += str;
    
    // Check if end of JSON (since it's chunked)
    if (this.diagBuffer.trim().endsWith('}') || this.diagBuffer.trim().endsWith(']')) {
      try {
        const json = JSON.parse(this.diagBuffer);
        this.diagBuffer = ""; // Reset for next transmission
        this.processDiagnosticsJson(json);
      } catch (err) {
        // Might be an incomplete chunk still, ignore parsing error
      }
    }
  },

  processDiagnosticsJson(data) {
    // If it's just an ACK for saving config
    if (data.configSaved) {
      console.log("Config saved ack:", data.key);
      return;
    }

    // Determine if it's the config dump or a diagnostics dump
    if (data.firmware !== undefined && data.stepper !== undefined && !data.sys) {
      this.populateSettingsTab(data);
    } else {
      this.renderDiagnosticsTab(data);
    }
  },

  populateSettingsTab(cfg) {
    this.els.devId.textContent = cfg.deviceId || "â€”";
    this.els.devFw.textContent = cfg.firmware || "â€”";
    this.els.fwVersion.textContent = cfg.firmware || "â€”";
    
    if (cfg.wifi) {
      this.els.devSsid.textContent = cfg.wifi.ssid || "Not configured";
      this.els.devWifiStatus.textContent = cfg.wifi.connected ? `Connected (${cfg.wifi.rssi}dBm)` : "Disconnected";
      this.els.currentSSID.textContent = cfg.wifi.ssid || "None";
    }
    
    if (cfg.stepper) {
      this.els.devCalibrated.textContent = cfg.stepper.isCalibrated ? "Yes" : "No";
      
      document.getElementById('rescueCfgOpenSpeed').value = cfg.stepper.openSpeed || 2000;
      document.getElementById('rescueCfgCloseSpeed').value = cfg.stepper.closeSpeed || 2000;
      document.getElementById('rescueCfgAccel').value = cfg.stepper.acceleration || 2000;
      document.getElementById('rescueCfgRelax').value = cfg.stepper.relaxSteps || 128;
    }
  },

  renderDiagnosticsTab(diag) {
    // Format JSON beautifully
    const formatted = JSON.stringify(diag, null, 2);
    // SECURITY: use textContent, not innerHTML. `diag` is device-published MQTT
    // data (attacker-influenceable), and JSON.stringify does NOT escape < > &, so
    // a crafted string field could close the <pre> and inject markup (stored XSS).
    // textContent renders it literally.
    this.els.diagOutput.innerHTML = '';
    const pre = document.createElement('pre');
    pre.style.cssText = 'margin:0;font-family:monospace;white-space:pre-wrap;color:inherit;';
    pre.textContent = formatted;
    this.els.diagOutput.appendChild(pre);
    Toast.success("Telemetry updated");
  },

  runAutoDiagnose() {
    try {
      // Find the <pre> block
      const preEl = this.els.diagOutput.querySelector('pre');
      if (!preEl) {
        Toast.error("Please fetch telemetry first");
        return;
      }
      
      const data = JSON.parse(preEl.innerText);
      
      // Simple local heuristics for rescue mode
      const issues = [];
      let score = 100;
      
      // Memory
      if (data.sys && data.sys.mem < 20000) { issues.push({sev:'HIGH', msg:'Low memory: ' + data.sys.mem + ' bytes'}); score-=20; }
      
      // WiFi
      if (data.wifi && !data.wifi.connected) { issues.push({sev:'CRITICAL', msg:'WiFi is disconnected'}); score-=40; }
      else if (data.wifi && data.wifi.rssi < -80) { issues.push({sev:'WARN', msg:'Weak WiFi signal: ' + data.wifi.rssi + 'dBm'}); score-=10; }
      
      // MQTT
      if (data.mqtt && !data.mqtt.connected) { issues.push({sev:'HIGH', msg:'MQTT Broker disconnected'}); score-=30; }
      
      // Calibration
      if (data.motor && !data.motor.calibrated) { issues.push({sev:'WARN', msg:'Stepper motor is not calibrated'}); score-=15; }
      
      let reportHtml = `<div style="margin-bottom:15px; border-bottom:1px solid var(--border-glass); padding-bottom:15px; background:var(--bg-glass); border-radius:12px; padding:16px;">`;
      reportHtml += `<h4 style="margin:0 0 10px 0; color:${score > 70 ? '#10b981' : (score > 40 ? 'var(--warning)' : 'var(--danger)')}; font-size:16px;">Health Score: ${score}/100</h4>`;
      
      if (issues.length > 0) {
        reportHtml += `<ul style="margin:0; padding-left:20px; color:var(--text-secondary); font-size:13px; line-height:1.6;">`;
        issues.forEach(iss => {
          const color = iss.sev === 'CRITICAL' ? 'var(--danger)' : (iss.sev === 'WARN' ? 'var(--warning)' : '#10b981');
          reportHtml += `<li><strong style="color:${color}">[${iss.sev}]</strong> ${iss.msg}</li>`;
        });
        reportHtml += `</ul>`;
      } else {
        reportHtml += `<div style="color:var(--text-secondary); font-size:13px;">No issues detected. System appears healthy.</div>`;
      }
      
      reportHtml += `</div>`;
      
      // Prepend report
      this.els.diagOutput.innerHTML = reportHtml + `<div style="margin-top:10px;font-size:11px;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:1px;">Raw Telemetry Payload</div>` + this.els.diagOutput.innerHTML;
      
    } catch (e) {
      console.error(e);
      Toast.error("Failed to analyze diagnostics data");
    }
  },

  // ===== WiFi =====
  
  async startWifiScan() {
    if (!this.isConnected || !this.chars.wifiScan) return;
    try {
      this.els.wifiScanBtn.disabled = true;
      this.els.wifiScanBtn.innerHTML = '<svg class="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg> Scanning...';
      this.els.wifiList.innerHTML = '<div style="text-align:center; padding:20px; color:var(--text-tertiary); font-size:13px;">Scanning for networks via Bluetooth...</div>';
      
      const encoder = new TextEncoder();
      // Write 0x01 to trigger scan
      await this.chars.wifiScan.writeValue(encoder.encode(String.fromCharCode(0x01)));
    } catch (e) {
      console.error(e);
      Toast.error("Failed to start scan");
      this.els.wifiScanBtn.disabled = false;
      this.els.wifiScanBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" x2="12.01" y1="20" y2="20"/></svg> Scan Networks';
    }
  },

  handleWifiResults(e) {
    const decoder = new TextDecoder();
    const str = decoder.decode(e.target.value);
    
    this.els.wifiScanBtn.disabled = false;
    this.els.wifiScanBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" x2="12.01" y1="20" y2="20"/></svg> Scan Networks';
    
    try {
      const networks = JSON.parse(str);
      this.renderWifiList(networks);
    } catch (err) {
      console.error("Invalid WiFi results:", err);
      this.els.wifiList.innerHTML = '<div style="color:var(--danger); padding:10px; font-size:13px; text-align:center;">Failed to parse scan results</div>';
    }
  },

  renderWifiList(networks) {
    this.els.wifiList.innerHTML = '';
    this.els.wifiCreds.style.display = 'none';
    
    if (networks.length === 0) {
      this.els.wifiList.innerHTML = '<div style="text-align:center; padding:20px; color:var(--text-tertiary); font-size:13px;">No networks found</div>';
      return;
    }
    
    networks.forEach(net => {
      if (!net.s) return; // Skip empty SSIDs
      const el = document.createElement('div');
      el.className = 'rescue-wifi-item';
      
      const lockIcon = net.e === 1 ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--text-tertiary)"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>' : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="transparent" stroke-width="2"><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>';
      
      el.innerHTML = `
        ${lockIcon}
        <div class="rescue-wifi-name">${net.s}</div>
        <div class="rescue-wifi-rssi">${net.r}dBm</div>
      `;
      
      el.addEventListener('click', () => {
        document.querySelectorAll('.rescue-wifi-item').forEach(i => i.classList.remove('selected'));
        el.classList.add('selected');
        
        this.els.selectedSSID.textContent = net.s;
        this.els.wifiPass.value = '';
        this.els.wifiCreds.style.display = 'block';
        
        setTimeout(() => this.els.wifiCreds.scrollIntoView({ behavior: 'smooth', block: 'end' }), 50);
      });
      
      this.els.wifiList.appendChild(el);
    });
  },

  sendWifiCredentials() {
    const ssid = this.els.selectedSSID.textContent;
    const pass = this.els.wifiPass.value;
    
    if (!ssid) return;
    
    this.els.wifiConnectBtn.disabled = true;
    this.els.wifiConnectBtn.innerHTML = "Sending...";
    
    this.sendCommand({cmd: "setWifi", ssid: ssid, pass: pass});
    
    Toast.success("Credentials sent to device");
    
    setTimeout(() => {
      this.els.wifiConnectBtn.disabled = false;
      this.els.wifiConnectBtn.innerHTML = "Connect";
    }, 2000);
  },

  // ===== Settings =====
  saveMotorConfig() {
    this.els.saveConfigBtn.disabled = true;
    this.els.saveConfigBtn.innerHTML = "Saving...";
    
    const fields = [
      { id: 'rescueCfgOpenSpeed', key: 'openSpeed' },
      { id: 'rescueCfgCloseSpeed', key: 'closeSpeed' },
      { id: 'rescueCfgAccel', key: 'acceleration' },
      { id: 'rescueCfgRelax', key: 'relaxSteps' }
    ];
    
    let delay = 0;
    fields.forEach(f => {
      const val = parseInt(document.getElementById(f.id).value);
      if (!isNaN(val)) {
         setTimeout(() => this.sendCommand({cmd: "setConfig", key: f.key, value: val}), delay);
         delay += 100;
      }
    });
    
    setTimeout(() => {
      this.sendCommand({cmd: "getConfig"}); // Refresh view
      this.els.saveConfigBtn.disabled = false;
      this.els.saveConfigBtn.innerHTML = "Save Motor Settings";
      Toast.success("Configuration sent");
    }, delay + 500);
  }
};

// Initialize after DOM load
document.addEventListener('DOMContentLoaded', () => {
    DeviceRescue.init();
});

// ============================================
// Context Menu with Swipe-to-Dismiss
// ============================================
const DeviceContextMenu = {
  currentDeviceId: null,
  backdrop: null,
  menu: null,
  startY: 0,
  currentY: 0,
  isDragging: false,

  init() {
    this.backdrop = document.getElementById('contextMenuBackdrop');
    this.menu = document.getElementById('contextMenu');

    // NOTE: MQTT listeners (onConnect, onStateUpdate) are registered once in initMQTT()
    // to prevent duplicate handlers that cause double card updates and redundant subscriptions.

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
    document.getElementById('contextMenuTitle').textContent = device.name || `Zaylo-${deviceId}`;
    document.getElementById('contextMenuSubtitle').textContent = state?._online ? 'Online' : 'Offline';

    // Show/hide rescue option â€” only for blind/stepper devices
    const deviceType = device.type || 'lumibot';
    const isBlind = deviceType === 'blind' || deviceType === 'stepper';
    const rescueBtn = this.menu.querySelector('.rescue-option');
    if (rescueBtn) {
      rescueBtn.style.display = isBlind ? '' : 'none';
    }

    // Reset any drag state
    this.menu.style.transform = '';
    this.backdrop.style.backgroundColor = '';

    // Show menu
    this.backdrop.classList.add('visible');

    Haptic.medium();
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
      case 'diagnostics':
        window.location.href = `diagnostics.html?id=${deviceId}`;
        break;
      case 'rescue':
        DeviceRescue.open(deviceId);
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
      onSubmit: async (rawName) => {
        // Strict sanitization
        // Allow alphanumeric, spaces, hyphens, underscores
        const cleanName = rawName.replace(/[^a-zA-Z0-9\s\-_]/g, '').trim();

        if (cleanName) {


          // 1. Sync to Firebase (Source of Truth)
          const user = Auth.getUser();
          const homeId = window.activeHomeId;
          if (user && homeId) {
            try {
              // This triggers onSnapshot immediately (Latency Compensation)
              await DeviceService.updateDevice(homeId, deviceId, { name: cleanName });
              console.debug('[Index] Rename command sent to Firebase');
              Toast.success('Device renamed');
            } catch (e) {
              console.error('[Index] Failed to sync rename to Firebase:', e);
              Toast.error('Failed to save name online');
            }
          } else {
            // Offline: Update local only
            console.warn('[Index] User not logged in, rename is local only');
            DeviceList.update(deviceId, { name: cleanName });
            renderDevices();
            Toast.success('Device renamed (Local only)');
          }
        } else {
          Toast.error('Invalid name');
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
          // Mark as pending deletion so merge logic won't re-add it
          _pendingDeletions.add(deviceId.toUpperCase().trim());

          const user = Auth.getUser();

          // ============================================
          // STEP 1: Remove from Firebase (if authenticated)
          // ============================================
          if (user) {
            console.debug('[Index] <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-trash-2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg> Removing device from Firebase:', deviceId);

            // Wait for DeviceService to be initialized
            await DeviceService.init();
            const homeId = window.activeHomeId;
            const success = await DeviceService.removeDevice(homeId, deviceId);

            if (!success) {
              console.error('[Index] âŒ Firebase removal failed for device:', deviceId);
              Toast.error('Failed to remove device from cloud');
              return; // Don't remove locally if cloud removal fails
            }

            console.debug('[Index] âœ… Device removed from Firebase successfully');
            // Note: removeDevice() already verifies deletion internally
          }

          // ============================================
          // STEP 2: Remove from local storage
          // ============================================

          const removed = DeviceList.remove(deviceId);

          if (!removed) {
            console.warn('[Index] Device was not in local storage:', deviceId);
          }

          // ============================================
          // STEP 3: Cleanup MQTT subscription
          // ============================================
          if (MQTTClient.unsubscribeDevice) {
            console.debug('[Index] Unsubscribing from MQTT for device:', deviceId);
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
          // console.log('[Index] âœ… Device removal complete:', deviceId);

        } catch (error) {
          console.error('[Index] âŒ Failed to remove device:', error);
          Toast.error('Failed to remove device: ' + (error.message || 'Unknown error'));
        } finally {
          // Always clear pending deletion flag
          _pendingDeletions.delete(deviceId.toUpperCase().trim());
        }
      }
    );
  }
};

// ============================================
// Card Drag-to-Reorder System
// ============================================
// ============================================
// Card Drag-to-Reorder System (Premium Polish)
// ============================================
const CardReorder = {
  // State Machine
  state: 'IDLE', // IDLE | HOLD_PENDING | HELD | DRAGGING | DROPPING
  dragCard: null,
  ghost: null,
  list: null,

  // Touch Tracking
  startX: 0,
  startY: 0,
  currentY: 0,
  initialGhostTop: 0,
  touchOffsetY: 0, // Distance from finger to card top

  // Animation Refs
  rafId: null,
  holdTimer: null,

  // Config
  HOLD_DELAY: 350, // ms - Deliberate long press required
  DRAG_MOVE_THRESHOLD: 12, // px - Movement needed to start drag from HELD
  SCROLL_ZONE: 80, // px - Area to trigger auto-scroll
  SCROLL_SPEED: 8, // px/frame
  TILT_MAX: 4,     // deg - Maximum tilt during drag

  // Cached DOM reference
  _appContainer: null,

  init() {
    this.list = document.getElementById('deviceList');
    if (!this.list) return;

    // Use passive listeners where possible for scroll performance
    this.list.addEventListener('touchstart', (e) => this.onTouchStart(e), { passive: true });
    document.addEventListener('touchmove', (e) => this.onTouchMove(e), { passive: false }); // Needs to preventDefault during drag
    document.addEventListener('touchend', (e) => this.onTouchEnd(e), { passive: true });
    document.addEventListener('touchcancel', (e) => this.onTouchEnd(e), { passive: true });

    // Dismiss hold-active state when tapping outside a held card
    document.addEventListener('touchstart', (e) => {
      if (this.state !== 'HELD') return;
      const card = e.target.closest('.device-card[data-device-id], .device-card[data-widget-id]');
      // If tapping the card-menu-btn, let the click handler deal with it
      if (e.target.closest('.card-menu-btn')) return;
      // If tapping outside the held card, dismiss hold state
      if (!card || card !== this.dragCard) {
        this.dismissHeld();
      }
    }, { passive: true });
  },

  /** Dismiss the HELD state (card returns to normal) */
  dismissHeld() {
    if (this.dragCard) {
      this.dragCard.classList.remove('hold-active');
    }
    this.state = 'IDLE';
    this.dragCard = null;
  },

  reset() {
    if (this.holdTimer) clearTimeout(this.holdTimer);
    if (this.rafId) cancelAnimationFrame(this.rafId);

    this.state = 'IDLE';
    this.dragCard = null;
    this.ghost = null;
    this.startX = 0;
    this.startY = 0;
    this.lastSwapDir = null;

    // Cleanup any loose classes (safety)
    document.querySelectorAll('.drag-ghost').forEach(el => el.remove());
    document.querySelectorAll('.drag-placeholder').forEach(el => {
      el.classList.remove('drag-placeholder');
      el.style.opacity = '';
      el.style.visibility = '';
    });
    document.querySelectorAll('.hold-active').forEach(el => el.classList.remove('hold-active'));
    document.querySelectorAll('.is-moving').forEach(el => el.classList.remove('is-moving'));
    document.querySelectorAll('.is-reordering').forEach(el => el.classList.remove('is-reordering'));
  },

  // â”€â”€ Touch Handlers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  onTouchStart(e) {
    // If already in HELD state, let the dismiss handler deal with it
    if (this.state === 'HELD') return;
    if (this.state !== 'IDLE') return;

    // 1. Target Validation
    const compactReorder = typeof WidgetLayout !== 'undefined' && WidgetLayout.isCompactReorderMode();
    if (typeof WidgetLayout !== 'undefined' && WidgetLayout.isCompact() && !compactReorder) return;

    const card = e.target.closest('.device-card[data-device-id], .device-card[data-widget-id]');
    if (!card) return;

    // 2. Interactive Element Bypass
    if (e.target.closest('button, .toggle-mini, .power-btn, .mode-btn, [data-mode], .blind-quick-btn')) {
      return;
    }

    // 3. Initialize State
    const touch = e.touches[0];
    this.dragCard = card;
    this.startX = touch.clientX;
    this.startY = touch.clientY;

    // 4. Capture touch coords as plain numbers (Touch objects get recycled by the browser)
    const touchX = touch.clientX;
    const touchY = touch.clientY;

    if (compactReorder) {
      this.state = 'HELD';
      this.dragCard.classList.add('hold-active');
      this.heldTouchX = touchX;
      this.heldTouchY = touchY;
      try { Haptic.selection(); } catch (_) { }
      return;
    }

    this.state = 'HOLD_PENDING';

    // 5. Start Hold Timer â€” transitions to HELD (not directly to DRAGGING)
    this.holdTimer = setTimeout(() => {
      if (this.state === 'HOLD_PENDING') {
        this.state = 'HELD';
        this.dragCard.classList.add('hold-active');
        // Store touch position for drag threshold check
        this.heldTouchX = touchX;
        this.heldTouchY = touchY;
        try { Haptic.heavy(); } catch (_) { }
      }
    }, this.HOLD_DELAY);
  },

  onTouchMove(e) {
    const touch = e.touches[0];
    const dx = touch.clientX - this.startX;
    const dy = touch.clientY - this.startY;

    // Case A: Waiting for Hold
    if (this.state === 'HOLD_PENDING') {
      // If moved too much before timer fires, cancel hold (it's a scroll)
      if (Math.abs(dy) > 10 || Math.abs(dx) > 10) {
        clearTimeout(this.holdTimer);
        this.state = 'IDLE';
        if (this.dragCard) this.dragCard.classList.remove('hold-active');
      }
      return;
    }

    // Case B: Held â€” start drag if moved enough
    if (this.state === 'HELD') {
      const moveDx = touch.clientX - (this.heldTouchX || this.startX);
      const moveDy = touch.clientY - (this.heldTouchY || this.startY);
      if (Math.abs(moveDy) > this.DRAG_MOVE_THRESHOLD || Math.abs(moveDx) > this.DRAG_MOVE_THRESHOLD) {
        e.preventDefault();
        this.startDrag(touch.clientX, touch.clientY);
      }
      return;
    }

    // Case C: Dragging
    if (this.state === 'DRAGGING') {
      e.preventDefault(); // Stop native scrolling
      this.currentY = touch.clientY;
      this.updateGhost(touch.clientX, touch.clientY);
      this.checkAutoScroll(touch.clientY);
    }
  },

  onTouchEnd(e) {
    if (this.state === 'HOLD_PENDING') {
      clearTimeout(this.holdTimer);
      this.state = 'IDLE';
      if (this.dragCard) this.dragCard.classList.remove('hold-active');
    } else if (this.state === 'HELD') {
      if (typeof WidgetLayout !== 'undefined' && WidgetLayout.isCompactReorderMode()) {
        this.dismissHeld();
        return;
      }
      // User long-pressed and released â€” keep the card in hold-active state
      // so they can tap the 3-dots menu button. Tapping elsewhere will dismiss.
      // State stays as HELD, which will be dismissed by the document touchstart handler.
    } else if (this.state === 'DRAGGING') {
      this.endDrag();
    }
  },

  // â”€â”€ Drag Logic (Slot-Based Architecture) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Instead of doing live DOM swaps during drag (which causes oscillation),
  // we freeze card positions at drag start, compute the closest slot,
  // and shift cards visually with CSS transforms. DOM is only reordered on drop.

  startDrag(clientX, clientY) {
    this.state = 'DRAGGING';

    try { Haptic.heavy(); } catch (_) { }

    // Cache the scrollable container for this drag session
    this._appContainer = document.querySelector('.app');
    // 1. Measurements
    const rect = this.dragCard.getBoundingClientRect();
    this.touchOffsetY = clientY - rect.top;
    this.touchOffsetX = clientX - rect.left;
    this.ghostWidth = rect.width;
    this.ghostHeight = rect.height;

    // Position tracking
    this.currentX = rect.left;
    this.currentY = rect.top;
    this.targetX = rect.left;
    this.targetY = rect.top;
    this.startX = rect.left;

    // 2. Freeze card positions into immutable slots
    const allCards = Array.from(this.list.querySelectorAll('.device-card[data-device-id], .device-card[data-widget-id]'));
    this.originalOrder = allCards;
    this.dragIndex = allCards.indexOf(this.dragCard);
    this.targetIndex = this.dragIndex;

    this.slots = allCards.map(c => {
      const r = c.getBoundingClientRect();
      return {
        top: r.top,
        left: r.left,
        width: r.width,
        height: r.height,
        centerX: r.left + r.width / 2,
        centerY: r.top + r.height / 2
      };
    });

    // Track initial scroll position for adjustment
    const container = document.querySelector('.app');
    this.startScrollTop = container ? container.scrollTop : 0;

    // 3. CRITICAL: Strip ALL CSS animations from cards.
    //    CSS animation fill-mode ('both'/'forwards') overrides inline styles
    //    in the CSS cascade, so transforms set by applyShifts() would be ignored.
    allCards.forEach(c => {
      c.classList.remove('card-enter');
      c.style.animation = 'none';
      c.style.webkitAnimation = 'none';
    });

    // 4. Create Ghost
    this.ghost = this.dragCard.cloneNode(true);
    this.ghost.classList.add('drag-ghost');
    this.ghost.classList.remove('hold-active');
    this.ghost.style.width = `${rect.width}px`;
    this.ghost.style.height = `${rect.height}px`;
    this.ghost.style.left = `${rect.left}px`;
    this.ghost.style.top = `${rect.top}px`;
    document.body.appendChild(this.ghost);

    // 5. Placeholder keeps space in layout
    this.dragCard.classList.add('drag-placeholder');
    this.list.classList.add('is-reordering');

    // 6. Start loop
    this.rafId = requestAnimationFrame(() => this.dragLoop());
  },

  dragLoop() {
    if (this.state !== 'DRAGGING') return;

    // 1. Direct Tracking
    this.currentX = this.targetX;
    this.currentY = this.targetY;

    // 2. Render Ghost
    const dx = this.currentX - this.startX;
    const tilt = Math.max(Math.min(dx * 0.1, 5), -5);

    this.ghost.style.transform = `translate3d(0, 0, 0) rotate(${tilt}deg) scale(1.05)`;
    this.ghost.style.top = `${this.currentY}px`;
    this.ghost.style.left = `${this.currentX}px`;

    // 3. Update which slot we're closest to
    this.updateSort();

    this.rafId = requestAnimationFrame(() => this.dragLoop());
  },

  updateGhost(clientX, clientY) {
    if (!this.ghost) return;
    this.targetY = clientY - this.touchOffsetY;
    this.targetX = clientX - this.touchOffsetX;
  },

  // â”€â”€ Slot-Based Sort â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Directional threshold: swap triggers when ghost has moved 30% toward the
  // next slot, making cards shift earlier and feel more responsive.
  updateSort() {
    if (!this.ghost || !this.slots || !this.slots.length) return;

    // Account for scroll changes since drag start
    const container = document.querySelector('.app');
    const scrollDelta = container ? (container.scrollTop - this.startScrollTop) : 0;

    // Ghost center in viewport coordinates
    const ghostCenterX = this.currentX + (this.ghostWidth / 2);
    const ghostCenterY = this.currentY + (this.ghostHeight / 2);

    // Current target index â€” check if we should move to a neighbor
    let newTarget = this.targetIndex;

    if (typeof WidgetLayout !== 'undefined' && WidgetLayout.isCompact()) {
      let bestDistance = Infinity;
      this.slots.forEach((slot, index) => {
        const dx = ghostCenterX - slot.centerX;
        const dy = ghostCenterY - (slot.centerY - scrollDelta);
        const distance = (dx * dx) + (dy * dy);
        if (distance < bestDistance) {
          bestDistance = distance;
          newTarget = index;
        }
      });

      if (newTarget === this.targetIndex) return;
      this.targetIndex = newTarget;
      this.applyShifts();
      try { Haptic.selection(); } catch (_) { }
      return;
    }

    // How far is 30% toward the next slot?
    const THRESHOLD = 0.30;

    // Check if should move DOWN
    if (newTarget < this.slots.length - 1) {
      const currentCenter = this.slots[newTarget].centerY - scrollDelta;
      const nextCenter = this.slots[newTarget + 1].centerY - scrollDelta;
      const triggerDown = currentCenter + (nextCenter - currentCenter) * THRESHOLD;
      if (ghostCenterY > triggerDown) {
        newTarget = newTarget + 1;
      }
    }

    // Check if should move UP (only if we didn't already move down)
    if (newTarget === this.targetIndex && newTarget > 0) {
      const currentCenter = this.slots[newTarget].centerY - scrollDelta;
      const prevCenter = this.slots[newTarget - 1].centerY - scrollDelta;
      const triggerUp = currentCenter - (currentCenter - prevCenter) * THRESHOLD;
      if (ghostCenterY < triggerUp) {
        newTarget = newTarget - 1;
      }
    }

    // No change? Skip.
    if (newTarget === this.targetIndex) return;

    this.targetIndex = newTarget;

    // Visually shift other cards to make room (transforms only, no DOM changes)
    this.applyShifts();

    try { Haptic.selection(); } catch (_) { }
  },

  // Apply CSS transforms to shift non-dragged cards to their temporary positions.
  // Uses !important to beat any CSS animation fill or pseudo-class overrides.
  applyShifts() {
    this.originalOrder.forEach((card, originalIdx) => {
      if (card === this.dragCard) return;

      // Compute this card's visual slot in the target arrangement
      let newSlotIdx = originalIdx;

      if (this.targetIndex > this.dragIndex) {
        // Dragging DOWN: cards between (dragIndex, targetIndex] shift UP by 1 slot
        if (originalIdx > this.dragIndex && originalIdx <= this.targetIndex) {
          newSlotIdx = originalIdx - 1;
        }
      } else if (this.targetIndex < this.dragIndex) {
        // Dragging UP: cards between [targetIndex, dragIndex) shift DOWN by 1 slot
        if (originalIdx >= this.targetIndex && originalIdx < this.dragIndex) {
          newSlotIdx = originalIdx + 1;
        }
      }

      // Compute pixel shift from original slot to target slot
      const shiftX = this.slots[newSlotIdx].left - this.slots[originalIdx].left;
      const shiftY = this.slots[newSlotIdx].top - this.slots[originalIdx].top;

      // Use setProperty with !important to guarantee override of any CSS
      // (animation fills, :hover, :active pseudo-classes, etc.)
      if (Math.abs(shiftX) > 0.5 || Math.abs(shiftY) > 0.5) {
        card.style.setProperty('transform', `translate(${shiftX}px, ${shiftY}px)`, 'important');
      } else {
        card.style.setProperty('transform', '', '');
      }
    });
  },

  checkAutoScroll(y) {
    const container = this._appContainer || document.querySelector('.app');
    if (!container) return;

    const bottomZone = window.innerHeight - this.SCROLL_ZONE;

    if (y < this.SCROLL_ZONE && container.scrollTop > 0) {
      container.scrollBy(0, -this.SCROLL_SPEED);
    } else if (y > bottomZone && container.scrollTop < container.scrollHeight - container.clientHeight - 5) {
      container.scrollBy(0, this.SCROLL_SPEED);
    }
  },

  // â”€â”€ End Drag â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  endDrag() {
    this.state = 'DROPPING';
    cancelAnimationFrame(this.rafId);

    // 1. Compute destination from frozen slot data
    const container = document.querySelector('.app');
    const scrollDelta = container ? (container.scrollTop - this.startScrollTop) : 0;
    const destTop = this.slots[this.targetIndex].top - scrollDelta;
    const destLeft = this.slots[this.targetIndex].left;

    // 2. Kill the ghostPop animation so it doesn't interfere with drop transition
    this.ghost.style.animation = 'none';

    // 3. Animate Ghost to target slot
    const ghost = this.ghost;
    const landingCard = this.dragCard;
    const list = this.list;
    const origOrder = this.originalOrder;
    const dragIdx = this.dragIndex;
    const targetIdx = this.targetIndex;

    requestAnimationFrame(() => {
      ghost.style.transition = [
        'top 0.35s cubic-bezier(0.22, 1, 0.36, 1)',
        'left 0.35s cubic-bezier(0.22, 1, 0.36, 1)',
        'transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)',
        'box-shadow 0.3s ease-out',
        'opacity 0.25s ease-out'
      ].join(', ');
      ghost.style.top = `${destTop}px`;
      ghost.style.left = `${destLeft}px`;
      ghost.style.transform = 'scale(1) rotate(0deg)';
      ghost.style.boxShadow = '0 4px 16px rgba(0,0,0,0.1)';
      ghost.style.opacity = '0.95';
    });

    try { Haptic.medium(); } catch (_) { }

    // 4. Cleanup after ghost transition ends
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;

      // Remove ghost
      if (ghost?.parentNode) ghost.remove();

      // Clear all visual transforms first
      origOrder.forEach(card => {
        card.style.transition = '';
        card.style.removeProperty('transform');
        card.style.removeProperty('animation');
        card.style.removeProperty('-webkit-animation');
      });

      // Do the actual DOM reorder (single atomic operation)
      if (targetIdx !== dragIdx && list) {
        const withoutDrag = origOrder.filter(c => c !== landingCard);
        withoutDrag.splice(targetIdx, 0, landingCard);

        // Preserve any non-device-card children (e.g. add-card)
        const addCard = list.querySelector('.add-card');
        withoutDrag.forEach(c => list.appendChild(c));
        if (addCard) list.appendChild(addCard);
      }

      // Restore the landed card
      if (landingCard) {
        landingCard.classList.remove('drag-placeholder', 'hold-active');
        landingCard.style.opacity = '';
        landingCard.style.visibility = '';
        // Settle bounce animation
        landingCard.classList.add('drag-dropped');
        const onEnd = () => landingCard.classList.remove('drag-dropped');
        landingCard.addEventListener('animationend', onEnd, { once: true });
        setTimeout(onEnd, 500);
      }

      if (list) list.classList.remove('is-reordering');
      this.state = 'IDLE';
      this.dragCard = null;
      this.ghost = null;
      this.originalOrder = [];
      this.slots = [];
      this.saveOrder();

      // Flush any render updates that were queued during the drag
      if (_pendingRenderUpdate) {
        const pending = _pendingRenderUpdate;
        _pendingRenderUpdate = null;
        renderDeviceList(pending.devices, pending.list, pending.emptyState, pending.countEl);
      }
    };

    ghost.addEventListener('transitionend', cleanup, { once: true });

    // Fail-safe timeout (must exceed longest transition: 350ms + rAF)
    setTimeout(() => {
      if (this.state === 'DROPPING') cleanup();
    }, 500);
  },

  // â”€â”€ Persistence â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async saveOrder() {
    const order = Array.from(this.list.querySelectorAll('.device-card[data-device-id], .device-card[data-widget-id]'))
      .map(el => el.dataset.widgetId || el.dataset.deviceid || el.dataset.deviceId)
      .filter(Boolean); // Handle potential casing

    // CRITICAL: Update in-memory state to prevent revert on re-render
    this.savedOrder = order;

    // Save locally immediately
    localStorage.setItem('zaylo-deviceOrder', JSON.stringify(order));

    // Sync to cloud
    const user = Auth.getUser();
    if (user && window.DeviceService) {
      try {
        await DeviceService.saveDeviceOrder(user.uid, order);
      } catch (e) {
        console.error('Failed to save order', e);
      }
    }
  },

  async loadOrder() {
    try {
      const local = JSON.parse(localStorage.getItem('zaylo-deviceOrder') || '[]');
      if (local.length) this.savedOrder = local;
    } catch (e) { }
    const user = Auth.getUser();
    if (user && window.DeviceService) {
      try {
        const fb = await DeviceService.getDeviceOrder(user.uid);
        if (fb?.length) {
          this.savedOrder = fb;
          localStorage.setItem('zaylo-deviceOrder', JSON.stringify(fb));
        }
      } catch (e) { }
    }
    return this.savedOrder;
  },

  applyOrder(devices) {
    if (!this.savedOrder?.length) return devices;
    const m = new Map(this.savedOrder.map((id, i) => [id, i]));
    return [...devices].sort((a, b) => (m.get(a.id) ?? 9999) - (m.get(b.id) ?? 9999));
  }
};

function getWidgetOrderIndex(id, fallbackIndex) {
  const order = CardReorder.savedOrder || [];
  const idx = order.indexOf(id);
  return idx === -1 ? 10000 + fallbackIndex : idx;
}

function buildHomeWidgetItems(devices) {
  const items = devices.map((device, index) => ({
    kind: 'device',
    id: String(device.id),
    device,
    sourceIndex: index
  }));

  if (typeof WidgetLayout !== 'undefined' && WidgetLayout.isCompact()) {
    const blindDevices = _getBlindDevices(devices);
    if (blindDevices.length >= 2) {
      items.unshift({
        kind: 'allBlinds',
        id: HOME_WIDGET_ALL_BLINDS_ID,
        sourceIndex: -1,
        devices: blindDevices
      });
    }
  }

  return items.sort((a, b) =>
    getWidgetOrderIndex(a.id, a.sourceIndex) - getWidgetOrderIndex(b.id, b.sourceIndex)
  );
}

function rerenderHomeWidgets() {
  const list = document.getElementById('deviceList');
  const emptyState = document.getElementById('emptyState');
  const countEl = document.getElementById('deviceCount');
  if (!list) return;
  const devices = CardReorder.applyOrder(DeviceList.getAll());
  renderDeviceList(devices, list, emptyState, countEl);
}

// ============================================
// Device Card Template
// ============================================
function createDeviceCard(device, state = null, index = 0) {
  // Handle three states: true (online), false (offline), undefined (unknown/connecting)
  const onlineStatus = state?._online;
  const isOnline = onlineStatus === true;
  const isConnecting = onlineStatus === undefined;
  const lightOn = state?.light ?? false;
  const mode = state?.mode ?? 0;
  const alarmEnabled = state?.config?.alarmEnabled ?? false;
  const alarmHour = state?.config?.alarmHour ?? 7;
  const alarmMin = state?.config?.alarmMin ?? 0;

  // Mode values MUST match firmware: 0=AUTO, 1=MANUAL, 4=LOCKED, 3=BEDTIME(Sleep)
  const modes = [
    { value: 0, icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>', label: 'Auto' },
    { value: 1, icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 11V6a2 2 0 0 0-2-2 2 2 0 0 0-2 2"/><path d="M14 10V4a2 2 0 0 0-2-2 2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2 2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></svg>', label: 'Manual' },
    { value: 4, icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>', label: 'Lock' },
    { value: 3, icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>', label: 'Sleep' }
  ];

  // Status text: show Connecting... during initial load, then Online/Offline
  const statusText = isConnecting ? 'Connecting...' : (isOnline ? 'Online' : 'Offline');

  // CRITICAL: Only animate entry on the VERY FIRST render.
  // Subsequent re-renders (even if new DOM elements) should appear instantly.
  const animClass = window.Zaylo_InitialRenderComplete ? '' : 'card-enter';

  const card = document.createElement('div');
  card.className = `device-card ${animClass} ${isOnline ? 'online' : ''} ${lightOn ? 'compact-active' : ''}`;
  card.id = `device-${device.id}`;
  card.dataset.deviceId = device.id;
  card.dataset.deviceType = device.type || 'lumibot';
  card.setAttribute('role', 'listitem');
  card.style.animationDelay = `${index * 0.08}s`;
  if (animClass) {
    card.addEventListener('animationend', () => card.classList.remove('card-enter'), { once: true });
  }

  card.innerHTML = `
        <button class="card-menu-btn" data-action="menu" aria-label="Device options"></button>
        <span class="compact-reorder-grip" aria-hidden="true">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/>
                <circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/>
            </svg>
        </span>
        <div class="device-header">
            <div class="device-info" data-action="navigate">
                <div class="device-icon ${lightOn ? 'on' : ''}">
                    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-lightbulb"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.9 1.2 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg>
                    <div class="status-dot ${isOnline ? 'online' : (isConnecting ? 'connecting' : '')}"></div>
                </div>
                <div class="device-details">
                    <div class="device-name">${Utils.escapeHtml(device.name || 'Zaylo-' + device.id)}</div>
                    <div class="device-status">${statusText} â€¢ ${lightOn ? 'On' : 'Off'}</div>
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
                <span class="quick-icon"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2"/><path d="M5 3 2 6"/><path d="m22 6-3-3"/><path d="M6.38 18.7 4 21"/><path d="M17.64 18.67 20 21"/></svg></span>
                <div class="quick-text">
                    <span class="quick-label">Alarm</span>
                    <span class="quick-value">${String(alarmHour).padStart(2, '0')}:${String(alarmMin).padStart(2, '0')}</span>
                </div>
            </div>
            <div class="toggle-mini ${alarmEnabled ? 'active' : ''}" data-action="alarm">
                <div class="thumb"></div>
            </div>
        </div>
        <div class="compact-widget-footer" aria-hidden="true">
            <span class="compact-action-chip">${lightOn ? 'Turn off' : 'Turn on'}</span>
            <span class="compact-mini-stat">${isOnline ? 'Ready' : statusText}</span>
        </div>
    `;

  return card;
}

// ============================================
// Blind Device Card Template
// ============================================

// Helper: edge-round position to fix firmware rounding (e.g. 99â†’100, 1â†’0)
function _roundBlindPosition(pos) {
  if (pos >= 98) return 100;
  if (pos <= 2) return 0;
  return pos;
}

// Helper: get badge class for a position value
function _badgeClass(pos) {
  if (pos === 0) return 'closed';
  if (pos === 100) return 'open';
  return 'half';
}

// Helper: get badge label text
function _badgeLabel(pos) {
  if (pos === 0) return 'Closed';
  if (pos === 100) return 'Open';
  if (pos === 50) return 'Half';
  return `${pos}%`;
}

// Helper: get position text for status line
function _posText(pos) {
  if (pos === 0) return 'Closed';
  if (pos === 100) return 'Open';
  return `${pos}%`;
}

function _isBlindDevice(device) {
  const type = String(device?.type || '').toLowerCase();
  return type === 'blind' || type === 'stepper';
}

function _getBlindDevices(devices) {
  const source = Array.isArray(devices)
    ? devices
    : ((typeof DeviceList !== 'undefined' && DeviceList.getAll) ? DeviceList.getAll() : []);
  return source.filter(_isBlindDevice);
}

function _readSavedBlindState(deviceId) {
  try {
    return JSON.parse(localStorage.getItem(`blind-state-${deviceId}`) || '{}');
  } catch (e) {
    return {};
  }
}

function _getBlindStateForDevice(device) {
  if (!device) return null;
  const id = String(device.id || device).trim();
  if (!id) return null;
  if (typeof MQTTClient !== 'undefined' && MQTTClient.getDeviceState) {
    const live = MQTTClient.getDeviceState(id);
    if (live) return live;
  }
  return device.state || null;
}

function _getBlindTypeLabel(deviceId) {
  const saved = _readSavedBlindState(deviceId);
  const typeLabels = { roller: 'Roller', vertical: 'Vertical', zebra: 'Zebra' };
  return typeLabels[saved.blindType] || 'Roller';
}

function _getBlindPositionForDevice(device) {
  const id = String(device?.id || device || '').trim();
  if (!id) return null;

  const lock = _blindTargetLock.get(id);
  if (lock && Date.now() - lock.timestamp < 10000) {
    return _roundBlindPosition(Number(lock.target));
  }

  const state = _getBlindStateForDevice(device);
  let raw = state?.blindPosition ?? state?.position ?? state?.targetPosition;
  if (raw === undefined || raw === null) {
    const saved = _readSavedBlindState(id);
    raw = saved.targetPosition ?? saved.position;
  }

  const pos = Number(raw);
  return Number.isFinite(pos) ? _roundBlindPosition(pos) : null;
}

function _persistBlindDashboardState(deviceId, pos) {
  try {
    const key = `blind-state-${deviceId}`;
    const saved = _readSavedBlindState(deviceId);
    saved.position = pos;
    saved.targetPosition = pos;
    saved.isOpen = pos > 0;
    localStorage.setItem(key, JSON.stringify(saved));
  } catch (e) { /* ignore */ }
}

function _applyBlindDashboardPosition(deviceId, pos, motionText) {
  const card = document.getElementById(`device-${deviceId}`);
  if (!card || !card.classList.contains('blind-card')) return;

  card.querySelectorAll('.blind-quick-btn').forEach(btn => {
    const action = btn.dataset.action;
    btn.classList.toggle('active',
      (action === 'blindClose' && pos === 0) ||
      (action === 'blindHalf' && pos > 0 && pos < 100) ||
      (action === 'blindOpen' && pos === 100)
    );
  });

  const icon = card.querySelector('.device-icon');
  if (icon) icon.classList.toggle('on', pos > 0);
  card.classList.toggle('compact-active', pos > 0);

  const badge = card.querySelector('.blind-position-badge');
  if (badge) {
    badge.textContent = _badgeLabel(pos);
    badge.classList.remove('open', 'closed', 'half');
    badge.classList.add(_badgeClass(pos));
  }

  const statusEl = card.querySelector('.device-status');
  if (statusEl) {
    const state = _getBlindStateForDevice({ id: deviceId });
    const connText = state?._online === undefined
      ? ((typeof MQTTClient !== 'undefined' && MQTTClient.connected) ? 'Online' : 'Connecting...')
      : (state._online ? 'Online' : 'Offline');
    statusEl.textContent = `${connText} - ${motionText || _posText(pos)} - ${_getBlindTypeLabel(deviceId)}`;
  }

  const compactChip = card.querySelector('.compact-action-chip');
  if (compactChip) compactChip.textContent = pos > 0 ? 'Close' : 'Open';
  const compactStat = card.querySelector('.compact-mini-stat');
  if (compactStat) compactStat.textContent = pos === 0 ? 'Closed' : _badgeLabel(pos);
}

function updateBlindGroupControl(devices) {
  const panel = document.getElementById('blindGroupControl');
  if (!panel) return;

  const blindDevices = _getBlindDevices(devices);
  // Show the hub only if there are 2 or more blinds (multi-blind spaces / controls).
  const isVisible = blindDevices.length >= 2;
  panel.classList.toggle('is-visible', isVisible);
  panel.setAttribute('aria-hidden', isVisible ? 'false' : 'true');
  if (!isVisible) return;

  let onlineCount = 0;
  let movingCount = 0;
  const positions = [];

  blindDevices.forEach(device => {
    const state = _getBlindStateForDevice(device);
    if (state?._online === true) onlineCount++;
    if (state?.isMoving === true) movingCount++;
    const pos = _getBlindPositionForDevice(device);
    if (pos !== null) positions.push(pos);
  });

  const average = positions.length
    ? `${Math.round(positions.reduce((sum, pos) => sum + pos, 0) / positions.length)}%`
    : '--';

  const countEl = document.getElementById('blindGroupCount');
  const onlineEl = document.getElementById('blindGroupOnline');
  const averageEl = document.getElementById('blindGroupAverage');
  const movingEl = document.getElementById('blindGroupMoving');

  if (countEl) countEl.textContent = `${blindDevices.length} blind${blindDevices.length !== 1 ? 's' : ''}`;
  if (onlineEl) onlineEl.textContent = `${onlineCount} online`;
  if (averageEl) averageEl.textContent = average;
  if (movingEl) movingEl.textContent = movingCount ? `${movingCount} moving` : 'Idle';
  updateAllBlindsCompactCard(blindDevices);
}

function getAllBlindsSummary(blindDevices = _getBlindDevices()) {
  let onlineCount = 0;
  let movingCount = 0;
  const positions = [];

  blindDevices.forEach(device => {
    const state = _getBlindStateForDevice(device);
    if (state?._online === true) onlineCount++;
    if (state?.isMoving === true) movingCount++;
    const pos = _getBlindPositionForDevice(device);
    if (pos !== null) positions.push(pos);
  });

  const averageValue = positions.length
    ? Math.round(positions.reduce((sum, pos) => sum + pos, 0) / positions.length)
    : null;

  return {
    count: blindDevices.length,
    onlineCount,
    movingCount,
    averageValue,
    averageLabel: averageValue === null ? '--' : `${averageValue}%`,
    isOpen: averageValue !== null && averageValue > 0
  };
}

function createAllBlindsCompactCard(blindDevices, index = 0) {
  const summary = getAllBlindsSummary(blindDevices);
  const animClass = window.Zaylo_InitialRenderComplete ? '' : 'card-enter';
  const card = document.createElement('div');
  card.className = `device-card all-blinds-compact-card ${animClass} ${summary.isOpen ? 'compact-active' : ''}`;
  card.id = 'allBlindsCompactCard';
  card.dataset.widgetId = HOME_WIDGET_ALL_BLINDS_ID;
  card.setAttribute('role', 'listitem');
  card.setAttribute('aria-label', 'All blinds compact control');
  card.style.animationDelay = `${index * 0.08}s`;
  if (animClass) {
    card.addEventListener('animationend', () => card.classList.remove('card-enter'), { once: true });
  }

  card.innerHTML = `
    <span class="compact-reorder-grip" aria-hidden="true">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/>
        <circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/>
      </svg>
    </span>
    <div class="device-header">
      <div class="device-info">
        <div class="device-icon blind-icon all-blinds-icon ${summary.isOpen ? 'on' : ''}">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/>
          </svg>
          <div class="status-dot ${summary.onlineCount > 0 ? 'online' : ''}"></div>
        </div>
        <div class="device-details">
          <div class="device-name">All Blinds</div>
          <div class="device-status">${summary.count} blinds â€¢ ${summary.onlineCount} online</div>
        </div>
      </div>
      <div class="blind-position-badge ${_badgeClass(summary.averageValue ?? 0)}">${summary.averageLabel}</div>
    </div>
    <div class="compact-widget-footer" aria-hidden="true">
      <span class="compact-action-chip">${summary.isOpen ? 'Close all' : 'Open all'}</span>
      <span class="compact-mini-stat">${summary.movingCount ? `${summary.movingCount} moving` : 'Group'}</span>
    </div>
  `;

  return card;
}

function updateAllBlindsCompactCard(blindDevices = _getBlindDevices()) {
  const card = document.getElementById('allBlindsCompactCard');
  if (!card) return;

  const summary = getAllBlindsSummary(blindDevices);
  card.classList.toggle('compact-active', summary.isOpen);

  const icon = card.querySelector('.device-icon');
  if (icon) icon.classList.toggle('on', summary.isOpen);

  const dot = card.querySelector('.status-dot');
  if (dot) dot.classList.toggle('online', summary.onlineCount > 0);

  const status = card.querySelector('.device-status');
  if (status) status.textContent = `${summary.count} blinds â€¢ ${summary.onlineCount} online`;

  const badge = card.querySelector('.blind-position-badge');
  if (badge) {
    badge.textContent = summary.averageLabel;
    badge.classList.remove('open', 'closed', 'half');
    badge.classList.add(_badgeClass(summary.averageValue ?? 0));
  }

  const chip = card.querySelector('.compact-action-chip');
  if (chip) chip.textContent = summary.isOpen ? 'Close all' : 'Open all';

  const mini = card.querySelector('.compact-mini-stat');
  if (mini) mini.textContent = summary.movingCount ? `${summary.movingCount} moving` : 'Group';
}

function setBlindGroupPosition(rawPos) {
  const pos = _roundBlindPosition(Number(rawPos));
  if (!Number.isFinite(pos)) return;

  const blindDevices = _getBlindDevices();
  if (!blindDevices.length) return;

  if (typeof Haptic !== 'undefined' && Haptic.selection) Haptic.selection();

  const isConnected = typeof MQTTClient !== 'undefined' && MQTTClient.connected;
  const canPublish = typeof MQTTClient !== 'undefined' && typeof MQTTClient.publishStepperControl === 'function';
  const motionText = isConnected ? _posText(pos) : 'Pending sync';

  blindDevices.forEach(device => {
    const deviceId = String(device.id || '').trim();
    if (!deviceId) return;
    _blindTargetLock.set(deviceId, { target: pos, timestamp: Date.now() });
    _applyBlindDashboardPosition(deviceId, pos, motionText);
    _persistBlindDashboardState(deviceId, pos);
    if (canPublish) MQTTClient.publishStepperControl(deviceId, { blindPosition: pos });
  });

  if (!isConnected && typeof Toast !== 'undefined' && Toast.info) {
    Toast.info('Offline - group change queued');
  } else if (typeof Toast !== 'undefined' && Toast.success) {
    const label = pos === 0 ? 'Close' : pos === 100 ? 'Open' : 'Half';
    Toast.success(`${label} sent to ${blindDevices.length} blinds`);
  }

  updateBlindGroupControl();
}

function stopBlindGroup() {
  const blindDevices = _getBlindDevices();
  if (!blindDevices.length) return;

  if (typeof Haptic !== 'undefined' && Haptic.medium) Haptic.medium();

  const isConnected = typeof MQTTClient !== 'undefined' && MQTTClient.connected;
  const canPublish = typeof MQTTClient !== 'undefined' && typeof MQTTClient.publishStepperControl === 'function';

  blindDevices.forEach(device => {
    const deviceId = String(device.id || '').trim();
    if (!deviceId) return;
    if (canPublish) MQTTClient.publishStepperControl(deviceId, { command: 'stop' });
    const pos = _getBlindPositionForDevice(device);
    if (pos !== null) {
      _blindTargetLock.set(deviceId, { target: pos, timestamp: Date.now() });
      _applyBlindDashboardPosition(deviceId, pos, 'Stopping');
    }
  });

  if (!isConnected && typeof Toast !== 'undefined' && Toast.info) {
    Toast.info('Offline - stop queued');
  } else if (typeof Toast !== 'undefined' && Toast.success) {
    Toast.success(`Stop sent to ${blindDevices.length} blinds`);
  }

  updateBlindGroupControl();
}

function setupBlindGroupControl() {
  const panel = document.getElementById('blindGroupControl');
  if (!panel || panel.dataset.bound === '1') return;
  panel.dataset.bound = '1';
  panel.addEventListener('click', (e) => {
    // Open the full multi-device control center
    if (e.target.closest('#blindGroupSpaces')) {
      if (typeof Haptic !== 'undefined' && Haptic.light) Haptic.light();
      window.location.href = 'groups.html';
      return;
    }

    const positionBtn = e.target.closest('[data-blind-group-pos]');
    if (positionBtn) {
      setBlindGroupPosition(positionBtn.dataset.blindGroupPos);
      return;
    }

    if (e.target.closest('#blindGroupStop')) {
      stopBlindGroup();
    }
  });
}

// Automation definitions for the carousel
const BLIND_AUTOMATIONS = [
  { key: 'sunset',      label: 'Sunset Close',    icon: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 10V2"/><path d="m4.93 10.93 1.41 1.41"/><path d="M2 18h2"/><path d="M20 18h2"/><path d="m19.07 10.93-1.41 1.41"/><path d="M22 22H2"/><path d="m16 6-4 4-4-4"/><path d="M16 18a4 4 0 0 0-8 0"/></svg>' },
  { key: 'morningOpen', label: 'Morning Open',     icon: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v8"/><path d="m4.93 10.93 1.41 1.41"/><path d="M2 18h2"/><path d="M20 18h2"/><path d="m19.07 10.93-1.41 1.41"/><path d="M22 22H2"/><path d="m8 6 4-4 4 4"/><path d="M16 18a4 4 0 0 0-8 0"/></svg>' },
  { key: 'nightLock',   label: 'Night Lock',       icon: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>' },
  { key: 'presence',    label: 'Presence',          icon: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>' },
  { key: 'temperature', label: 'Heat Protection',   icon: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z"/></svg>' }
];

function createBlindDeviceCard(device, state = null, index = 0) {
  const onlineStatus = state?._online;
  const isOnline = onlineStatus === true;
  const isConnecting = onlineStatus === undefined;
  const rawPosition = state?.blindPosition ?? state?.position ?? 0;
  const position = _roundBlindPosition(rawPosition);
  const isOpen = position > 0;

  const statusText = isConnecting ? 'Connecting...' : (isOnline ? 'Online' : 'Offline');
  const posText = _posText(position);

  // Read blind type and rules from saved state
  let blindTypeLabel = 'Roller';
  let savedRules = { sunset: true, morningOpen: true, nightLock: false, presence: true, temperature: false };
  try {
    const saved = JSON.parse(localStorage.getItem(`blind-state-${device.id}`) || '{}');
    const typeLabels = { roller: 'Roller', vertical: 'Vertical', zebra: 'Zebra' };
    blindTypeLabel = typeLabels[saved.blindType] || 'Roller';
    if (saved.rules) {
      Object.assign(savedRules, saved.rules);
    }
  } catch (e) { /* ignore */ }

  // CRITICAL: Only animate entry on the VERY FIRST render.
  const animClass = window.Zaylo_InitialRenderComplete ? '' : 'card-enter';

  const card = document.createElement('div');
  card.className = `device-card blind-card ${animClass} ${isOnline ? 'online' : ''} ${isOpen ? 'compact-active' : ''}`;
  card.id = `device-${device.id}`;
  card.dataset.deviceId = device.id;
  card.dataset.deviceType = device.type === 'stepper' ? 'stepper' : 'blind';
  card.setAttribute('role', 'listitem');
  card.style.animationDelay = `${index * 0.08}s`;
  if (animClass) {
    card.addEventListener('animationend', () => card.classList.remove('card-enter'), { once: true });
  }

  // Build automation carousel slides
  const slidesHtml = BLIND_AUTOMATIONS.map(auto => {
    const isActive = savedRules[auto.key] === true;
    return `
      <div class="blind-auto-slide">
        <div class="quick-row blind-smart-row">
          <div class="quick-info">
            <span class="quick-icon">${auto.icon}</span>
            <div class="quick-text">
              <span class="quick-label">${auto.label}</span>
              <span class="quick-value blind-auto-status-${auto.key}">${isActive ? 'Active' : 'Off'}</span>
            </div>
          </div>
          <div class="toggle-mini ${isActive ? 'active' : ''}" data-action="blindAutoRule" data-rule="${auto.key}">
            <div class="thumb"></div>
          </div>
        </div>
      </div>`;
  }).join('');

  const dotsHtml = BLIND_AUTOMATIONS.map((_, i) =>
    `<span class="blind-auto-dot ${i === 0 ? 'active' : ''}" data-slide="${i}"></span>`
  ).join('');

  // Determine active quick button
  const isHalf = position > 0 && position < 100;

  card.innerHTML = `
        <button class="card-menu-btn" data-action="menu" aria-label="Device options"></button>
        <span class="compact-reorder-grip" aria-hidden="true">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/>
                <circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/>
            </svg>
        </span>
        <div class="device-header">
            <div class="device-info" data-action="navigate">
                <div class="device-icon blind-icon ${isOpen ? 'on' : ''}">
                    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-blinds"><path d="M3 3h18"/><path d="M20 7H8"/><path d="M20 11H8"/><path d="M10 19h10"/><path d="M8 15h12"/><path d="M4 3v14"/><circle cx="4" cy="19" r="2"/></svg>
                    <div class="status-dot ${isOnline ? 'online' : (isConnecting ? 'connecting' : '')}"></div>
                </div>
                <div class="device-details">
                    <div class="device-name">${Utils.escapeHtml(device.name || 'Blinds-' + device.id)}</div>
                    <div class="device-status">${statusText} â€¢ ${posText} â€¢ ${blindTypeLabel}</div>
                </div>
            </div>
            <div class="blind-position-badge ${_badgeClass(position)}">
                ${_badgeLabel(position)}
            </div>
        </div>
        
        <div class="blind-quick-row">
            <button class="blind-quick-btn ${position === 0 ? 'active' : ''}" data-action="blindClose">
                <span class="blind-quick-icon"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-moon"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg></span>
                <span class="blind-quick-label">Close</span>
            </button>
            <button class="blind-quick-btn ${isHalf ? 'active' : ''}" data-action="blindHalf">
                <span class="blind-quick-icon"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a10 10 0 0 1 0 20z" fill="currentColor"/></svg></span>
                <span class="blind-quick-label">Half</span>
            </button>
            <button class="blind-quick-btn ${position === 100 ? 'active' : ''}" data-action="blindOpen">
                <span class="blind-quick-icon"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-sun"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg></span>
                <span class="blind-quick-label">Open</span>
            </button>
        </div>

        <div class="blind-auto-carousel" data-current-slide="0">
            <div class="blind-auto-track">
                ${slidesHtml}
            </div>
            <div class="blind-auto-dots">
                ${dotsHtml}
            </div>
        </div>
        <div class="compact-widget-footer" aria-hidden="true">
            <span class="compact-action-chip">${isOpen ? 'Close' : 'Open'}</span>
            <span class="compact-mini-stat">${position === 0 ? 'Closed' : _badgeLabel(position)}</span>
        </div>
    `;

  // Setup carousel swipe after card is rendered
  requestAnimationFrame(() => _initBlindCarousel(card));

  return card;
}

// ============================================
// Update Blind Device Card
// ============================================
function updateBlindDeviceCard(deviceId, state) {
  const card = document.getElementById(`device-${deviceId}`);
  if (!card || !card.classList.contains('blind-card')) return;

  const onlineStatus = state?._online;
  const isOnline = onlineStatus === true;
  const isConnecting = onlineStatus === undefined;
  const rawPosition = state?.blindPosition ?? state?.position ?? 0;
  const position = _roundBlindPosition(rawPosition);
  let displayPosition = position;

  const lock = _blindTargetLock.get(deviceId);
  if (lock) {
    const target = _roundBlindPosition(Number(lock.target));
    const elapsed = Date.now() - lock.timestamp;
    if (position === target || elapsed > 10000) {
      _blindTargetLock.delete(deviceId);
    } else {
      displayPosition = target;
    }
  }

  const isOpen = displayPosition > 0;

  const statusText = isConnecting ? 'Connecting...' : (isOnline ? 'Online' : 'Offline');
  const posText = _posText(displayPosition);

  // Retrieve blind type label for status text
  let blindTypeLabel = 'Roller';
  try {
    const saved = JSON.parse(localStorage.getItem(`blind-state-${deviceId}`) || '{}');
    const typeLabels = { roller: 'Roller', vertical: 'Vertical', zebra: 'Zebra' };
    blindTypeLabel = typeLabels[saved.blindType] || 'Roller';
  } catch (e) { /* ignore */ }

  card.classList.toggle('online', isOnline);
  card.classList.toggle('compact-active', isOpen);

  const icon = card.querySelector('.device-icon');
  if (icon) icon.classList.toggle('on', isOpen);

  const dot = card.querySelector('.status-dot');
  if (dot) {
    dot.classList.remove('online', 'connecting');
    if (isOnline) dot.classList.add('online');
    else if (isConnecting) dot.classList.add('connecting');
  }

  const status = card.querySelector('.device-status');
  if (status) status.textContent = `${statusText} â€¢ ${posText} â€¢ ${blindTypeLabel}`;

  const badge = card.querySelector('.blind-position-badge');
  if (badge) {
    badge.textContent = _badgeLabel(displayPosition);
    badge.classList.remove('open', 'closed', 'half');
    badge.classList.add(_badgeClass(displayPosition));
  }

  // Update quick button active states
  const isHalf = displayPosition > 0 && displayPosition < 100;
  

  const btns = card.querySelectorAll('.blind-quick-btn');
  btns.forEach(btn => {
    const action = btn.dataset.action;
    if (action === 'blindClose') btn.classList.toggle('active', displayPosition === 0);
    else if (action === 'blindHalf') btn.classList.toggle('active', isHalf);
    else if (action === 'blindOpen') btn.classList.toggle('active', displayPosition === 100);
  });

  const compactChip = card.querySelector('.compact-action-chip');
  if (compactChip) compactChip.textContent = isOpen ? 'Close' : 'Open';
  const compactStat = card.querySelector('.compact-mini-stat');
  if (compactStat) compactStat.textContent = displayPosition === 0 ? 'Closed' : _badgeLabel(displayPosition);

  // Update automation toggle states from localStorage
  try {
    const saved = JSON.parse(localStorage.getItem(`blind-state-${deviceId}`) || '{}');
    if (saved.rules) {
      BLIND_AUTOMATIONS.forEach(auto => {
        const isActive = saved.rules[auto.key] === true;
        const toggle = card.querySelector(`[data-rule="${auto.key}"]`);
        if (toggle) toggle.classList.toggle('active', isActive);
        const statusEl = card.querySelector(`.blind-auto-status-${auto.key}`);
        if (statusEl) statusEl.textContent = isActive ? 'Active' : 'Off';
      });
    }
  } catch (e) { /* ignore */ }
}

// ============================================
// Blind Automation Carousel â€” Swipe Handler
// ============================================
function _initBlindCarousel(card) {
  const carousel = card.querySelector('.blind-auto-carousel');
  if (!carousel) return;

  const track = carousel.querySelector('.blind-auto-track');
  const dots = carousel.querySelectorAll('.blind-auto-dot');
  const slideCount = carousel.querySelectorAll('.blind-auto-slide').length;
  if (!track || slideCount === 0) return;

  let currentSlide = 0;
  let startX = 0;
  let startY = 0;
  let isDragging = false;
  let currentTranslate = 0;
  let startTranslate = 0;
  let isHorizontalSwipe = null;

  function goToSlide(idx) {
    currentSlide = Math.max(0, Math.min(idx, slideCount - 1));
    currentTranslate = -currentSlide * 100;
    track.classList.remove('dragging');
    track.style.transform = `translateX(${currentTranslate}%)`;
    carousel.dataset.currentSlide = currentSlide;
    dots.forEach((d, i) => d.classList.toggle('active', i === currentSlide));
  }

  // Dot click navigation
  dots.forEach((dot, i) => {
    dot.addEventListener('click', (e) => {
      e.stopPropagation();
      goToSlide(i);
      if (typeof Haptic !== 'undefined') Haptic.light();
    });
  });

  // Touch swipe
  carousel.addEventListener('touchstart', (e) => {
    // Don't start swipe on toggle buttons
    if (e.target.closest('.toggle-mini')) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    isDragging = true;
    isHorizontalSwipe = null;
    startTranslate = currentTranslate;
    track.classList.add('dragging');
  }, { passive: true });

  carousel.addEventListener('touchmove', (e) => {
    if (!isDragging) return;
    const x = e.touches[0].clientX;
    const y = e.touches[0].clientY;
    const dx = x - startX;
    const dy = y - startY;

    // Determine swipe direction lock on first significant movement
    if (isHorizontalSwipe === null && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
      isHorizontalSwipe = Math.abs(dx) > Math.abs(dy);
    }

    // Only handle horizontal swipes
    if (!isHorizontalSwipe) {
      isDragging = false;
      track.classList.remove('dragging');
      return;
    }

    e.preventDefault();
    const pctDelta = (dx / carousel.offsetWidth) * 100;
    let newTranslate = startTranslate + pctDelta;
    // Add resistance at edges
    if (newTranslate > 0) newTranslate *= 0.3;
    if (newTranslate < -(slideCount - 1) * 100) {
      const overscroll = newTranslate + (slideCount - 1) * 100;
      newTranslate = -(slideCount - 1) * 100 + overscroll * 0.3;
    }
    track.style.transform = `translateX(${newTranslate}%)`;
  }, { passive: false });

  carousel.addEventListener('touchend', (e) => {
    if (!isDragging) return;
    isDragging = false;

    if (isHorizontalSwipe) {
      const dx = e.changedTouches[0].clientX - startX;
      const threshold = carousel.offsetWidth * 0.2;

      if (dx < -threshold && currentSlide < slideCount - 1) {
        goToSlide(currentSlide + 1);
        if (typeof Haptic !== 'undefined') Haptic.light();
      } else if (dx > threshold && currentSlide > 0) {
        goToSlide(currentSlide - 1);
        if (typeof Haptic !== 'undefined') Haptic.light();
      } else {
        goToSlide(currentSlide); // Snap back
      }
    } else {
      track.classList.remove('dragging');
    }
  }, { passive: true });
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
    <div class="add-subtitle">Zaylo Lumibot or Zaylo Slide</div>
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

  // Load saved order (local first, then Firebase override)
  await CardReorder.loadOrder();

  // FAST PATH: Render from local storage immediately (no await)
  let localDevices = DeviceList.getAll();

  // Apply saved order
  localDevices = CardReorder.applyOrder(localDevices);

  // Show skeleton loader if no local devices found (waiting for Firebase)
  // This prevents flash of "No devices" empty state on first load
  if (localDevices.length === 0) {
    if (!list.querySelector('.error-card')) {
      renderSkeletonLoader(list);
    }
  } else {
    renderDeviceList(localDevices, list, emptyState, countEl);
  }

  // BACKGROUND: Sync with Firebase (Real-time)
  setupFirebaseSubscription(list, emptyState, countEl);

  // Mark initial render as complete IMMEDIATELY after first render
  // so future state updates don't trigger entry animations
  if (!window.Zaylo_InitialRenderComplete) {
    // Use rAF to set after the first paint frame
    requestAnimationFrame(() => {
      window.Zaylo_InitialRenderComplete = true;
    });
  }
}

// ============================================
// No Connection Exception Card
// ============================================
function renderNoConnectionCard(list) {
  list.innerHTML = '';
  const style = document.createElement('style');
  style.textContent = '.device-card { touch-action: none !important; }';
  document.head.appendChild(style);

  const card = document.createElement('div');
  card.className = 'device-card error-card';
  card.style.animationDelay = '0s';
  card.style.pointerEvents = 'none'; // Prevent interaction
  card.innerHTML = `
    <div class="device-header" style="justify-content: center; text-align: center; flex-direction: column; gap: 16px; padding: 20px 0;">
        <div class="device-icon" style="background: rgba(239, 68, 68, 0.1); border: 2px solid rgba(239, 68, 68, 0.2); width: 64px; height: 64px; font-size: 32px; margin: 0 auto; box-shadow: 0 4px 20px rgba(239,68,68,0.15);">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.3;"><path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/></svg>
            <div class="status-dot" style="background: var(--danger); box-shadow: 0 0 10px rgba(239,68,68,0.5);"></div>
        </div>
        <div class="device-details" style="width: 100%;">
            <div class="device-name" style="font-size: 18px; color: var(--danger);">No MQTT Connection</div>
            <div class="device-status" style="white-space: normal; margin-top: 8px;">Network or broker error. Retrying...</div>
        </div>
    </div>
  `;
  list.appendChild(card);
}

// Skeleton Loader - Premium shimmer effect
function renderSkeletonLoader(list) {
  list.innerHTML = '';
  // touch-action override for reliable drag handling
  const style = document.createElement('style');
  style.textContent = '.device-card { touch-action: none !important; }';
  document.head.appendChild(style);
  for (let i = 0; i < 2; i++) {
    const skeleton = document.createElement('div');
    skeleton.className = 'device-card';
    skeleton.style.animationDelay = `${i * 0.08}s`;
    skeleton.style.pointerEvents = 'none';
    skeleton.innerHTML = `
      <div class="device-header">
        <div class="device-info">
          <div class="device-icon" style="background: linear-gradient(135deg, var(--bg-glass-strong) 0%, var(--bg-tertiary) 100%); border: none; animation: shimmer 2s ease-in-out infinite; background-size: 200% 100%;"></div>
          <div class="device-details">
            <div style="width: 110px; height: 16px; background: linear-gradient(90deg, var(--bg-glass-strong) 25%, rgba(255,255,255,0.06) 50%, var(--bg-glass-strong) 75%); background-size: 200% 100%; animation: shimmer 1.8s linear infinite; border-radius: 6px; margin-bottom: 8px;"></div>
            <div style="width: 70px; height: 12px; background: linear-gradient(90deg, var(--bg-glass-strong) 25%, rgba(255,255,255,0.06) 50%, var(--bg-glass-strong) 75%); background-size: 200% 100%; animation: shimmer 1.8s linear infinite 0.1s; border-radius: 5px;"></div>
          </div>
        </div>
        <div style="width: 48px; height: 48px; border-radius: 50%; background: linear-gradient(135deg, var(--bg-glass-strong) 0%, var(--bg-tertiary) 100%); animation: shimmer 2s ease-in-out infinite 0.2s; background-size: 200% 100%;"></div>
      </div>
      <div class="mode-row">
        ${[0, 1, 2, 3].map(j => `
        <div style="height: 56px; background: linear-gradient(90deg, var(--bg-glass-strong) 25%, rgba(255,255,255,0.04) 50%, var(--bg-glass-strong) 75%); background-size: 200% 100%; animation: shimmer 1.8s linear infinite ${j * 0.08}s; border-radius: 12px;"></div>
        `).join('')}
      </div>
      <div style="height: 48px; background: linear-gradient(90deg, var(--bg-glass-strong) 25%, rgba(255,255,255,0.04) 50%, var(--bg-glass-strong) 75%); background-size: 200% 100%; animation: shimmer 1.8s linear infinite 0.3s; border-radius: 12px;"></div>
    `;
    list.appendChild(skeleton);
  }

  const addCard = createAddDeviceCard();
  addCard.style.animationDelay = `${2 * 0.08}s`;
  list.appendChild(addCard);
}

// Queued update buffer: if a render is requested during an active drag,
// store it here and replay it once the drag finishes.
let _pendingRenderUpdate = null;

// Helper function to render device list without blocking - Smart Updates
function renderDeviceList(devices, list, emptyState, countEl) {
  // GUARD: Don't re-render during an active drag â€” queue it for later
  if (typeof CardReorder !== 'undefined' && CardReorder.state !== 'IDLE') {
    _pendingRenderUpdate = { devices, list, emptyState, countEl };
    return;
  }
  // Always hide empty state - we always show add card now
  if (emptyState) emptyState.classList.add('hidden');

  // Remove any skeleton loader cards and synthetic widgets before rendering real devices
  list.querySelectorAll('.device-card:not([data-device-id])').forEach(card => card.remove());

  // Map existing cards by ID for quick lookup
  const existingCards = new Map();
  list.querySelectorAll('.device-card[data-device-id]').forEach(card => {
    // CRITICAL: Normalize ID (string + trim) to match device data exactly
    const navId = String(card.dataset.deviceId).trim();
    if (navId) existingCards.set(navId, card);
  });

  // Preserve the Add Card if it exists, or create it later
  let addCard = list.querySelector('.add-card');
  if (addCard) {
    // Detach it temporarily so we can append it at the end
    addCard.remove();
  } else {
    addCard = createAddDeviceCard();
  }

  const widgetItems = buildHomeWidgetItems(devices);

  // Iterate through the new list of widgets/devices
  // NOTE: MQTT subscriptions are handled centrally in initMQTT() onConnect handler
  widgetItems.forEach((item, index) => {
    if (item.kind === 'allBlinds') {
      list.appendChild(createAllBlindsCompactCard(item.devices, index));
      return;
    }

    const device = item.device;
    const deviceIdStr = String(device.id).trim();

    let card = existingCards.get(deviceIdStr);
    const state = (typeof MQTTClient !== 'undefined' && MQTTClient.getDeviceState)
      ? MQTTClient.getDeviceState(device.id)
      : null;

    if (card) {
      // CASE 1: UPDATE EXISTING â€” no re-animation, just update data
      existingCards.delete(deviceIdStr); // Mark as processed

      // Check if device type changed â€” if so, rebuild the card entirely
      const deviceType = device.type || 'lumibot';
      const cardIsBlind = card.classList.contains('blind-card');
      const shouldBeBlind = deviceType === 'blind' || deviceType === 'stepper';

      if (cardIsBlind !== shouldBeBlind) {
        // Type mismatch â€” remove old card and create the correct one
        card.remove();
        card = shouldBeBlind
          ? createBlindDeviceCard(device, state, index)
          : createDeviceCard(device, state, index);
        list.appendChild(card);
      } else {
        // Same type â€” update in place
        const defaultName = shouldBeBlind ? 'Blinds-' : 'Zaylo-';
        const nameEl = card.querySelector('.device-name');
        const newName = device.name || defaultName + device.id;
        if (nameEl && nameEl.textContent !== newName) {
          nameEl.textContent = newName;
        }

        // Call correct update function based on type
        if (shouldBeBlind) {
          updateBlindDeviceCard(device.id, state);
        } else {
          updateDeviceCard(device.id, state);
        }

        // Re-append to ensure correct order (move in DOM)
        list.appendChild(card);
      }

    } else {
      // CASE 2: CREATE NEW â€” only new cards get the slide-in animation
      const deviceType = device.type || 'lumibot';
      const shouldBeBlind = deviceType === 'blind' || deviceType === 'stepper';
      card = shouldBeBlind
        ? createBlindDeviceCard(device, state, index)
        : createDeviceCard(device, state, index);
      list.appendChild(card);

      // Staggered entry animation ONLY for genuinely new cards
      const staggerDelay = Math.min(index, 5) * 0.08;
      card.style.animationDelay = `${staggerDelay}s`;
      card.classList.add('card-enter');
    }
  });

  // CASE 3: REMOVE DELETED
  // Any cards still in the map were not in the new list
  existingCards.forEach((card, id) => {
    card.remove();
    // Cleanup MQTT subscription
    if (MQTTClient && typeof MQTTClient.unsubscribeDevice === 'function') {
      MQTTClient.unsubscribeDevice(id);
    }
  });

  // Always add the "Add Device" card at the end
  // Don't re-apply animation on re-renders
  if (!addCard._rendered) {
    addCard.style.animationDelay = `${Math.min(devices.length, 6) * 0.08}s`;
    addCard._rendered = true;
  }
  list.appendChild(addCard);

  if (countEl) {
    countEl.textContent = `${devices.length} device${devices.length !== 1 ? 's' : ''}`;
  }

  updateBlindGroupControl(devices);

  // Initial ambient background check
  updateAmbientBackground();
}


// Background Firebase sync - runs after initial render
// CRITICAL: Firebase is the SOURCE OF TRUTH for device list
// Background Firebase sync - Real-time listener
// CRITICAL: Firebase is the SOURCE OF TRUTH for device list
let deviceSubscription = null;

async function setupFirebaseSubscription(list, emptyState, countEl) {
  try {
    await Auth.waitForAuthReady();
    const user = Auth.getUser();
    const homeId = window.activeHomeId;
    if (!user || !homeId) {
      console.debug('[Index] Not authenticated or no home, keeping local devices');
      // Don't wipe local devices â€” render whatever is saved locally
      const localDevices = DeviceList.getAll();
      if (localDevices.length > 0) {
        renderDeviceList(localDevices, list, emptyState, countEl);
      }
      return;
    }

    if (deviceSubscription) deviceSubscription(); // Unsubscribe existing

    console.debug('[Index] Setting up Firebase real-time listener for home:', homeId);
    await DeviceService.init();

    deviceSubscription = await DeviceService.subscribeToDevices(homeId, (rawDevices) => {
      // console.log('[Index] Received update from Firebase:', rawDevices.length, 'devices');

      // Clean IDs
      const firebaseDevices = rawDevices.map(d => {
        const cleanId = d.id.toString().replace(/[^A-Fa-f0-9]/g, '').toUpperCase();
        d.id = cleanId;
        return d;
      }).filter(d => /^[A-F0-9]+$/.test(d.id));

      // MERGE: Preserve recently-added local devices that haven't synced to Firebase yet
      const localDevices = DeviceList.getAll();
      const firebaseIds = new Set(firebaseDevices.map(d => d.id));
      const GRACE_PERIOD_MS = 5 * 60 * 1000; // 5 minutes
      const now = Date.now();

      // Find local-only devices added recently (likely from setup wizard)
      // Exclude devices currently being deleted to prevent flash-back
      const recentLocalOnly = localDevices.filter(d => {
        if (firebaseIds.has(d.id)) return false; // Already in Firebase
        if (_pendingDeletions.has(d.id)) return false; // Being deleted right now
        const addedAt = d.addedAt || 0;
        return (now - addedAt) < GRACE_PERIOD_MS;
      });

      if (recentLocalOnly.length > 0) {
        console.log(`[Index] Preserving ${recentLocalOnly.length} recently-added local device(s):`,
          recentLocalOnly.map(d => d.id).join(', '));
      }

      // Merged list = Firebase devices + recent local-only devices
      const mergedDevices = [...firebaseDevices, ...recentLocalOnly];

      // Basic diff check to avoid unnecessary re-renders
      // We include Name in the comparison to ensure Rename triggers re-render
      const localJSON = JSON.stringify(localDevices.map(d => ({
        id: d.id,
        name: d.name,
        type: d.type || 'lumibot'
      })).sort((a, b) => a.id.localeCompare(b.id)));

      const mergedJSON = JSON.stringify(mergedDevices.map(d => ({
        id: d.id,
        name: d.name,
        type: d.type || 'lumibot'
      })).sort((a, b) => a.id.localeCompare(b.id)));

      const hasSkeletons = list.querySelector('.device-card:not([data-device-id]):not([data-widget-id]):not(.error-card)') !== null;

      if (localJSON !== mergedJSON || localDevices.length !== mergedDevices.length || hasSkeletons) {
        // console.log('[Index] Device list/names changed, updating UI');

        // SAFETY: If Firebase returns 0 devices but local has devices,
        // skip the wipe â€” this likely means migration hasn't completed or rules blocked the read
        if (mergedDevices.length === 0 && localDevices.length > 0) {
          console.warn('[Index] âš ï¸ Firebase returned 0 devices but local has', localDevices.length, 'â€” keeping local (migration may be pending)');
          return;
        }

        // Update Local Storage with merged list (Firebase + recent local)
        // CRITICAL: Use DeviceList.STORAGE_KEY (scoped to homeId), NOT hardcoded 'zaylo-devices'
        Storage.set(DeviceList.STORAGE_KEY, mergedDevices);

        // Apply saved order before rendering
        const orderedDevices = CardReorder.applyOrder(mergedDevices);
        renderDeviceList(orderedDevices, list, emptyState, countEl);
      } else {
        console.debug('[Index] Data identical, skipping re-render');
      }
    });

  } catch (error) {
    console.error('[Index] Firebase subscription error:', error);
  }
}

// ============================================
// Update Device Card
// ============================================
function updateDeviceCard(deviceId, state) {
  const card = document.getElementById(`device-${deviceId}`);
  if (!card) return;

  // Handle three states: true (online), false (offline), undefined (unknown/connecting)
  const onlineStatus = state?._online;
  const isOnline = onlineStatus === true;
  const isConnecting = onlineStatus === undefined;
  const lightOn = state?.light ?? false;
  const mode = state?.mode ?? 0;

  // Status text: show Connecting... during initial load, then Online/Offline
  const statusText = isConnecting ? 'Connecting...' : (isOnline ? 'Online' : 'Offline');

  card.classList.toggle('online', isOnline);
  card.classList.toggle('compact-active', lightOn);

  const icon = card.querySelector('.device-icon');
  if (icon) icon.classList.toggle('on', lightOn);

  const dot = card.querySelector('.status-dot');
  if (dot) {
    dot.classList.remove('online', 'connecting');
    if (isOnline) dot.classList.add('online');
    else if (isConnecting) dot.classList.add('connecting');
  }

  const status = card.querySelector('.device-status');
  if (status) status.textContent = `${statusText} â€¢ ${lightOn ? 'On' : 'Off'}`;

  const powerBtn = card.querySelector('[data-action="power"]');
  if (powerBtn) powerBtn.classList.toggle('active', lightOn);

  const compactChip = card.querySelector('.compact-action-chip');
  if (compactChip) compactChip.textContent = lightOn ? 'Turn off' : 'Turn on';
  const compactStat = card.querySelector('.compact-mini-stat');
  if (compactStat) compactStat.textContent = isOnline ? 'Ready' : statusText;

  card.querySelectorAll('[data-mode]').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.mode, 10) === mode);
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

  // Update ambient background based on overall active devices
  updateAmbientBackground();
}

// ============================================
// Ambient Background System
// ============================================
function updateAmbientBackground() {
  if (typeof MQTTClient === 'undefined') return;
  const devices = DeviceList.getAll();
  let anyOn = false;

  devices.forEach(device => {
    const state = MQTTClient.getDeviceState(device.id);
    if (state && state.light) {
      anyOn = true;
    }
  });

  const app = document.querySelector('.app');
  if (app) {
    app.classList.toggle('has-active-devices', anyOn);
  }
}

function handleCompactDeviceTap(card, deviceId) {
  const type = card.dataset.deviceType;
  const isBlindOrStepper = type === 'blind' || type === 'stepper';

  if (isBlindOrStepper) {
    const currentPos = _getBlindPositionForDevice({ id: deviceId }) ?? 0;
    const pos = currentPos > 0 ? 0 : 100;
    if (typeof Haptic !== 'undefined') Haptic.selection();

    _blindTargetLock.set(deviceId, { target: pos, timestamp: Date.now() });
    _applyBlindDashboardPosition(deviceId, pos, (typeof MQTTClient !== 'undefined' && MQTTClient.connected) ? _posText(pos) : 'Pending sync');
    _persistBlindDashboardState(deviceId, pos);

    if (typeof MQTTClient !== 'undefined') {
      if (type === 'stepper' || type === 'blind') {
        MQTTClient.publishStepperControl(deviceId, { blindPosition: pos });
      } else {
        MQTTClient.publishControl(deviceId, { blindPosition: pos, blindOpen: pos > 0 });
      }
      if (!MQTTClient.connected && typeof Toast !== 'undefined' && Toast.info) {
        Toast.info('Offline - change queued');
      }
    }

    updateBlindGroupControl();
    return;
  }

  if (typeof MQTTClient === 'undefined') return;
  if (!MQTTClient.connected) {
    Toast.error('Not connected. Reconnecting...');
    Haptic.error();
    MQTTClient.connect();
    return;
  }

  const currentState = MQTTClient.getDeviceState(deviceId);
  const newState = !(currentState?.light ?? false);
  MQTTClient.publishControl(deviceId, { light: newState });
  if (typeof Haptic !== 'undefined') Haptic.medium();

  card.classList.toggle('compact-active', newState);
  const icon = card.querySelector('.device-icon');
  if (icon) icon.classList.toggle('on', newState);
  const status = card.querySelector('.device-status');
  if (status) status.textContent = `Online â€¢ ${newState ? 'On' : 'Off'}`;
  const chip = card.querySelector('.compact-action-chip');
  if (chip) chip.textContent = newState ? 'Turn off' : 'Turn on';
  const powerBtn = card.querySelector('[data-action="power"]');
  if (powerBtn) powerBtn.classList.toggle('active', newState);
  updateAmbientBackground();
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

    if (typeof WidgetLayout !== 'undefined' && WidgetLayout.isCompact()) {
      if (WidgetLayout.shouldSuppressCompactClick()) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      if (WidgetLayout.isCompactReorderMode()) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      if (card.dataset.widgetId === HOME_WIDGET_ALL_BLINDS_ID) {
        e.preventDefault();
        const summary = getAllBlindsSummary();
        setBlindGroupPosition(summary.isOpen ? 0 : 100);
        updateAllBlindsCompactCard();
        return;
      }
    }

    const deviceId = (card.dataset.deviceId || '').trim();
    if (!deviceId) return;

    if (typeof WidgetLayout !== 'undefined' && WidgetLayout.isCompact()
      && !e.target.closest('[data-action="menu"], button, .toggle-mini, [data-mode], .blind-quick-btn')) {
      e.preventDefault();
      handleCompactDeviceTap(card, deviceId);
      return;
    }

    // 3-dots menu button â†’ open context menu
    if (e.target.closest('[data-action="menu"]')) {
      e.stopPropagation();
      DeviceContextMenu.show(deviceId);
      // Dismiss hold-active state and reset CardReorder
      card.classList.remove('hold-active');
      if (CardReorder.state === 'HELD') {
        CardReorder.state = 'IDLE';
        CardReorder.dragCard = null;
      }
      return;
    }

    // Navigate to device page (only if not holding or dragging)
    if (e.target.closest('[data-action="navigate"]')) {
      if (CardReorder.state === 'DRAGGING' || CardReorder.state === 'HELD' || card.classList.contains('hold-active')) return;
      const type = card.dataset.deviceType;
      const isBlindOrStepper = type === 'blind' || type === 'stepper';
      window.location.href = isBlindOrStepper
        ? `blind-device.html?id=${deviceId}`
        : `device.html?id=${deviceId}`;
      return;
    }

    // Blind quick actions
    if (e.target.closest('[data-action="blindOpen"]') ||
      e.target.closest('[data-action="blindClose"]') ||
      e.target.closest('[data-action="blindHalf"]')) {
      const action = e.target.closest('[data-action]').dataset.action;
      const pos = action === 'blindOpen' ? 100 : action === 'blindHalf' ? 50 : 0;
      Haptic.selection();

      // Lock the UI to prevent MQTT overwriting the optimistic button state
      _blindTargetLock.set(deviceId, { target: pos, timestamp: Date.now() });

      // Optimistic update
      card.querySelectorAll('.blind-quick-btn').forEach(b => b.classList.remove('active'));
      e.target.closest('.blind-quick-btn')?.classList.add('active');

      const badge = card.querySelector('.blind-position-badge');
      if (badge) {
        badge.textContent = _badgeLabel(pos);
        badge.classList.remove('open', 'closed', 'half');
        badge.classList.add(_badgeClass(pos));
      }

      const isConn = (typeof MQTTClient !== 'undefined') && MQTTClient.connected;

      const statusEl = card.querySelector('.device-status');
      if (statusEl) {
        const parts = statusEl.textContent.split('â€¢').map(s => s.trim());
        const connText = parts[0] || 'Online';
        const typeText = parts.length >= 3 ? parts[2] : 'Roller'; // Fix array bounds for undefined text
        // Be honest about timing: only claim motion ("Opening"/"Closing") when
        // actually connected; offline taps are queued, so say "Pending sync".
        const motionText = isConn ? _posText(pos) : 'Pending sync';
        statusEl.textContent = `${connText} â€¢ ${motionText} â€¢ ${typeText}`;
      }

      // Always publish. MQTTClient._publish() queues the command (deduped by
      // topic, last-write-wins) and flushes it on reconnect, so an offline tap is
      // delivered later instead of being silently dropped while the card claimed
      // it was opening/closing.
      const type = card.dataset.deviceType;
      if (type === 'stepper' || type === 'blind') {
        MQTTClient.publishStepperControl(deviceId, { blindPosition: pos });
      } else {
        MQTTClient.publishControl(deviceId, { blindPosition: pos, blindOpen: pos > 0 });
      }
      if (!isConn && typeof Toast !== 'undefined' && Toast.info) {
        Toast.info('Offline â€” change queued, will apply when reconnected');
      }

      // Save to local blind state
      try {
        const key = `blind-state-${deviceId}`;
        const saved = JSON.parse(localStorage.getItem(key) || '{}');
        saved.position = pos;
        saved.targetPosition = pos;
        saved.isOpen = pos > 0;
        localStorage.setItem(key, JSON.stringify(saved));
      } catch (ex) { /* ignore */ }
      updateBlindGroupControl();
      return;
    }

    // Blind automation rule toggle (carousel)
    if (e.target.closest('[data-action="blindAutoRule"]')) {
      const toggle = e.target.closest('[data-action="blindAutoRule"]');
      const rule = toggle.dataset.rule;
      if (!rule) return;

      const enabled = !toggle.classList.contains('active');
      toggle.classList.toggle('active', enabled);
      if (typeof Haptic !== 'undefined') Haptic.light();

      // Update status label text
      const statusEl = card.querySelector(`.blind-auto-status-${rule}`);
      if (statusEl) statusEl.textContent = enabled ? 'Active' : 'Off';

      try {
        const key = `blind-state-${deviceId}`;
        const saved = JSON.parse(localStorage.getItem(key) || '{}');
        if (!saved.rules) saved.rules = {};
        saved.rules[rule] = enabled;
        localStorage.setItem(key, JSON.stringify(saved));

        // Always publish â€” _publish() queues it (deduped by topic) and flushes on
        // reconnect, so toggling an automation offline is delivered later instead
        // of being silently dropped after the toggle visibly flipped.
        if (typeof MQTTClient !== 'undefined') {
          MQTTClient.publishConfig(deviceId, { rules: saved.rules });
          if (!MQTTClient.connected && typeof Toast !== 'undefined' && Toast.info) {
            Toast.info('Offline â€” automation change will sync when reconnected');
          }
        }

        // Notify automation engine
        if (typeof AutomationEngine !== 'undefined' && AutomationEngine.evaluate) {
          AutomationEngine.evaluate();
        }
      } catch (ex) { /* ignore */ }
      return;
    }

    // Power toggle
    if (e.target.closest('[data-action="power"]')) {
      if (!MQTTClient.connected) {
        console.warn(`[Index] Cannot toggle power - MQTT not connected (State: ${MQTTClient.connectionState})`);
        Toast.error('Not connected. Reconnecting...');
        Haptic.error();
        MQTTClient.connect(); // Force reconnect attempt
        return;
      }

      const currentState = MQTTClient.getDeviceState(deviceId);
      const newState = !(currentState?.light ?? false);
      MQTTClient.publishControl(deviceId, { light: newState });
      Haptic.medium();

      // Optimistic update with spring animation
      const btn = card.querySelector('[data-action="power"]');
      if (btn) {
        btn.classList.toggle('active', newState);
        btn.style.transition = 'transform 0.1s ease-in';
        btn.style.transform = 'scale(0.82)';
        setTimeout(() => {
          btn.style.transition = 'transform 0.4s cubic-bezier(0.16, 1, 0.3, 1)';
          btn.style.transform = '';
        }, 120);
      }
      return;
    }

    // Mode buttons
    if (e.target.closest('[data-mode]')) {
      if (!MQTTClient.connected) {
        console.warn(`[Index] Cannot change mode - MQTT not connected (State: ${MQTTClient.connectionState})`);
        Toast.error('Not connected. Reconnecting...');
        Haptic.error();
        MQTTClient.connect(); // Force reconnect attempt
        return;
      }

      const btn = e.target.closest('[data-mode]');
      const mode = parseInt(btn.dataset.mode, 10);
      MQTTClient.publishControl(deviceId, { mode, lastUpdated: Math.floor(Date.now() / 1000) });
      Haptic.selection();

      // Optimistic update
      card.querySelectorAll('[data-mode]').forEach(b => {
        b.classList.toggle('active', parseInt(b.dataset.mode, 10) === mode);
      });
      return;
    }

    // Alarm toggle
    if (e.target.closest('[data-action="alarm"]')) {
      if (!MQTTClient.connected) {
        console.warn(`[Index] Cannot toggle alarm - MQTT not connected (State: ${MQTTClient.connectionState})`);
        Toast.error('Not connected. Reconnecting...');
        Haptic.error();
        MQTTClient.connect(); // Force reconnect attempt
        return;
      }

      const toggle = e.target.closest('[data-action="alarm"]');
      const enabled = !toggle.classList.contains('active');
      Haptic.light();

      // Optimistic update
      toggle.classList.toggle('active', enabled);
      console.debug(`[Index] Setting alarm for ${deviceId}: ${enabled}`);
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
                    What type of device are you adding?
                </p>
                
                <div class="modal-option-group">
                    <button class="modal-option-btn accent" id="addLumibotBtn" style="display: none;">
                        <span class="option-icon"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.9 1.2 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg></span>
                        <div>
                            <div class="option-title">Zaylo Lumibot</div>
                            <div class="option-subtitle">Smart light switch with radar</div>
                        </div>
                    </button>
                    
                    <button class="modal-option-btn teal" id="addBlindBtn">
                        <span class="option-icon"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3h18"/><path d="M20 7H8"/><path d="M20 11H8"/><path d="M10 19h10"/><path d="M8 15h12"/><path d="M4 3v14"/><circle cx="4" cy="19" r="2"/></svg></span>
                        <div>
                            <div class="option-title">Smart Blinds</div>
                            <div class="option-subtitle">Motorized blinds control</div>
                        </div>
                    </button>
                </div>
            </div>
        `,
    actions: []
  });

  modal.querySelector('#addLumibotBtn')?.addEventListener('click', () => {
    Modal.chain(() => showLumibotAddOptions());
  });

  modal.querySelector('#addBlindBtn')?.addEventListener('click', () => {
    Modal.chain(() => showBlindAddOptions());
  });
}

// Zaylo-specific add options (setup new vs add existing)
function showLumibotAddOptions() {
  const { modal, close } = Modal.create({
    title: 'Add Zaylo Lumibot',
    content: `
            <div class="modal-option-group">
                <button class="modal-option-btn accent" id="setupNewBtn">
                    <span class="option-icon"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg></span>
                    <div>
                        <div class="option-title">Setup New Device</div>
                        <div class="option-subtitle">Configure a brand new Zaylo Lumibot</div>
                    </div>
                </button>
                <button class="modal-option-btn" id="addExistingBtn">
                    <span class="option-icon"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg></span>
                    <div>
                        <div class="option-title">Add Existing Device</div>
                        <div class="option-subtitle">Enter a device ID manually</div>
                    </div>
                </button>
            </div>
        `,
    actions: []
  });

  modal.querySelector('#setupNewBtn')?.addEventListener('click', () => {
    Modal.chain(() => { window.location.href = 'setup.html'; });
  });

  modal.querySelector('#addExistingBtn')?.addEventListener('click', () => {
    Modal.chain(() => showAddExistingModal('lumibot'));
  });
}

function showBlindAddOptions() {
  const { modal, close } = Modal.create({
    title: 'Add Smart Blinds',
    content: `
            <div class="modal-option-group">
                <button class="modal-option-btn teal" id="setupNewBtn">
                    <span class="option-icon"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg></span>
                    <div>
                        <div class="option-title">Setup New Device</div>
                        <div class="option-subtitle">Configure a brand new Stepper Motor</div>
                    </div>
                </button>
                <button class="modal-option-btn" id="addExistingBtn">
                    <span class="option-icon"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg></span>
                    <div>
                        <div class="option-title">Add Existing Device</div>
                        <div class="option-subtitle">Enter a device ID manually</div>
                    </div>
                </button>
            </div>
        `,
    actions: []
  });

  modal.querySelector('#setupNewBtn')?.addEventListener('click', () => {
    Modal.chain(() => { window.location.href = 'setup.html?type=stepper'; });
  });

  modal.querySelector('#addExistingBtn')?.addEventListener('click', () => {
    Modal.chain(() => showAddExistingModal('blind'));
  });
}


function showAddExistingModal(deviceType = 'lumibot') {
  const isBlind = deviceType === 'blind';
  const typeLabel = isBlind ? 'Smart Blinds' : 'Zaylo Lumibot';
  const defaultName = isBlind ? 'Blinds' : 'Zaylo Lumibot';
  const { modal, close } = Modal.create({
    title: 'Add Existing Device',
    content: `
            <p style="color: var(--text-secondary); margin-bottom: 20px;">
                Enter the Device ID shown on your device (4-6 characters)
            </p>
            <div style="margin-bottom: 16px;">
                <input 
                    type="text" 
                    id="deviceIdInput"
                    placeholder="A1B2C3" 
                    maxlength="6"
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
                        letter-spacing: 6px;
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

          if (!/^[A-F0-9]{4,6}$/.test(id)) {
            Toast.error('Please enter a valid 4-6 character hex ID');
            return false;
          }

          // Add to local storage
          const added = DeviceList.add({
            id,
            name: name || `${defaultName}-${id}`,
            type: deviceType
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
              const homeId = window.activeHomeId;
              await DeviceService.addDevice(homeId, { id, name: name || `${defaultName}-${id}`, type: deviceType });
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
    // Removed auto-focus to prevent iOS/Android keyboard from causing page scroll jumps
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

    if (text) text.textContent = connected ? 'MQTT Connected' : 'No MQTT Connection';

    if (connected) {
      setTimeout(() => status.classList.remove('visible'), 3000);

      const list = document.getElementById('deviceList');
      if (list && list.querySelector('.error-card')) {
        renderDevices();
      }
    } else {
      const list = document.getElementById('deviceList');
      if (list && typeof DeviceList !== 'undefined' && DeviceList.getAll().length === 0) {
        renderNoConnectionCard(list);
      }
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

  // Force correct path if it got messed up by the crash cycling
  if (localStorage.getItem('zaylo-BrokerPath') === '') {
    localStorage.setItem('zaylo-BrokerPath', '/mqtt');
    console.log('[Index] ðŸ”§ Fixed corrupted WebSocket path');
  }

  // Clear previous listeners to prevent duplicates on hot-reload
  MQTTClient.clearCallbacks();

  // CRITICAL FIX: Reset reconnect state for fresh page load (same as device.js)
  // This prevents stale state from causing Code 8 disconnects
  MQTTClient.reconnectAttempts = 0;
  MQTTClient.reconnectDelay = 1000;

  // PWA SUPPORT: Initialize visibility change handler for reconnection on app resume
  MQTTClient.initVisibilityHandler();

  // ============================================
  // CRITICAL: Clean up invalid devices BEFORE connecting
  // Invalid device IDs in localStorage can cause broker rejection
  // ============================================


  MQTTClient.on('onConnect', async () => {
    updateMQTTStatus(true);
    updateBlindGroupControl();
    console.log('[Index] MQTT Connected. Starting sequential subscription...');

    const deviceList = DeviceList.getAll();

    if (deviceList.length === 0) {
      console.log('[Index] No devices to subscribe to.');
      return;
    }

    // SEQUENTIAL SUBSCRIPTION SCHEDULER
    // Strictly subscribes to one device at a time to prevent packet floods (Code 8)
    const subscribeSequentially = (devices, index = 0) => {
      if (!MQTTClient.connected) {
        console.warn('[Index] Connection lost during sequence, stopping.');
        return;
      }

      if (index >= devices.length) {
        console.log('[Index] âœ… All devices subscribed successfully.');

        // TIMEZONE FIX: After all devices are subscribed, broadcast the current
        // browser timezone to every device. This ensures ALL devices have the correct
        // local time after DST transitions, even if the user never opens individual
        // device pages. This is the primary "set and forget" timezone sync mechanism.
        setTimeout(() => {
          if (MQTTClient.connected) {
            MQTTClient.syncTimezoneToAllDevices(devices);
          }
        }, 500);
        return;
      }

      const device = devices[index];

      // CRITICAL: POISON PILL CHECK
      // If a device ID is null, empty, or contains invalid characters, subscribing to it 
      // can cause an immediate "Code 8" broker disconnect.
      const isValidId = device.id && /^[A-F0-9]+$/.test(device.id);

      if (!isValidId) {
        console.warn(`[Index] âš ï¸ SKIPPING INVALID DEVICE ID: "${device.id}" (Poison Pill)`);
        console.warn('[Index] This device ID causes Code 8 crashes. Skipping safely.');
        // Skip this device immediately
        subscribeSequentially(devices, index + 1);
        return;
      }

      console.log(`[Index] [${index + 1}/${devices.length}] Subscribing to: ${device.id}`);

      // 1. Subscribe
      MQTTClient.subscribeDevice(device.id);

      // 2. Wait 150ms then request state (reduced from 300ms â€” _activeSubscriptions guard prevents floods)
      setTimeout(() => {
        if (MQTTClient.connected) {
          MQTTClient.publishControl(device.id, { command: 'getState' });

          setTimeout(() => {
            const currentState = MQTTClient.getDeviceState(device.id);
            // Check if device has received any real state response (not just a stale LWT)
            const hasRealState = currentState && (currentState.position !== undefined || currentState.blindPosition !== undefined || currentState.light !== undefined || currentState.mode !== undefined);
            // If the device has no state yet, or it's not confirmed online
            if (!currentState || currentState._online === undefined || (!hasRealState && currentState._online === false)) {
                console.log(`[Index] Device timeout: ${device.id}. Marking as Offline.`);
                // Force a state update, but preserve existing properties if any
                const offlineState = currentState ? { ...currentState, _online: false } : { _online: false };
                MQTTClient.deviceStates.set(device.id, offlineState);
                if (typeof StateStore !== 'undefined') StateStore.update(device.id, offlineState);
                MQTTClient.callbacks.onStateUpdate.forEach(cb => { try { cb(device.id, offlineState); } catch(e){} });
            }
          }, 3000);

          // 3. Wait 200ms before processing next device (reduced from 500ms)
          setTimeout(() => {
            subscribeSequentially(devices, index + 1);
          }, 200);
        }
      }, 300);
    };

    // Start the sequence
    subscribeSequentially(deviceList);
  });

  MQTTClient.on('onDisconnect', () => {
    updateMQTTStatus(false);
    updateBlindGroupControl();
  });

  // PERFORMANCE: Batch state â†’ DOM updates via requestAnimationFrame
  // Multiple MQTT messages arriving in rapid succession are coalesced into a single frame
  const _pendingStateUpdates = new Map();
  let _stateUpdateRafId = null;

  MQTTClient.on('onStateUpdate', (deviceId, state) => {
    // Queue the update (latest state wins per device)
    _pendingStateUpdates.set(deviceId, state);

    // Schedule a single RAF to flush all pending updates
    if (!_stateUpdateRafId) {
      _stateUpdateRafId = requestAnimationFrame(() => {
        _pendingStateUpdates.forEach((pendingState, pendingId) => {
          const card = document.getElementById(`device-${pendingId}`);
          if (card && card.classList.contains('blind-card')) {
            updateBlindDeviceCard(pendingId, pendingState);
          } else {
            updateDeviceCard(pendingId, pendingState);
          }

          // PERSIST: Save state to cache so device page loads instantly
          const stateToCache = {
            light: pendingState.light,
            mode: pendingState.mode,
            _online: pendingState._online,
            isSleeping: pendingState.isSleeping,
            config: pendingState.config
          };
          DeviceList.update(pendingId, { state: stateToCache });
        });
        updateBlindGroupControl();
        _pendingStateUpdates.clear();
        _stateUpdateRafId = null;
      });
    }
  });

  // Start connection
  try {
    await MQTTClient.connect();
  } catch (err) {
    console.error('[Index] Initial MQTT connection failed:', err);
    updateMQTTStatus(false);
  }
}

// ============================================
// Home Invite Helpers
// ============================================
const HOME_INVITE_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{6}$/;

function normalizeHomeInviteCode(value) {
  const raw = (value || '').toString().trim();
  if (!raw) return '';

  const compact = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (HOME_INVITE_CODE_PATTERN.test(compact)) return compact;

  try {
    const payload = JSON.parse(raw);
    if (payload && typeof payload === 'object') {
      return normalizeHomeInviteCode(
        payload.code || payload.shareCode || payload.inviteCode || payload.joinHome
      );
    }
  } catch (e) {
    // Not JSON; continue with URL and text parsing.
  }

  try {
    const url = new URL(raw, window.location.origin);
    const code = url.searchParams.get('joinHome') ||
      url.searchParams.get('shareCode') ||
      url.searchParams.get('code');
    if (code) return normalizeHomeInviteCode(code);
  } catch (e) {
    // Not a URL; continue with plain text parsing.
  }

  const match = raw.toUpperCase().match(/[A-HJ-NP-Z2-9]{6}/);
  return match ? match[0] : '';
}

function buildHomeInviteQrPayload(code) {
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('joinHome', code);
    url.hash = '';
    return url.toString();
  } catch (e) {
    return `zaylo://join-home?code=${encodeURIComponent(code)}`;
  }
}

function renderHomeInviteQr(container, payload, code) {
  if (!container) return false;
  container.innerHTML = '';

  if (typeof qrcode !== 'function') {
    container.innerHTML = '<div class="home-qr-error">QR generator unavailable. Use the code above.</div>';
    return false;
  }

  try {
    const qr = qrcode(0, 'M');
    qr.addData(payload);
    qr.make();

    const frame = document.createElement('div');
    frame.className = 'home-qr-frame';
    frame.innerHTML = qr.createSvgTag({
      cellSize: 5,
      margin: 12,
      scalable: true,
      title: `Join home with code ${code}`,
      alt: 'Scan this QR code to join this home'
    });

    const svg = frame.querySelector('svg');
    if (svg) {
      svg.classList.add('home-qr-code');
      svg.setAttribute('focusable', 'false');
    }

    container.appendChild(frame);
    return true;
  } catch (error) {
    console.warn('[HomeSettings] QR code generation failed:', error);
    container.innerHTML = '<div class="home-qr-error">QR generation failed. Use the code above.</div>';
    return false;
  }
}

function setHomeQrScannerStatus(modal, message, type = 'info') {
  const status = modal?.querySelector('#qrScannerStatus');
  if (!status) return;
  status.textContent = message;
  status.dataset.type = type;
}

function setHomeQrScannerPanel(modal, visible) {
  const panel = modal?.querySelector('#qrScannerPanel');
  const btn = modal?.querySelector('#scanHomeQrBtn');
  if (panel) panel.hidden = !visible;
  if (btn) {
    btn.classList.toggle('active', visible);
    btn.setAttribute('aria-expanded', visible ? 'true' : 'false');
    btn.innerHTML = visible
      ? '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" x2="6" y1="6" y2="18"/><line x1="6" x2="18" y1="6" y2="18"/></svg><span>Stop Scan</span>'
      : '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V5a1 1 0 0 1 1-1h2"/><path d="M17 4h2a1 1 0 0 1 1 1v2"/><path d="M20 17v2a1 1 0 0 1-1 1h-2"/><path d="M7 20H5a1 1 0 0 1-1-1v-2"/><path d="M7 7h.01"/><path d="M11 7h2"/><path d="M17 7h.01"/><path d="M7 11h.01"/><path d="M11 11h.01"/><path d="M15 11h2"/><path d="M7 15h2"/><path d="M13 15h.01"/><path d="M17 15h.01"/></svg><span>Scan QR</span>';
  }
}

async function startHomeInviteQrScanner(modal, onCode) {
  const video = modal.querySelector('#qrScannerVideo');
  if (!video) throw new Error('Scanner video element missing');

  if (!window.isSecureContext && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
    throw new Error('Camera scanning requires HTTPS.');
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Camera access is not available in this browser.');
  }

  if (typeof BarcodeDetector === 'undefined') {
    throw new Error('QR scanning is not supported by this browser.');
  }

  if (typeof BarcodeDetector.getSupportedFormats === 'function') {
    const formats = await BarcodeDetector.getSupportedFormats();
    if (Array.isArray(formats) && formats.length > 0 && !formats.includes('qr_code')) {
      throw new Error('QR scanning is not supported by this browser.');
    }
  }

  const detector = new BarcodeDetector({ formats: ['qr_code'] });
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1280 },
      height: { ideal: 720 }
    }
  });

  let stopped = false;
  let scanTimer = null;

  const stop = () => {
    stopped = true;
    if (scanTimer) clearTimeout(scanTimer);
    stream.getTracks().forEach(track => track.stop());
    video.pause();
    video.srcObject = null;
  };

  video.srcObject = stream;
  video.setAttribute('playsinline', '');
  video.muted = true;
  await video.play();

  const scan = async () => {
    if (stopped) return;

    try {
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        const results = await detector.detect(video);
        const code = normalizeHomeInviteCode(results?.[0]?.rawValue || '');
        if (code) {
          stop();
          onCode(code);
          return;
        }
      }
      setHomeQrScannerStatus(modal, 'Align the QR code inside the frame.');
    } catch (error) {
      console.warn('[HomeSettings] QR scan tick failed:', error);
    }

    scanTimer = setTimeout(scan, 250);
  };

  scan();
  return stop;
}

async function redeemHomeInviteCode(code, user, options = {}) {
  const cleanCode = normalizeHomeInviteCode(code);
  const { button = null, close = null } = options;

  if (!cleanCode) {
    Toast.warning('Please enter a valid share code');
    return false;
  }

  if (!user?.uid) {
    Toast.error('Please sign in first');
    return false;
  }

  const previousContent = button ? button.innerHTML : '';
  if (button) {
    button.textContent = '...';
    button.disabled = true;
  }

  try {
    const result = await HomeService.redeemShareCode(cleanCode, user.uid);
    if (result.success) {
      Toast.success(`Joined "${result.homeName}"!`);
      if (typeof close === 'function') close();
      await HomeService.setActiveHome(user.uid, result.homeId);
      setTimeout(() => location.reload(), 500);
      return true;
    }

    Toast.error(result.error || 'Failed to join home');
    return false;
  } finally {
    if (button) {
      button.innerHTML = previousContent || 'Join';
      button.disabled = false;
    }
  }
}

async function processHomeInviteFromUrl() {
  const url = new URL(window.location.href);
  const code = normalizeHomeInviteCode(
    url.searchParams.get('joinHome') ||
    url.searchParams.get('shareCode') ||
    url.searchParams.get('code')
  );

  if (!code) return;

  url.searchParams.delete('joinHome');
  url.searchParams.delete('shareCode');
  url.searchParams.delete('code');
  history.replaceState(history.state, '', url.toString());

  const user = Auth.getUser();
  if (!user) {
    Toast.info('Sign in to join this home.');
    return;
  }

  Modal.confirm('Join Home', `Join the home shared with code ${code}?`, async () => {
    await redeemHomeInviteCode(code, user);
  });
}

// ============================================
// Home Settings Modal
// ============================================
async function showHomeSettingsModal() {
  if (typeof HomeService === 'undefined') {
    Toast.error('Home service not available');
    return;
  }

  const user = Auth.getUser();
  if (!user) {
    Toast.error('Please sign in first');
    return;
  }

  const homeId = window.activeHomeId;
  if (!homeId) {
    Toast.error('No active home');
    return;
  }

  // Fetch data in parallel
  const [homeDetails, members, homes, userRole] = await Promise.all([
    HomeService.getHomeDetails(homeId),
    HomeService.getMembers(homeId),
    HomeService.getHomes(user.uid),
    HomeService.getUserRole(homeId, user.uid)
  ]);

  const isOwner = userRole === 'owner';
  const homeName = homeDetails?.name || 'My Home';
  const safeHomeName = Utils.escapeHtml(homeName);

  // Build member list HTML
  const memberListHtml = members.map(m => {
    const isMe = m.userId === user.uid;
    const roleClass = m.role === 'owner' ? 'role-owner' : 'role-member';
    const roleBadge = m.role === 'owner' ? 'Owner' : 'Member';
    const removeBtn = (isOwner && !isMe) ? `<button class="home-member-remove" data-member-id="${m.userId}" title="Remove">&times;</button>` : '';
    const memberName = m.displayName || 'User';
    const safeMemberName = Utils.escapeHtml(memberName);
    return `
      <div class="home-member-item">
        <div class="home-member-avatar">${Utils.escapeHtml((memberName || 'U').charAt(0).toUpperCase())}</div>
        <div class="home-member-info">
          <div class="home-member-name">${safeMemberName}${isMe ? ' (You)' : ''}</div>
          <span class="home-role-badge ${roleClass}">${roleBadge}</span>
        </div>
        ${removeBtn}
      </div>
    `;
  }).join('');

  // Build home switcher HTML (only if multiple homes)
  let homeSwitcherHtml = '';
  if (homes.length > 1) {
    const homeOptions = homes.map(h => `
      <div class="home-switch-item ${h.id === homeId ? 'active' : ''}" data-home-id="${h.id}">
        <span class="home-switch-icon">${h.id === homeId ? 'ðŸ ' : 'ðŸ¡'}</span>
        <span class="home-switch-name">${Utils.escapeHtml(h.name || 'Home')}</span>
        ${h.id === homeId ? '<span class="home-switch-active">Active</span>' : ''}
      </div>
    `).join('');
    homeSwitcherHtml = `
      <div class="home-section">
        <h4 class="home-section-title">Switch Home</h4>
        <div class="home-switch-list">${homeOptions}</div>
      </div>
    `;
  }

  const content = `
    <div class="home-settings-content">
      <div class="home-section">
        <h4 class="home-section-title">Home Name</h4>
        <div class="home-name-row">
          <span id="homeNameDisplay" class="home-name-text">${safeHomeName}</span>
          ${isOwner ? '<button class="btn btn-secondary home-name-edit" id="homeRenameBtn">Edit</button>' : ''}
        </div>
      </div>

      <div class="home-section">
        <h4 class="home-section-title">Members (${members.length})</h4>
        <div class="home-member-list" id="homeMemberList">
          ${memberListHtml}
        </div>
      </div>

      ${homeSwitcherHtml}

      <div class="home-section">
        <h4 class="home-section-title">Invite Family</h4>
        ${isOwner ? `
          <button class="btn btn-primary home-share-btn" id="homeShareBtn" style="width:100%;">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:8px;"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" x2="12" y1="2" y2="15"/></svg>
            Generate Share Code
          </button>
          <div id="shareCodeContainer" style="display:none; margin-top:16px;"></div>
        ` : '<p style="color:var(--text-tertiary); font-size:13px;">Only the home owner can generate share codes.</p>'}
      </div>

      <div class="home-section">
        <h4 class="home-section-title">Join Another Home</h4>
        <div class="home-join-row">
          <input type="text" id="joinCodeInput" class="modal-input home-join-input" placeholder="Enter share code" maxlength="6" autocomplete="off" inputmode="text">
          <button class="btn btn-primary" id="joinHomeBtn">Join</button>
        </div>
        <button class="btn btn-secondary home-scan-btn" id="scanHomeQrBtn" type="button" aria-expanded="false" aria-controls="qrScannerPanel">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V5a1 1 0 0 1 1-1h2"/><path d="M17 4h2a1 1 0 0 1 1 1v2"/><path d="M20 17v2a1 1 0 0 1-1 1h-2"/><path d="M7 20H5a1 1 0 0 1-1-1v-2"/><path d="M7 7h.01"/><path d="M11 7h2"/><path d="M17 7h.01"/><path d="M7 11h.01"/><path d="M11 11h.01"/><path d="M15 11h2"/><path d="M7 15h2"/><path d="M13 15h.01"/><path d="M17 15h.01"/></svg>
          <span>Scan QR</span>
        </button>
        <div class="home-qr-scanner-panel" id="qrScannerPanel" hidden>
          <div class="home-qr-video-wrap">
            <video id="qrScannerVideo" class="home-qr-video" muted playsinline></video>
            <div class="home-qr-target" aria-hidden="true"></div>
          </div>
          <div class="home-qr-scanner-status" id="qrScannerStatus" data-type="info">Camera ready.</div>
        </div>
      </div>

      <div class="home-section" style="margin-top:24px; padding-top:16px; border-top:1px solid var(--border-glass);">
        ${isOwner ?
          `<button class="btn btn-secondary home-danger-btn" id="deleteHomeBtn" style="width:100%; color:var(--danger);">Delete Home</button>` :
          `<button class="btn btn-secondary home-danger-btn" id="leaveHomeBtn" style="width:100%; color:var(--danger);">Leave Home</button>`
        }
      </div>
    </div>
  `;

  const { modal, close } = Modal.create({
    title: 'ðŸ  Home Settings',
    content: content,
    actions: [],
    onClose: () => {
      if (stopQrScanner) {
        stopQrScanner();
        stopQrScanner = null;
      }
    }
  });

  // --- Event Handlers ---
  let stopQrScanner = null;

  const stopScannerUi = (hidePanel = true) => {
    if (stopQrScanner) {
      stopQrScanner();
      stopQrScanner = null;
    }
    if (hidePanel) {
      setHomeQrScannerPanel(modal, false);
    }
  };

  // Rename home
  modal.querySelector('#homeRenameBtn')?.addEventListener('click', () => {
    Haptic.light();
    Modal.input({
      title: 'Rename Home',
      placeholder: 'Enter new name',
      value: homeName,
      onSubmit: async (newName) => {
        const clean = newName.replace(/[^a-zA-Z0-9\s\-_']/g, '').trim();
        if (clean) {
          const success = await HomeService.renameHome(homeId, clean, user.uid);
          if (success) {
            Toast.success('Home renamed');
            const display = document.getElementById('homeNameDisplay');
            if (display) display.textContent = clean;
          } else {
            Toast.error('Failed to rename');
          }
        }
      }
    });
  });

  // Remove member (owner action)
  modal.querySelectorAll('.home-member-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      Haptic.medium();
      const memberId = btn.dataset.memberId;
      const memberName = btn.closest('.home-member-item')?.querySelector('.home-member-name')?.textContent || 'this member';
      Modal.confirm('Remove Member', `Remove ${memberName} from this home?`, async () => {
        const success = await HomeService.removeMember(homeId, memberId, user.uid);
        if (success) {
          Toast.success('Member removed');
          btn.closest('.home-member-item')?.remove();
        } else {
          Toast.error('Failed to remove member');
        }
      });
    });
  });

  // Switch home
  modal.querySelectorAll('.home-switch-item:not(.active)').forEach(item => {
    item.addEventListener('click', async () => {
      Haptic.medium();
      const newHomeId = item.dataset.homeId;
      await HomeService.setActiveHome(user.uid, newHomeId);
      DeviceList.setHome(newHomeId);
      Toast.success('Switching home...');
      close();
      setTimeout(() => location.reload(), 500);
    });
  });

  // Generate share code
  modal.querySelector('#homeShareBtn')?.addEventListener('click', async () => {
    Haptic.medium();
    const btn = modal.querySelector('#homeShareBtn');
    btn.innerHTML = 'Generating...';
    btn.disabled = true;

    const result = await HomeService.generateShareCode(homeId, user.uid);
    if (result) {
      const expiresIn = Math.round((result.expiresAt - Date.now()) / (1000 * 60 * 60));
      const invitePayload = buildHomeInviteQrPayload(result.code);
      const container = modal.querySelector('#shareCodeContainer');
      container.style.display = 'block';
      container.innerHTML = `
        <div class="share-code-display glass-card">
          <div class="share-code-label">Share Code</div>
          <div class="share-code-value" id="shareCodeValue">${result.code}</div>
          <div class="share-code-expiry">Expires in ${expiresIn}h â€¢ Max 10 uses</div>
          <div id="qrCodeCanvas" class="home-qr-container" aria-live="polite"></div>
          <button class="btn btn-secondary share-code-copy" id="copyCodeBtn">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
            Copy Code
          </button>
        </div>
      `;
      renderHomeInviteQr(container.querySelector('#qrCodeCanvas'), invitePayload, result.code);

      // Copy button
      container.querySelector('#copyCodeBtn')?.addEventListener('click', async () => {
        Haptic.light();
        try {
          await navigator.clipboard.writeText(result.code);
          Toast.success('Code copied!');
        } catch {
          // Fallback
          const textarea = document.createElement('textarea');
          textarea.value = result.code;
          document.body.appendChild(textarea);
          textarea.select();
          document.execCommand('copy');
          textarea.remove();
          Toast.success('Code copied!');
        }
      });

      btn.innerHTML = 'Code Generated';
    } else {
      Toast.error('Failed to generate code');
      btn.innerHTML = 'Generate Share Code';
      btn.disabled = false;
    }
  });

  // Join home
  modal.querySelector('#joinHomeBtn')?.addEventListener('click', async () => {
    Haptic.medium();
    const code = modal.querySelector('#joinCodeInput')?.value?.trim();
    const joinBtn = modal.querySelector('#joinHomeBtn');
    await redeemHomeInviteCode(code, user, { button: joinBtn, close });
  });

  // Scan home invite QR
  modal.querySelector('#scanHomeQrBtn')?.addEventListener('click', async () => {
    Haptic.light();

    if (stopQrScanner) {
      stopScannerUi(true);
      return;
    }

    setHomeQrScannerPanel(modal, true);
    setHomeQrScannerStatus(modal, 'Starting camera...');

    try {
      stopQrScanner = await startHomeInviteQrScanner(modal, async (code) => {
        Haptic.success();
        const input = modal.querySelector('#joinCodeInput');
        if (input) input.value = code;
        stopScannerUi(true);
        Toast.success('QR code scanned');
        await redeemHomeInviteCode(code, user, { button: modal.querySelector('#joinHomeBtn'), close });
      });
      setHomeQrScannerStatus(modal, 'Align the QR code inside the frame.');
    } catch (error) {
      console.warn('[HomeSettings] QR scanner unavailable:', error);
      stopScannerUi(true);
      Toast.warning(error.message || 'QR scanning is unavailable. Enter the code manually.');
    }
  });

  // Format join code input
  modal.querySelector('#joinCodeInput')?.addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  });

  // Delete home (owner)
  modal.querySelector('#deleteHomeBtn')?.addEventListener('click', () => {
    Haptic.heavy();
    Modal.confirm('Delete Home', 'This will permanently delete the home and remove all members. Devices will be unlinked. This cannot be undone.', async () => {
      const success = await HomeService.deleteHome(homeId, user.uid);
      if (success) {
        Toast.success('Home deleted');
        close();
        setTimeout(() => location.reload(), 500);
      } else {
        Toast.error('Failed to delete home');
      }
    });
  });

  // Leave home (member)
  modal.querySelector('#leaveHomeBtn')?.addEventListener('click', () => {
    Haptic.heavy();
    Modal.confirm('Leave Home', `Are you sure you want to leave "${homeName}"? You will lose access to all shared devices.`, async () => {
      const success = await HomeService.leaveHome(homeId, user.uid);
      if (success) {
        Toast.success('Left home');
        close();
        setTimeout(() => location.reload(), 500);
      } else {
        Toast.error('Failed to leave home');
      }
    });
  });
}

// ============================================
// Initialize
// ============================================
document.addEventListener('DOMContentLoaded', async () => {
  // ============================================
  // CRITICAL: Resolve HomeService BEFORE any device operations
  // This prevents race conditions with localStorage scope + Firebase subscriptions
  // ============================================
  try {
    await Auth.waitForAuthReady();
    const user = Auth.getUser();
    if (user && typeof HomeService !== 'undefined') {
      await HomeService.init();
      const homeId = await HomeService.getActiveHome(user.uid);
      // Scope localStorage to this home (prevents data bleed between homes)
      DeviceList.setHome(homeId);
      await processHomeInviteFromUrl();
      if (window.DEBUG) console.log('[Index] Active home resolved:', homeId);
    }
  } catch (e) {
    console.error('[Index] HomeService init failed (degraded mode):', e);
  }

  // ============================================
  // Clean up invalid devices IMMEDIATELY on load
  // Must run BEFORE renderDevices to ensure DOM is clean
  // ============================================
  const devices = DeviceList.getAll();
  let devicesChanged = false;

  const validDevices = devices.map(d => {
    if (!d.id) return null;

    // Aggressively strip ALL non-alphanumeric characters (newlines, spaces, hidden unicode)
    const cleanId = d.id.toString().replace(/[^A-Fa-f0-9]/g, '').toUpperCase();

    if (d.id !== cleanId) {
      console.log(`[Index] ðŸ§¹ Cleaned corrupted ID (onLoad): "${d.id}" -> "${cleanId}"`);
      d.id = cleanId;
      devicesChanged = true;
    }

    if (!/^[A-F0-9]+$/.test(cleanId)) {
      console.warn(`[Index] âš ï¸ Removing unsalvageable device: "${d.id}"`);
      devicesChanged = true;
      return null;
    }

    return d;
  }).filter(d => d !== null);

  if (devicesChanged) {
    console.warn(`[Index] âš ï¸ Saving cleaned device list to Storage (pre-render)`);
    Storage.set(DeviceList.STORAGE_KEY, validDevices);
  }
  // Protocol Check
  if (window.location.protocol === 'file:') {
    const warning = document.createElement('div');
    warning.style.cssText = `
          position: fixed; top: 0; left: 0; right: 0; background: #ef4444; color: white;
          padding: 12px; text-align: center; z-index: 9999; font-weight: bold;
          box-shadow: 0 2px 10px rgba(0,0,0,0.2);
      `;
    warning.innerHTML = `
          âš ï¸ Running via file:// protocol. Connection issues expected. 
          <br><span style="font-weight: normal; font-size: 0.9em;">Please run "start_server.bat" to fix.</span>
      `;
    document.body.appendChild(warning);
    setTimeout(() => warning.remove(), 10000);
  }

  // Theme
  Theme.init();
  const themeBtn = document.getElementById('themeToggle');
  if (themeBtn) {
    themeBtn.innerHTML = Theme.get() !== 'light' ? '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-moon"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>' : '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-sun"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>';
    themeBtn.addEventListener('click', () => {
      Haptic.light();
      const newTheme = Theme.toggle();
      themeBtn.innerHTML = newTheme !== 'light' ? '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-moon"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>' : '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-sun"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>';
    });
  }

  // Empty state add button
  document.getElementById('emptyAddBtn')?.addEventListener('click', showAddDeviceModal);

  WidgetLayout.init();

  // Setup card actions
  setupCardActions();
  setupBlindGroupControl();

  // Setup logout button (guarded against double-tap)
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    guardClick(logoutBtn, () => {
      Haptic.medium();
      Modal.confirm(
        'Sign Out',
        'Are you sure you want to sign out?',
        async () => {
          try {
            await Auth.signOut();
          } catch (error) {
            console.error('[Index] Logout error:', error);
            Toast.error('Failed to sign out');
          }
        }
      );
    }, 600);
  }

  // Helper: format offset value for display
  function _fmtOffset(v) {
    if (v === 0) return '0 min';
    return `${v >= 0 ? '+' : ''}${v} min`;
  }

  // Setup Settings Button
  document.getElementById('settingsBtn')?.addEventListener('click', () => {
    const currentIP = localStorage.getItem('zaylo-BrokerIP') || 'ernesto-heptamerous-lourdes.ngrok-free.dev';
    const currentPort = localStorage.getItem('zaylo-BrokerPort') || '443';
    const currentPath = localStorage.getItem('zaylo-BrokerPath') ?? '/mqtt';
    const isOled = Theme.get() === 'oled';
    const currentWidgetLayout = WidgetLayout.getLayout();

    const { modal, close } = Modal.create({
      title: 'Settings',
      content: `
        <div style="margin-bottom: 20px;">
          <div style="display:flex; align-items:center; justify-content:space-between; padding:14px 16px; background:var(--bg-glass); border:1px solid var(--border-glass); border-radius:14px;">
            <div style="flex:1; min-width:0;">
              <div style="font-size:15px; font-weight:700; color:var(--text-primary); margin-bottom:3px;">OLED True Black</div>
              <div style="font-size:12px; color:var(--text-tertiary); line-height:1.3;">Pure #000 backgrounds â€” saves battery on OLED screens</div>
            </div>
            <div class="toggle-mini ${isOled ? 'active' : ''}" id="oledToggle" style="margin-left:14px;">
              <div class="thumb"></div>
            </div>
          </div>
        </div>

        <div style="margin-bottom: 24px;">
          <h4 style="margin-bottom: 12px; font-size: 15px; font-weight: 600; color: var(--text-primary); border-bottom: 1px solid var(--border-glass); padding-bottom: 8px;">Home Widgets</h4>
          <div class="settings-card">
            <div class="settings-card-title">Device Card Size</div>
            <div class="settings-card-subtitle">Large keeps the full dashboard controls. Compact creates a two-column home grid with tap controls.</div>
            <div class="widget-layout-segmented" role="group" aria-label="Device card size">
              <button class="widget-layout-choice ${currentWidgetLayout === 'large' ? 'active' : ''}" type="button" data-widget-layout-choice="large">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 8h10"/><path d="M7 12h7"/><path d="M7 16h4"/></svg>
                <span>Large</span>
              </button>
              <button class="widget-layout-choice ${currentWidgetLayout === 'compact' ? 'active' : ''}" type="button" data-widget-layout-choice="compact">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>
                <span>Compact</span>
              </button>
            </div>
            <button id="compactReorderStartBtn" class="widget-reorder-button" type="button" ${currentWidgetLayout === 'compact' ? '' : 'disabled'}>
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/></svg>
              <span>Reorder Widgets</span>
            </button>
          </div>
        </div>
        
        <div style="margin-bottom: 24px;">
            <h4 style="margin-bottom: 12px; font-size: 15px; font-weight: 600; color: var(--text-primary); border-bottom: 1px solid var(--border-glass); padding-bottom: 8px;">Location & Weather</h4>
            <p style="font-size: 12px; color: var(--text-tertiary); margin-bottom: 12px; line-height: 1.4;">Sets the global location for accurate sunrise, sunset, and weather features across all your devices.</p>
            
            <div style="margin-bottom: 12px;">
                <label style="display:block; color:var(--text-secondary); margin-bottom:8px; font-size:14px;">Postcode or City</label>
                <div style="display: flex; gap: 8px;">
                    <input type="text" id="globalLocationInput" placeholder="e.g. SW1A 1AA or London" value="${localStorage.getItem('zaylo-LocationCity') || ''}" style="flex: 1; padding:12px; background:var(--bg-glass); border:1px solid var(--border-glass); border-radius:12px; color:var(--text-primary); font-size:14px;">
                    <button id="globalLocationSaveBtn" class="btn btn-primary" style="padding: 0 16px; border-radius: 12px;">Set</button>
                </div>
            </div>
            
            <button id="globalUseDeviceLocationBtn" style="width:100%; padding:12px; border-radius:12px; border:1px solid var(--border-glass); background:var(--bg-glass); color:var(--text-secondary); font-family:var(--font-family); font-size:13px; font-weight:600; cursor:pointer; transition:all 0.2s ease; display:flex; align-items:center; justify-content:center; gap:8px;">
                ðŸ“ Use Device Location
            </button>
        </div>

        <div style="margin-bottom: 24px;">
            <h4 style="margin-bottom: 12px; font-size: 15px; font-weight: 600; color: var(--text-primary); border-bottom: 1px solid var(--border-glass); padding-bottom: 8px;">Sunrise & Sunset Offsets</h4>
            <p style="font-size: 12px; color: var(--text-tertiary); margin-bottom: 16px; line-height: 1.4;">Adjust when sunset/sunrise automations trigger across all devices. Positive values delay the action, negative values trigger it earlier.</p>

            <div style="display:flex; flex-direction:column; gap:12px;">
                <!-- Sunrise Offset -->
                <div style="display:flex; align-items:center; justify-content:space-between; padding:14px 16px; background:var(--bg-glass); border:1px solid var(--border-glass); border-radius:14px; transition: border-color 0.2s ease;">
                    <div style="display:flex; align-items:center; gap:12px; flex:1; min-width:0;">
                        <div style="width:36px; height:36px; border-radius:10px; background:linear-gradient(135deg, rgba(251,191,36,0.2), rgba(245,158,11,0.08)); border:1px solid rgba(251,191,36,0.25); display:flex; align-items:center; justify-content:center; flex-shrink:0;">
                            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v8"/><path d="m4.93 10.93 1.41 1.41"/><path d="M2 18h2"/><path d="M20 18h2"/><path d="m19.07 10.93-1.41 1.41"/><path d="M22 22H2"/><path d="m8 6 4-4 4 4"/><path d="M16 18a4 4 0 0 0-8 0"/></svg>
                        </div>
                        <div>
                            <div style="font-size:14px; font-weight:600; color:var(--text-primary);">Sunrise Offset</div>
                            <div style="font-size:11px; color:var(--text-tertiary); line-height:1.3;">Day Idle mode start adjustment</div>
                        </div>
                    </div>
                    <div style="display:flex; align-items:center; gap:6px; flex-shrink:0;">
                        <button id="globalSunriseOffsetDown" style="width:32px; height:32px; border-radius:8px; border:1px solid var(--border-glass); background:var(--bg-glass-strong); color:var(--text-primary); font-size:16px; font-weight:700; cursor:pointer; display:flex; align-items:center; justify-content:center; transition:all 0.15s ease;">âˆ’</button>
                        <div id="globalSunriseOffsetValue" style="min-width:56px; text-align:center; font-size:14px; font-weight:700; color:var(--accent); font-variant-numeric:tabular-nums; transition:transform 0.15s ease;">${_fmtOffset(parseInt(localStorage.getItem('zaylo-SunriseOffset') || '0', 10))}</div>
                        <button id="globalSunriseOffsetUp" style="width:32px; height:32px; border-radius:8px; border:1px solid var(--border-glass); background:var(--bg-glass-strong); color:var(--text-primary); font-size:16px; font-weight:700; cursor:pointer; display:flex; align-items:center; justify-content:center; transition:all 0.15s ease;">+</button>
                    </div>
                </div>

                <!-- Sunset Offset -->
                <div style="display:flex; align-items:center; justify-content:space-between; padding:14px 16px; background:var(--bg-glass); border:1px solid var(--border-glass); border-radius:14px; transition: border-color 0.2s ease;">
                    <div style="display:flex; align-items:center; gap:12px; flex:1; min-width:0;">
                        <div style="width:36px; height:36px; border-radius:10px; background:linear-gradient(135deg, rgba(124,58,237,0.2), rgba(168,85,247,0.08)); border:1px solid rgba(124,58,237,0.25); display:flex; align-items:center; justify-content:center; flex-shrink:0;">
                            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#a855f7" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 10V2"/><path d="m4.93 10.93 1.41 1.41"/><path d="M2 18h2"/><path d="M20 18h2"/><path d="m19.07 10.93-1.41 1.41"/><path d="M22 22H2"/><path d="m16 6-4 4-4-4"/><path d="M16 18a4 4 0 0 0-8 0"/></svg>
                        </div>
                        <div>
                            <div style="font-size:14px; font-weight:600; color:var(--text-primary);">Sunset Offset</div>
                            <div style="font-size:11px; color:var(--text-tertiary); line-height:1.3;">After-sunset action timing</div>
                        </div>
                    </div>
                    <div style="display:flex; align-items:center; gap:6px; flex-shrink:0;">
                        <button id="globalSunsetOffsetDown" style="width:32px; height:32px; border-radius:8px; border:1px solid var(--border-glass); background:var(--bg-glass-strong); color:var(--text-primary); font-size:16px; font-weight:700; cursor:pointer; display:flex; align-items:center; justify-content:center; transition:all 0.15s ease;">âˆ’</button>
                        <div id="globalSunsetOffsetValue" style="min-width:56px; text-align:center; font-size:14px; font-weight:700; color:var(--accent); font-variant-numeric:tabular-nums; transition:transform 0.15s ease;">${_fmtOffset(parseInt(localStorage.getItem('zaylo-SunsetOffset') || '0', 10))}</div>
                        <button id="globalSunsetOffsetUp" style="width:32px; height:32px; border-radius:8px; border:1px solid var(--border-glass); background:var(--bg-glass-strong); color:var(--text-primary); font-size:16px; font-weight:700; cursor:pointer; display:flex; align-items:center; justify-content:center; transition:all 0.15s ease;">+</button>
                    </div>
                </div>
            </div>

            <!-- Sunrise/Sunset Times Display -->
            <div id="sunTimesPanel" style="margin-top:12px; padding:14px 16px; border-radius:14px; background:var(--bg-glass); border:1px solid var(--border-glass);">
                <div style="display:flex; align-items:center; gap:8px; margin-bottom:10px;">
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                    <span style="font-size:12px; font-weight:600; color:var(--text-secondary);">Today's Times</span>
                    <span id="sunTimesCity" style="font-size:11px; color:var(--text-tertiary); margin-left:auto;"></span>
                </div>
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
                    <div style="padding:10px 12px; border-radius:10px; background:linear-gradient(135deg, rgba(251,191,36,0.1), rgba(245,158,11,0.04)); border:1px solid rgba(251,191,36,0.15); text-align:center;">
                        <div style="font-size:10px; font-weight:600; color:#f59e0b; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px;">Sunrise</div>
                        <div id="sunTimeSunrise" style="font-size:16px; font-weight:700; color:var(--text-primary); font-variant-numeric:tabular-nums;">--:--</div>
                        <div id="sunTimeEffSunrise" style="font-size:11px; color:var(--text-tertiary); margin-top:2px;">effective --:--</div>
                    </div>
                    <div style="padding:10px 12px; border-radius:10px; background:linear-gradient(135deg, rgba(124,58,237,0.1), rgba(168,85,247,0.04)); border:1px solid rgba(124,58,237,0.15); text-align:center;">
                        <div style="font-size:10px; font-weight:600; color:#a855f7; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px;">Sunset</div>
                        <div id="sunTimeSunset" style="font-size:16px; font-weight:700; color:var(--text-primary); font-variant-numeric:tabular-nums;">--:--</div>
                        <div id="sunTimeEffSunset" style="font-size:11px; color:var(--text-tertiary); margin-top:2px;">effective --:--</div>
                    </div>
                </div>
                <div id="sunTimesLoading" style="text-align:center; padding:4px 0; margin-top:6px;">
                    <span style="font-size:11px; color:var(--text-tertiary);">Loading times...</span>
                </div>
            </div>
        </div>

        <div style="margin-bottom: 24px;">
            <h4 style="margin-bottom: 12px; font-size: 15px; font-weight: 600; color: var(--text-primary); border-bottom: 1px solid var(--border-glass); padding-bottom: 8px;">Connection</h4>
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
            <div style="margin-bottom: 16px;">
              <label style="display:block; color:var(--text-secondary); margin-bottom:8px; font-size:14px;">WebSocket Path</label>
              <input type="text" id="brokerPathInput" value="${currentPath}" style="width:100%; padding:12px; background:var(--bg-glass); border:1px solid var(--border-glass); border-radius:12px; color:var(--text-primary); font-family:monospace;">
              <p style="font-size:12px; color:var(--text-tertiary); margin-top:6px;">Default: /mqtt (Mosquitto standard). Leave empty for direct connection.</p>
            </div>
            <div style="padding:12px; background:rgba(99,102,241,0.1); border-radius:12px; border:1px solid rgba(99,102,241,0.2);">
               <p style="color:var(--accent); font-size:12px; line-height:1.4; display:flex; align-items:flex-start; gap:4px; max-width:100%;"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0; margin-top:2px;"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> <span>Using secure tunnel via Ngrok. Connection is encrypted.</span></p>
            </div>
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
            const path = modal.querySelector('#brokerPathInput').value.trim();

            if (ip) {
              localStorage.setItem('zaylo-BrokerIP', ip);
              localStorage.setItem('zaylo-BrokerPort', port || '443');
              localStorage.setItem('zaylo-BrokerPath', path);
              Toast.success('Settings saved. Reloading...');
              setTimeout(() => location.reload(), 1000);
            }
          }
        }
      ]
    });

    // OLED toggle handler
    const oledToggle = modal.querySelector('#oledToggle');
    if (oledToggle) {
      oledToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const enabling = !oledToggle.classList.contains('active');
        oledToggle.classList.toggle('active', enabling);
        Haptic.light();

        if (enabling) {
          Theme.set('oled');
        } else {
          Theme.set('dark');
        }

        // Update the header theme button icon (moon for dark modes)
        const themeBtn = document.getElementById('themeToggle');
        if (themeBtn) {
          themeBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-moon"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>';
        }
      });
    }

    // â”€â”€ Global Sunrise/Sunset Offset Handlers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    modal.querySelectorAll('[data-widget-layout-choice]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const layout = btn.dataset.widgetLayoutChoice === 'compact' ? 'compact' : 'large';
        WidgetLayout.setLayout(layout);
        modal.querySelectorAll('[data-widget-layout-choice]').forEach(choice => {
          choice.classList.toggle('active', choice.dataset.widgetLayoutChoice === layout);
        });
        const reorderBtn = modal.querySelector('#compactReorderStartBtn');
        if (reorderBtn) reorderBtn.disabled = layout !== 'compact';
        if (typeof Haptic !== 'undefined') Haptic.selection();
      });
    });

    modal.querySelector('#compactReorderStartBtn')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!WidgetLayout.isCompact()) return;
      WidgetLayout.setCompactReorderMode(true);
      if (typeof Haptic !== 'undefined') Haptic.medium();
      if (typeof close === 'function') close();
    });

    function _setupOffsetControl(prefix, localStorageKey) {
        const downBtn = modal.querySelector(`#global${prefix}OffsetDown`);
        const upBtn = modal.querySelector(`#global${prefix}OffsetUp`);
        const display = modal.querySelector(`#global${prefix}OffsetValue`);
        if (!downBtn || !upBtn || !display) return;

        const STEP = 5;   // 5-minute increments
        const MIN = -120;  // -2 hours
        const MAX = 120;   // +2 hours

        const broadcastOffsets = () => {
            const sunriseVal = parseInt(localStorage.getItem('zaylo-SunriseOffset') || '0', 10);
            const sunsetVal = parseInt(localStorage.getItem('zaylo-SunsetOffset') || '0', 10);
            if (typeof MQTTClient !== 'undefined' && MQTTClient.connected) {
                const devices = DeviceList.getAll();
                devices.forEach(d => {
                    if (d.id) {
                        MQTTClient.publishConfig(d.id, {
                            config: {
                                sunriseOffset: sunriseVal,
                                sunsetOffset: sunsetVal
                            }
                        });
                    }
                });
            }
        };

        const update = (delta) => {
            let current = parseInt(localStorage.getItem(localStorageKey) || '0', 10);
            current = Math.max(MIN, Math.min(MAX, current + delta));
            localStorage.setItem(localStorageKey, String(current));
            display.textContent = _fmtOffset(current);

            // Micro-animation on value change
            display.style.transform = 'scale(1.15)';
            setTimeout(() => { display.style.transform = ''; }, 150);

            broadcastOffsets();
            if (typeof Haptic !== 'undefined') Haptic.light();
        };

        downBtn.addEventListener('click', (e) => { e.stopPropagation(); update(-STEP); });
        upBtn.addEventListener('click', (e) => { e.stopPropagation(); update(STEP); });
    }

    _setupOffsetControl('Sunrise', 'zaylo-SunriseOffset');
    _setupOffsetControl('Sunset', 'zaylo-SunsetOffset');

    // â”€â”€ Sunrise/Sunset Time Display â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Stores the fetched Unix timestamps for recalculation when offsets change
    let _sunriseUnix = 0;
    let _sunsetUnix = 0;

    function _fmtTime(date) {
        return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    }

    function _updateEffectiveTimes() {
        if (!_sunriseUnix || !_sunsetUnix) return;
        const srOff = parseInt(localStorage.getItem('zaylo-SunriseOffset') || '0', 10);
        const ssOff = parseInt(localStorage.getItem('zaylo-SunsetOffset') || '0', 10);
        const effSr = new Date((_sunriseUnix + srOff * 60) * 1000);
        const effSs = new Date((_sunsetUnix + ssOff * 60) * 1000);
        const effSrEl = modal.querySelector('#sunTimeEffSunrise');
        const effSsEl = modal.querySelector('#sunTimeEffSunset');
        if (effSrEl) effSrEl.textContent = `effective ${_fmtTime(effSr)}`;
        if (effSsEl) effSsEl.textContent = `effective ${_fmtTime(effSs)}`;
    }

    // Patch offset update handlers to also refresh effective times
    const origSrDown = modal.querySelector('#globalSunriseOffsetDown');
    const origSrUp = modal.querySelector('#globalSunriseOffsetUp');
    const origSsDown = modal.querySelector('#globalSunsetOffsetDown');
    const origSsUp = modal.querySelector('#globalSunsetOffsetUp');
    [origSrDown, origSrUp, origSsDown, origSsUp].forEach(btn => {
        if (btn) btn.addEventListener('click', () => setTimeout(_updateEffectiveTimes, 10));
    });

    // Fetch sunrise/sunset from OpenWeatherMap
    const storedLat = localStorage.getItem('zaylo-LocationLat');
    const storedLon = localStorage.getItem('zaylo-LocationLon');
    const storedCity = localStorage.getItem('zaylo-LocationCity');
    const sunTimesLoading = modal.querySelector('#sunTimesLoading');
    const sunTimesCity = modal.querySelector('#sunTimesCity');

    if (storedLat && storedLon) {
        if (sunTimesCity && storedCity) sunTimesCity.textContent = storedCity;
        fetch(`https://api.openweathermap.org/data/2.5/weather?lat=${storedLat}&lon=${storedLon}&appid=e20c6a9a37404d9726371c943d7da0ba`)
            .then(r => r.json())
            .then(data => {
                if (data?.sys?.sunrise && data?.sys?.sunset) {
                    _sunriseUnix = data.sys.sunrise;
                    _sunsetUnix = data.sys.sunset;
                    const srDate = new Date(_sunriseUnix * 1000);
                    const ssDate = new Date(_sunsetUnix * 1000);
                    const srEl = modal.querySelector('#sunTimeSunrise');
                    const ssEl = modal.querySelector('#sunTimeSunset');
                    if (srEl) srEl.textContent = _fmtTime(srDate);
                    if (ssEl) ssEl.textContent = _fmtTime(ssDate);
                    _updateEffectiveTimes();
                    if (sunTimesLoading) sunTimesLoading.style.display = 'none';
                }
            })
            .catch(() => {
                if (sunTimesLoading) sunTimesLoading.innerHTML = '<span style="font-size:11px; color:var(--text-tertiary);">Could not load times</span>';
            });
    } else {
        if (sunTimesLoading) sunTimesLoading.innerHTML = '<span style="font-size:11px; color:var(--text-tertiary);">Set a location above to see sunrise/sunset times</span>';
    }

    // Global Location Handlers
    const saveGlobalLocationBtn = modal.querySelector('#globalLocationSaveBtn');
    const globalLocationInput = modal.querySelector('#globalLocationInput');
    const API_KEY = 'e20c6a9a37404d9726371c943d7da0ba'; // OpenWeather API Key
    
    const applyGlobalLocation = (lat, lon, cityName) => {
        localStorage.setItem('zaylo-LocationLat', lat);
        localStorage.setItem('zaylo-LocationLon', lon);
        localStorage.setItem('zaylo-LocationCity', cityName);
        
        // Sync location AND current global offsets to all devices
        const globalSunriseOffset = parseInt(localStorage.getItem('zaylo-SunriseOffset') || '0', 10);
        const globalSunsetOffset = parseInt(localStorage.getItem('zaylo-SunsetOffset') || '0', 10);
        
        if (typeof MQTTClient !== 'undefined' && MQTTClient.connected) {
            const devices = DeviceList.getAll();
            devices.forEach(d => {
                if (d.id) {
                    MQTTClient.publishConfig(d.id, {
                        config: {
                            lat, lon,
                            sunriseOffset: globalSunriseOffset,
                            sunsetOffset: globalSunsetOffset
                        }
                    });
                }
            });
        }
        
        Toast.success(`Global location set to ${cityName}`);
    };

    if (saveGlobalLocationBtn && globalLocationInput) {
        saveGlobalLocationBtn.addEventListener('click', () => {
            const query = globalLocationInput.value.trim();
            if (!query) {
                Toast.warning('Please enter a postcode or city');
                return;
            }
            
            saveGlobalLocationBtn.disabled = true;
            saveGlobalLocationBtn.innerHTML = '...';
            
            const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(query)}&appid=${API_KEY}&units=metric`;
            
            fetch(url)
                .then(res => {
                    if (!res.ok) throw new Error('Location not found');
                    return res.json();
                })
                .then(data => {
                    if (data && data.coord) {
                        applyGlobalLocation(data.coord.lat, data.coord.lon, data.name || query);
                        globalLocationInput.value = data.name || query;
                    } else {
                        throw new Error('Invalid data');
                    }
                })
                .catch(err => {
                    console.error('[GlobalLocation] fetch failed:', err);
                    Toast.error('Could not find location. Try City, Country code.');
                })
                .finally(() => {
                    saveGlobalLocationBtn.disabled = false;
                    saveGlobalLocationBtn.innerHTML = 'Set';
                    Haptic.light();
                });
        });
    }
    
    // Global Set from Device GPS
    const useDeviceLocationBtn = modal.querySelector('#globalUseDeviceLocationBtn');
    if (useDeviceLocationBtn) {
        useDeviceLocationBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();

            if (useDeviceLocationBtn.disabled) return;
            
            if (!navigator.geolocation) {
                Toast.error('Geolocation not supported by this browser');
                return;
            }
            
            let isResolved = false;
            
            useDeviceLocationBtn.disabled = true;
            useDeviceLocationBtn.innerHTML = '<svg class="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg> Locating...';
            
            navigator.geolocation.getCurrentPosition(
                (pos) => {
                    if (isResolved) return;
                    isResolved = true;
                    
                    const lat = pos.coords.latitude;
                    const lon = pos.coords.longitude;
                    
                    // reverse geocode using coords to get a nice name
                    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${API_KEY}&units=metric`;
                    fetch(url)
                        .then(res => res.json())
                        .then(data => {
                            if (data && data.name) {
                                globalLocationInput.value = data.name;
                                applyGlobalLocation(lat, lon, data.name);
                            } else {
                                applyGlobalLocation(lat, lon, "Device Location");
                            }
                        })
                        .catch(() => {
                            applyGlobalLocation(lat, lon, "Device Location");
                        })
                        .finally(() => {
                            useDeviceLocationBtn.disabled = false;
                            useDeviceLocationBtn.innerHTML = 'ðŸ“ Use Device Location';
                            Haptic.light();
                        });
                },
                (err) => {
                    if (isResolved) return;
                    isResolved = true;
                    
                    console.error('[GlobalLocation] Geolocation Error:', err);
                    useDeviceLocationBtn.disabled = false;
                    useDeviceLocationBtn.innerHTML = 'ðŸ“ Use Device Location';
                    
                    if (err.code === 1) { // PERMISSION_DENIED
                        Modal.create({
                            title: 'Location Blocked',
                            content: `
                                <div style="text-align: center; padding: 12px 0;">
                                    <div style="font-size: 3em; margin-bottom: 12px;">ðŸ—ºï¸</div>
                                    <p style="color: var(--text-secondary); line-height: 1.5; font-size: 14px; margin-bottom: 16px;">
                                        Your browser or device has blocked location access.
                                    </p>
                                    <div style="background: rgba(99,102,241,0.1); padding: 12px; border-radius: 12px; text-align: left; font-size: 13px; color: var(--text-secondary);">
                                        <strong>How to fix on Android:</strong>
                                        <ol style="margin-top: 8px; padding-left: 20px; text-align: left; line-height: 1.6;">
                                            <li>Open your device <strong>Settings</strong> &gt; <strong>Apps</strong></li>
                                            <li>Find Chrome (or Zaylo app)</li>
                                            <li>Go to <strong>Permissions</strong> &gt; <strong>Location</strong></li>
                                            <li>Set to "Allow"</li>
                                        </ol>
                                        <p style="margin-top: 12px; margin-bottom:0; color:var(--text-tertiary);">Alternatively, you can manually enter your City or Postcode and tap "Set".</p>
                                    </div>
                                </div>
                            `,
                            actions: [{ label: 'Got it', primary: true, onClick: () => true }]
                        });
                    } else if (err.code === 2) { // POSITION_UNAVAILABLE
                        Toast.error('GPS signal unavailable. Try entering postcode.');
                    } else if (err.code === 3) { // TIMEOUT
                        Toast.error('Location request timed out. Make sure GPS is on.');
                    } else {
                        Toast.error('Location access failed for unknown reason.');
                    }
                },
                { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
            );
        });
    }

  });

  // Setup Home Settings Button (guarded against double-tap)
  const homeSettingsBtn = document.getElementById('homeSettingsBtn');
  if (homeSettingsBtn) {
    guardClick(homeSettingsBtn, () => {
      Haptic.light();
      showHomeSettingsModal();
    }, 800);
  }

  // Validate user (redirect if not logged in)
  /* const user = await Auth.init();
  if (!user) {
      window.location.href = 'login.html';
      return;
  } */

  // Initialize UI Interactables
  DeviceContextMenu.init();
  CardReorder.init();

  // Render devices (async - loads from Firebase if authenticated)
  await renderDevices();

  // Dismiss loading splash â€” start immediately, don't block on async
  const appLoader = document.getElementById('appLoader');
  if (appLoader) {
    appLoader.style.opacity = '0';
    appLoader.style.visibility = 'hidden';
    setTimeout(() => appLoader.remove(), 350);
  }

  // Initialize Pull-to-Refresh
  const appEl = document.querySelector('.app');
  if (appEl) {
    new PullToRefresh(appEl, async () => {
      console.log('[PTR] Refreshing...');
      await renderDevices();
      if (MQTTClient.connected) {
        const deviceList = DeviceList.getAll();
        deviceList.forEach(d => {
          MQTTClient.publishControl(d.id, { command: 'getState' });
        });
      }
    });
  }

  // Connect MQTT after devices are loaded
  try {
    await initMQTT();
  } catch (err) {
    console.error('[Main] Failed to initialize MQTT:', err);
    Toast.error('Connection failed');
  }
});
