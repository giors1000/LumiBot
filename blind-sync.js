/**
 * Shared production-grade sync primitives for motorized blinds.
 *
 * Responsibilities:
 * - Durable position command queue shared by dashboard, Spaces, and device page.
 * - Separate pending targets from confirmed physical position in local cache.
 * - Ack-driven config sync using the firmware cfgRev echo.
 * - Ack-driven command receipt using the firmware lastCommandId echo when present.
 */
(function (global) {
    'use strict';

    const COMMAND_QUEUE_KEY = 'blind-command-queue-v2';
    const CFG_REGISTRY_KEY = 'blind-cfgsync-devices';
    const CFG_RETRY_MS = 5000;
    const CFG_MAX_ATTEMPTS = 8;
    const COMMAND_RETRY_MS = 3500;
    const COMMAND_MAX_ATTEMPTS = 5;
    // A position command queued while offline only stays valid for a SHORT
    // window. It used to survive 12 hours, which meant a tap made during a
    // broker outage could physically move the blind much later (e.g. at night
    // on reconnect) — the exact "blind moves by itself" failure the firmware's
    // retained-command clearing was built to prevent. 5 minutes rides out a
    // router/broker blip while guaranteeing a stale intent can never fire long
    // after the user has moved on; expired commands surface as 'expired' so the
    // UI can tell the user the tap did not happen.
    const POSITION_EXPIRY_MS = 5 * 60 * 1000;
    const IMMEDIATE_EXPIRY_MS = 15000;

    const cfgTimers = new Map();
    let commandFlushTimer = null;

    function cleanId(deviceId) {
        return String(deviceId || '').trim().toUpperCase();
    }

    function now() {
        return Date.now();
    }

    function clampPct(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return null;
        return Math.max(0, Math.min(100, Math.round(n)));
    }

    function readJson(key, fallback) {
        try {
            const parsed = JSON.parse(localStorage.getItem(key) || 'null');
            return parsed == null ? fallback : parsed;
        } catch (e) {
            return fallback;
        }
    }

    function writeJson(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
            return true;
        } catch (e) {
            return false;
        }
    }

    function cfgKey(deviceId) {
        return `blind-cfgsync-${cleanId(deviceId) || 'unknown'}`;
    }

    function cfgRevKey(deviceId) {
        return `blind-cfgsync-rev-${cleanId(deviceId) || 'unknown'}`;
    }

    function registerConfigDevice(deviceId) {
        const id = cleanId(deviceId);
        if (!id) return;
        const list = readJson(CFG_REGISTRY_KEY, []);
        if (!Array.isArray(list)) {
            writeJson(CFG_REGISTRY_KEY, [id]);
            return;
        }
        if (!list.includes(id)) {
            list.push(id);
            writeJson(CFG_REGISTRY_KEY, list);
        }
    }

    function removeConfigDevice(deviceId) {
        const id = cleanId(deviceId);
        if (!id) return;
        const list = readJson(CFG_REGISTRY_KEY, []);
        if (Array.isArray(list)) writeJson(CFG_REGISTRY_KEY, list.filter(x => x !== id));
    }

    function readSavedBlindState(deviceId) {
        const id = cleanId(deviceId);
        return readJson(`blind-state-${id}`, {});
    }

    function saveBlindState(deviceId, state) {
        const id = cleanId(deviceId);
        if (!id) return false;
        return writeJson(`blind-state-${id}`, state || {});
    }

    function dispatch(name, detail) {
        if (typeof global.dispatchEvent !== 'function' || typeof global.CustomEvent !== 'function') return;
        try { global.dispatchEvent(new CustomEvent(name, { detail })); } catch (e) {}
    }

    function commandQueue() {
        const list = readJson(COMMAND_QUEUE_KEY, []);
        return Array.isArray(list) ? list.filter(item => item && item.deviceId && item.payload) : [];
    }

    function saveCommandQueue(list) {
        writeJson(COMMAND_QUEUE_KEY, list);
        dispatch('zaylo:blind-command-queue-change', { pending: list.length, queue: list });
    }

    function commandKind(payload) {
        if (!payload || typeof payload !== 'object') return 'unknown';
        if (payload.command === 'emergencyStop') return 'emergencyStop';
        if (payload.command === 'stop') return 'stop';
        if (payload.jog !== undefined || payload.dir !== undefined) return 'jog';
        if (payload.position !== undefined || payload.blindPosition !== undefined) return 'position';
        return 'control';
    }

    function commandTarget(payload) {
        if (!payload || typeof payload !== 'object') return null;
        const raw = payload.blindPosition !== undefined ? payload.blindPosition : payload.position;
        return clampPct(raw);
    }

    function makeCommandId(deviceId) {
        return `${cleanId(deviceId)}-${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    }

    function withCommandId(deviceId, payload, existingId) {
        const id = existingId || payload.commandId || makeCommandId(deviceId);
        return { ...payload, commandId: id };
    }

    function updatePendingTarget(deviceId, target, status, commandId, source) {
        const id = cleanId(deviceId);
        if (!id || target === null) return;
        const saved = readSavedBlindState(id);
        saved.targetPosition = target;
        saved.pendingTargetPosition = target;
        saved.pendingCommandId = commandId || saved.pendingCommandId || null;
        saved.pendingCommandTs = now();
        saved.pendingCommandSource = source || saved.pendingCommandSource || 'app';
        saved.lastCommandStatus = status || 'pending';
        saved.isOpen = target > 0;
        saveBlindState(id, saved);
    }

    function clearPendingTarget(deviceId, reason) {
        const id = cleanId(deviceId);
        if (!id) return;
        const saved = readSavedBlindState(id);
        if (saved.pendingTargetPosition === undefined && saved.pendingCommandId === undefined) return;
        delete saved.pendingTargetPosition;
        delete saved.pendingCommandId;
        delete saved.pendingCommandTs;
        delete saved.pendingCommandSource;
        saved.lastCommandStatus = reason || 'confirmed';
        saveBlindState(id, saved);
    }

    function markRejected(deviceId, reason, target) {
        const id = cleanId(deviceId);
        if (!id) return;
        const saved = readSavedBlindState(id);
        delete saved.pendingTargetPosition;
        delete saved.pendingCommandId;
        delete saved.pendingCommandTs;
        saved.lastCommandStatus = 'rejected';
        saved.lastCommandRejectReason = reason || 'rejected';
        if (target !== null && target !== undefined) saved.lastCommandRejectedTarget = target;
        saveBlindState(id, saved);
    }

    function enqueueCommand(item) {
        const id = cleanId(item.deviceId);
        if (!id) return null;
        const kind = item.kind || commandKind(item.payload);
        const target = commandTarget(item.payload);
        const expiresAt = item.expiresAt || (now() + (kind === 'position' ? POSITION_EXPIRY_MS : IMMEDIATE_EXPIRY_MS));
        const commandId = item.commandId || item.payload.commandId || makeCommandId(id);
        const payload = withCommandId(id, item.payload, commandId);
        let list = commandQueue().filter(existing => {
            if (existing.deviceId !== id) return true;
            if (kind === 'position' && existing.kind === 'position') return false;
            if ((kind === 'stop' || kind === 'emergencyStop') && (existing.kind === 'stop' || existing.kind === 'emergencyStop')) return false;
            return true;
        });
        const queued = {
            id: commandId,
            commandId,
            deviceId: id,
            payload,
            kind,
            target,
            attempts: item.attempts || 0,
            createdAt: item.createdAt || now(),
            updatedAt: now(),
            expiresAt,
            source: item.source || 'app'
        };
        list.push(queued);
        saveCommandQueue(list);
        if (kind === 'position' && target !== null) updatePendingTarget(id, target, 'queued', commandId, queued.source);
        scheduleCommandFlush();
        return queued;
    }

    function removeQueuedCommand(deviceId, predicate) {
        const id = cleanId(deviceId);
        const before = commandQueue();
        const after = before.filter(item => {
            if (id && item.deviceId !== id) return true;
            return !predicate(item);
        });
        if (after.length !== before.length) saveCommandQueue(after);
    }

    function clearExecutedCommand(deviceId, payload) {
        const id = cleanId(deviceId);
        if (!id || !payload || typeof payload !== 'object') return;
        const commandId = payload.commandId || payload.cmdId;
        const kind = commandKind(payload);
        const target = commandTarget(payload);
        removeQueuedCommand(id, item => {
            if (commandId && (item.commandId === commandId || item.id === commandId || (item.payload && item.payload.commandId === commandId))) {
                return true;
            }
            return kind === 'position' && item.kind === 'position' && target !== null && item.target === target;
        });
    }

    function publishPayload(deviceId, payload) {
        if (!global.MQTTClient || typeof global.MQTTClient.publishStepperControl !== 'function') return false;
        return global.MQTTClient.publishStepperControl(deviceId, payload);
    }

    function clearMqttShortQueue(deviceId) {
        if (!global.MQTTClient || !global.MQTTClient.pendingMessages) return;
        const id = cleanId(deviceId);
        const topic = `lumibot/${id}/stepper/set_position`;
        try { global.MQTTClient.pendingMessages.delete(topic); } catch (e) {}
    }

    function sendCommand(deviceId, payload, options) {
        const id = cleanId(deviceId);
        if (!id || !payload || typeof payload !== 'object') return { sent: false, queued: false, reason: 'invalid' };
        const opts = options || {};
        const kind = commandKind(payload);
        const target = commandTarget(payload);
        const commandId = opts.commandId || payload.commandId || makeCommandId(id);
        const wirePayload = withCommandId(id, payload, commandId);
        if (kind === 'position' && target !== null) {
            updatePendingTarget(id, target, 'pending', commandId, opts.source || 'app');
        }

        const sent = publishPayload(id, wirePayload);
        if (sent) {
            if (kind === 'position' && target !== null) updatePendingTarget(id, target, 'sent', commandId, opts.source || 'app');
            if (kind === 'position' && target !== null && opts.persist !== false) {
                const queued = enqueueCommand({
                    deviceId: id,
                    payload: wirePayload,
                    kind,
                    target,
                    commandId,
                    attempts: 1,
                    source: opts.source || 'app'
                });
                return { sent: true, queued: !!queued, commandId, payload: wirePayload };
            }
            return { sent: true, queued: false, commandId, payload: wirePayload };
        }

        if (opts.persist === false) {
            clearMqttShortQueue(id);
            return { sent: false, queued: false, commandId, payload: wirePayload };
        }

        clearMqttShortQueue(id);
        const queued = enqueueCommand({
            deviceId: id,
            payload: wirePayload,
            kind,
            target,
            commandId,
            source: opts.source || 'app',
            expiresAt: opts.expiresAt
        });
        return { sent: false, queued: !!queued, commandId, payload: wirePayload };
    }

    function sendPosition(deviceId, position, options) {
        const target = clampPct(position);
        if (target === null) return { sent: false, queued: false, reason: 'invalid-position' };
        return sendCommand(deviceId, { blindPosition: target }, options);
    }

    function clearBySource(source, deviceId) {
        const src = String(source || '');
        if (!src) return false;
        const id = deviceId ? cleanId(deviceId) : null;
        const before = commandQueue();
        const after = before.filter(item => {
            if (!item || item.source !== src) return true;
            return id && cleanId(item.deviceId) !== id;
        });
        if (after.length !== before.length) {
            saveCommandQueue(after);
            return true;
        }
        return false;
    }

    function flushCommands() {
        if (!global.MQTTClient || !global.MQTTClient.connected) return false;
        let list = commandQueue();
        const ts = now();
        let changed = false;
        const survivors = [];

        list.forEach(item => {
            if (!item || item.expiresAt <= ts || item.attempts >= COMMAND_MAX_ATTEMPTS) {
                changed = true;
                if (item && item.kind === 'position') markRejected(item.deviceId, 'expired', item.target);
                return;
            }
            const sent = publishPayload(item.deviceId, item.payload);
            item.attempts = (item.attempts || 0) + 1;
            item.updatedAt = ts;
            changed = true;
            if (sent && item.kind !== 'position') {
                return;
            }
            survivors.push(item);
        });

        if (changed) saveCommandQueue(survivors);
        if (survivors.length) scheduleCommandFlush();
        return changed;
    }

    function scheduleCommandFlush(delay) {
        clearTimeout(commandFlushTimer);
        commandFlushTimer = setTimeout(flushCommands, delay || COMMAND_RETRY_MS);
    }

    function handleCommandState(deviceId, state) {
        const id = cleanId(deviceId);
        if (!id || !state) return false;
        let changed = false;

        const ackId = state.lastCommandId || state.commandId || state.cmdId;
        const ackResult = state.lastCommandResult || state.commandResult || state.cmdResult;
        if (ackId) {
            removeQueuedCommand(id, item => item.commandId === ackId || item.id === ackId);
            if (String(ackResult || '').toLowerCase().includes('reject')) {
                markRejected(id, state.lastCommandRejectReason || state.lastCommandRejected || ackResult, state.lastCommandTarget);
            }
            changed = true;
        }

        const rejectSeq = Number(state.lastCommandRejectedSeq || 0);
        const savedForReject = readSavedBlindState(id);
        const handledRejectSeq = Number(savedForReject._handledRejectSeq || 0);
        const hasNewReject = (state.lastCommandRejected || state.lastCommandRejectReason) &&
            (!Number.isFinite(rejectSeq) || rejectSeq === 0 || rejectSeq > handledRejectSeq);
        if (hasNewReject) {
            markRejected(id, state.lastCommandRejected || state.lastCommandRejectReason, state.lastCommandRejectedTarget);
            const updated = readSavedBlindState(id);
            if (Number.isFinite(rejectSeq) && rejectSeq > 0) updated._handledRejectSeq = rejectSeq;
            saveBlindState(id, updated);
            removeQueuedCommand(id, item => item.kind === 'position');
            changed = true;
        }

        const saved = readSavedBlindState(id);
        const pendingTarget = clampPct(saved.pendingTargetPosition);
        if (pendingTarget !== null) {
            const pos = clampPct(state.blindPosition !== undefined ? state.blindPosition : state.position);
            const target = clampPct(state.targetPosition);
            const isMoving = state.isMoving === true;
            if (!isMoving && pos !== null && Math.abs(pos - pendingTarget) <= 2) {
                clearPendingTarget(id, 'confirmed');
                removeQueuedCommand(id, item => item.kind === 'position' && item.target === pendingTarget);
                changed = true;
            } else if (target !== null && Math.abs(target - pendingTarget) <= 2) {
                saved.lastCommandStatus = 'accepted';
                saveBlindState(id, saved);
                changed = true;
            }
        }

        return changed;
    }

    function nextRevision(deviceId) {
        if (global.BlindSchema && typeof global.BlindSchema.nextRevision === 'function') {
            return global.BlindSchema.nextRevision(deviceId);
        }
        const key = cfgRevKey(deviceId);
        let last = parseInt(localStorage.getItem(key) || '0', 10);
        if (!Number.isFinite(last)) last = 0;
        let rev = last + 1;
        if (rev < 1 || rev > 0x7ffffffe) rev = 1;
        try { localStorage.setItem(key, String(rev)); } catch (e) {}
        return rev;
    }

    function buildConfigPayload(deviceId, savedState, rev) {
        if (global.BlindSchema && typeof global.BlindSchema.buildConfigPayload === 'function') {
            return global.BlindSchema.buildConfigPayload(deviceId, savedState, rev);
        }
        const saved = savedState || readSavedBlindState(deviceId);
        return {
            rules: saved.rules || {},
            config: saved.config || {},
            cfgRev: rev
        };
    }

    function queueConfigSync(deviceId, savedState, options) {
        const id = cleanId(deviceId);
        if (!id) return null;
        const opts = options || {};
        const rev = opts.rev || nextRevision(id);
        const payload = opts.payload || buildConfigPayload(id, savedState, rev);
        const item = {
            rev,
            payload,
            acked: false,
            attempts: 0,
            source: opts.source || 'app',
            updatedAt: now()
        };
        writeJson(cfgKey(id), item);
        registerConfigDevice(id);
        const sent = attemptConfigSync(id);
        return { rev, payload, sent };
    }

    function attemptConfigSync(deviceId) {
        const id = cleanId(deviceId);
        if (!id) return false;
        clearTimeout(cfgTimers.get(id));
        const item = readJson(cfgKey(id), null);
        if (!item || item.acked || !item.payload) return false;
        if (!global.MQTTClient || !global.MQTTClient.connected || typeof global.MQTTClient.publishConfig !== 'function') return false;

        const sent = global.MQTTClient.publishConfig(id, item.payload);
        item.attempts = (item.attempts || 0) + 1;
        item.updatedAt = now();
        writeJson(cfgKey(id), item);
        registerConfigDevice(id);

        if (sent && item.attempts < CFG_MAX_ATTEMPTS) {
            cfgTimers.set(id, setTimeout(() => attemptConfigSync(id), CFG_RETRY_MS));
        }
        return !!sent;
    }

    function flushConfigSync(deviceId) {
        return attemptConfigSync(deviceId);
    }

    function flushAllConfigSyncs(deviceIds) {
        const ids = Array.isArray(deviceIds) && deviceIds.length
            ? deviceIds.map(cleanId).filter(Boolean)
            : readJson(CFG_REGISTRY_KEY, []);
        (Array.isArray(ids) ? ids : []).forEach(id => attemptConfigSync(id));
    }

    function handleConfigState(deviceId, state) {
        const id = cleanId(deviceId);
        if (!id || !state) return false;
        const item = readJson(cfgKey(id), null);
        if (!item || item.acked || item.rev === undefined) return false;

        let echoed = state.cfgRev;
        if (echoed === undefined && state.config) echoed = state.config.cfgRev;
        if (echoed !== undefined && Number(echoed) === Number(item.rev)) {
            try { localStorage.removeItem(cfgKey(id)); } catch (e) {}
            removeConfigDevice(id);
            clearTimeout(cfgTimers.get(id));
            cfgTimers.delete(id);
            dispatch('zaylo:blind-config-synced', { deviceId: id, rev: item.rev });
            return true;
        }

        if (echoed !== undefined && global.MQTTClient && global.MQTTClient.connected && (item.attempts || 0) < CFG_MAX_ATTEMPTS) {
            attemptConfigSync(id);
        } else if ((item.attempts || 0) >= CFG_MAX_ATTEMPTS && (state.position !== undefined || state.blindPosition !== undefined)) {
            // Compatibility fallback for older firmware without cfgRev echo.
            try { localStorage.removeItem(cfgKey(id)); } catch (e) {}
            removeConfigDevice(id);
            return true;
        }
        return false;
    }

    function handleState(deviceId, state) {
        const a = handleCommandState(deviceId, state);
        const b = handleConfigState(deviceId, state);
        return a || b;
    }

    function init(options) {
        const opts = options || {};
        if (opts.deviceIds) {
            opts.deviceIds.map(cleanId).filter(Boolean).forEach(registerConfigDevice);
        }
        flushAllConfigSyncs(opts.deviceIds);
        flushCommands();
    }

    global.BlindCommandQueue = {
        send: sendCommand,
        sendPosition,
        enqueue: enqueueCommand,
        clearBySource,
        clearExecuted: clearExecutedCommand,
        flush: flushCommands,
        handleState: handleCommandState,
        markRejected,
        clearPendingTarget,
        getPending: commandQueue
    };

    global.BlindConfigSync = {
        queue: queueConfigSync,
        flush: flushConfigSync,
        flushAll: flushAllConfigSyncs,
        handleState: handleConfigState,
        init
    };

    global.BlindSync = {
        init,
        handleState,
        flushCommands,
        flushConfigSync: flushAllConfigSyncs,
        sendPosition,
        sendCommand,
        readSavedBlindState,
        saveBlindState
    };
})(window);
