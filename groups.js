/* ============================================================
   Spaces — Multi-device control center for Zaylo blinds
   Scenes · Groups · Automations
   ------------------------------------------------------------
   Reuses the shared app singletons loaded before this file:
     DeviceList, Storage, Toast, Haptic, Theme, Modal,
     MQTTClient, Auth, HomeService, DeviceService, StateStore
   ============================================================ */
(function () {
  'use strict';

  // ── Icon library (inline lucide-style SVGs) ──────────────────
  const ICONS = {
    sunrise: '<path d="M12 2v8"/><path d="m4.93 10.93 1.41 1.41"/><path d="M2 18h2"/><path d="M20 18h2"/><path d="m19.07 10.93-1.41 1.41"/><path d="M22 22H2"/><path d="m8 6 4-4 4 4"/><path d="M16 18a4 4 0 0 0-8 0"/>',
    sunset: '<path d="M12 10V2"/><path d="m4.93 10.93 1.41 1.41"/><path d="M2 18h2"/><path d="M20 18h2"/><path d="m19.07 10.93-1.41 1.41"/><path d="M22 22H2"/><path d="m16 6-4 4-4-4"/><path d="M16 18a4 4 0 0 0-8 0"/>',
    moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
    film: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 3v18"/><path d="M3 7.5h4"/><path d="M3 12h18"/><path d="M3 16.5h4"/><path d="M17 3v18"/><path d="M17 7.5h4"/><path d="M17 16.5h4"/>',
    book: '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/>',
    coffee: '<path d="M10 2v2"/><path d="M14 2v2"/><path d="M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1"/><path d="M6 2v2"/>',
    sparkles: '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/>',
    home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
    leaf: '<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"/><path d="M2 21c0-3 1.85-5.36 5.08-6"/>',
    shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1Z"/>',
    star: '<path d="M11.5 2.8 9.6 7.6 4.4 8a.6.6 0 0 0-.34 1.06l3.98 3.42-1.2 5.1a.6.6 0 0 0 .9.65L12 15.5l4.46 2.7a.6.6 0 0 0 .9-.64l-1.2-5.1 3.98-3.43A.6.6 0 0 0 19.6 8l-5.2-.4-1.9-4.8a.6.6 0 0 0-1.1 0Z"/>',
    cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
    thermometer: '<path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z"/>',
    blinds: '<path d="M3 3h18"/><path d="M20 7H8"/><path d="M20 11H8"/><path d="M10 19h10"/><path d="M8 15h12"/><path d="M4 3v14"/><circle cx="4" cy="19" r="2"/>',
    bolt: '<path d="M12 2v4"/><path d="m6.41 6.41 2.83 2.83"/><path d="M2 12h4"/><path d="m6.41 17.59 2.83-2.83"/><path d="M12 18v4"/><circle cx="12" cy="12" r="3"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'
  };
  function svgIcon(name, w) {
    const s = w || 24;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ICONS.sparkles}</svg>`;
  }

  const SCENE_ICON_CHOICES = ['sparkles', 'sunrise', 'sunset', 'moon', 'sun', 'film', 'book', 'coffee', 'home', 'leaf', 'shield', 'star'];
  const SCENE_PALETTE = {
    sunrise: ['rgba(251,191,36,0.18)', '#fbbf24', 'rgba(251,191,36,0.3)'],
    sun: ['rgba(251,191,36,0.18)', '#fbbf24', 'rgba(251,191,36,0.3)'],
    sunset: ['rgba(249,115,22,0.18)', '#fb923c', 'rgba(249,115,22,0.3)'],
    moon: ['rgba(129,140,248,0.18)', '#a5b4fc', 'rgba(129,140,248,0.3)'],
    film: ['rgba(236,72,153,0.16)', '#f472b6', 'rgba(236,72,153,0.3)'],
    book: ['rgba(45,212,191,0.16)', '#5eead4', 'rgba(20,184,166,0.3)'],
    coffee: ['rgba(180,120,80,0.18)', '#d9a066', 'rgba(180,120,80,0.3)'],
    leaf: ['rgba(34,197,94,0.16)', '#4ade80', 'rgba(34,197,94,0.3)'],
    default: ['rgba(124,58,237,0.16)', '#a78bfa', 'rgba(124,58,237,0.3)']
  };
  function scenePalette(icon) { return SCENE_PALETTE[icon] || SCENE_PALETTE.default; }

  // ── Automation type metadata ─────────────────────────────────
  // Each maps 1:1 to a real firmware rule the ESP32 runs autonomously.
  const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  const AUTO_TYPES = {
    sunset: {
      label: 'Sunset Close', rule: 'sunset', icon: 'sunset',
      color: ['rgba(249,115,22,0.16)', '#fb923c', 'rgba(249,115,22,0.28)'],
      defaults: { offset: 15, target: 0 },
      summary: c => `Sunset ${c.offset >= 0 ? '+' : ''}${c.offset} min`,
      blurb: 'Closes when the sun sets, using your home location.'
    },
    morning: {
      label: 'Morning Open', rule: 'morningOpen', icon: 'sunrise',
      color: ['rgba(251,191,36,0.16)', '#fbbf24', 'rgba(251,191,36,0.28)'],
      defaults: { time: '07:00', days: [true, true, true, true, true, true, true], target: 100, duration: 30 },
      summary: c => `${c.time} · ${daysLabel(c.days)}`,
      blurb: 'Gradually opens your blinds to wake the room with daylight.'
    },
    night: {
      label: 'Night Lock', rule: 'nightLock', icon: 'moon',
      color: ['rgba(129,140,248,0.16)', '#a5b4fc', 'rgba(129,140,248,0.28)'],
      defaults: { time: '22:00', days: [true, true, true, true, true, true, true], target: 0 },
      summary: c => `${c.time} · ${daysLabel(c.days)}`,
      blurb: 'Closes for privacy every night at your chosen bedtime.'
    },
    temperature: {
      label: 'Heat Protection', rule: 'temperature', icon: 'thermometer',
      color: ['rgba(239,68,68,0.15)', '#f87171', 'rgba(239,68,68,0.28)'],
      defaults: { threshold: 28, target: 30 },
      summary: c => `Above ${c.threshold}°C`,
      blurb: 'Closes to block heat when the outdoor temperature climbs.'
    }
  };
  const AUTO_ORDER = ['morning', 'sunset', 'night', 'temperature'];

  // ── Small helpers ────────────────────────────────────────────
  function clampPct(v) { v = Math.round(Number(v)); return Math.max(0, Math.min(100, isFinite(v) ? v : 0)); }
  function targetLabel(p) { p = clampPct(p); return p === 0 ? 'Closed' : p === 100 ? 'Open' : p === 50 ? 'Half' : p + '%'; }
  function daysLabel(days) {
    if (!Array.isArray(days) || days.length !== 7) return 'Every day';
    const on = days.map((d, i) => d ? i : -1).filter(i => i >= 0);
    if (on.length === 7) return 'Every day';
    if (on.length === 0) return 'Never';
    const isWeekdays = on.length === 5 && [1, 2, 3, 4, 5].every(i => days[i]);
    if (isWeekdays) return 'Weekdays';
    const isWeekend = on.length === 2 && days[0] && days[6];
    if (isWeekend) return 'Weekends';
    const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return on.map(i => names[i]).join(', ');
  }
  function uid(prefix) { return (prefix || 'x') + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function haptic(kind) { try { if (typeof Haptic !== 'undefined' && Haptic[kind]) Haptic[kind](); } catch (e) {} }
  function toast(kind, msg) { try { if (typeof Toast !== 'undefined' && Toast[kind]) Toast[kind](msg); } catch (e) {} }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // ── Home-scoped storage ──────────────────────────────────────
  function homeSuffix() {
    try {
      if (typeof DeviceList !== 'undefined' && DeviceList._homeId) return DeviceList._homeId;
      return localStorage.getItem('zaylo-activeHomeId') || 'temp';
    } catch (e) { return 'temp'; }
  }
  function makeStore(prefix) {
    return {
      key() { return `zaylo-${prefix}-${homeSuffix()}`; },
      all() {
        try { return JSON.parse(localStorage.getItem(this.key()) || '[]') || []; } catch (e) { return []; }
      },
      saveAll(list) { try { localStorage.setItem(this.key(), JSON.stringify(list)); } catch (e) {} },
      upsert(item) {
        const list = this.all();
        const i = list.findIndex(x => x.id === item.id);
        if (i >= 0) list[i] = item; else list.push(item);
        this.saveAll(list);
      },
      remove(id) { this.saveAll(this.all().filter(x => x.id !== id)); }
    };
  }
  const SceneStore = makeStore('scenes');
  const GroupStore = makeStore('groups');
  const AutomationStore = makeStore('automations');

  // ── Device helpers ───────────────────────────────────────────
  function isBlind(d) { const t = String(d && d.type || '').toLowerCase(); return t === 'blind' || t === 'stepper'; }
  function allBlinds() {
    const src = (typeof DeviceList !== 'undefined' && DeviceList.getAll) ? DeviceList.getAll() : [];
    return src.filter(isBlind);
  }
  function blindIds() { return allBlinds().map(d => String(d.id).trim().toUpperCase()); }
  function deviceName(id) {
    const d = (typeof DeviceList !== 'undefined' && DeviceList.get) ? DeviceList.get(id) : null;
    return (d && d.name) || `Blinds-${String(id).slice(-4)}`;
  }
  function savedBlindState(id) {
    try { return JSON.parse(localStorage.getItem(`blind-state-${id}`) || '{}') || {}; } catch (e) { return {}; }
  }
  function liveState(id) {
    if (typeof MQTTClient !== 'undefined' && MQTTClient.getDeviceState) {
      const s = MQTTClient.getDeviceState(id);
      if (s) return s;
    }
    return null;
  }
  function isOnline(id) { const s = liveState(id); return s ? s._online === true : false; }
  function isMoving(id) { const s = liveState(id); return s ? s.isMoving === true : false; }

  const _targetLock = new Map(); // id -> { pos, ts }
  function positionOf(id) {
    const lock = _targetLock.get(id);
    if (lock && Date.now() - lock.ts < 10000) return clampPct(lock.pos);
    const s = liveState(id);
    let raw = s ? (s.blindPosition != null ? s.blindPosition : s.position) : undefined;
    if (raw == null) { const sv = savedBlindState(id); raw = sv.targetPosition != null ? sv.targetPosition : sv.position; }
    const n = Number(raw);
    return isFinite(n) ? clampPct(n) : null;
  }
  function averagePosition(ids) {
    const vals = ids.map(positionOf).filter(v => v != null);
    if (!vals.length) return null;
    return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
  }

  // ── Issuing commands ─────────────────────────────────────────
  function canControl() { return typeof MQTTClient !== 'undefined' && typeof MQTTClient.publishStepperControl === 'function'; }
  function connected() { return typeof MQTTClient !== 'undefined' && MQTTClient.connected; }

  function persistPosition(id, pos) {
    try {
      const sv = savedBlindState(id);
      sv.position = pos; sv.targetPosition = pos; sv.isOpen = pos > 0;
      localStorage.setItem(`blind-state-${id}`, JSON.stringify(sv));
    } catch (e) {}
  }

  function applyPositionToDevices(ids, pos, label) {
    pos = clampPct(pos);
    ids = ids.filter(Boolean);
    if (!ids.length) { toast('info', 'No blinds to control'); return; }
    haptic('selection');
    ids.forEach(id => {
      _targetLock.set(id, { pos, ts: Date.now() });
      persistPosition(id, pos);
      if (canControl()) MQTTClient.publishStepperControl(id, { blindPosition: pos });
    });
    const what = label || `${targetLabel(pos)}`;
    if (!connected()) toast('info', `Offline — ${what} queued for ${ids.length}`);
    else toast('success', `${what} · ${ids.length} blind${ids.length !== 1 ? 's' : ''}`);
    renderHero(); renderGroups();
  }
  function stopDevices(ids) {
    ids = ids.filter(Boolean);
    if (!ids.length) return;
    haptic('medium');
    ids.forEach(id => {
      if (canControl()) MQTTClient.publishStepperControl(id, { command: 'stop' });
      const p = positionOf(id);
      if (p != null) _targetLock.set(id, { pos: p, ts: Date.now() });
    });
    toast(connected() ? 'success' : 'info', `Stop · ${ids.length} blind${ids.length !== 1 ? 's' : ''}`);
    renderHero(); renderGroups();
  }

  // ── Scenes ───────────────────────────────────────────────────
  function sceneDeviceIds(scene) {
    if (scene.scope === 'all') return blindIds();
    return (scene.deviceIds || []).filter(id => blindIds().includes(id));
  }
  function applyScene(scene) {
    const ids = sceneDeviceIds(scene);
    if (!ids.length) { toast('info', 'This scene has no available blinds'); return; }
    haptic('success');
    ids.forEach(id => {
      const pos = clampPct(scene.target);
      _targetLock.set(id, { pos, ts: Date.now() });
      persistPosition(id, pos);
      if (canControl()) MQTTClient.publishStepperControl(id, { blindPosition: pos });
    });
    if (!connected()) toast('info', `Offline — "${scene.name}" queued`);
    else toast('success', `"${scene.name}" · ${ids.length} blind${ids.length !== 1 ? 's' : ''}`);
    renderHero();
  }
  function seedDefaultScenesOnce() {
    const flag = `zaylo-spaces-seed-${homeSuffix()}`;
    try { if (localStorage.getItem(flag)) return; } catch (e) { return; }
    if (SceneStore.all().length) { try { localStorage.setItem(flag, '1'); } catch (e) {} return; }
    const defaults = [
      { name: 'Good Morning', icon: 'sunrise', scope: 'all', deviceIds: [], target: 100 },
      { name: 'Good Night', icon: 'moon', scope: 'all', deviceIds: [], target: 0 },
      { name: 'Movie Time', icon: 'film', scope: 'all', deviceIds: [], target: 0 },
      { name: 'Daylight', icon: 'sun', scope: 'all', deviceIds: [], target: 50 }
    ].map(s => Object.assign({ id: uid('scene') }, s));
    SceneStore.saveAll(defaults);
    try { localStorage.setItem(flag, '1'); } catch (e) {}
  }

  // ── Automation → firmware config translation ─────────────────
  function tzPayload() {
    if (typeof MQTTClient !== 'undefined' && typeof MQTTClient.getTimezonePayload === 'function') {
      const tz = MQTTClient.getTimezonePayload();
      const out = { gmtOffset: tz.gmtOffset, daylightOffset: tz.daylightOffset };
      if (tz.tzPosix) out.tzPosix = tz.tzPosix;
      return out;
    }
    return {};
  }
  // Build the firmware config + local-state patch for ONE enabled automation.
  function typePatch(type, c) {
    const fw = {}; // sent over MQTT (+ persisted into blind-state.config)
    if (type === 'sunset') {
      fw.sunsetTarget = clampPct(c.target);
      fw.sunsetOffset = Math.max(-120, Math.min(120, parseInt(c.offset, 10) || 0));
    } else if (type === 'morning') {
      fw.morningTime = c.time || '07:00';
      fw.morningTarget = clampPct(c.target);
      fw.morningDuration = Math.max(1, Math.min(120, parseInt(c.duration, 10) || 30));
      fw.morningDays = (c.days || []).map(on => ({ enabled: !!on, time: c.time || '07:00', duration: fw.morningDuration, target: fw.morningTarget }));
    } else if (type === 'night') {
      fw.nightTime = c.time || '22:00';
      fw.nightTarget = clampPct(c.target);
      fw.nightDays = (c.days || []).map(on => ({ enabled: !!on, time: c.time || '22:00', target: clampPct(c.target) }));
    } else if (type === 'temperature') {
      fw.tempThreshold = Math.max(20, Math.min(80, parseInt(c.threshold, 10) || 28));
      fw.tempTarget = clampPct(c.target);
    }
    return fw;
  }
  // Map firmware config keys → the web blind-state.config keys (same names here).
  function mergeDeviceLocal(id, rulesPatch, configPatch) {
    try {
      const sv = savedBlindState(id);
      sv.rules = Object.assign({}, sv.rules, rulesPatch);
      sv.config = Object.assign({}, sv.config, configPatch);
      localStorage.setItem(`blind-state-${id}`, JSON.stringify(sv));
    } catch (e) {}
  }

  // ── Reliable per-device config push (multi-device ConfigSync) ─
  const ConfigPush = {
    key() { return `zaylo-spaces-cfgpush-${homeSuffix()}`; },
    pending() { try { return JSON.parse(localStorage.getItem(this.key()) || '{}') || {}; } catch (e) { return {}; } },
    save(p) { try { localStorage.setItem(this.key(), JSON.stringify(p)); } catch (e) {} },
    nextRev() { return Date.now() & 0x7fffffff; },
    enqueue(id, rev, payload) {
      const p = this.pending();
      p[id] = { rev, payload, attempts: 0 };
      this.save(p);
      this._attempt(id);
    },
    _attempt(id) {
      const p = this.pending();
      const item = p[id];
      if (!item) return;
      if (connected() && typeof MQTTClient.publishConfig === 'function') {
        MQTTClient.publishConfig(id, item.payload);
        item.attempts = (item.attempts || 0) + 1;
        this.save(p);
      }
    },
    flush() {
      const p = this.pending();
      Object.keys(p).forEach(id => this._attempt(id));
    },
    handleState(id, state) {
      if (!state) return;
      const p = this.pending();
      const item = p[id];
      if (!item) return;
      let echoed = state.cfgRev;
      if (echoed === undefined && state.config) echoed = state.config.cfgRev;
      if (echoed !== undefined && Number.isFinite(Number(echoed))) {
        if (Number(echoed) >= item.rev) {
          delete p[id]; this.save(p);                       // device applied our config → done
        } else if (connected() && (item.attempts || 0) < 10) {
          this._attempt(id);                                // alive but stale (was offline when pushed) → resend
        }
      } else if ((item.attempts || 0) >= 8 && (state.position !== undefined || state.blindPosition !== undefined)) {
        // Older firmware that doesn't echo cfgRev — a full state proves delivery.
        delete p[id]; this.save(p);
      }
    }
  };

  // Recompute each device's managed rules from ALL automations and push.
  // `typesToAssert` forces a rule to be (re)emitted even when no automation of
  // that type remains — so deleting/disabling the last one of a type turns the
  // firmware rule OFF, instead of silently leaving it enabled on-device.
  function pushAutomationsToDevices(deviceIds, typesToAssert) {
    const autos = AutomationStore.all();
    const valid = new Set(blindIds());
    const assert = new Set(typesToAssert || []);
    deviceIds.filter(id => valid.has(id)).forEach(id => {
      const referenced = new Set();
      const enabledByType = {};
      autos.forEach(a => {
        if (!(a.deviceIds || []).includes(id)) return;
        referenced.add(a.type);
        if (a.enabled) enabledByType[a.type] = a; // last enabled of a type wins
      });
      // Emit every type still referenced here, plus any we were asked to assert.
      const emit = new Set([...referenced, ...assert]);
      const rules = {}; let config = {};
      AUTO_ORDER.forEach(type => {
        if (!emit.has(type)) return;
        const meta = AUTO_TYPES[type];
        const a = enabledByType[type];
        if (a) { rules[meta.rule] = true; Object.assign(config, typePatch(type, a.cfg)); }
        else { rules[meta.rule] = false; }
      });
      if (!Object.keys(rules).length) return;
      mergeDeviceLocal(id, rules, config);
      Object.assign(config, tzPayload());
      const rev = ConfigPush.nextRev();
      ConfigPush.enqueue(id, rev, { rules, config, cfgRev: rev });
    });
  }

  // ════════════════════════════════════════════════════════════
  //  RENDERING
  // ════════════════════════════════════════════════════════════
  const RING_C = 2 * Math.PI * 52;

  function renderConn() {
    const badge = document.getElementById('connBadge');
    const txt = document.getElementById('connText');
    if (!badge) return;
    const on = connected();
    badge.classList.toggle('online', on);
    if (txt) txt.textContent = on ? 'Live' : 'Offline';
  }

  function renderHero() {
    const ids = blindIds();
    const avg = averagePosition(ids);
    const onlineN = ids.filter(isOnline).length;
    const movingN = ids.filter(isMoving).length;

    const ring = document.getElementById('ringProg');
    const ringVal = document.getElementById('ringVal');
    if (ring) ring.style.strokeDashoffset = String(RING_C * (1 - (avg == null ? 0 : avg) / 100));
    if (ringVal) ringVal.textContent = avg == null ? '--' : avg + '%';

    const c = document.getElementById('chipCount');
    if (c) c.querySelector('span').textContent = `${ids.length} blind${ids.length !== 1 ? 's' : ''}`;
    const o = document.getElementById('chipOnline');
    if (o) o.querySelector('span').textContent = `${onlineN} online`;
    const m = document.getElementById('chipMoving');
    if (m) { m.style.display = movingN ? '' : 'none'; m.querySelector('span').textContent = `${movingN} moving`; }

    // master slider reflects avg unless being dragged
    if (!Master.dragging) Master.setVisual(avg == null ? 50 : avg);
    renderConn();
  }

  function renderScenes() {
    const grid = document.getElementById('sceneGrid');
    const cnt = document.getElementById('sceneCount');
    if (!grid) return;
    const scenes = SceneStore.all();
    if (cnt) cnt.textContent = scenes.length ? `· ${scenes.length}` : '';
    let html = scenes.map((s, i) => {
      const pal = scenePalette(s.icon);
      const n = sceneDeviceIds(s).length;
      const meta = (s.scope === 'all' ? 'All blinds' : `${n} blind${n !== 1 ? 's' : ''}`) + ` · ${targetLabel(s.target)}`;
      return `<div class="gp-scene" data-scene="${esc(s.id)}" style="--scene-ico-bg:${pal[0]};--scene-ico-fg:${pal[1]};--scene-ico-br:${pal[2]};--scene-glow:${pal[0]};animation-delay:${i * 0.05}s">
        <button class="gp-scene-edit" data-scene-edit="${esc(s.id)}" aria-label="Edit scene">${svgIcon('edit', 14)}</button>
        <div class="gp-scene-ico">${svgIcon(s.icon, 24)}</div>
        <div class="gp-scene-body">
          <div class="gp-scene-name">${esc(s.name)}</div>
          <div class="gp-scene-meta">${esc(meta)}</div>
        </div>
      </div>`;
    }).join('');
    html += `<div class="gp-scene add" id="sceneAddCard"><div class="gp-plus">${svgIcon('sparkles', 22)}</div><span>New Scene</span></div>`;
    grid.innerHTML = html;
  }

  function avatarStack(ids) {
    const shown = ids.slice(0, 4);
    let html = shown.map(id => `<div class="gp-avatar">${esc(deviceName(id).replace(/[^A-Za-z0-9]/g, '').slice(0, 1).toUpperCase() || 'B')}</div>`).join('');
    if (ids.length > 4) html += `<div class="gp-avatar more">+${ids.length - 4}</div>`;
    return `<div class="gp-avatars">${html}</div>`;
  }

  function groupRecords() {
    // Implicit "All Blinds" group always first, then custom groups.
    const all = { id: '__all', name: 'All Blinds', deviceIds: blindIds(), _all: true };
    return [all].concat(GroupStore.all());
  }
  function renderGroups() {
    const list = document.getElementById('groupList');
    const cnt = document.getElementById('groupCount');
    if (!list) return;
    const groups = groupRecords();
    const custom = groups.filter(g => !g._all);
    if (cnt) cnt.textContent = custom.length ? `· ${custom.length}` : '';
    list.innerHTML = groups.map((g, i) => {
      const ids = (g.deviceIds || []).filter(id => blindIds().includes(id));
      const avg = averagePosition(ids);
      const onlineN = ids.filter(isOnline).length;
      const posChip = avg == null ? '' : `<span class="gp-pos-chip ${avg === 0 ? 'closed' : ''}">${avg}% open</span>`;
      const editBtn = g._all ? '' : `<button class="gp-card-edit" data-group-edit="${esc(g.id)}" aria-label="Edit group">${svgIcon('edit', 16)}</button>`;
      const ctrls = ids.length ? `<div class="gp-group-ctrl">
          <button class="gp-mini" data-group-pos="${esc(g.id)}" data-pos="0">${svgIcon('moon', 15)}Close</button>
          <button class="gp-mini" data-group-pos="${esc(g.id)}" data-pos="50">Half</button>
          <button class="gp-mini" data-group-pos="${esc(g.id)}" data-pos="100">${svgIcon('sun', 15)}Open</button>
          <button class="gp-mini stop" data-group-stop="${esc(g.id)}">Stop</button>
        </div>` : `<div class="gp-group-ctrl" style="grid-template-columns:1fr"><div class="gp-mini" style="cursor:default;opacity:.6">No blinds in this group</div></div>`;
      return `<div class="gp-card" style="animation-delay:${i * 0.05}s">
        <div class="gp-card-head">
          <div class="gp-card-ico">${svgIcon(g._all ? 'home' : 'blinds', 23)}</div>
          <div class="gp-card-info">
            <div class="gp-card-name">${esc(g.name)} ${posChip}</div>
            <div class="gp-card-sub">${ids.length} blind${ids.length !== 1 ? 's' : ''} · ${onlineN} online ${ids.length ? avatarStack(ids) : ''}</div>
          </div>
          ${editBtn}
        </div>
        ${ctrls}
      </div>`;
    }).join('');
  }

  function renderAutomations() {
    const list = document.getElementById('autoList');
    const cnt = document.getElementById('autoCount');
    if (!list) return;
    const autos = AutomationStore.all().slice().sort((a, b) => AUTO_ORDER.indexOf(a.type) - AUTO_ORDER.indexOf(b.type));
    if (cnt) cnt.textContent = autos.length ? `· ${autos.length}` : '';
    if (!autos.length) {
      list.innerHTML = `<div class="gp-empty">
        <div class="gp-empty-ico">${svgIcon('bolt', 30)}</div>
        <h3>No automations yet</h3>
        <p>Create one schedule and apply it to many blinds at once. Each blind runs it on its own — even when your phone is away.</p>
      </div>`;
      return;
    }
    list.innerHTML = autos.map((a, i) => {
      const meta = AUTO_TYPES[a.type]; if (!meta) return '';
      const ids = (a.deviceIds || []).filter(id => blindIds().includes(id));
      return `<div class="gp-card ${a.enabled ? '' : 'disabled'}" style="--ico-bg:${meta.color[0]};--ico-fg:${meta.color[1]};--ico-br:${meta.color[2]};animation-delay:${i * 0.05}s">
        <div class="gp-accent-bar"></div>
        <div class="gp-card-head" style="padding-left:6px">
          <div class="gp-card-ico">${svgIcon(meta.icon, 23)}</div>
          <div class="gp-card-info">
            <div class="gp-card-name">${esc(a.name)}</div>
            <div class="gp-card-sub">${svgIcon('clock', 12)} ${esc(meta.summary(a.cfg))}</div>
          </div>
          <label class="gp-toggle" data-stop="1">
            <input type="checkbox" ${a.enabled ? 'checked' : ''} data-auto-toggle="${esc(a.id)}">
            <span class="tk"></span><span class="th"></span>
          </label>
        </div>
        <div class="gp-auto-foot">
          <div style="display:flex;align-items:center;gap:10px;min-width:0">
            ${ids.length ? avatarStack(ids) : ''}
            <span class="gp-card-sub" style="margin:0">${ids.length} blind${ids.length !== 1 ? 's' : ''}</span>
          </div>
          <div style="display:flex;align-items:center;gap:10px">
            <span class="gp-auto-target">${targetLabel(a.cfg.target)}</span>
            <button class="gp-card-edit" data-auto-edit="${esc(a.id)}" aria-label="Edit automation">${svgIcon('edit', 16)}</button>
          </div>
        </div>
      </div>`;
    }).join('');
  }

  function renderAll() { renderHero(); renderScenes(); renderGroups(); renderAutomations(); }

  // ════════════════════════════════════════════════════════════
  //  MASTER SLIDER
  // ════════════════════════════════════════════════════════════
  const Master = {
    dragging: false, value: 50,
    track: null, fill: null, handle: null, valueLabel: null,
    init() {
      this.track = document.getElementById('masterTrack');
      this.fill = document.getElementById('masterFill');
      this.handle = document.getElementById('masterHandle');
      this.valueLabel = document.getElementById('masterValueLabel');
      if (!this.track) return;
      const pointer = e => {
        const r = this.track.getBoundingClientRect();
        const cx = (e.touches && e.touches[0]) ? e.touches[0].clientX : e.clientX;
        return clampPct(((cx - r.left) / r.width) * 100);
      };
      const move = e => { if (!this.dragging) return; e.preventDefault(); this.setVisual(pointer(e)); };
      const end = () => {
        if (!this.dragging) return;
        this.dragging = false;
        this.track.classList.remove('dragging');
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', end);
        document.removeEventListener('pointercancel', end);
        applyPositionToDevices(blindIds(), this.value, `All blinds → ${this.value}%`);
      };
      this.track.addEventListener('pointerdown', e => {
        e.preventDefault();
        this.dragging = true;
        this.track.classList.add('dragging'); // kills CSS transitions for 1:1 drag
        try { this.track.setPointerCapture(e.pointerId); } catch (_) {}
        this.setVisual(pointer(e)); haptic('light');
        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', end);
        document.addEventListener('pointercancel', end);
      });
      this.track.addEventListener('keydown', e => {
        let v = this.value;
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') v = clampPct(v + 5);
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') v = clampPct(v - 5);
        else return;
        e.preventDefault(); this.setVisual(v);
        applyPositionToDevices(blindIds(), v, `Set to ${v}%`);
      });
    },
    setVisual(v) {
      this.value = clampPct(v);
      if (this.fill) this.fill.style.width = this.value + '%';
      // Keep the 28px knob fully inside the track at both extremes.
      if (this.handle) this.handle.style.left = 'calc(14px + (100% - 28px) * ' + (this.value / 100) + ')';
      if (this.valueLabel) this.valueLabel.textContent = this.value + '%';
      if (this.track) this.track.setAttribute('aria-valuenow', String(this.value));
    }
  };

  // ════════════════════════════════════════════════════════════
  //  TABS
  // ════════════════════════════════════════════════════════════
  function initTabs() {
    const tabs = document.getElementById('gpTabs');
    const pill = document.getElementById('tabPill');
    if (!tabs) return;
    const buttons = Array.from(tabs.querySelectorAll('.gp-tab'));
    function positionPill(btn, animate) {
      if (!pill || !btn) return;
      const cb = tabs.getBoundingClientRect();
      const bb = btn.getBoundingClientRect();
      if (!bb.width) return;
      if (animate === false) pill.style.transition = 'none';
      pill.style.width = bb.width + 'px';
      // Measure from rects (offsetLeft's reference doesn't match the pill's
      // absolute-positioning origin once container padding/border are involved).
      pill.style.transform = 'translateX(' + (bb.left - cb.left - tabs.clientLeft) + 'px)';
      if (animate === false) { void pill.offsetWidth; pill.style.transition = ''; }
    }
    function currentBtn() { return buttons.find(b => b.classList.contains('active')) || buttons[0]; }
    let _enterTimer = null;
    function activate(name, animate) {
      const btn = buttons.find(b => b.dataset.tab === name) || buttons[0];
      buttons.forEach(b => b.classList.toggle('active', b === btn));
      positionPill(btn, animate);
      let activePanel = null;
      document.querySelectorAll('.gp-panel').forEach(p => {
        const on = p.id === `panel-${name}`;
        p.classList.toggle('active', on);
        p.classList.remove('gp-entering');
        if (on) activePanel = p;
      });
      // Cascade the cards in on tab-entry only (transient class), then clear it so
      // live MQTT re-renders (renderGroups) don't re-trigger the entrance animation.
      if (activePanel) {
        void activePanel.offsetWidth;
        activePanel.classList.add('gp-entering');
        clearTimeout(_enterTimer);
        _enterTimer = setTimeout(() => activePanel.classList.remove('gp-entering'), 850);
      }
      try { localStorage.setItem('zaylo-spaces-tab', name); } catch (e) {}
    }
    buttons.forEach(b => b.addEventListener('click', () => { haptic('selection'); activate(b.dataset.tab, true); }));
    let initial = 'scenes';
    try { initial = localStorage.getItem('zaylo-spaces-tab') || 'scenes'; } catch (e) {}
    activate(initial, false);
    // Re-measure once layout + web fonts have settled, and on resize/orientation.
    requestAnimationFrame(() => positionPill(currentBtn(), false));
    setTimeout(() => positionPill(currentBtn(), false), 320);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => positionPill(currentBtn(), false));
    window.addEventListener('resize', () => positionPill(currentBtn(), false));
    // Re-measure whenever the tab bar itself changes size (font swap, orientation).
    if (window.ResizeObserver) { try { new ResizeObserver(() => positionPill(currentBtn(), false)).observe(tabs); } catch (e) {} }
  }

  // ════════════════════════════════════════════════════════════
  //  BOTTOM SHEET
  // ════════════════════════════════════════════════════════════
  const Sheet = {
    open(title, bodyHTML, footButtons) {
      document.getElementById('sheetTitle').textContent = title;
      document.getElementById('sheetBody').innerHTML = bodyHTML;
      const foot = document.getElementById('sheetFoot');
      foot.innerHTML = '';
      (footButtons || []).forEach(b => {
        const btn = document.createElement('button');
        btn.className = 'gp-btn ' + (b.cls || 'ghost');
        btn.innerHTML = b.html || b.label;
        btn.addEventListener('click', b.onClick);
        foot.appendChild(btn);
      });
      document.getElementById('sheetBackdrop').classList.add('open');
      const app = document.querySelector('.gp-app'); if (app) app.classList.add('sheet-lock');
    },
    close() {
      document.getElementById('sheetBackdrop').classList.remove('open');
      const app = document.querySelector('.gp-app'); if (app) app.classList.remove('sheet-lock');
    }
  };

  // device multiselect — returns { html, wire(root){...}, get() }
  function deviceMultiSelect(selectedIds) {
    const sel = new Set(selectedIds || []);
    const blinds = allBlinds();
    function row(d) {
      const id = String(d.id).toUpperCase();
      const pos = positionOf(id);
      const on = isOnline(id);
      return `<div class="gp-dev ${sel.has(id) ? 'sel' : ''}" data-dev="${esc(id)}">
        <div class="gp-dev-ico">${svgIcon('blinds', 19)}</div>
        <div class="gp-dev-info">
          <div class="gp-dev-name">${esc(deviceName(id))}</div>
          <div class="gp-dev-sub">${on ? 'Online' : 'Offline'}${pos != null ? ' · ' + pos + '% open' : ''}</div>
        </div>
        <div class="gp-check">${svgIcon('check', 14)}</div>
      </div>`;
    }
    const html = !blinds.length
      ? `<div class="gp-hint" style="text-align:center;padding:18px 0">No blinds found. Add a blind from the home screen first.</div>`
      : `<div class="gp-quick-pick"><button data-pick="all">Select all</button><button data-pick="none">Clear</button></div>
         <div class="gp-dev-list">${blinds.map(row).join('')}</div>`;
    return {
      html,
      wire(root) {
        root.querySelectorAll('[data-dev]').forEach(el => {
          el.addEventListener('click', () => {
            const id = el.dataset.dev;
            if (sel.has(id)) sel.delete(id); else sel.add(id);
            el.classList.toggle('sel', sel.has(id));
            haptic('light');
          });
        });
        root.querySelectorAll('[data-pick]').forEach(btn => {
          btn.addEventListener('click', () => {
            haptic('selection');
            if (btn.dataset.pick === 'all') blinds.forEach(d => sel.add(String(d.id).toUpperCase()));
            else sel.clear();
            root.querySelectorAll('[data-dev]').forEach(el => el.classList.toggle('sel', sel.has(el.dataset.dev)));
          });
        });
      },
      get() { return Array.from(sel); },
      isAll() { return blinds.length > 0 && sel.size === blinds.length; }
    };
  }

  // ── Scene editor ─────────────────────────────────────────────
  function openSceneEditor(existing) {
    const scene = existing || { id: uid('scene'), name: '', icon: 'sparkles', scope: 'all', deviceIds: [], target: 100 };
    let icon = scene.icon, target = clampPct(scene.target);
    const preIds = scene.scope === 'all' ? blindIds() : (scene.deviceIds || []);
    const ms = deviceMultiSelect(preIds);

    const body = `
      <div class="gp-field">
        <label class="gp-label">Scene name</label>
        <input class="gp-input" id="scName" placeholder="e.g. Movie Time" value="${esc(scene.name)}" maxlength="28">
      </div>
      <div class="gp-field">
        <label class="gp-label">Icon</label>
        <div class="gp-icon-grid" id="scIcons">
          ${SCENE_ICON_CHOICES.map(n => `<div class="gp-icon-opt ${n === icon ? 'sel' : ''}" data-icon="${n}">${svgIcon(n, 21)}</div>`).join('')}
        </div>
      </div>
      <div class="gp-field">
        <label class="gp-label">Set blinds to</label>
        <div class="gp-target-presets" id="scPresets">
          ${[['Close', 0], ['Half', 50], ['Open', 100]].map(([l, v]) => `<button class="gp-tp ${target === v ? 'sel' : ''}" data-v="${v}">${l}</button>`).join('')}
          <button class="gp-tp ${![0, 50, 100].includes(target) ? 'sel' : ''}" data-v="custom">Custom</button>
        </div>
        <div class="gp-slider-row">
          <input type="range" class="gp-range" id="scRange" min="0" max="100" step="1" value="${target}">
          <span class="gp-range-val" id="scRangeVal">${target}%</span>
        </div>
      </div>
      <div class="gp-field">
        <label class="gp-label">Blinds in this scene</label>
        ${ms.html}
      </div>`;

    const foot = [];
    if (existing) foot.push({ cls: 'danger-ghost', html: svgIcon('trash', 18), onClick: () => confirmDelete('scene', scene.id, scene.name) });
    foot.push({ cls: 'ghost', label: 'Cancel', onClick: () => Sheet.close() });
    foot.push({
      cls: 'primary', label: existing ? 'Save Scene' : 'Create Scene', onClick: () => {
        const name = (document.getElementById('scName').value || '').trim();
        if (!name) { toast('error', 'Give your scene a name'); return; }
        const ids = ms.get();
        if (!ids.length) { toast('error', 'Pick at least one blind'); return; }
        scene.name = name; scene.icon = icon; scene.target = target;
        scene.scope = ms.isAll() ? 'all' : 'custom';
        scene.deviceIds = ids;
        SceneStore.upsert(scene);
        haptic('success'); toast('success', existing ? 'Scene updated' : 'Scene created');
        Sheet.close(); renderScenes();
      }
    });

    Sheet.open(existing ? 'Edit Scene' : 'New Scene', body, foot);
    const root = document.getElementById('sheetBody');
    ms.wire(root);
    root.querySelectorAll('#scIcons .gp-icon-opt').forEach(el => el.addEventListener('click', () => {
      icon = el.dataset.icon; haptic('light');
      root.querySelectorAll('#scIcons .gp-icon-opt').forEach(x => x.classList.toggle('sel', x === el));
    }));
    const range = root.querySelector('#scRange'), rangeVal = root.querySelector('#scRangeVal');
    function syncPresets() { root.querySelectorAll('#scPresets .gp-tp').forEach(b => { const v = b.dataset.v; b.classList.toggle('sel', (v === 'custom' && ![0, 50, 100].includes(target)) || Number(v) === target); }); }
    range.addEventListener('input', () => { target = clampPct(range.value); rangeVal.textContent = target + '%'; syncPresets(); });
    root.querySelectorAll('#scPresets .gp-tp').forEach(b => b.addEventListener('click', () => {
      haptic('light');
      if (b.dataset.v !== 'custom') { target = Number(b.dataset.v); range.value = target; rangeVal.textContent = target + '%'; }
      syncPresets();
    }));
  }

  // ── Group editor ─────────────────────────────────────────────
  function openGroupEditor(existing) {
    const group = existing || { id: uid('group'), name: '', deviceIds: [] };
    const ms = deviceMultiSelect(group.deviceIds || []);
    const body = `
      <div class="gp-field">
        <label class="gp-label">Group name</label>
        <input class="gp-input" id="grName" placeholder="e.g. Living Room" value="${esc(group.name)}" maxlength="28">
      </div>
      <div class="gp-field">
        <label class="gp-label">Blinds in this group</label>
        ${ms.html}
      </div>`;
    const foot = [];
    if (existing) foot.push({ cls: 'danger-ghost', html: svgIcon('trash', 18), onClick: () => confirmDelete('group', group.id, group.name) });
    foot.push({ cls: 'ghost', label: 'Cancel', onClick: () => Sheet.close() });
    foot.push({
      cls: 'primary', label: existing ? 'Save Group' : 'Create Group', onClick: () => {
        const name = (document.getElementById('grName').value || '').trim();
        if (!name) { toast('error', 'Give your group a name'); return; }
        const ids = ms.get();
        if (!ids.length) { toast('error', 'Pick at least one blind'); return; }
        group.name = name; group.deviceIds = ids;
        GroupStore.upsert(group);
        haptic('success'); toast('success', existing ? 'Group updated' : 'Group created');
        Sheet.close(); renderGroups();
      }
    });
    Sheet.open(existing ? 'Edit Group' : 'New Group', body, foot);
    ms.wire(document.getElementById('sheetBody'));
  }

  // ── Automation editor ────────────────────────────────────────
  function openAutoEditor(existing) {
    const creating = !existing;
    let type = existing ? existing.type : 'morning';
    let cfg = existing ? JSON.parse(JSON.stringify(existing.cfg)) : JSON.parse(JSON.stringify(AUTO_TYPES[type].defaults));
    let name = existing ? existing.name : AUTO_TYPES[type].label;
    const ms = deviceMultiSelect(existing ? existing.deviceIds : blindIds());

    function triggerSection() {
      if (type === 'sunset') {
        return `<div class="gp-field"><label class="gp-label">Offset from sunset</label>
          ${stepperHTML('atOffset', cfg.offset, -120, 120, 5, v => `${v >= 0 ? '+' : ''}${v} min`)}
          <p class="gp-hint">Positive = after sunset, negative = before. Uses your home location.</p></div>`;
      }
      if (type === 'temperature') {
        return `<div class="gp-field"><label class="gp-label">Close when hotter than</label>
          ${stepperHTML('atThreshold', cfg.threshold, 20, 45, 1, v => `${v}°C`)}
          <p class="gp-hint">Outdoor temperature from the weather service for your location.</p></div>`;
      }
      // morning / night → time + days (+ duration for morning)
      const dur = type === 'morning' ? `<div class="gp-field"><label class="gp-label">Glide duration</label>
          ${stepperHTML('atDuration', cfg.duration, 1, 120, 5, v => `${v} min`)}
          <p class="gp-hint">How gradually the blinds move to the target.</p></div>` : '';
      return `<div class="gp-field"><label class="gp-label">Time</label>
          <input type="time" class="gp-input gp-time-input" id="atTime" value="${esc(cfg.time)}"></div>
        <div class="gp-field"><label class="gp-label">Repeat</label>
          <div class="gp-days" id="atDays">${DOW.map((d, i) => `<div class="gp-day ${cfg.days[i] ? 'sel' : ''}" data-d="${i}">${d}</div>`).join('')}</div></div>
        ${dur}`;
    }
    function targetSection() {
      const t = clampPct(cfg.target);
      return `<div class="gp-field"><label class="gp-label">Move blinds to</label>
        <div class="gp-target-presets" id="atPresets">
          ${[['Close', 0], ['Half', 50], ['Open', 100]].map(([l, v]) => `<button class="gp-tp ${t === v ? 'sel' : ''}" data-v="${v}">${l}</button>`).join('')}
          <button class="gp-tp ${![0, 50, 100].includes(t) ? 'sel' : ''}" data-v="custom">Custom</button>
        </div>
        <div class="gp-slider-row"><input type="range" class="gp-range" id="atRange" min="0" max="100" step="1" value="${t}"><span class="gp-range-val" id="atRangeVal">${t}%</span></div></div>`;
    }
    function typeSelector() {
      if (!creating) return '';
      return `<div class="gp-field"><label class="gp-label">Trigger type</label>
        <div class="gp-seg" id="atTypeSeg">${AUTO_ORDER.map(tk => `<button data-type="${tk}" class="${tk === type ? 'sel' : ''}">${svgIcon(AUTO_TYPES[tk].icon, 18)}${AUTO_TYPES[tk].label.split(' ')[0]}</button>`).join('')}</div></div>`;
    }

    let _swapTimer = null;
    function rebuild() {
      const meta = AUTO_TYPES[type];
      const dyn = document.getElementById('atDynamic');
      const blurb = document.getElementById('atBlurb');
      if (!dyn) return;
      clearTimeout(_swapTimer);
      // 1) slide + fade the current fields out
      dyn.classList.remove('gp-swap-in');
      dyn.classList.add('gp-swap-out');
      _swapTimer = setTimeout(() => {
        // 2) swap content while invisible
        dyn.innerHTML = triggerSection() + targetSection();
        if (blurb) {
          blurb.textContent = meta.blurb;
          blurb.style.animation = 'none'; void blurb.offsetWidth; blurb.style.animation = 'gpFade 0.45s ease';
        }
        wireDynamic();
        // 3) snap container back to place (no fade) and stagger the new fields in
        dyn.style.transition = 'none';
        dyn.classList.remove('gp-swap-out');
        void dyn.offsetWidth;
        dyn.style.transition = '';
        dyn.classList.add('gp-swap-in');
      }, 150);
    }
    function wireDynamic() {
      const root = document.getElementById('sheetBody');
      // time
      const tEl = root.querySelector('#atTime'); if (tEl) tEl.addEventListener('input', () => { cfg.time = tEl.value || cfg.time; });
      // days
      root.querySelectorAll('#atDays .gp-day').forEach(el => el.addEventListener('click', () => {
        const i = +el.dataset.d; cfg.days[i] = !cfg.days[i]; el.classList.toggle('sel', cfg.days[i]); haptic('light');
      }));
      // steppers
      wireStepper(root, 'atOffset', v => cfg.offset = v);
      wireStepper(root, 'atThreshold', v => cfg.threshold = v);
      wireStepper(root, 'atDuration', v => cfg.duration = v);
      // target
      const range = root.querySelector('#atRange'), rangeVal = root.querySelector('#atRangeVal');
      function syncPresets() { root.querySelectorAll('#atPresets .gp-tp').forEach(b => { const v = b.dataset.v; b.classList.toggle('sel', (v === 'custom' && ![0, 50, 100].includes(clampPct(cfg.target))) || Number(v) === clampPct(cfg.target)); }); }
      if (range) range.addEventListener('input', () => { cfg.target = clampPct(range.value); rangeVal.textContent = cfg.target + '%'; syncPresets(); });
      root.querySelectorAll('#atPresets .gp-tp').forEach(b => b.addEventListener('click', () => {
        haptic('light');
        if (b.dataset.v !== 'custom') { cfg.target = Number(b.dataset.v); if (range) { range.value = cfg.target; rangeVal.textContent = cfg.target + '%'; } }
        syncPresets();
      }));
    }

    const body = `
      <div class="gp-info-banner">${svgIcon('bolt', 18)}<p id="atBlurb">${esc(AUTO_TYPES[type].blurb)}</p></div>
      ${typeSelector()}
      <div class="gp-field"><label class="gp-label">Name</label>
        <input class="gp-input" id="atName" value="${esc(name)}" maxlength="28"></div>
      <div id="atDynamic">${triggerSection()}${targetSection()}</div>
      <div class="gp-field"><label class="gp-label">Apply to blinds</label>${ms.html}</div>`;

    const foot = [];
    if (existing) foot.push({ cls: 'danger-ghost', html: svgIcon('trash', 18), onClick: () => confirmDelete('automation', existing.id, existing.name) });
    foot.push({ cls: 'ghost', label: 'Cancel', onClick: () => Sheet.close() });
    foot.push({
      cls: 'primary', label: existing ? 'Save' : 'Create', onClick: () => {
        const nm = (document.getElementById('atName').value || '').trim() || AUTO_TYPES[type].label;
        const ids = ms.get();
        if (!ids.length) { toast('error', 'Pick at least one blind'); return; }
        if ((type === 'morning' || type === 'night') && !cfg.days.some(Boolean)) { toast('error', 'Pick at least one day'); return; }
        const rec = existing || { id: uid('auto'), enabled: true };
        const prevIds = existing ? (existing.deviceIds || []) : [];
        rec.type = type; rec.name = nm; rec.cfg = cfg; rec.deviceIds = ids;
        if (rec.enabled === undefined) rec.enabled = true;
        AutomationStore.upsert(rec);
        // Push to the union of old + new devices so removed ones get the rule cleared.
        // Assert this type so devices dropped from the automation get rules[type]=false.
        pushAutomationsToDevices(Array.from(new Set(prevIds.concat(ids))), [rec.type]);
        haptic('success');
        toast('success', existing ? 'Automation saved' : `"${nm}" added to ${ids.length} blind${ids.length !== 1 ? 's' : ''}`);
        Sheet.close(); renderAutomations();
      }
    });

    Sheet.open(existing ? 'Edit Automation' : 'New Automation', body, foot);
    const root = document.getElementById('sheetBody');
    ms.wire(root);
    wireDynamic();
    if (creating) {
      root.querySelectorAll('#atTypeSeg button').forEach(b => b.addEventListener('click', () => {
        type = b.dataset.type; haptic('selection');
        cfg = JSON.parse(JSON.stringify(AUTO_TYPES[type].defaults));
        if (!existing) { const nameEl = document.getElementById('atName'); if (nameEl && (!nameEl.value || Object.values(AUTO_TYPES).some(m => m.label === nameEl.value))) nameEl.value = AUTO_TYPES[type].label; }
        root.querySelectorAll('#atTypeSeg button').forEach(x => x.classList.toggle('sel', x === b));
        rebuild();
      }));
    }
  }

  // small stepper control (− value +) used in sheets
  function stepperHTML(id, val, min, max, step, fmt) {
    return `<div style="display:flex;align-items:center;gap:10px" data-stepper="${id}" data-min="${min}" data-max="${max}" data-step="${step}" data-val="${val}">
      <button type="button" data-step-dn style="width:46px;height:46px;border-radius:13px;border:1px solid var(--border-glass);background:var(--bg-glass);color:var(--text-primary);font-size:22px;font-weight:700;cursor:pointer">−</button>
      <div data-step-val style="flex:1;text-align:center;font-family:var(--font-display);font-size:20px;font-weight:800;color:#5eead4">${fmt(val)}</div>
      <button type="button" data-step-up style="width:46px;height:46px;border-radius:13px;border:1px solid var(--border-glass);background:var(--bg-glass);color:var(--text-primary);font-size:22px;font-weight:700;cursor:pointer">+</button>
    </div>`;
  }
  function wireStepper(root, id, onChange) {
    const box = root.querySelector(`[data-stepper="${id}"]`);
    if (!box) return;
    const min = +box.dataset.min, max = +box.dataset.max, step = +box.dataset.step;
    const valEl = box.querySelector('[data-step-val]');
    const fmt = id === 'atOffset' ? (v => `${v >= 0 ? '+' : ''}${v} min`) : id === 'atThreshold' ? (v => `${v}°C`) : (v => `${v} min`);
    function set(v) { v = Math.max(min, Math.min(max, v)); box.dataset.val = v; valEl.textContent = fmt(v); onChange(v); }
    box.querySelector('[data-step-dn]').addEventListener('click', () => { haptic('light'); set((+box.dataset.val) - step); });
    box.querySelector('[data-step-up]').addEventListener('click', () => { haptic('light'); set((+box.dataset.val) + step); });
  }

  // ── Delete confirmation ──────────────────────────────────────
  function confirmDelete(kind, id, name) {
    const labels = { scene: 'scene', group: 'group', automation: 'automation' };
    const run = () => {
      if (kind === 'scene') { SceneStore.remove(id); renderScenes(); }
      else if (kind === 'group') { GroupStore.remove(id); renderGroups(); }
      else if (kind === 'automation') {
        const a = AutomationStore.all().find(x => x.id === id);
        AutomationStore.remove(id);
        // Assert the deleted type so its firmware rule is turned OFF on those blinds
        // (it's no longer in the store, so it wouldn't be emitted otherwise).
        if (a) pushAutomationsToDevices(a.deviceIds || [], [a.type]);
        renderAutomations();
      }
      haptic('medium'); toast('success', `${labels[kind][0].toUpperCase() + labels[kind].slice(1)} deleted`);
      Sheet.close();
    };
    if (typeof Modal !== 'undefined' && Modal.confirm) {
      Modal.confirm(`Delete ${labels[kind]}?`, `"${name || 'This ' + labels[kind]}" will be removed.${kind === 'automation' ? ' The schedule will be turned off on its blinds.' : ''}`, run);
    } else { run(); }
  }

  // ════════════════════════════════════════════════════════════
  //  EVENT WIRING
  // ════════════════════════════════════════════════════════════
  function wireStaticEvents() {
    document.getElementById('backBtn').addEventListener('click', () => { haptic('light'); window.location.href = 'index.html'; });
    // theme
    const themeBtn = document.getElementById('themeToggle');
    if (themeBtn && typeof Theme !== 'undefined') {
      themeBtn.addEventListener('click', () => { haptic('light'); Theme.toggle(); });
    }
    // master buttons
    document.querySelectorAll('[data-master]').forEach(btn => btn.addEventListener('click', () => {
      const v = btn.dataset.master;
      if (v === 'stop') stopDevices(blindIds());
      else applyPositionToDevices(blindIds(), Number(v), targetLabel(Number(v)) + ' all');
    }));
    // add buttons
    document.getElementById('addSceneBtn').addEventListener('click', () => { haptic('selection'); openSceneEditor(null); });
    document.getElementById('addGroupBtn').addEventListener('click', () => { haptic('selection'); openGroupEditor(null); });
    document.getElementById('addAutoBtn').addEventListener('click', () => { haptic('selection'); openAutoEditor(null); });
    // sheet close
    document.getElementById('sheetClose').addEventListener('click', () => Sheet.close());
    document.getElementById('sheetBackdrop').addEventListener('click', e => { if (e.target.id === 'sheetBackdrop') Sheet.close(); });

    // delegated clicks for dynamic content
    document.getElementById('sceneGrid').addEventListener('click', e => {
      const edit = e.target.closest('[data-scene-edit]');
      if (edit) { e.stopPropagation(); const s = SceneStore.all().find(x => x.id === edit.dataset.sceneEdit); if (s) openSceneEditor(s); return; }
      if (e.target.closest('#sceneAddCard')) { haptic('selection'); openSceneEditor(null); return; }
      const card = e.target.closest('[data-scene]');
      if (card) { const s = SceneStore.all().find(x => x.id === card.dataset.scene); if (s) applyScene(s); }
    });
    document.getElementById('groupList').addEventListener('click', e => {
      const edit = e.target.closest('[data-group-edit]');
      if (edit) { const g = GroupStore.all().find(x => x.id === edit.dataset.groupEdit); if (g) openGroupEditor(g); return; }
      const posBtn = e.target.closest('[data-group-pos]');
      if (posBtn) {
        const g = groupRecords().find(x => x.id === posBtn.dataset.groupPos);
        if (g) applyPositionToDevices((g.deviceIds || []).filter(id => blindIds().includes(id)), Number(posBtn.dataset.pos), `${targetLabel(Number(posBtn.dataset.pos))} · ${g.name}`);
        return;
      }
      const stopBtn = e.target.closest('[data-group-stop]');
      if (stopBtn) { const g = groupRecords().find(x => x.id === stopBtn.dataset.groupStop); if (g) stopDevices((g.deviceIds || []).filter(id => blindIds().includes(id))); }
    });
    const autoList = document.getElementById('autoList');
    // Toggle uses `change` (clicks land on the visual track/thumb, not the input).
    autoList.addEventListener('change', e => {
      const tg = e.target.closest('[data-auto-toggle]');
      if (!tg) return;
      const a = AutomationStore.all().find(x => x.id === tg.dataset.autoToggle);
      if (a) {
        a.enabled = tg.checked; AutomationStore.upsert(a);
        pushAutomationsToDevices(a.deviceIds || [], [a.type]);
        haptic('selection'); toast(a.enabled ? 'success' : 'info', `${a.name} ${a.enabled ? 'on' : 'off'}`);
        renderAutomations();
      }
    });
    autoList.addEventListener('click', e => {
      const edit = e.target.closest('[data-auto-edit]');
      if (edit) { const a = AutomationStore.all().find(x => x.id === edit.dataset.autoEdit); if (a) openAutoEditor(a); }
    });
  }

  // ════════════════════════════════════════════════════════════
  //  MQTT
  // ════════════════════════════════════════════════════════════
  let _rafPending = false;
  function scheduleRender() {
    if (_rafPending) return; _rafPending = true;
    requestAnimationFrame(() => { _rafPending = false; renderHero(); renderGroups(); });
  }
  let _mqttReady = false;
  async function initMQTT() {
    if (typeof MQTTClient === 'undefined') { renderConn(); return; }
    if (_mqttReady) return; _mqttReady = true;
    try { MQTTClient.clearCallbacks(); } catch (e) {}
    try { MQTTClient.reconnectAttempts = 0; MQTTClient.reconnectDelay = 1000; } catch (e) {}
    try { if (MQTTClient.initVisibilityHandler) MQTTClient.initVisibilityHandler(); } catch (e) {}

    MQTTClient.on('onConnect', () => {
      renderConn();
      const ids = blindIds();
      // light sequential subscribe to avoid packet floods
      (function sub(i) {
        if (!MQTTClient.connected || i >= ids.length) { setTimeout(() => ConfigPush.flush(), 600); return; }
        const id = ids[i];
        if (/^[A-F0-9]+$/.test(id)) {
          try { MQTTClient.subscribeDevice(id); } catch (e) {}
          setTimeout(() => { if (MQTTClient.connected) MQTTClient.publishControl(id, { command: 'getState' }); }, 140);
        }
        setTimeout(() => sub(i + 1), 220);
      })(0);
      renderHero();
    });
    MQTTClient.on('onDisconnect', () => renderConn());
    MQTTClient.on('onStateUpdate', (id, state) => {
      ConfigPush.handleState(id, state);
      scheduleRender();
    });
    try { await MQTTClient.connect(); } catch (e) { renderConn(); }
  }

  // ════════════════════════════════════════════════════════════
  //  BOOTSTRAP
  // ════════════════════════════════════════════════════════════
  document.addEventListener('DOMContentLoaded', async () => {
    if (typeof Theme !== 'undefined') Theme.init();

    // Self-heal a corrupted/empty broker WebSocket path — mqtt.js's `?? '/mqtt'`
    // only catches null/undefined, not '' — so opening this page directly (PWA
    // shortcut / bookmark) without going through index.html still connects.
    try { if (localStorage.getItem('zaylo-BrokerPath') === '') localStorage.setItem('zaylo-BrokerPath', '/mqtt'); } catch (e) {}

    // Resolve home for scoped storage (mirrors blind-device.js)
    try {
      if (typeof HomeService !== 'undefined' && typeof Auth !== 'undefined') {
        let tries = 0;
        while (!Auth.getUser() && tries < 10) { await new Promise(r => setTimeout(r, 300)); tries++; }
        const user = Auth.getUser();
        if (user) {
          await HomeService.init();
          const homeId = await HomeService.getActiveHome(user.uid);
          if (homeId) { window.activeHomeId = homeId; if (typeof DeviceList !== 'undefined' && DeviceList.setHome) DeviceList.setHome(homeId); }
        }
      }
    } catch (e) { /* offline / not signed in — fall back to cached scope */ }

    seedDefaultScenesOnce();
    Master.init();
    initTabs();
    wireStaticEvents();
    renderAll();

    try { await initMQTT(); } catch (e) { /* ignore */ }

    // periodic light refresh for live position/online updates
    setInterval(() => { renderHero(); }, 8000);
  });

})();
