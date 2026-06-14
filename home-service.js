/**
 * Zaylo — Home Service
 * Multi-user shared access: homes, members, roles, share codes, migration
 *
 * Firestore Structure:
 *   homes/{homeId}          — { name, ownerId, createdAt }
 *   homes/{homeId}/members/{userId}  — { role, displayName, joinedAt }
 *   homes/{homeId}/devices/{deviceId} — (same schema as before)
 *   users/{userId}          — { activeHomeId, deviceOrder }
 *   users/{userId}/homes/{homeId}    — { name, role }  (denormalized index)
 *   shareCodes/{code}       — { homeId, homeName, createdBy, createdAt, expiresAt, maxUses, uses }
 */

const HomeService = {
    db: null,
    _initialized: false,
    _initPromise: null,
    SHARE_CODE_PATTERN: /^[A-HJ-NP-Z2-9]{6}$/,

    // ─── Cache ────────────────────────────────────────────
    _activeHomeId: null,   // in-memory cache (also set on window.activeHomeId)
    _activeHomeResolve: null,
    _activeHomePromise: null,

    // ====================================================
    // Initialization
    // ====================================================

    async init() {
        if (this._initialized) return;
        if (this._initPromise) return this._initPromise;
        this._initPromise = this._doInit();
        await this._initPromise;
    },

    async _doInit() {
        try {
            // Wait for Auth
            if (typeof Auth !== 'undefined' && !Auth.initialized) {
                await Auth.init();
            }

            if (typeof firebase === 'undefined' || typeof firebase.firestore !== 'function') {
                console.error('[HomeService] Firebase Firestore compat SDK not loaded.');
                return;
            }

            this.db = firebase.firestore();
            this._initialized = true;
            if (window.DEBUG) console.log('[HomeService] Initialized (compat)');
        } catch (error) {
            console.error('[HomeService] Init error:', error);
            throw error;
        }
    },

    // ====================================================
    // Home CRUD
    // ====================================================

    /**
     * Create a new home and add the creator as owner.
     * @param {string} userId
     * @param {string} homeName
     * @returns {string} homeId
     */
    async createHome(userId, homeName) {
        if (!this._initialized) await this.init();

        const homeRef = this.db.collection('homes').doc();
        const homeId = homeRef.id;
        const now = Date.now();
        const displayName = this._getUserDisplayName();

        // IMPORTANT: Sequential writes, NOT a batch.
        // Firestore security rules evaluate each batch write independently.
        // If we create the home + member in one batch, the member creation
        // rule can't verify the home's ownerId (it doesn't exist yet).
        // Sequential writes ensure each step's prerequisites exist.

        // Step 1: Create home document
        await homeRef.set({
            name: homeName,
            ownerId: userId,
            createdAt: now
        });

        // Step 2: Add owner as member (home doc now exists, rules can verify ownerId)
        await homeRef.collection('members').doc(userId).set({
            role: 'owner',
            displayName: displayName,
            joinedAt: now
        });

        // Step 3: Add to user's homes index (user's own doc, always writable)
        await this.db.collection('users').doc(userId)
            .collection('homes').doc(homeId).set({
                name: homeName,
                role: 'owner'
            });

        if (window.DEBUG) console.log(`[HomeService] Created home "${homeName}" (${homeId})`);
        return homeId;
    },

    /**
     * Rename a home (owner only).
     */
    async renameHome(homeId, newName, userId) {
        if (!this._initialized) await this.init();
        if (!homeId || !newName) return false;

        try {
            const homeRef = this.db.collection('homes').doc(homeId);
            const homeDoc = await homeRef.get();
            if (!homeDoc.exists || homeDoc.data().ownerId !== userId) {
                console.error('[HomeService] Not the owner or home not found');
                return false;
            }

            const batch = this.db.batch();
            batch.update(homeRef, { name: newName });

            // Update denormalized name for ALL members
            const membersSnap = await homeRef.collection('members').get();
            membersSnap.forEach(memberDoc => {
                const memberUserId = memberDoc.id;
                const userHomeRef = this.db.collection('users').doc(memberUserId)
                    .collection('homes').doc(homeId);
                batch.update(userHomeRef, { name: newName });
            });

            await batch.commit();
            return true;
        } catch (error) {
            console.error('[HomeService] Rename error:', error);
            return false;
        }
    },

    // ====================================================
    // Home Listing & Active Home
    // ====================================================

    /**
     * List all homes the user belongs to.
     * Reads from the fast denormalized index: users/{userId}/homes
     * @returns {Array<{id, name, role}>}
     */
    async getHomes(userId) {
        if (!this._initialized) await this.init();
        if (!userId) return [];

        try {
            const snap = await this.db.collection('users').doc(userId)
                .collection('homes').get();
            const homes = [];
            snap.forEach(doc => {
                homes.push({ id: doc.id, ...doc.data() });
            });
            return homes;
        } catch (error) {
            console.error('[HomeService] getHomes error:', error);
            return [];
        }
    },

    /**
     * Get (or auto-create) the user's activeHomeId.
     * Handles first-time users, migration from legacy structure, and caching.
     * This is the primary entry point — must be called before any DeviceService work.
     * @returns {string} homeId
     */
    async getActiveHome(userId) {
        if (!this._initialized) await this.init();

        // 1. Return from memory cache
        if (this._activeHomeId) {
            return this._activeHomeId;
        }

        // 2. Prevent concurrent calls from racing
        if (this._activeHomePromise) {
            return this._activeHomePromise;
        }

        this._activeHomePromise = this._resolveActiveHome(userId);
        try {
            const homeId = await this._activeHomePromise;
            return homeId;
        } finally {
            this._activeHomePromise = null;
        }
    },

    /**
     * Internal: resolve the active home (read Firestore, migrate, or create).
     */
    async _resolveActiveHome(userId) {
        try {
            // Read user doc for activeHomeId
            const userRef = this.db.collection('users').doc(userId);
            const userDoc = await userRef.get();

            if (userDoc.exists && userDoc.data().activeHomeId) {
                const homeId = userDoc.data().activeHomeId;

                // Verify the home still exists and user is a member
                const memberDoc = await this.db.collection('homes').doc(homeId)
                    .collection('members').doc(userId).get();
                if (memberDoc.exists) {
                    this._setActiveHomeCache(homeId);
                    return homeId;
                }
                // Home was deleted or user was removed — fall through
                console.warn('[HomeService] activeHomeId points to invalid home, re-resolving...');
            }

            // Check if user has any homes at all
            const homes = await this.getHomes(userId);
            if (homes.length > 0) {
                // Pick the first owned home, or first available
                const owned = homes.find(h => h.role === 'owner');
                const homeId = (owned || homes[0]).id;
                await userRef.set({ activeHomeId: homeId }, { merge: true });
                this._setActiveHomeCache(homeId);
                return homeId;
            }

            // No homes at all — check for legacy devices to migrate
            const legacyDevicesSnap = await this.db.collection('users').doc(userId)
                .collection('devices').get();

            if (!legacyDevicesSnap.empty) {
                if (window.DEBUG) console.log('[HomeService] Found legacy devices, migrating...');
                const homeId = await this.migrateUserDevices(userId);
                this._setActiveHomeCache(homeId);
                return homeId;
            }

            // Brand new user — create default home
            if (window.DEBUG) console.log('[HomeService] New user, creating default home');
            const homeId = await this.createHome(userId, 'My Home');
            await userRef.set({ activeHomeId: homeId }, { merge: true });
            this._setActiveHomeCache(homeId);
            return homeId;

        } catch (error) {
            console.error('[HomeService] _resolveActiveHome error:', error);
            throw error;
        }
    },

    /**
     * Switch the user's active home.
     */
    async setActiveHome(userId, homeId) {
        if (!this._initialized) await this.init();
        await this.db.collection('users').doc(userId)
            .set({ activeHomeId: homeId }, { merge: true });
        this._setActiveHomeCache(homeId);
        if (window.DEBUG) console.log(`[HomeService] Switched active home to ${homeId}`);
    },

    /**
     * Set the in-memory + window global cache for activeHomeId.
     */
    _setActiveHomeCache(homeId) {
        this._activeHomeId = homeId;
        window.activeHomeId = homeId;
        try {
            localStorage.setItem('zaylo-activeHomeId', homeId);
        } catch(e) {}
    },

    /**
     * Clear the cached activeHomeId (e.g. on sign-out).
     */
    clearCache() {
        this._activeHomeId = null;
        window.activeHomeId = null;
        try {
            localStorage.removeItem('zaylo-activeHomeId');
        } catch(e) {}
    },

    // ====================================================
    // Members
    // ====================================================

    /**
     * Get all members of a home.
     * @returns {Array<{userId, role, displayName, joinedAt}>}
     */
    async getMembers(homeId) {
        if (!this._initialized) await this.init();
        if (!homeId) return [];

        try {
            const snap = await this.db.collection('homes').doc(homeId)
                .collection('members').get();
            const members = [];
            snap.forEach(doc => {
                members.push({ userId: doc.id, ...doc.data() });
            });
            // Sort: owner first, then by joinedAt
            members.sort((a, b) => {
                if (a.role === 'owner' && b.role !== 'owner') return -1;
                if (b.role === 'owner' && a.role !== 'owner') return 1;
                return (a.joinedAt || 0) - (b.joinedAt || 0);
            });
            return members;
        } catch (error) {
            console.error('[HomeService] getMembers error:', error);
            return [];
        }
    },

    /**
     * Remove a member from a home (owner action).
     */
    async removeMember(homeId, targetUserId, requesterId) {
        if (!this._initialized) await this.init();

        try {
            // Verify requester is owner
            const homeDoc = await this.db.collection('homes').doc(homeId).get();
            if (!homeDoc.exists || homeDoc.data().ownerId !== requesterId) {
                console.error('[HomeService] Only the owner can remove members');
                return false;
            }
            if (targetUserId === requesterId) {
                console.error('[HomeService] Owner cannot remove themselves');
                return false;
            }

            const batch = this.db.batch();

            // Remove from home members
            batch.delete(this.db.collection('homes').doc(homeId)
                .collection('members').doc(targetUserId));

            // Remove from user's homes index
            batch.delete(this.db.collection('users').doc(targetUserId)
                .collection('homes').doc(homeId));

            // Do not edit the removed user's private profile document here.
            // On their next load, getActiveHome() detects the missing member doc
            // and resolves them onto another home or creates a fresh default.

            await batch.commit();
            if (window.DEBUG) console.log(`[HomeService] Removed ${targetUserId} from ${homeId}`);
            return true;
        } catch (error) {
            console.error('[HomeService] removeMember error:', error);
            return false;
        }
    },

    /**
     * Leave a home voluntarily (non-owner member).
     */
    async leaveHome(homeId, userId) {
        if (!this._initialized) await this.init();

        try {
            const homeDoc = await this.db.collection('homes').doc(homeId).get();
            if (!homeDoc.exists) return false;
            if (homeDoc.data().ownerId === userId) {
                console.error('[HomeService] Owner cannot leave — delete the home instead');
                return false;
            }

            const batch = this.db.batch();
            batch.delete(this.db.collection('homes').doc(homeId)
                .collection('members').doc(userId));
            batch.delete(this.db.collection('users').doc(userId)
                .collection('homes').doc(homeId));

            // Clear activeHomeId if it was this home
            const userDoc = await this.db.collection('users').doc(userId).get();
            if (userDoc.exists && userDoc.data().activeHomeId === homeId) {
                batch.update(this.db.collection('users').doc(userId), {
                    activeHomeId: firebase.firestore.FieldValue.delete()
                });
            }

            await batch.commit();

            // Clear local cache
            if (this._activeHomeId === homeId) {
                this.clearCache();
            }

            return true;
        } catch (error) {
            console.error('[HomeService] leaveHome error:', error);
            return false;
        }
    },

    /**
     * Delete a home entirely (owner only).
     * Removes all member references and the home document.
     * Does NOT delete devices sub-collection (Firestore limitation without Cloud Functions).
     */
    async deleteHome(homeId, requesterId) {
        if (!this._initialized) await this.init();

        try {
            const homeRef = this.db.collection('homes').doc(homeId);
            const homeDoc = await homeRef.get();
            if (!homeDoc.exists || homeDoc.data().ownerId !== requesterId) {
                console.error('[HomeService] Only the owner can delete a home');
                return false;
            }

            // Get all members to clean up their user-side references
            const membersSnap = await homeRef.collection('members').get();
            const batch = this.db.batch();

            membersSnap.forEach(memberDoc => {
                const memberUserId = memberDoc.id;
                // Remove home from member's homes list
                batch.delete(this.db.collection('users').doc(memberUserId)
                    .collection('homes').doc(homeId));
                // Remove member doc
                batch.delete(memberDoc.ref);
            });

            // Delete all devices in this home
            const devicesSnap = await homeRef.collection('devices').get();
            devicesSnap.forEach(deviceDoc => {
                batch.delete(deviceDoc.ref);
            });

            // Delete the home document itself
            batch.delete(homeRef);

            await batch.commit();

            // Clear cache if this was active home
            if (this._activeHomeId === homeId) {
                this.clearCache();
            }

            if (window.DEBUG) console.log(`[HomeService] Deleted home ${homeId}`);
            return true;
        } catch (error) {
            console.error('[HomeService] deleteHome error:', error);
            return false;
        }
    },

    // ====================================================
    // Share Codes
    // ====================================================

    /**
     * Generate a unique 6-character share code for a home.
     * Code expires after 24 hours. Max 10 uses.
     * @returns {{ code: string, expiresAt: number }}
     */
    async generateShareCode(homeId, userId) {
        if (!this._initialized) await this.init();

        try {
            // Verify user is owner
            const homeDoc = await this.db.collection('homes').doc(homeId).get();
            if (!homeDoc.exists || homeDoc.data().ownerId !== userId) {
                console.error('[HomeService] Only the owner can generate share codes');
                return null;
            }

            const now = Date.now();
            const expiresAt = now + (24 * 60 * 60 * 1000); // 24 hours

            let code = null;
            for (let attempt = 0; attempt < 8; attempt++) {
                const candidate = this._generateCode(6);
                const codeRef = this.db.collection('shareCodes').doc(candidate);
                const created = await this.db.runTransaction(async (transaction) => {
                    const existing = await transaction.get(codeRef);
                    if (existing.exists) return false;

                    transaction.set(codeRef, {
                        homeId: homeId,
                        homeName: homeDoc.data().name,
                        createdBy: userId,
                        createdAt: now,
                        expiresAt: expiresAt,
                        maxUses: 10,
                        uses: 0
                    });
                    return true;
                });

                if (created) {
                    code = candidate;
                    break;
                }
            }

            if (!code) {
                console.error('[HomeService] Failed to generate a unique share code');
                return null;
            }

            if (window.DEBUG) console.log(`[HomeService] Generated share code: ${code}`);
            return { code, expiresAt };
        } catch (error) {
            console.error('[HomeService] generateShareCode error:', error);
            return null;
        }
    },

    /**
     * Redeem a share code to join a home.
     * @returns {{ success: boolean, homeId?: string, homeName?: string, error?: string }}
     */
    async redeemShareCode(code, userId) {
        if (!this._initialized) await this.init();

        const cleanCode = (code || '').trim().toUpperCase();
        if (!this.SHARE_CODE_PATTERN.test(cleanCode)) {
            return { success: false, error: 'Invalid code format.' };
        }

        try {
            const codeRef = this.db.collection('shareCodes').doc(cleanCode);
            const inviteDisplayName = (this._getUserDisplayName() || 'User').toString().slice(0, 120) || 'User';

            const redemption = await this.db.runTransaction(async (transaction) => {
                const codeDoc = await transaction.get(codeRef);
                if (!codeDoc.exists) {
                    return { success: false, error: 'Invalid share code.' };
                }

                const data = codeDoc.data();
                if (Date.now() > data.expiresAt) {
                    return { success: false, error: 'This code has expired.' };
                }

                if ((data.uses || 0) >= data.maxUses) {
                    return { success: false, error: 'This code has reached its maximum uses.' };
                }

                const userHomeRef = this.db.collection('users').doc(userId)
                    .collection('homes').doc(data.homeId);
                const memberRef = this.db.collection('homes').doc(data.homeId)
                    .collection('members').doc(userId);

                const existingHome = await transaction.get(userHomeRef);
                const existingMember = await transaction.get(memberRef);
                if (existingHome.exists || existingMember.exists) {
                    return { success: false, error: 'You are already a member of this home.' };
                }

                const now = Date.now();
                transaction.set(memberRef, {
                    role: 'member',
                    displayName: inviteDisplayName,
                    joinedAt: now,
                    joinedViaCode: cleanCode
                });

                transaction.set(userHomeRef, {
                    name: data.homeName,
                    role: 'member'
                });

                transaction.update(codeRef, {
                    uses: firebase.firestore.FieldValue.increment(1)
                });

                return {
                    success: true,
                    homeId: data.homeId,
                    homeName: data.homeName
                };
            });

            if (redemption.success && window.DEBUG) {
                console.log(`[HomeService] Redeemed code ${cleanCode}, joined home ${redemption.homeId}`);
            }
            return redemption;

        } catch (error) {
            console.error('[HomeService] redeemShareCode error:', error);
            return { success: false, error: 'Failed to redeem code. Please try again.' };
        }
    },

    /**
     * Generate a random alphanumeric code.
     * @param {number} length
     * @returns {string}
     */
    _generateCode(length) {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 for readability
        let code = '';
        const array = new Uint8Array(length);
        crypto.getRandomValues(array);
        for (let i = 0; i < length; i++) {
            code += chars[array[i] % chars.length];
        }
        return code;
    },

    // ====================================================
    // Data Migration (Legacy users/{userId}/devices → homes)
    // ====================================================

    /**
     * Migrate a user's legacy devices to a new home.
     * Uses a Firestore WriteBatch for atomicity.
     * Steps:
     *   1. Read all devices from users/{userId}/devices
     *   2. Create a new home
     *   3. Batch-write all devices to homes/{homeId}/devices
     *   4. Set user's activeHomeId
     *   5. Delete old device documents from users/{userId}/devices
     *
     * @param {string} userId
     * @returns {string} homeId of the newly created home
     */
    async migrateUserDevices(userId) {
        if (!this._initialized) await this.init();

        console.info('[HomeService] ⚡ Starting device migration for user:', userId);

        try {
            // 1. Read ALL legacy devices
            const legacyCol = this.db.collection('users').doc(userId).collection('devices');
            const legacySnap = await legacyCol.get();

            if (legacySnap.empty) {
                console.info('[HomeService] No legacy devices found, creating empty home');
                const homeId = await this.createHome(userId, 'My Home');
                await this.db.collection('users').doc(userId)
                    .set({ activeHomeId: homeId }, { merge: true });
                return homeId;
            }

            const devices = [];
            legacySnap.forEach(doc => {
                devices.push({ docId: doc.id, ...doc.data() });
            });

            console.info(`[HomeService] Migrating ${devices.length} device(s)...`);

            // 2. Create home + member + user index SEQUENTIALLY
            //    (Firestore rules evaluate each write independently,
            //     so the home must exist before we can add members or devices)
            const homeRef = this.db.collection('homes').doc();
            const homeId = homeRef.id;
            const now = Date.now();
            const displayName = this._getUserDisplayName();

            // Step 2a: Create home document
            await homeRef.set({
                name: 'My Home',
                ownerId: userId,
                createdAt: now
            });

            // Step 2b: Add owner as member
            await homeRef.collection('members').doc(userId).set({
                role: 'owner',
                displayName: displayName,
                joinedAt: now
            });

            // Step 2c: Add to user's homes index
            await this.db.collection('users').doc(userId)
                .collection('homes').doc(homeId).set({
                    name: 'My Home',
                    role: 'owner'
                });

            // Step 2d: Set activeHomeId
            await this.db.collection('users').doc(userId)
                .set({ activeHomeId: homeId }, { merge: true });

            // 3. Now batch-copy all devices (home + member exist, rules will pass)
            const deviceBatch = this.db.batch();
            let batchCount = 0;

            devices.forEach(device => {
                const cleanId = device.docId.toUpperCase().replace(/[^A-F0-9]/g, '');
                if (!cleanId || cleanId.length < 4) return; // Skip corrupted
                const newDeviceRef = homeRef.collection('devices').doc(cleanId);
                const { docId, ...deviceData } = device; // strip the docId helper field
                deviceBatch.set(newDeviceRef, { ...deviceData, id: cleanId });
                batchCount++;
            });

            if (batchCount > 0) {
                await deviceBatch.commit();
            }

            console.info(`[HomeService] ✅ Migration committed. Home: ${homeId}, Devices: ${batchCount}`);

            // 4. Clean up old device docs (non-atomic, data is already safely copied)
            const deleteBatch = this.db.batch();
            legacySnap.forEach(doc => {
                deleteBatch.delete(doc.ref);
            });

            try {
                await deleteBatch.commit();
                console.info('[HomeService] ✅ Legacy device records cleaned up');
            } catch (cleanupError) {
                // Non-fatal — devices are already in the new home
                console.warn('[HomeService] ⚠ Legacy cleanup failed (non-fatal):', cleanupError);
            }

            return homeId;

        } catch (error) {
            console.error('[HomeService] ❌ Migration FAILED:', error);
            throw error;
        }
    },

    // ====================================================
    // Helpers
    // ====================================================

    /**
     * Get the current user's display name from Auth.
     */
    _getUserDisplayName() {
        if (typeof Auth !== 'undefined' && Auth.user) {
            return Auth.user.displayName || Auth.user.email || 'User';
        }
        return 'User';
    },

    /**
     * Get the role of the current user in the active home.
     * @returns {'owner'|'member'|null}
     */
    async getUserRole(homeId, userId) {
        if (!this._initialized) await this.init();
        if (!homeId || !userId) return null;

        try {
            const memberDoc = await this.db.collection('homes').doc(homeId)
                .collection('members').doc(userId).get();
            if (memberDoc.exists) {
                return memberDoc.data().role;
            }
            return null;
        } catch (error) {
            console.error('[HomeService] getUserRole error:', error);
            return null;
        }
    },

    /**
     * Get home details (name, ownerId).
     */
    async getHomeDetails(homeId) {
        if (!this._initialized) await this.init();
        if (!homeId) return null;

        try {
            const doc = await this.db.collection('homes').doc(homeId).get();
            if (doc.exists) {
                return { id: doc.id, ...doc.data() };
            }
            return null;
        } catch (error) {
            console.error('[HomeService] getHomeDetails error:', error);
            return null;
        }
    }
};

// Export for modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { HomeService };
}
