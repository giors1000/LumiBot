/**
 * Zaylo - Core Application Utilities
 * Theme management, toasts, modals, and shared helpers
 * Version: 1.0.0
 */

// ============================================
// PWA Viewport Height Fix
// ============================================
const setAppHeight = () => {
  // Prefer visualViewport (accurate when mobile keyboard is open/closed)
  const height = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  document.documentElement.style.setProperty('--app-height', `${height}px`);
};
window.addEventListener('resize', setAppHeight);
window.addEventListener('orientationchange', () => { setTimeout(setAppHeight, 100); });

// visualViewport fires resize events when the on-screen keyboard opens/closes,
// which window.resize does NOT do on iOS Safari. This keeps modals and inputs
// visible above the keyboard instead of being hidden behind it.
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', setAppHeight);
  window.visualViewport.addEventListener('scroll', setAppHeight);
}
setAppHeight();

// Prevent splash flash on internal routing
window.addEventListener('load', () => {
    sessionStorage.setItem('zaylo-session-active', 'true');
});

// ============================================
// Performance: Pause Decorative Animations When Hidden
// ============================================
document.addEventListener('visibilitychange', () => {
  const app = document.querySelector('.app');
  if (app) {
    app.classList.toggle('page-hidden', document.hidden);
  }
});

// ============================================
// Global Error Handler - Production Safety Net
// ============================================

window.addEventListener('error', (event) => {
  if (typeof originalConsole !== 'undefined') {
    originalConsole.error('[Zaylo] Uncaught error:', event.message, event.filename, event.lineno);
  }
});

window.addEventListener('unhandledrejection', (event) => {
  if (typeof originalConsole !== 'undefined') {
    originalConsole.error('[Zaylo] Unhandled promise rejection:', event.reason);
  }
  // Prevent browser default rejection logging noise
  event.preventDefault();
});

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
originalConsole.info(`[Zaylo] v1.0.0 | Debug: ${DEBUG ? 'ON' : 'OFF'} | Use enableDebug()/disableDebug() to toggle`);

// ============================================
// Theme Management
// ============================================

const Theme = {
  STORAGE_KEY: 'zaylo-theme',

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
    // Update theme-color meta tags for browser chrome
    // Both media-qualified tags must be updated so the active one reflects the user's choice
    const darkMeta = document.querySelector('meta[name="theme-color"][media*="dark"]');
    const lightMeta = document.querySelector('meta[name="theme-color"][media*="light"]');
    const color = theme === 'light' ? '#f8fafc' : theme === 'oled' ? '#000000' : '#0a0a0f';
    if (darkMeta) darkMeta.content = color;
    if (lightMeta) lightMeta.content = color;
    // Dispatch event for components that need to react
    window.dispatchEvent(new CustomEvent('themechange', { detail: { theme } }));
  },

  toggle() {
    const current = this.get();
    // Toggle between dark and light. If currently OLED, go to light.
    const next = (current === 'dark' || current === 'oled') ? 'light' : 'dark';
    this.set(next);
    return next;
  },

  isOled() {
    return this.get() === 'oled';
  }
};

// ============================================
// Haptic Feedback Utility
// ============================================

const Haptic = {
  _audioCtx: null,

  _getAudioContext() {
    if (!this._audioCtx) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (AudioContext) {
        this._audioCtx = new AudioContext();
      }
    }
    return this._audioCtx;
  },

  _playAudioTaptic(frequency, duration, volume = 1.0) {
    try {
      const ctx = this._getAudioContext();
      if (!ctx) return;

      if (ctx.state === 'suspended') {
        ctx.resume();
      }

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.connect(gain);
      gain.connect(ctx.destination);

      // Low frequency sine wave produces high-fidelity physical speaker cone vibration
      osc.type = 'sine';
      osc.frequency.setValueAtTime(frequency, ctx.currentTime);

      gain.gain.setValueAtTime(volume, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);

      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + duration);
    } catch (e) {
      console.warn('[Haptic] Web Audio feedback failed:', e);
    }
  },

  vibrate(pattern) {
    if (navigator.vibrate) {
      navigator.vibrate(pattern);
    } else {
      // iOS Web Audio Taptic Engine Fallback
      if (Array.isArray(pattern)) {
        let delay = 0;
        pattern.forEach((dur, idx) => {
          if (idx % 2 === 0) {
            setTimeout(() => {
              this._playAudioTaptic(80, dur / 1000, 1.0);
            }, delay);
          }
          delay += dur;
        });
      } else {
        this._playAudioTaptic(80, pattern / 1000, 1.0);
      }
    }
  },

  light() {
    this.vibrate(10);
  },

  medium() {
    this.vibrate(25);
  },

  heavy() {
    this.vibrate(50);
  },

  selection() {
    this.vibrate(5);
  },

  success() {
    this.vibrate([10, 30, 10]);
  },

  error() {
    this.vibrate([50, 30, 50]);
  },

  notification(type) {
    if (type === 'success') {
      this.success();
    } else if (type === 'error' || type === 'warning') {
      this.error();
    } else {
      this.medium();
    }
  }
};

// ============================================
// Network Status Detection
// ============================================

const Network = {
  _listeners: [],
  _bannerTimeout: null,

  init() {
    window.addEventListener('online', () => this._handleChange(true));
    window.addEventListener('offline', () => this._handleChange(false));
  },

  isOnline() {
    return navigator.onLine;
  },

  _handleChange(online) {
    const banner = document.getElementById('networkBanner');
    if (banner) {
      clearTimeout(this._bannerTimeout);

      // Build rich content with icon
      if (online) {
        banner.innerHTML = `
          <span class="network-banner-icon">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>
          </span>
          <span class="network-banner-text">Back online</span>`;
        banner.className = 'network-banner visible online';
        Haptic.success();
        this._bannerTimeout = setTimeout(() => {
          banner.classList.add('dismissing');
          setTimeout(() => {
            banner.className = 'network-banner';
            banner.classList.remove('dismissing');
          }, 400);
        }, 3000);
      } else {
        banner.innerHTML = `
          <span class="network-banner-icon">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="2" y1="2" x2="22" y2="22"/><path d="M8.5 16.5a5 5 0 0 1 7 0"/><path d="M2 8.82a15 15 0 0 1 4.17-2.65"/><path d="M10.66 5c4.01-.36 8.14.9 11.34 3.76"/><path d="M16.85 11.25a10 10 0 0 1 2.22 1.68"/><path d="M5 12.55a10 10 0 0 1 5.17-2.39"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>
          </span>
          <span class="network-banner-text">No internet connection</span>`;
        banner.className = 'network-banner visible offline';
        Haptic.error();
      }
    }

    this._listeners.forEach(fn => fn(online));
  },

  on(callback) {
    this._listeners.push(callback);
  },

  off(callback) {
    this._listeners = this._listeners.filter(fn => fn !== callback);
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
    this.container.setAttribute('role', 'status');
    this.container.setAttribute('aria-live', 'polite');
    this.container.setAttribute('aria-atomic', 'false');
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
      <span class="toast-message">${Utils.escapeHtml(message)}</span>
      <div class="toast-progress" style="animation: toastProgress ${duration}ms linear forwards;"></div>
    `;

    this.container.appendChild(toast);

    // Force reflow for animation
    toast.offsetHeight;
    toast.classList.add('toast-enter');

    // Auto dismiss
    const dismissTimer = setTimeout(() => {
      toast.classList.remove('toast-enter');
      toast.classList.add('toast-exit');
      setTimeout(() => toast.remove(), 350);
    }, duration);

    // Click to dismiss early
    toast.addEventListener('click', () => {
      clearTimeout(dismissTimer);
      toast.classList.remove('toast-enter');
      toast.classList.add('toast-exit');
      setTimeout(() => toast.remove(), 350);
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
  _transitionLock: false,  // Prevents race conditions when chaining modals
  _transitionTimer: null,

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

    // Animate in with double-rAF for reliable CSS transition trigger
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        backdrop.classList.add('active');
      });
    });

    // ---- Back Button (popstate) Support ----
    // Push a history entry so the phone's back button closes the modal
    // instead of navigating away from the page.
    let closedByPopstate = false;
    history.pushState({ zayloModal: true }, '');

    const popstateHandler = (e) => {
      // Back button was pressed while modal is open — close the modal
      // CRITICAL: Skip if we're in a modal transition (chaining modals)
      if (Modal._transitionLock) return;
      closedByPopstate = true;
      close();
    };
    window.addEventListener('popstate', popstateHandler);

    // ESC key handler defined here for cleanup
    const escHandler = (e) => {
      if (e.key === 'Escape') {
        close();
      }
    };
    document.addEventListener('keydown', escHandler);

    // Close function
    const close = () => {
      // Prevent double-close
      if (backdrop._closing) return;
      backdrop._closing = true;

      document.removeEventListener('keydown', escHandler); // FIX: Always cleanup ESC listener
      window.removeEventListener('popstate', popstateHandler); // Cleanup back button listener

      // If close was NOT triggered by the back button, we need to pop the history
      // entry we pushed, to keep the history stack clean.
      if (!closedByPopstate) {
        history.back();
      }

      backdrop.classList.remove('active');

      // Fix iOS/mobile body scrolling bug when keyboard dismisses
      // We blur any inputs inside the modal to guarantee keyboard dismissal,
      // and unconditionally reset scroll offsets to correct viewport layout shifts.
      const modalInputs = modal.querySelectorAll('input, textarea');
      modalInputs.forEach(input => input.blur());
      window.scrollTo(0, 0);
      document.body.scrollTop = 0;
      setTimeout(() => {
        window.scrollTo(0, 0);
        document.body.scrollTop = 0;
      }, 80);

      setTimeout(() => {
        backdrop.remove();
        if (this.activeModal === backdrop) {
          this.activeModal = null;
          this.closeCallback = null;
        }
        if (onClose) onClose();
      }, 300);
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
      if (e.target.closest('.modal-close') || e.target.closest('button') || e.target.closest('input') || e.target.closest('a') || e.target.closest('.modal-option-btn') || e.target.closest('.toggle-mini')) {
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
    modal.addEventListener('touchmove', moveDrag, { passive: false }); // FIX: Must not be passive to use preventDefault
    modal.addEventListener('touchend', endDrag);

    // Store handler for cleanup
    this.activeModal = backdrop;
    this.closeCallback = close;

    // Action buttons
    actions.forEach((action, index) => {
      const btn = modal.querySelector(`[data-action="${index}"]`);
      if (btn) {
        btn.addEventListener('click', async () => {
          if (action.onClick) {
            try {
              const result = action.onClick(modal);
              if (result && typeof result.then === 'function') {
                const asyncResult = await result;
                if (asyncResult !== false) close();
              } else {
                if (result !== false) close();
              }
            } catch (error) {
              console.error('Modal action error:', error);
            }
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

  /**
   * Close the current modal and open a new one after the close animation finishes.
   * Prevents the popstate race condition that causes chained modals to close immediately.
   * @param {Function} openNextFn - Function that creates/shows the next modal
   */
  chain(openNextFn) {
    // Set transition lock to prevent popstate from firing during the transition
    this._transitionLock = true;
    clearTimeout(this._transitionTimer);

    if (this.closeCallback) {
      this.closeCallback();
    }

    // Wait for the close animation to complete, then open the next modal
    this._transitionTimer = setTimeout(() => {
      this._transitionLock = false;
      if (openNextFn) openNextFn();
    }, 350);
  },

  // Convenience method for confirmation dialogs
  confirm(title, message, onConfirm) {
    const safeMessage = Utils.escapeHtml(String(message ?? ''));
    return this.create({
      title,
      content: `<p style="color: var(--text-secondary); margin-bottom: var(--spacing-md); white-space: pre-line;">${safeMessage}</p>`,
      actions: [
        { label: 'Cancel', primary: false },
        { label: 'Confirm', primary: true, onClick: onConfirm }
      ]
    });
  },

  // Convenience method for alert dialogs
  alert(title, message, onAccept = null) {
    return this.create({
      title,
      content: typeof message === 'string' && message.includes('<') ? 
               `<div style="margin-bottom: var(--spacing-md);">${message}</div>` : 
               `<p style="color: var(--text-secondary); margin-bottom: var(--spacing-md); white-space: pre-line;">${message}</p>`,
      actions: [
        { label: 'OK', primary: true, onClick: onAccept }
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

    // Scroll to initial value (350ms delay ensures modal animation is complete)
    setTimeout(() => {
      scroll.scrollTop = selectedIndex * itemHeight;
    }, 350);

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

    // Initialize scroll positions (350ms delay ensures modal animation is complete)
    setTimeout(() => {
      hourScroll.scrollTop = hour * itemHeight;
      minuteScroll.scrollTop = minute * itemHeight;
    }, 350);

    // Hour/minute scroll handler with proper initial index
    const setupScroll = (scroll, values, initialValue, onUpdate) => {
      let currentIndex = values.indexOf(initialValue);
      if (currentIndex === -1) currentIndex = 0;

      // Set initial selected class so the current value is visually highlighted
      scroll.querySelectorAll('.picker-item').forEach((item, i) => {
        item.classList.toggle('selected', i === currentIndex);
      });

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
    };

    setupScroll(hourScroll, hours, hour, (h) => selectedHour = h);
    setupScroll(minuteScroll, minutes, minute, (m) => selectedMinute = m);

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
        <input type="text" class="modal-input" placeholder="${Utils.escapeHtml(placeholder)}" value="${Utils.escapeHtml(value)}" data-modal-input>
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

    // Focus input - disabled to prevent iOS/Android keyboard scroll jumps
    setTimeout(() => {
      const input = modal.querySelector('[data-modal-input]');
      if (input) {
        // input.focus();
        // input.select();

        // Reset scroll when input blurs (keyboard dismissed natively by Done button)
        input.addEventListener('blur', () => {
          setTimeout(() => {
            window.scrollTo(0, 0);
            document.body.scrollTop = 0;
          }, 80);
        });
      }
    }, 300);

    return { backdrop, modal, close };
  }
};

// ============================================
// Context Menu System
// ============================================

const ContextMenu = {
  activeMenu: null,

  show(options = {}) {
    const {
      x,
      y,
      items = [],
      onClose = null
    } = options;

    this.close(); // Close any existing

    // Create backdrop
    const backdrop = document.createElement('div');
    backdrop.className = 'context-backdrop';
    backdrop.style.position = 'fixed';
    backdrop.style.inset = '0';
    backdrop.style.zIndex = '99998';

    // Create menu
    const menu = document.createElement('div');
    menu.className = 'context-menu glass-card elevated';
    menu.style.position = 'fixed';
    menu.style.zIndex = '99999';
    menu.style.minWidth = '160px';
    menu.style.padding = '8px 0';
    menu.style.opacity = '0';
    menu.style.transform = 'scale(0.95)';
    menu.style.transformOrigin = 'top left';
    menu.style.transition = 'opacity 0.15s ease, transform 0.15s cubic-bezier(0.2, 0.9, 0.1, 1)';

    // Build items
    items.forEach(item => {
      if (item.divider) {
        const div = document.createElement('div');
        div.style.height = '1px';
        div.style.background = 'var(--border-glass)';
        div.style.margin = '4px 0';
        menu.appendChild(div);
        return;
      }

      const btn = document.createElement('button');
      btn.className = 'context-item ripple';
      btn.style.display = 'flex';
      btn.style.alignItems = 'center';
      btn.style.gap = '12px';
      btn.style.width = '100%';
      btn.style.padding = '12px 16px';
      btn.style.border = 'none';
      btn.style.background = 'transparent';
      btn.style.color = item.danger ? 'var(--danger)' : 'var(--text-primary)';
      btn.style.fontSize = '15px';
      btn.style.fontWeight = '500';
      btn.style.textAlign = 'left';
      btn.style.cursor = 'pointer';

      btn.innerHTML = `
        ${item.icon ? `<span style="font-size: 18px; width: 24px; text-align: center;">${item.icon}</span>` : ''}
        <span>${item.label}</span>
      `;

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.close();
        if (item.onClick) item.onClick();
      });

      menu.appendChild(btn);
    });

    document.body.appendChild(backdrop);
    document.body.appendChild(menu);

    // Position menu and ensure it doesn't go off screen
    const rect = menu.getBoundingClientRect();
    let posX = x;
    let posY = y;

    if (posX + rect.width > window.innerWidth - 16) {
      posX = window.innerWidth - rect.width - 16;
      menu.style.transformOrigin = 'top right';
    }

    if (posY + rect.height > window.innerHeight - 16) {
      posY = window.innerHeight - rect.height - 16;
      menu.style.transformOrigin = posY < y ? 'bottom left' : 'top left';
    }

    menu.style.left = `${posX}px`;
    menu.style.top = `${posY}px`;

    // Animate in
    requestAnimationFrame(() => {
      menu.style.opacity = '1';
      menu.style.transform = 'scale(1)';
    });

    // Close on click outside
    const closeHandler = () => {
      this.close();
      if (onClose) onClose();
    };

    backdrop.addEventListener('click', closeHandler);
    window.addEventListener('resize', closeHandler, { once: true });
    window.addEventListener('scroll', closeHandler, { once: true, capture: true });

    this.activeMenu = { menu, backdrop, closeHandler };
  },

  close() {
    if (this.activeMenu) {
      const { menu, backdrop, closeHandler } = this.activeMenu;

      menu.style.opacity = '0';
      menu.style.transform = 'scale(0.95)';

      backdrop.removeEventListener('click', closeHandler);
      window.removeEventListener('resize', closeHandler);
      window.removeEventListener('scroll', closeHandler, { capture: true });

      setTimeout(() => {
        menu.remove();
        backdrop.remove();
      }, 150);

      this.activeMenu = null;
    }
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
  STORAGE_KEY: (() => {
    try {
      const cached = localStorage.getItem('zaylo-activeHomeId');
      return cached ? 'zaylo-devices-' + cached : 'zaylo-devices-temp';
    } catch(e) { return 'zaylo-devices-temp'; }
  })(),
  _homeId: (() => {
    try { return localStorage.getItem('zaylo-activeHomeId') || null; } catch(e) { return null; }
  })(),

  /**
   * Scope localStorage cache to a specific home.
   * MUST be called before any read/write operations when homeId is known.
   * Prevents data bleed when switching between homes.
   * @param {string} homeId
   */
  setHome(homeId) {
    if (homeId && homeId !== this._homeId) {
      this._homeId = homeId;
      this.STORAGE_KEY = 'zaylo-devices-' + homeId;
      if (window.DEBUG) console.log(`[DeviceList] Storage scoped to home: ${homeId}`);
    }
  },

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
    // Spread all incoming properties (type, angleOn, angleOff, etc.)
    // then override with sanitized id and ensure defaults
    const defaultName = (device.type === 'blind' || device.type === 'stepper')
      ? `Blinds-${id}` : `Zaylo-${id}`;
    devices.push({
      ...device,
      id: id,
      name: device.name || defaultName,
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
    let s = Math.floor(seconds % 60);
    // FIX: Show at least 1 second remaining if fractional time exists, without causing 00:60 rollover
    if (seconds > 0 && s === 0 && seconds % 60 > 0) s = 1;

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
    return Date.now().toString(36) + Math.random().toString(36).substring(2);
  },

  // Check if on mobile
  isMobile() {
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || (window.innerWidth <= 768);
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

/* ============================================
   Premium Ripple Effect System
   ============================================ */
const Ripple = {
  init() {
    // Mobile trigger
    document.addEventListener('touchstart', (e) => this.create(e), { passive: true });
    // Desktop trigger
    document.addEventListener('mousedown', (e) => this.create(e));
  },

  create(e) {
    // Select targets for ripple
    // We target common interactive elements + any element with .ripple class
    const target = e.target.closest('.btn, .device-card, .header-btn, .mode-btn, .power-btn, .blind-quick-btn, .preset-btn, .ripple, .dock-btn, .link-option');

    if (!target) return;

    // Don't ripple if disabled
    if (target.disabled || target.classList.contains('disabled')) return;

    // Ensure container has relative positioning and overflow hidden
    // We add this class dynamically if not present to avoid messing up existing layout if possible,
    // but styles.css defines .ripple-container { position: relative; overflow: hidden; }
    if (!target.classList.contains('ripple-container')) {
      target.classList.add('ripple-container');
    }

    // Get coordinates
    const rect = target.getBoundingClientRect();
    const event = e.touches ? e.touches[0] : e;

    // Safety check for coordinates
    if (!event) return;

    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    // Create ripple element
    const ripple = document.createElement('span');
    ripple.className = 'ripple-effect';

    // Position center of ripple at touch point
    ripple.style.left = `${x}px`;
    ripple.style.top = `${y}px`;

    // Add to DOM
    target.appendChild(ripple);

    // Clean up after animation
    setTimeout(() => {
      ripple.remove();
    }, 600);
  }
};

/* ============================================
   Page Transition System
   ============================================ */
const PageTransition = {
  init() {
    // 1. Create overlay if it doesn't exist
    if (!document.querySelector('.page-transition-overlay')) {
      const overlay = document.createElement('div');
      overlay.className = 'page-transition-overlay';
      document.body.appendChild(overlay);
    }

    // 2. Intercept link clicks
    document.addEventListener('click', (e) => {
      // Find closest anchor
      const link = e.target.closest('a');
      if (!link) return;

      const href = link.getAttribute('href');

      // Ignore:
      // - No href
      // - Hash links (#)
      // - Protocol links (mailto:, tel:)
      // - New tab links (_blank)
      // - Same page links
      if (!href ||
        href.startsWith('#') ||
        href.startsWith('mailto:') ||
        href.startsWith('tel:') ||
        href.startsWith('javascript:') ||
        link.target === '_blank') {
        return;
      }

      // Check if it's actually a navigation to a new page
      const currentUrl = window.location.href.split('#')[0];
      const targetUrl = new URL(href, window.location.href).href.split('#')[0];

      if (currentUrl === targetUrl) return;

      e.preventDefault();
      this.navigate(href);
    });

    // 3. Handle browser back/forward cache (bfcache)
    // If user swipes back, we need to ensure overlay is hidden
    window.addEventListener('pageshow', (e) => {
      if (e.persisted) {
        const overlay = document.querySelector('.page-transition-overlay');
        if (overlay) overlay.classList.remove('active');
        document.body.style.opacity = '1';
      }
    });
  },

  navigate(url) {
    const overlay = document.querySelector('.page-transition-overlay');
    if (overlay) {
      // Fade out
      overlay.classList.add('active');

      // Wait for animation then navigate
      setTimeout(() => {
        window.location.href = url;
      }, 180); // Matches reduced CSS transition
    } else {
      window.location.href = url;
    }
  }
};

// ============================================
// Auto-Initialize Premium Features
// ============================================
document.addEventListener('DOMContentLoaded', () => {
  // Initialize Premium UI Systems
  setTimeout(() => {
    Ripple.init();
    PageTransition.init();

    // Ensure body is visible (handles case where CSS might hide it initially)
    document.body.style.opacity = '1';
  }, 10); // Minimal delay for DOM paint

  // Initialize network status monitoring
  Network.init();
});

// ============================================
// Double-Tap / Rapid-Click Prevention
// ============================================

function guardClick(btn, handler, cooldownMs = 400) {
  let blocked = false;
  btn.addEventListener('click', (e) => {
    if (blocked) { e.preventDefault(); return; }
    blocked = true;
    handler(e);
    setTimeout(() => { blocked = false; }, cooldownMs);
  });
}



// Expose premium components globally for non-modular browser environments
if (typeof window !== 'undefined') {
  window.Theme = Theme;
  window.Haptic = Haptic;
  window.Network = Network;
  if (typeof Toast !== 'undefined') window.Toast = Toast;
  if (typeof Modal !== 'undefined') window.Modal = Modal;
  if (typeof Storage !== 'undefined') window.Storage = Storage;
  if (typeof Utils !== 'undefined') window.Utils = Utils;
}

// Export for modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Theme, Toast, Modal, Storage, DeviceList, Utils, Haptic, Network };
}
