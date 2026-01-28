/**
 * LumiBot - Core Application Utilities
 * Theme management, toasts, modals, and shared helpers
 * Version: 1.0.0
 */

// ============================================
// Production Debug Logging System
// Enable debug mode: localStorage.setItem('DEBUG', 'true'); location.reload();
// Disable debug mode: localStorage.removeItem('DEBUG'); location.reload();
// ============================================

const DEBUG = localStorage.getItem('DEBUG') === 'true';

// Store original console methods
const originalConsole = {
  log: console.log.bind(console),
  debug: console.debug.bind(console),
  warn: console.warn.bind(console),
  info: console.info.bind(console),
  error: console.error.bind(console)
};

// In production mode, suppress verbose logging unless DEBUG is enabled
if (!DEBUG) {
  // Suppress regular logs and debug output
  console.log = () => { };
  console.debug = () => { };

  // Keep warnings for important issues, but filter out MQTT noise
  console.warn = (...args) => {
    const msg = args[0]?.toString() || '';
    // Always show critical warnings
    if (msg.includes('⚠') || msg.includes('CRITICAL') || msg.includes('ERROR')) {
      originalConsole.warn(...args);
    }
  };

  // Always show errors - they're critical
  // console.error remains unchanged

  // Info is for important production events
  console.info = originalConsole.info;
}

// Expose debug mode flag and restore function globally
window.DEBUG = DEBUG;
window.enableDebug = () => {
  localStorage.setItem('DEBUG', 'true');
  location.reload();
};
window.disableDebug = () => {
  localStorage.removeItem('DEBUG');
  location.reload();
};

window.resetApp = () => {
  if (confirm('REALLY CLEAR EVERYTHING? All saved devices and theme settings will be lost.')) {
    localStorage.clear();
    location.reload();
  }
};

// Log startup mode (this will show even if DEBUG is false because we use original)
originalConsole.info(`[LumiBot] v1.0.0 | Debug: ${DEBUG ? 'ON' : 'OFF'} | Use enableDebug()/disableDebug() to toggle`);

// ============================================
// Theme Management
// ============================================

const Theme = {
  STORAGE_KEY: 'LumiBot-theme',

  init() {
    const saved = localStorage.getItem(this.STORAGE_KEY);
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const theme = saved || (prefersDark ? 'dark' : 'light');
    this.set(theme, false);

    // Listen for system theme changes
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      if (!localStorage.getItem(this.STORAGE_KEY)) {
        this.set(e.matches ? 'dark' : 'light', false);
      }
    });
  },

  get() {
    return document.documentElement.getAttribute('data-theme') || 'dark';
  },

  set(theme, save = true) {
    document.documentElement.setAttribute('data-theme', theme);
    if (save) {
      localStorage.setItem(this.STORAGE_KEY, theme);
    }
    // Dispatch event for components that need to react
    window.dispatchEvent(new CustomEvent('themechange', { detail: { theme } }));
  },

  toggle() {
    const current = this.get();
    const next = current === 'dark' ? 'light' : 'dark';
    this.set(next);
    return next;
  }
};

// ============================================
// Toast Notifications
// ============================================

const Toast = {
  container: null,

  init() {
    if (this.container) return;
    this.container = document.createElement('div');
    this.container.className = 'toast-container';
    document.body.appendChild(this.container);
  },

  show(message, type = 'info', duration = 3000) {
    this.init();

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    const icons = {
      success: '✓',
      error: '✕',
      warning: '⚠',
      info: 'ℹ'
    };

    toast.innerHTML = `
      <span class="toast-icon">${icons[type] || icons.info}</span>
      <span class="toast-message">${message}</span>
    `;

    this.container.appendChild(toast);

    // Auto dismiss
    setTimeout(() => {
      toast.classList.add('toast-exit');
      setTimeout(() => toast.remove(), 300);
    }, duration);

    // Click to dismiss
    toast.addEventListener('click', () => {
      toast.classList.add('toast-exit');
      setTimeout(() => toast.remove(), 300);
    });

    return toast;
  },

  success(message, duration) { return this.show(message, 'success', duration); },
  error(message, duration) { return this.show(message, 'error', duration); },
  warning(message, duration) { return this.show(message, 'warning', duration); },
  info(message, duration) { return this.show(message, 'info', duration); }
};

// ============================================
// Modal System
// ============================================

const Modal = {
  activeModal: null,
  closeCallback: null,

  create(options = {}) {
    const {
      title = '',
      content = '',
      showHandle = true,
      showClose = true,
      actions = [],
      onClose = null
    } = options;

    // Create backdrop
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';

    // Create modal
    const modal = document.createElement('div');
    modal.className = 'modal';

    let html = '';

    if (showHandle) {
      html += '<div class="modal-handle"></div>';
    }

    if (title || showClose) {
      html += `
        <div class="modal-header">
          <h3 class="modal-title">${title}</h3>
          ${showClose ? '<button class="modal-close" aria-label="Close">✕</button>' : ''}
        </div>
      `;
    }

    html += `<div class="modal-content">${content}</div>`;

    if (actions.length > 0) {
      html += '<div class="modal-actions">';
      actions.forEach((action, index) => {
        const btnClass = action.primary ? 'btn btn-primary' : 'btn btn-secondary';
        html += `<button class="${btnClass}" data-action="${index}">${action.label}</button>`;
      });
      html += '</div>';
    }

    modal.innerHTML = html;
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    // Animate in
    requestAnimationFrame(() => {
      backdrop.classList.add('active');
    });

    // Close function
    const close = () => {
      backdrop.classList.remove('active');
      setTimeout(() => {
        backdrop.remove();
        if (this.activeModal === backdrop) {
          this.activeModal = null;
          this.closeCallback = null;
        }
        if (onClose) onClose();
      }, 400);
    };

    // Store for external close
    this.activeModal = backdrop;
    this.closeCallback = close;

    // Close button - ensure proper event handling
    const closeBtn = modal.querySelector('.modal-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        close();
      });
    }

    // Backdrop click
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close();
    });

    // Swipe-to-dismiss - extend to entire top area
    let startY = 0;
    let currentY = 0;
    let isDragging = false;

    const handle = modal.querySelector('.modal-handle');
    const header = modal.querySelector('.modal-header');

    // Create a drag zone that covers the handle and header area
    const dragElements = [handle, header].filter(Boolean);

    // Also make the top 80px of modal draggable for easier interaction
    const startDrag = (e) => {
      // CRITICAL FIX: Do NOT start drag if touching interactive elements
      // This allows clicks on buttons, inputs, and the close button to work correctly
      if (e.target.closest('.modal-close') || e.target.closest('button') || e.target.closest('input') || e.target.closest('a')) {
        return;
      }

      const touch = e.type === 'touchstart' ? e.touches[0] : e;
      const modalRect = modal.getBoundingClientRect();
      const touchY = touch.clientY - modalRect.top;

      // Only start drag if touching the top 80px or drag elements
      if (touchY > 80 && !dragElements.some(el => el && el.contains(e.target))) {
        return;
      }

      startY = touch.clientY;
      isDragging = true;
      modal.style.transition = 'none';
      e.preventDefault();
    };

    const moveDrag = (e) => {
      if (!isDragging) return;
      const touch = e.type === 'touchmove' ? e.touches[0] : e;
      currentY = touch.clientY;
      const diff = currentY - startY;
      if (diff > 0) {
        modal.style.transform = `translateY(${diff}px)`;
        backdrop.style.backgroundColor = `rgba(0, 0, 0, ${Math.max(0, 0.6 - diff / 500)})`;
      }
    };

    const endDrag = () => {
      if (!isDragging) return;
      isDragging = false;
      modal.style.transition = '';
      backdrop.style.transition = '';

      const diff = currentY - startY;
      if (diff > 80) { // Reduced threshold from 100 to 80
        close();
      } else {
        modal.style.transform = '';
        backdrop.style.backgroundColor = '';
      }
    };

    // Attach drag events to the modal itself
    modal.addEventListener('touchstart', startDrag, { passive: false });
    modal.addEventListener('touchmove', moveDrag, { passive: true });
    modal.addEventListener('touchend', endDrag);

    // ESC key to close
    const escHandler = (e) => {
      if (e.key === 'Escape') {
        close();
        document.removeEventListener('keydown', escHandler);
      }
    };
    document.addEventListener('keydown', escHandler);

    // Action buttons
    actions.forEach((action, index) => {
      const btn = modal.querySelector(`[data-action="${index}"]`);
      if (btn) {
        btn.addEventListener('click', () => {
          if (action.onClick) {
            const result = action.onClick();
            if (result !== false) close();
          } else {
            close();
          }
        });
      }
    });

    return { backdrop, modal, close };
  },

  // Close active modal
  close() {
    if (this.closeCallback) {
      this.closeCallback();
    }
  },

  // Convenience method for confirmation dialogs
  confirm(title, message, onConfirm) {
    return this.create({
      title,
      content: `<p style="color: var(--text-secondary); margin-bottom: var(--spacing-md);">${message}</p>`,
      actions: [
        { label: 'Cancel', primary: false },
        { label: 'Confirm', primary: true, onClick: onConfirm }
      ]
    });
  },

  // iOS-style value picker
  picker(options = {}) {
    const {
      title = 'Select Value',
      values = [],
      currentValue = null,
      formatValue = (v) => v,
      onSelect = null
    } = options;

    let selectedIndex = values.findIndex(v => v === currentValue);
    if (selectedIndex === -1) selectedIndex = 0;

    const itemHeight = 44;
    const visibleItems = 5;
    const spacerHeight = itemHeight * 2;

    const content = `
      <div class="picker">
        <div class="picker-highlight"></div>
        <div class="picker-scroll" data-picker-scroll>
          <div class="picker-spacer"></div>
          ${values.map((v, i) => `
            <div class="picker-item" data-index="${i}" data-value="${v}">
              ${formatValue(v)}
            </div>
          `).join('')}
          <div class="picker-spacer"></div>
        </div>
      </div>
    `;

    const { backdrop, modal, close } = this.create({
      title,
      content,
      actions: [
        { label: 'Cancel', primary: false },
        {
          label: 'Save',
          primary: true,
          onClick: () => {
            if (onSelect) onSelect(values[selectedIndex]);
          }
        }
      ]
    });

    const scroll = modal.querySelector('[data-picker-scroll]');
    const items = modal.querySelectorAll('.picker-item');

    // Scroll to initial value
    setTimeout(() => {
      scroll.scrollTop = selectedIndex * itemHeight;
    }, 100);

    // Update selection on scroll
    const updateSelection = () => {
      const scrollTop = scroll.scrollTop;
      const newIndex = Math.round(scrollTop / itemHeight);

      if (newIndex !== selectedIndex && newIndex >= 0 && newIndex < values.length) {
        selectedIndex = newIndex;
        items.forEach((item, i) => {
          item.classList.toggle('selected', i === selectedIndex);
        });
      }
    };

    scroll.addEventListener('scroll', updateSelection);

    // Snap to nearest on scroll end
    let scrollTimeout;
    scroll.addEventListener('scroll', () => {
      clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => {
        scroll.scrollTo({
          top: selectedIndex * itemHeight,
          behavior: 'smooth'
        });
      }, 100);
    });

    // Initial selection
    items.forEach((item, i) => {
      item.classList.toggle('selected', i === selectedIndex);
    });

    return { backdrop, modal, close };
  },

  // Time picker (hour:minute)
  timePicker(options = {}) {
    const {
      title = 'Select Time',
      hour = 12,
      minute = 0,
      onSelect = null
    } = options;

    let selectedHour = hour;
    let selectedMinute = minute;

    const hours = Array.from({ length: 24 }, (_, i) => i);
    const minutes = Array.from({ length: 60 }, (_, i) => i);

    const formatNum = (n) => n.toString().padStart(2, '0');

    const content = `
      <div class="flex gap-md">
        <div class="picker" style="flex: 1;">
          <div class="picker-highlight"></div>
          <div class="picker-scroll" data-picker-hours>
            <div class="picker-spacer"></div>
            ${hours.map(h => `
              <div class="picker-item" data-value="${h}">${formatNum(h)}</div>
            `).join('')}
            <div class="picker-spacer"></div>
          </div>
        </div>
        <div style="font-size: 24px; font-weight: bold; display: flex; align-items: center;">:</div>
        <div class="picker" style="flex: 1;">
          <div class="picker-highlight"></div>
          <div class="picker-scroll" data-picker-minutes>
            <div class="picker-spacer"></div>
            ${minutes.map(m => `
              <div class="picker-item" data-value="${m}">${formatNum(m)}</div>
            `).join('')}
            <div class="picker-spacer"></div>
          </div>
        </div>
      </div>
    `;

    const { backdrop, modal, close } = this.create({
      title,
      content,
      actions: [
        { label: 'Cancel', primary: false },
        {
          label: 'Save',
          primary: true,
          onClick: () => {
            if (onSelect) onSelect(selectedHour, selectedMinute);
          }
        }
      ]
    });

    const hourScroll = modal.querySelector('[data-picker-hours]');
    const minuteScroll = modal.querySelector('[data-picker-minutes]');
    const itemHeight = 44;

    // Initialize scroll positions
    setTimeout(() => {
      hourScroll.scrollTop = hour * itemHeight;
      minuteScroll.scrollTop = minute * itemHeight;
    }, 100);

    // Hour scroll handler
    const setupScroll = (scroll, values, onUpdate) => {
      let currentIndex = 0;

      const update = () => {
        const newIndex = Math.round(scroll.scrollTop / itemHeight);
        if (newIndex !== currentIndex && newIndex >= 0 && newIndex < values.length) {
          currentIndex = newIndex;
          onUpdate(values[currentIndex]);

          scroll.querySelectorAll('.picker-item').forEach((item, i) => {
            item.classList.toggle('selected', i === currentIndex);
          });
        }
      };

      scroll.addEventListener('scroll', update);

      let timeout;
      scroll.addEventListener('scroll', () => {
        clearTimeout(timeout);
        timeout = setTimeout(() => {
          scroll.scrollTo({ top: currentIndex * itemHeight, behavior: 'smooth' });
        }, 100);
      });

      return () => { currentIndex = values.indexOf(onUpdate === ((h) => selectedHour = h) ? hour : minute); };
    };

    setupScroll(hourScroll, hours, (h) => selectedHour = h);
    setupScroll(minuteScroll, minutes, (m) => selectedMinute = m);

    return { backdrop, modal, close };
  },

  // Text input modal
  input(options = {}) {
    const {
      title = 'Enter Value',
      placeholder = '',
      value = '',
      onSubmit = null
    } = options;

    const content = `
      <div class="input-group">
        <input type="text" class="input" placeholder="${placeholder}" value="${value}" data-modal-input>
      </div>
    `;

    const { backdrop, modal, close } = this.create({
      title,
      content,
      actions: [
        { label: 'Cancel', primary: false },
        {
          label: 'Save',
          primary: true,
          onClick: () => {
            const input = modal.querySelector('[data-modal-input]');
            if (onSubmit) onSubmit(input.value);
          }
        }
      ]
    });

    // Focus input
    setTimeout(() => {
      const input = modal.querySelector('[data-modal-input]');
      input.focus();
      input.select();
    }, 300);

    return { backdrop, modal, close };
  }
};

// ============================================
// Local Storage Helpers
// ============================================

const Storage = {
  get(key, defaultValue = null) {
    try {
      const item = localStorage.getItem(key);
      return item ? JSON.parse(item) : defaultValue;
    } catch (e) {
      console.error('Storage.get error:', e);
      return defaultValue;
    }
  },

  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      console.error('Storage.set error:', e);
      return false;
    }
  },

  remove(key) {
    try {
      localStorage.removeItem(key);
      return true;
    } catch (e) {
      return false;
    }
  }
};

// ============================================
// Device List Management
// ============================================

const DeviceList = {
  STORAGE_KEY: 'LumiBot-devices',

  getAll() {
    return Storage.get(this.STORAGE_KEY, []);
  },

  add(device) {
    const devices = this.getAll();
    // CRITICAL: Strict sanitization (fail-safe)
    const id = device.id.toUpperCase().replace(/[^A-F0-9]/g, '');
    // Check for duplicate
    if (devices.find(d => d.id === id)) {
      return false;
    }
    devices.push({
      id: id,
      name: device.name || `LumiBot-${id}`,
      addedAt: Date.now()
    });
    Storage.set(this.STORAGE_KEY, devices);
    return true;
  },

  remove(deviceId) {
    const devices = this.getAll();
    const id = deviceId.toUpperCase().trim();
    const filtered = devices.filter(d => d.id !== id);
    Storage.set(this.STORAGE_KEY, filtered);
    return filtered.length !== devices.length;
  },

  update(deviceId, updates) {
    const devices = this.getAll();
    const id = deviceId.toUpperCase().trim();
    const index = devices.findIndex(d => d.id === id);
    if (index === -1) return false;
    devices[index] = { ...devices[index], ...updates };
    Storage.set(this.STORAGE_KEY, devices);
    return true;
  },

  get(deviceId) {
    const id = deviceId.toUpperCase().trim();
    return this.getAll().find(d => d.id === id) || null;
  }
};

// ============================================
// Utility Functions
// ============================================

const Utils = {
  // Format seconds to MM:SS or HH:MM:SS
  formatTime(seconds) {
    if (seconds < 0) seconds = 0;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;

    if (h > 0) {
      return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  },

  // Format duration in minutes to human readable
  formatDuration(minutes) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (h > 0 && m > 0) return `${h}h ${m}m`;
    if (h > 0) return `${h}h`;
    return `${m}m`;
  },

  // Format duration in SECONDS to human readable (for timeout settings)
  formatSecondsAsDuration(seconds) {
    if (seconds === undefined || seconds === null || isNaN(seconds) || seconds <= 0) return '--';
    if (seconds < 60) return `${seconds}s`;
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (mins >= 60) {
      const hours = Math.floor(mins / 60);
      const remainingMins = mins % 60;
      if (remainingMins > 0) return `${hours}h ${remainingMins}m`;
      return `${hours}h`;
    }
    if (secs === 0) return `${mins}m`;
    return `${mins}m ${secs}s`;
  },

  // Get WiFi signal quality from RSSI
  getSignalQuality(rssi) {
    if (rssi >= -50) return 'excellent';
    if (rssi >= -60) return 'good';
    if (rssi >= -70) return 'fair';
    return 'poor';
  },

  // Debounce function
  debounce(fn, delay) {
    let timeout;
    return (...args) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => fn(...args), delay);
    };
  },

  // Throttle function
  throttle(fn, limit) {
    let inThrottle;
    return (...args) => {
      if (!inThrottle) {
        fn(...args);
        inThrottle = true;
        setTimeout(() => inThrottle = false, limit);
      }
    };
  },

  // Generate unique ID
  uid() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
  },

  // Check if on mobile
  isMobile() {
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  },

  // Escape HTML to prevent XSS attacks
  escapeHtml(str) {
    if (typeof str !== 'string') return str;
    const escapeMap = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    };
    return str.replace(/[&<>"']/g, char => escapeMap[char]);
  },

  // Parse URL query params
  getQueryParams() {
    const params = {};
    new URLSearchParams(window.location.search).forEach((value, key) => {
      params[key] = value;
    });
    return params;
  }
};

// ============================================
// Ripple Effect for Buttons
// ============================================

document.addEventListener('click', (e) => {
  const btn = e.target.closest('.btn');
  if (!btn || btn.disabled) return;

  const ripple = document.createElement('span');
  ripple.className = 'ripple';

  const rect = btn.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height);
  const x = e.clientX - rect.left - size / 2;
  const y = e.clientY - rect.top - size / 2;

  ripple.style.width = ripple.style.height = `${size}px`;
  ripple.style.left = `${x}px`;
  ripple.style.top = `${y}px`;

  btn.appendChild(ripple);

  setTimeout(() => ripple.remove(), 600);
});

// ============================================
// Initialize on DOM Ready
// ============================================

document.addEventListener('DOMContentLoaded', () => {
  Theme.init();
});

// Export for modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Theme, Toast, Modal, Storage, DeviceList, Utils };
}
