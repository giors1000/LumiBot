/**
 * LumiBot - Index Page Logic
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

    // Initialize MQTT Listener for Index page
    if (window.MQTTClient) {
      // PWA SUPPORT: Ensure visibility handler is initialized (backup location)
      MQTTClient.initVisibilityHandler();

      // Connect if not already (Index needs to listen to ALL devices)
      if (!MQTTClient.connected) {
        MQTTClient.connect().catch(e => console.error('[Index] MQTT Connect failed:', e));
      }

      // Listen for state updates to update cards
      MQTTClient.on('onStateUpdate', (deviceId, state) => {
        updateDeviceCard(deviceId, state);
      });

      MQTTClient.on('onConnect', () => {
        // Re-subscribe to all known devices on reconnect
        const devices = DeviceList.getAll();
        devices.forEach(d => MQTTClient.subscribeDevice(d.id));
      });
    }

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
          if (user) {
            try {
              // This triggers onSnapshot immediately (Latency Compensation)
              await DeviceService.updateDevice(user.uid, deviceId, { name: cleanName });
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
          const user = Auth.getUser();

          // ============================================
          // STEP 1: Remove from Firebase (if authenticated)
          // ============================================
          if (user) {
            console.debug('[Index] 🗑️ Removing device from Firebase:', deviceId);

            // Wait for DeviceService to be initialized
            await DeviceService.init();

            const success = await DeviceService.removeDevice(user.uid, deviceId);

            if (!success) {
              console.error('[Index] ❌ Firebase removal failed for device:', deviceId);
              Toast.error('Failed to remove device from cloud');
              return; // Don't remove locally if cloud removal fails
            }

            console.debug('[Index] ✅ Device removed from Firebase successfully');

            // Verify removal by checking if device still exists
            const stillExists = await DeviceService.deviceExists(user.uid, deviceId);
            if (stillExists) {
              console.error('[Index] ⚠️ Device still exists in Firebase after deletion!');
              Toast.error('Device removal may have failed. Please try again.');
              return;
            }
            console.debug('[Index] ✅ Verified: Device no longer exists in Firebase');
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
          // console.log('[Index] ✅ Device removal complete:', deviceId);

        } catch (error) {
          console.error('[Index] ❌ Failed to remove device:', error);
          Toast.error('Failed to remove device: ' + (error.message || 'Unknown error'));
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
  state: 'IDLE', // IDLE | HOLD_PENDING | DRAGGING | DROPPING
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
  HOLD_DELAY: 250, // ms - Snappy but deliberate
  SCROLL_ZONE: 80, // px - Area to trigger auto-scroll
  SCROLL_SPEED: 8, // px/frame
  TILT_MAX: 4,     // deg - Maximum tilt during drag

  init() {
    this.list = document.getElementById('deviceList');
    if (!this.list) return;

    // Use non-passive listeners to allow preventing scroll
    this.list.addEventListener('touchstart', (e) => this.onTouchStart(e), { passive: false });
    document.addEventListener('touchmove', (e) => this.onTouchMove(e), { passive: false });
    document.addEventListener('touchend', (e) => this.onTouchEnd(e));
    document.addEventListener('touchcancel', (e) => this.onTouchEnd(e));
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
    document.querySelectorAll('.is-moving').forEach(el => el.classList.remove('is-moving'));
    document.querySelectorAll('.is-reordering').forEach(el => el.classList.remove('is-reordering'));
  },

  // ── Touch Handlers ────────────────────────────────

  onTouchStart(e) {
    if (this.state !== 'IDLE') return;

    // 1. Target Validation
    const card = e.target.closest('.device-card[data-device-id]');
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
    this.state = 'HOLD_PENDING';

    // 4. Capture touch coords as plain numbers (Touch objects get recycled by the browser)
    const touchX = touch.clientX;
    const touchY = touch.clientY;

    // 5. Start Hold Timer
    this.holdTimer = setTimeout(() => {
      if (this.state === 'HOLD_PENDING') {
        this.startDrag(touchX, touchY);
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
      }
      return;
    }

    // Case B: Dragging
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
      // Optional: Check if it was a tap?
    } else if (this.state === 'DRAGGING') {
      this.endDrag();
    }
  },

  // ── Drag Logic (Slot-Based Architecture) ────────────────
  // Instead of doing live DOM swaps during drag (which causes oscillation),
  // we freeze card positions at drag start, compute the closest slot,
  // and shift cards visually with CSS transforms. DOM is only reordered on drop.

  startDrag(clientX, clientY) {
    this.state = 'DRAGGING';

    try { Haptic.heavy(); } catch (_) { }

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
    const allCards = Array.from(this.list.querySelectorAll('.device-card'));
    this.originalOrder = allCards;
    this.dragIndex = allCards.indexOf(this.dragCard);
    this.targetIndex = this.dragIndex;

    this.slots = allCards.map(c => {
      const r = c.getBoundingClientRect();
      return { top: r.top, left: r.left, height: r.height, centerY: r.top + r.height / 2 };
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

  // ── Slot-Based Sort ─────────────────────────────────
  // Directional threshold: swap triggers when ghost has moved 30% toward the
  // next slot, making cards shift earlier and feel more responsive.
  updateSort() {
    if (!this.ghost || !this.slots || !this.slots.length) return;

    // Account for scroll changes since drag start
    const container = document.querySelector('.app');
    const scrollDelta = container ? (container.scrollTop - this.startScrollTop) : 0;

    // Ghost center in viewport coordinates
    const ghostCenterY = this.currentY + (this.ghostHeight / 2);

    // Current target index — check if we should move to a neighbor
    let newTarget = this.targetIndex;

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
      const shiftY = this.slots[newSlotIdx].top - this.slots[originalIdx].top;

      // Use setProperty with !important to guarantee override of any CSS
      // (animation fills, :hover, :active pseudo-classes, etc.)
      if (Math.abs(shiftY) > 0.5) {
        card.style.setProperty('transform', `translateY(${shiftY}px)`, 'important');
      } else {
        card.style.setProperty('transform', '', '');
      }
    });
  },

  checkAutoScroll(y) {
    const container = document.querySelector('.app');
    if (!container) return;

    const bottomZone = window.innerHeight - this.SCROLL_ZONE;

    if (y < this.SCROLL_ZONE && container.scrollTop > 0) {
      container.scrollBy(0, -this.SCROLL_SPEED);
    } else if (y > bottomZone && container.scrollTop < container.scrollHeight - container.clientHeight - 5) {
      container.scrollBy(0, this.SCROLL_SPEED);
    }
  },

  // ── End Drag ──────────────────────────────────────

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
        landingCard.classList.remove('drag-placeholder');
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
    };

    ghost.addEventListener('transitionend', cleanup, { once: true });

    // Fail-safe timeout (must exceed longest transition: 350ms + rAF)
    setTimeout(() => {
      if (this.state === 'DROPPING') cleanup();
    }, 500);
  },

  // ── Persistence ───────────────────────────────────

  async saveOrder() {
    const order = Array.from(this.list.querySelectorAll('.device-card[data-device-id]'))
      .map(el => el.dataset.deviceid || el.dataset.deviceId); // Handle potential casing

    // CRITICAL: Update in-memory state to prevent revert on re-render
    this.savedOrder = order;

    // Save locally immediately
    localStorage.setItem('LumiBot-deviceOrder', JSON.stringify(order));

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
      const local = JSON.parse(localStorage.getItem('LumiBot-deviceOrder') || '[]');
      if (local.length) this.savedOrder = local;
    } catch (e) { }
    const user = Auth.getUser();
    if (user && window.DeviceService) {
      try {
        const fb = await DeviceService.getDeviceOrder(user.uid);
        if (fb?.length) {
          this.savedOrder = fb;
          localStorage.setItem('LumiBot-deviceOrder', JSON.stringify(fb));
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
    { value: 0, icon: '🔄', label: 'Auto' },
    { value: 1, icon: '✋', label: 'Manual' },
    { value: 4, icon: '🔒', label: 'Lock' },
    { value: 3, icon: '🌙', label: 'Sleep' }
  ];

  // Status text: show Connecting... during initial load, then Online/Offline
  const statusText = isConnecting ? 'Connecting...' : (isOnline ? 'Online' : 'Offline');

  // CRITICAL: Only animate entry on the VERY FIRST render.
  // Subsequent re-renders (even if new DOM elements) should appear instantly.
  const animClass = window.LumiBot_InitialRenderComplete ? '' : 'card-enter';

  const card = document.createElement('div');
  card.className = `device-card ${animClass} ${isOnline ? 'online' : ''}`;
  card.id = `device-${device.id}`;
  card.dataset.deviceId = device.id;
  card.setAttribute('role', 'listitem');
  card.style.animationDelay = `${index * 0.08}s`;
  if (animClass) {
    card.addEventListener('animationend', () => card.classList.remove('card-enter'), { once: true });
  }

  card.innerHTML = `
        <button class="card-menu-btn" data-action="menu" aria-label="Device options"></button>
        <div class="device-header">
            <div class="device-info" data-action="navigate">
                <div class="device-icon ${lightOn ? 'on' : ''}">
                    💡
                    <div class="status-dot ${isOnline ? 'online' : (isConnecting ? 'connecting' : '')}"></div>
                </div>
                <div class="device-details">
                    <div class="device-name">${Utils.escapeHtml(device.name || 'LumiBot-' + device.id)}</div>
                    <div class="device-status">${statusText} • ${lightOn ? 'On' : 'Off'}</div>
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

  return card;
}

// ============================================
// Blind Device Card Template
// ============================================
function createBlindDeviceCard(device, state = null, index = 0) {
  const onlineStatus = state?._online;
  const isOnline = onlineStatus === true;
  const isConnecting = onlineStatus === undefined;
  const position = state?.blindPosition ?? 0;
  const isOpen = position > 0;

  const statusText = isConnecting ? 'Connecting...' : (isOnline ? 'Online' : 'Offline');
  const posText = position === 0 ? 'Closed' : position === 100 ? 'Open' : `${position}%`;

  // Read blind type from saved state
  let blindTypeLabel = 'Roller Blind';
  try {
    const saved = JSON.parse(localStorage.getItem(`blind-state-${device.id}`) || '{}');
    const typeLabels = { roller: 'Roller', venetian: 'Venetian', vertical: 'Vertical', zebra: 'Zebra' };
    blindTypeLabel = typeLabels[saved.blindType] || 'Roller';
  } catch (e) { /* ignore */ }

  // CRITICAL: Only animate entry on the VERY FIRST render.
  const animClass = window.LumiBot_InitialRenderComplete ? '' : 'card-enter';

  const card = document.createElement('div');
  card.className = `device-card blind-card ${animClass} ${isOnline ? 'online' : ''}`;
  card.id = `device-${device.id}`;
  card.dataset.deviceId = device.id;
  card.dataset.deviceType = 'blind';
  card.setAttribute('role', 'listitem');
  card.style.animationDelay = `${index * 0.08}s`;
  if (animClass) {
    card.addEventListener('animationend', () => card.classList.remove('card-enter'), { once: true });
  }

  card.innerHTML = `
        <button class="card-menu-btn" data-action="menu" aria-label="Device options"></button>
        <div class="device-header">
            <div class="device-info" data-action="navigate">
                <div class="device-icon blind-icon ${isOpen ? 'on' : ''}">
                    🪟
                    <div class="status-dot ${isOnline ? 'online' : (isConnecting ? 'connecting' : '')}"></div>
                </div>
                <div class="device-details">
                    <div class="device-name">${Utils.escapeHtml(device.name || 'Blinds-' + device.id)}</div>
                    <div class="device-status">${statusText} • ${posText} • ${blindTypeLabel}</div>
                </div>
            </div>
            <div class="blind-position-badge ${isOpen ? 'open' : 'closed'}">
                ${position}%
            </div>
        </div>
        
        <div class="blind-quick-row">
            <button class="blind-quick-btn ${!isOpen ? 'active' : ''}" data-action="blindClose">
                <span class="blind-quick-icon">🌙</span>
                <span class="blind-quick-label">Close</span>
            </button>
            <button class="blind-quick-btn ${position === 50 ? 'active' : ''}" data-action="blindHalf">
                <span class="blind-quick-icon">⛅</span>
                <span class="blind-quick-label">Half</span>
            </button>
            <button class="blind-quick-btn ${position === 100 ? 'active' : ''}" data-action="blindOpen">
                <span class="blind-quick-icon">☀️</span>
                <span class="blind-quick-label">Open</span>
            </button>
        </div>

        <div class="quick-row blind-smart-row">
            <div class="quick-info">
                <span class="quick-icon">🌅</span>
                <div class="quick-text">
                    <span class="quick-label">Sunset Close</span>
                    <span class="quick-value blind-auto-status">Active</span>
                </div>
            </div>
            <div class="toggle-mini ${state?.blindAutoSunset ? 'active' : ''}" data-action="blindAutoSunset">
                <div class="thumb"></div>
            </div>
        </div>
    `;

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
  const position = state?.blindPosition ?? 0;
  const isOpen = position > 0;

  const statusText = isConnecting ? 'Connecting...' : (isOnline ? 'Online' : 'Offline');
  const posText = position === 0 ? 'Closed' : position === 100 ? 'Open' : `${position}%`;

  card.classList.toggle('online', isOnline);

  const icon = card.querySelector('.device-icon');
  if (icon) icon.classList.toggle('on', isOpen);

  const dot = card.querySelector('.status-dot');
  if (dot) {
    dot.classList.remove('online', 'connecting');
    if (isOnline) dot.classList.add('online');
    else if (isConnecting) dot.classList.add('connecting');
  }

  const status = card.querySelector('.device-status');
  if (status) status.textContent = `${statusText} • ${posText}`;

  const badge = card.querySelector('.blind-position-badge');
  if (badge) {
    badge.textContent = `${position}%`;
    badge.classList.toggle('open', isOpen);
    badge.classList.toggle('closed', !isOpen);
  }
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
    <div class="add-subtitle">LumiBot or Smart Blinds</div>
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
    renderSkeletonLoader(list);
  } else {
    renderDeviceList(localDevices, list, emptyState, countEl);
  }

  // BACKGROUND: Sync with Firebase (Real-time)
  setupFirebaseSubscription(list, emptyState, countEl);

  // Mark initial render as complete so future updates don't trigger entry animations
  // Use a slight timeout to allow the initial animation to start
  setTimeout(() => {
    window.LumiBot_InitialRenderComplete = true;
  }, 1000);
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

// Helper function to render device list without blocking - Smart Updates
function renderDeviceList(devices, list, emptyState, countEl) {
  // Always hide empty state - we always show add card now
  if (emptyState) emptyState.classList.add('hidden');

  // Remove any skeleton loader cards (no data-device-id) before rendering real devices
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

  // Iterate through the new list of devices
  devices.forEach((device, index) => {
    const deviceIdStr = String(device.id).trim();

    // CRITICAL: Subscribe to device status updates (Online/Offline)
    if (MQTTClient && typeof MQTTClient.subscribeDevice === 'function') {
      MQTTClient.subscribeDevice(device.id);
    }

    let card = existingCards.get(deviceIdStr);
    const state = MQTTClient.getDeviceState(device.id);

    if (card) {
      // CASE 1: UPDATE EXISTING
      existingCards.delete(deviceIdStr); // Mark as processed

      // Check if device type changed — if so, rebuild the card entirely
      const deviceType = device.type || 'lumibot';
      const cardIsBlind = card.classList.contains('blind-card');
      const shouldBeBlind = deviceType === 'blind';

      if (cardIsBlind !== shouldBeBlind) {
        // Type mismatch — remove old card and create the correct one
        card.remove();
        card = shouldBeBlind
          ? createBlindDeviceCard(device, state, index)
          : createDeviceCard(device, state, index);
        list.appendChild(card);
      } else {
        // Same type — update in place
        const defaultName = shouldBeBlind ? 'Blinds-' : 'LumiBot-';
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
      // CASE 2: CREATE NEW
      // Only new cards will get the slide-in animation
      const deviceType = device.type || 'lumibot';
      card = deviceType === 'blind'
        ? createBlindDeviceCard(device, state, index)
        : createDeviceCard(device, state, index);
      list.appendChild(card);
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
  // Reset animation delay for add card to avoid it waiting unnecessarily if moved
  addCard.style.animationDelay = '0s';
  list.appendChild(addCard);

  if (countEl) {
    countEl.textContent = `${devices.length} device${devices.length !== 1 ? 's' : ''}`;
  }
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
    if (!user) {
      console.debug('[Index] Not authenticated, showing empty state');
      renderDeviceList([], list, emptyState, countEl);
      return;
    }

    if (deviceSubscription) deviceSubscription(); // Unsubscribe existing

    console.debug('[Index] Setting up Firebase real-time listener');
    await DeviceService.init();

    deviceSubscription = await DeviceService.subscribeToDevices(user.uid, (rawDevices) => {
      // console.log('[Index] Received update from Firebase:', rawDevices.length, 'devices');

      // Clean IDs
      const firebaseDevices = rawDevices.map(d => {
        const cleanId = d.id.toString().replace(/[^A-Fa-f0-9]/g, '').toUpperCase();
        d.id = cleanId;
        return d;
      }).filter(d => /^[A-F0-9]+$/.test(d.id));

      // Sync to local storage
      const localDevices = DeviceList.getAll();

      // Basic diff check to avoid unnecessary re-renders
      // We include Name in the comparison to ensure Rename triggers re-render
      const localJSON = JSON.stringify(localDevices.map(d => ({
        id: d.id,
        name: d.name,
        type: d.type || 'lumibot'
      })).sort((a, b) => a.id.localeCompare(b.id)));

      const firebaseJSON = JSON.stringify(firebaseDevices.map(d => ({
        id: d.id,
        name: d.name,
        type: d.type || 'lumibot'
      })).sort((a, b) => a.id.localeCompare(b.id)));

      if (localJSON !== firebaseJSON || localDevices.length !== firebaseDevices.length) {
        // console.log('[Index] Device list/names changed, updating UI');

        // Update Local Storage with Source of Truth
        // Preserve local-only fields if any (though currently we treat Firebase as master)
        Storage.set('LumiBot-devices', firebaseDevices);

        // Apply saved order before rendering
        const orderedDevices = CardReorder.applyOrder(firebaseDevices);
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

  const icon = card.querySelector('.device-icon');
  if (icon) icon.classList.toggle('on', lightOn);

  const dot = card.querySelector('.status-dot');
  if (dot) {
    dot.classList.remove('online', 'connecting');
    if (isOnline) dot.classList.add('online');
    else if (isConnecting) dot.classList.add('connecting');
  }

  const status = card.querySelector('.device-status');
  if (status) status.textContent = `${statusText} • ${lightOn ? 'On' : 'Off'}`;

  const powerBtn = card.querySelector('[data-action="power"]');
  if (powerBtn) powerBtn.classList.toggle('active', lightOn);

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

    const deviceId = card.dataset.deviceId.trim();

    // Navigate to device page (only if not holding or dragging)
    if (e.target.closest('[data-action="navigate"]')) {
      if (CardReorder.isDragging || card.classList.contains('hold-active')) return;
      const isBlind = card.dataset.deviceType === 'blind';
      window.location.href = isBlind
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

      // Optimistic update
      card.querySelectorAll('.blind-quick-btn').forEach(b => b.classList.remove('active'));
      e.target.closest('.blind-quick-btn')?.classList.add('active');

      const badge = card.querySelector('.blind-position-badge');
      if (badge) {
        badge.textContent = `${pos}%`;
        badge.classList.toggle('open', pos > 0);
        badge.classList.toggle('closed', pos === 0);
      }

      const statusEl = card.querySelector('.device-status');
      if (statusEl) {
        const posText = pos === 0 ? 'Closed' : pos === 100 ? 'Open' : `${pos}%`;
        statusEl.textContent = statusEl.textContent.split('•')[0].trim() + ` • ${posText}`;
      }

      if (MQTTClient.connected) {
        MQTTClient.publishControl(deviceId, { blindPosition: pos, blindOpen: pos > 0 });
      }

      // Save to local blind state
      try {
        const key = `blind-state-${deviceId}`;
        const saved = JSON.parse(localStorage.getItem(key) || '{}');
        saved.position = pos;
        saved.isOpen = pos > 0;
        localStorage.setItem(key, JSON.stringify(saved));
      } catch (ex) { /* ignore */ }
      return;
    }

    // Blind sunset auto toggle
    if (e.target.closest('[data-action="blindAutoSunset"]')) {
      const toggle = e.target.closest('[data-action="blindAutoSunset"]');
      const enabled = !toggle.classList.contains('active');
      toggle.classList.toggle('active', enabled);
      Haptic.light();

      try {
        const key = `blind-state-${deviceId}`;
        const saved = JSON.parse(localStorage.getItem(key) || '{}');
        if (!saved.rules) saved.rules = {};
        saved.rules.sunset = enabled;
        localStorage.setItem(key, JSON.stringify(saved));
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
      MQTTClient.publishControl(deviceId, { mode });
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
                
                <div style="display: flex; flex-direction: column; gap: 12px;">
                    <button class="modal-option-btn" id="addLumibotBtn" style="
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
                        <span style="font-size: 28px;">💡</span>
                        <div>
                            <div style="font-weight: 700;">LumiBot Light</div>
                            <div style="font-size: 12px; color: var(--text-tertiary);">Smart light switch with radar</div>
                        </div>
                    </button>
                    
                    <button class="modal-option-btn" id="addBlindBtn" style="
                        display: flex;
                        align-items: center;
                        gap: 16px;
                        padding: 16px 20px;
                        background: rgba(20, 184, 166, 0.08);
                        border: 2px solid rgba(20, 184, 166, 0.4);
                        border-radius: 16px;
                        color: var(--text-primary);
                        font-family: var(--font-family);
                        font-size: 16px;
                        cursor: pointer;
                        transition: all 0.2s ease;
                        width: 100%;
                        text-align: left;
                    ">
                        <span style="font-size: 28px;">🪟</span>
                        <div>
                            <div style="font-weight: 700;">Smart Blinds</div>
                            <div style="font-size: 12px; color: var(--text-tertiary);">Motorized blinds control</div>
                        </div>
                    </button>
                </div>
            </div>
        `,
    actions: []
  });

  modal.querySelector('#addLumibotBtn')?.addEventListener('click', () => {
    close();
    showLumibotAddOptions();
  });

  modal.querySelector('#addBlindBtn')?.addEventListener('click', () => {
    close();
    showAddExistingModal('blind');
  });
}

// LumiBot-specific add options (setup new vs add existing)
function showLumibotAddOptions() {
  const { modal, close } = Modal.create({
    title: 'Add LumiBot',
    content: `
            <div style="display: flex; flex-direction: column; gap: 12px;">
                <button class="modal-option-btn" id="setupNewBtn" style="
                    display: flex; align-items: center; gap: 16px;
                    padding: 16px 20px;
                    background: rgba(99, 102, 241, 0.1);
                    border: 2px solid var(--accent);
                    border-radius: 16px;
                    color: var(--text-primary);
                    font-family: var(--font-family); font-size: 16px;
                    cursor: pointer; transition: all 0.2s ease;
                    width: 100%; text-align: left;
                ">
                    <span style="font-size: 24px;">🆕</span>
                    <div>
                        <div style="font-weight: 700;">Setup New Device</div>
                        <div style="font-size: 12px; color: var(--text-tertiary);">Configure a brand new LumiBot</div>
                    </div>
                </button>
                <button class="modal-option-btn" id="addExistingBtn" style="
                    display: flex; align-items: center; gap: 16px;
                    padding: 16px 20px;
                    background: var(--bg-glass);
                    border: 2px solid var(--border-glass);
                    border-radius: 16px;
                    color: var(--text-primary);
                    font-family: var(--font-family); font-size: 16px;
                    cursor: pointer; transition: all 0.2s ease;
                    width: 100%; text-align: left;
                ">
                    <span style="font-size: 24px;">➕</span>
                    <div>
                        <div style="font-weight: 700;">Add Existing Device</div>
                        <div style="font-size: 12px; color: var(--text-tertiary);">Enter a device ID manually</div>
                    </div>
                </button>
            </div>
        `,
    actions: []
  });

  modal.querySelector('#setupNewBtn')?.addEventListener('click', () => {
    close();
    window.location.href = 'setup.html';
  });

  modal.querySelector('#addExistingBtn')?.addEventListener('click', () => {
    close();
    showAddExistingModal('lumibot');
  });
}

function showAddExistingModal(deviceType = 'lumibot') {
  const isBlind = deviceType === 'blind';
  const typeLabel = isBlind ? 'Smart Blinds' : 'LumiBot';
  const defaultName = isBlind ? 'Blinds' : 'LumiBot';
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
              await DeviceService.addDevice(user.uid, { id, name: name || `${defaultName}-${id}`, type: deviceType });
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

  // Force correct path if it got messed up by the crash cycling
  if (localStorage.getItem('LumiBot-BrokerPath') === '') {
    localStorage.setItem('LumiBot-BrokerPath', '/mqtt');
    console.log('[Index] 🔧 Fixed corrupted WebSocket path');
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
        console.log('[Index] ✅ All devices subscribed successfully.');
        return;
      }

      const device = devices[index];

      // CRITICAL: POISON PILL CHECK
      // If a device ID is null, empty, or contains invalid characters, subscribing to it 
      // can cause an immediate "Code 8" broker disconnect.
      const isValidId = device.id && /^[A-F0-9]+$/.test(device.id);

      if (!isValidId) {
        console.warn(`[Index] ⚠️ SKIPPING INVALID DEVICE ID: "${device.id}" (Poison Pill)`);
        console.warn('[Index] This device ID causes Code 8 crashes. Skipping safely.');
        // Skip this device immediately
        subscribeSequentially(devices, index + 1);
        return;
      }

      console.log(`[Index] [${index + 1}/${devices.length}] Subscribing to: ${device.id}`);

      // 1. Subscribe
      MQTTClient.subscribeDevice(device.id);

      // 2. Wait 300ms then request state
      setTimeout(() => {
        if (MQTTClient.connected) {
          MQTTClient.publishControl(device.id, { command: 'getState' });

          // 3. Wait 500ms before processing next device
          setTimeout(() => {
            subscribeSequentially(devices, index + 1);
          }, 500);
        }
      }, 300);
    };

    // Start the sequence
    subscribeSequentially(deviceList);
  });

  MQTTClient.on('onDisconnect', () => {
    updateMQTTStatus(false);
  });

  MQTTClient.on('onStateUpdate', (deviceId, state) => {
    const card = document.getElementById(`device-${deviceId}`);
    if (card && card.classList.contains('blind-card')) {
      updateBlindDeviceCard(deviceId, state);
    } else {
      updateDeviceCard(deviceId, state);
    }

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
  // ============================================
  // CRITICAL: Clean up invalid devices IMMEDIATELY on load
  // Must run BEFORE renderDevices to ensure DOM is clean
  // ============================================
  const devices = DeviceList.getAll();
  let devicesChanged = false;

  const validDevices = devices.map(d => {
    if (!d.id) return null;

    // Aggressively strip ALL non-alphanumeric characters (newlines, spaces, hidden unicode)
    const cleanId = d.id.toString().replace(/[^A-Fa-f0-9]/g, '').toUpperCase();

    if (d.id !== cleanId) {
      console.log(`[Index] 🧹 Cleaned corrupted ID (onLoad): "${d.id}" -> "${cleanId}"`);
      d.id = cleanId;
      devicesChanged = true;
    }

    if (!/^[A-F0-9]+$/.test(cleanId)) {
      console.warn(`[Index] ⚠️ Removing unsalvageable device: "${d.id}"`);
      devicesChanged = true;
      return null;
    }

    return d;
  }).filter(d => d !== null);

  if (devicesChanged) {
    console.warn(`[Index] ⚠️ Saving cleaned device list to Storage (pre-render)`);
    Storage.set('LumiBot-devices', validDevices);
    // Force reload of internal list cache if needed
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
      Haptic.light();
      const newTheme = Theme.toggle();
      themeBtn.textContent = newTheme === 'dark' ? '🌙' : '☀️';
    });
  }

  // Initialize context menu
  ContextMenu.init();

  // Initialize drag-to-reorder
  CardReorder.init();

  // Empty state add button
  document.getElementById('emptyAddBtn')?.addEventListener('click', showAddDeviceModal);

  // Setup card actions
  setupCardActions();

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

  // Setup Settings Button
  document.getElementById('settingsBtn')?.addEventListener('click', () => {
    const currentIP = localStorage.getItem('LumiBot-BrokerIP') || 'ernesto-heptamerous-lourdes.ngrok-free.dev';
    const currentPort = localStorage.getItem('LumiBot-BrokerPort') || '443';
    const currentPath = localStorage.getItem('LumiBot-BrokerPath') ?? '/mqtt';

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
        <div style="margin-bottom: 16px;">
          <label style="display:block; color:var(--text-secondary); margin-bottom:8px; font-size:14px;">WebSocket Path</label>
          <input type="text" id="brokerPathInput" value="${currentPath}" style="width:100%; padding:12px; background:var(--bg-glass); border:1px solid var(--border-glass); border-radius:12px; color:var(--text-primary); font-family:monospace;">
          <p style="font-size:12px; color:var(--text-tertiary); margin-top:6px;">Default: /mqtt (Mosquitto standard). Leave empty for direct connection.</p>
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
            const path = modal.querySelector('#brokerPathInput').value.trim();

            if (ip) {
              localStorage.setItem('LumiBot-BrokerIP', ip);
              localStorage.setItem('LumiBot-BrokerPort', port || '443');
              localStorage.setItem('LumiBot-BrokerPath', path);
              Toast.success('Settings saved. Reloading...');
              setTimeout(() => location.reload(), 1000);
            }
          }
        }
      ]
    });
  });

  // Validate user (redirect if not logged in)
  /* const user = await Auth.init();
  if (!user) {
      window.location.href = 'login.html';
      return;
  } */

  // Initialize UI Interactables
  ContextMenu.init();
  CardReorder.init();

  // Render devices (async - loads from Firebase if authenticated)
  await renderDevices();

  // Dismiss loading splash
  const appLoader = document.getElementById('appLoader');
  if (appLoader) {
    appLoader.style.opacity = '0';
    appLoader.style.visibility = 'hidden';
    setTimeout(() => appLoader.remove(), 400);
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
