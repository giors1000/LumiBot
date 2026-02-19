/**
 * LumiBot - Firebase Device Service
 * Handles device storage in Firebase Firestore linked to user accounts
 * 
 * Firestore Structure:
 * users/{userId}/devices/{deviceId}
 *   - id: string (4-char device ID)
 *   - name: string
 *   - type: string (optional, 'lumibot' or 'blind')
 *   - addedAt: timestamp
 */

const DeviceService = {
    db: null,
    userId: null,
    _initialized: false,
    _initPromise: null,

    /**
     * Initialize Firestore connection
     * Must be called after Auth.init()
     */
    async init() {
        if (this._initialized) return;
        if (this._initPromise) return this._initPromise;

        this._initPromise = this._doInit();
        await this._initPromise;
    },

    async _doInit() {
        try {
            // Wait for Auth to be initialized first
            if (!Auth.initialized) {
                if (window.DEBUG) console.log('[DeviceService] Waiting for Auth to initialize...');
                await Auth.init();
            }

            // CRITICAL FIX: Use the compat API (firebase.firestore()) that is already
            // loaded via <script> tags in the HTML pages (firebase-firestore-compat.js).
            // Previously this used dynamic import() to load ES modules, which conflicts.
            if (typeof firebase === 'undefined' || typeof firebase.firestore !== 'function') {
                console.error('[DeviceService] Firebase Firestore compat SDK not loaded.');
                return;
            }

            // Get Firestore instance from existing Firebase app
            if (!Auth.app) {
                console.error('[DeviceService] Auth not initialized');
                return;
            }

            this.db = firebase.firestore();

            // Store compat Firestore methods as wrappers
            this._collection = (db, ...pathSegs) => db.collection(pathSegs.join('/'));
            this._doc = (db, ...pathSegs) => db.doc(pathSegs.join('/'));
            this._getDocs = (ref) => ref.get();
            this._setDoc = (ref, data, opts) => opts?.merge ? ref.set(data, { merge: true }) : ref.set(data);
            this._deleteDoc = (ref) => ref.delete();
            this._updateDoc = (ref, data) => ref.update(data);
            this._query = (ref, ...queryConstraints) => ref; // compat uses chaining, handled below
            this._orderBy = (field, dir) => ({ field, dir }); // store for later use
            this._onSnapshot = (ref, onNext, onError) => ref.onSnapshot(onNext, onError);

            // Override _getDevicesCollection to use compat chaining
            this._getDevicesCollection = (userId) => {
                return this.db.collection('users').doc(userId).collection('devices');
            };

            this._initialized = true;
            if (window.DEBUG) console.log('[DeviceService] Firestore initialized (compat)');

        } catch (error) {
            console.error('[DeviceService] Init error:', error);
            throw error;
        }
    },

    /**
     * Get devices collection reference for a user
     */
    _getDevicesCollection(userId) {
        return this._collection(this.db, 'users', userId, 'devices');
    },

    /**
     * Subscribe to real-time updates for a SINGLE device
     * @param {string} userId - Firebase user ID
     * @param {string} deviceId - Device ID to watch
     * @param {function} onUpdate - Callback with device object
     * @returns {function} Unsubscribe function
     */
    async subscribeToDevice(userId, deviceId, onUpdate) {
        if (!this._initialized) await this.init();
        if (!userId || !deviceId) return () => { };

        const id = deviceId.toUpperCase().trim();

        try {
            const deviceRef = this.db.collection('users').doc(userId).collection('devices').doc(id);

            return deviceRef.onSnapshot((docSnap) => {
                if (docSnap.exists) {
                    onUpdate({ id: docSnap.id.toUpperCase(), ...docSnap.data() });
                } else {
                    // device deleted
                    onUpdate(null);
                }
            }, (error) => {
                console.error('[DeviceService] Device subscription error:', error);
            });
        } catch (error) {
            console.error('[DeviceService] Device subscribe setup error:', error);
            return () => { };
        }
    },

    /**
     * Subscribe to real-time device updates
     * @param {string} userId - Firebase user ID
     * @param {function} onUpdate - Callback with devices array
     * @returns {function} Unsubscribe function
     */
    async subscribeToDevices(userId, onUpdate) {
        if (!this._initialized) await this.init();
        if (!userId) return () => { };

        try {
            const devicesCol = this.db.collection('users').doc(userId).collection('devices');
            let q;
            try {
                q = devicesCol.orderBy('addedAt', 'desc');
            } catch (e) {
                q = devicesCol;
            }

            return q.onSnapshot((snapshot) => {
                const devices = [];
                snapshot.forEach(doc => {
                    const cleanId = doc.id.toUpperCase().replace(/[^A-F0-9]/g, '');
                    if (cleanId) {
                        devices.push({ id: cleanId, ...doc.data() });
                    }
                });
                onUpdate(devices);
            }, (error) => {
                console.error('[DeviceService] Subscription error:', error);
            });
        } catch (error) {
            console.error('[DeviceService] Subscribe setup error:', error);
            return () => { };
        }
    },

    /**
     * Get all devices for current user
     * Returns array of device objects
     */
    async getDevices(userId) {
        if (!this._initialized) await this.init();
        if (!userId) {
            console.warn('[DeviceService] No user ID provided');
            return [];
        }

        try {
            const devicesCol = this.db.collection('users').doc(userId).collection('devices');

            let snapshot;
            try {
                // Try with ordering first
                snapshot = await devicesCol.orderBy('addedAt', 'desc').get();
            } catch (orderError) {
                // Fallback to unordered query if addedAt index doesn't exist
                console.warn('[DeviceService] Ordered query failed, using unordered:', orderError.message);
                snapshot = await devicesCol.get();
            }

            const devices = [];
            snapshot.forEach(doc => {
                // CRITICAL: Aggressively clean ID (remove spaces/garbage)
                // This prevents dirty data in Firebase from crashing the app
                const cleanId = doc.id.toUpperCase().replace(/[^A-F0-9]/g, '');
                if (cleanId) {
                    devices.push({ id: cleanId, ...doc.data() });
                } else {
                    console.warn(`[DeviceService] Skipping invalid/corrupt device ID in Firebase: "${doc.id}"`);
                }
            });

            if (window.DEBUG) console.log(`[DeviceService] Loaded ${devices.length} devices for user`);
            return devices;

        } catch (error) {
            console.error('[DeviceService] Error loading devices:', error);
            return [];
        }
    },

    /**
     * Get a single device for current user
     * @param {string} userId - Firebase user ID
     * @param {string} deviceId - Device ID to get
     * @returns {object|null} Device object or null if not found
     */
    async getDevice(userId, deviceId) {
        if (!this._initialized) await this.init();
        if (!userId || !deviceId) {
            console.warn('[DeviceService] getDevice: No user ID or device ID provided', { userId: !!userId, deviceId: !!deviceId });
            return null;
        }

        const id = deviceId.toUpperCase().trim();



        if (window.DEBUG) {
            console.log('[DeviceService] getDevice called:');
            console.log('[DeviceService]   userId:', userId);
            console.log('[DeviceService]   deviceId:', id);
        }

        try {
            const deviceRef = this.db.collection('users').doc(userId).collection('devices').doc(id);

            const docSnap = await deviceRef.get();

            if (docSnap.exists) {
                const data = docSnap.data();
                return { id: docSnap.id.toUpperCase(), ...data };
            } else {
                if (window.DEBUG) console.log('[DeviceService] ⚠️ Device NOT found in Firebase:', id);
                return null;
            }
        } catch (error) {
            console.error('[DeviceService] ❌ Error loading device:', error);
            return null;
        }
    },

    /**
     * Add a device to user's collection
     * @param {string} userId - Firebase user ID
     * @param {object} device - Device object with id and name
     * @returns {boolean} Success status
     */
    async addDevice(userId, device) {
        if (!this._initialized) await this.init();
        if (!userId || !device || !device.id) {
            console.error('[DeviceService] Invalid parameters for addDevice');
            return false;
        }

        const id = device.id.toUpperCase().replace(/[^A-F0-9]/g, '');

        try {
            const deviceRef = this.db.collection('users').doc(userId).collection('devices').doc(id);

            // Strict sanitization: Allow alphanumeric, spaces, hyphens, underscores
            // This prevents garbage characters like "" from corrupting the UI
            const defaultName = device.type === 'blind' ? `Blinds-${id}` : `LumiBot-${id}`;
            const rawName = device.name || defaultName;
            const cleanName = rawName.replace(/[^a-zA-Z0-9\s\-_]/g, '').trim() || defaultName;

            const deviceData = {
                id: id,
                name: cleanName,
                addedAt: Date.now()
            };

            // Preserve device type (e.g., 'blind')
            if (device.type) deviceData.type = device.type;

            // Optional Servo Calibration Data (from Setup Wizard)
            if (device.angleOn !== undefined) deviceData.angleOn = device.angleOn;
            if (device.angleOff !== undefined) deviceData.angleOff = device.angleOff;

            await deviceRef.set(deviceData);

            if (window.DEBUG) console.log(`[DeviceService] Added device ${id} for user`);
            return true;

        } catch (error) {
            console.error('[DeviceService] Error adding device:', error);
            return false;
        }
    },

    /**
     * Remove a device from user's collection
     * @param {string} userId - Firebase user ID
     * @param {string} deviceId - Device ID to remove
     * @returns {boolean} Success status
     */
    async removeDevice(userId, deviceId) {
        if (!this._initialized) await this.init();
        if (!userId || !deviceId) {
            console.error('[DeviceService] Invalid parameters for removeDevice');
            return false;
        }

        const id = deviceId.toUpperCase().trim();

        try {
            if (window.DEBUG) console.log(`[DeviceService] Removing device ${id} for user ${userId}...`);
            const deviceRef = this.db.collection('users').doc(userId).collection('devices').doc(id);

            // Wait for the delete to complete
            await deviceRef.delete();

            // Verify deletion
            const docSnap = await deviceRef.get();

            if (docSnap.exists) {
                console.error('[DeviceService] ❌ Deletion verification failed: Device still exists');
                return false;
            }

            if (window.DEBUG) console.log(`[DeviceService] ✅ Successfully removed device ${id} from Firebase`);
            return true;

        } catch (error) {
            console.error('[DeviceService] ❌ Error removing device:', error);
            console.error('[DeviceService]   Error code:', error.code);
            console.error('[DeviceService]   Error message:', error.message);
            return false;
        }
    },

    /**
     * Update a device's properties
     * @param {string} userId - Firebase user ID
     * @param {string} deviceId - Device ID to update
     * @param {object} updates - Object with properties to update
     * @returns {boolean} Success status
     */
    async updateDevice(userId, deviceId, updates) {
        if (!this._initialized) await this.init();
        if (!userId || !deviceId || !updates) {
            console.error('[DeviceService] Invalid parameters for updateDevice');
            return false;
        }

        const id = deviceId.toUpperCase().trim();

        try {
            const deviceRef = this.db.collection('users').doc(userId).collection('devices').doc(id);

            // Use set with merge to ensure we create the document if it doesn't exist (Upsert)
            await deviceRef.set(updates, { merge: true });

            if (window.DEBUG) console.log(`[DeviceService] ✅ Successfully updated device ${id} in Firebase`);
            return true;

        } catch (error) {
            console.error('[DeviceService] ❌ Error updating device:', error);
            return false;
        }
    },

    /**
     * Check if a device exists for user
     * @param {string} userId - Firebase user ID
     * @param {string} deviceId - Device ID to check
     * @returns {boolean} Whether device exists
     */
    async deviceExists(userId, deviceId) {
        if (!this._initialized) await this.init();
        if (!userId || !deviceId) return false;

        try {
            const devices = await this.getDevices(userId);
            // Check against uppercase ID
            return devices.some(d => d.id === deviceId.toUpperCase().trim());
        } catch (error) {
            console.error('[DeviceService] Error checking device existence:', error);
            return false;
        }
    },

    /**
     * Save device display order for a user
     * Stores the ordered array of device IDs on the user document
     * @param {string} userId - Firebase user ID
     * @param {Array<string>} orderedIds - Array of device IDs in display order
     * @returns {boolean} Success status
     */
    async saveDeviceOrder(userId, orderedIds) {
        if (!this._initialized) await this.init();
        if (!userId || !Array.isArray(orderedIds)) {
            console.error('[DeviceService] Invalid parameters for saveDeviceOrder');
            return false;
        }

        try {
            const userRef = this.db.collection('users').doc(userId);
            await userRef.set({ deviceOrder: orderedIds }, { merge: true });
            if (window.DEBUG) console.log(`[DeviceService] ✅ Device order saved (${orderedIds.length} devices)`);
            return true;
        } catch (error) {
            console.error('[DeviceService] ❌ Error saving device order:', error);
            return false;
        }
    },

    /**
     * Get saved device display order for a user
     * @param {string} userId - Firebase user ID
     * @returns {Array<string>|null} Array of device IDs in order, or null
     */
    async getDeviceOrder(userId) {
        if (!this._initialized) await this.init();
        if (!userId) return null;

        try {
            const userRef = this.db.collection('users').doc(userId);
            const docSnap = await userRef.get();

            if (docSnap.exists) {
                const data = docSnap.data();
                return data.deviceOrder || null;
            }
            return null;
        } catch (error) {
            console.error('[DeviceService] Error loading device order:', error);
            return null;
        }
    },

    /**
     * @deprecated This function is no longer used.
     * Firebase is now the source of truth for device list.
     * Local devices are only synced to Firebase if they were added within
     * the last 5 minutes (to handle offline additions).
     * See index.js loadFirebaseDevicesInBackground for the new sync logic.
     * 
     * WARNING: Using this function will re-add devices that were intentionally
     * deleted from Firebase, causing the "device comes back after delete" bug.
     * 
     * @param {string} userId - Firebase user ID
     */
    async syncFromLocalStorage(userId) {
        // NO-OP: This function is deprecated
        console.warn('[DeviceService] ⚠️ syncFromLocalStorage is DEPRECATED - Firebase is source of truth');
        // Previously this would sync local devices to Firebase, but that caused
        // deleted devices to be re-added. The new sync logic in index.js handles
        // this correctly by only syncing recently-added devices.
    }
};

// Export for modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { DeviceService };
}
