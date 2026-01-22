/**
 * LumiBot - Firebase Device Service
 * Handles device storage in Firebase Firestore linked to user accounts
 * 
 * Firestore Structure:
 * users/{userId}/devices/{deviceId}
 *   - id: string (4-char device ID)
 *   - name: string
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
                console.log('[DeviceService] Waiting for Auth to initialize...');
                await Auth.init();
            }

            // Import Firestore modules
            const { getFirestore, collection, doc, getDocs, setDoc, deleteDoc, updateDoc, query, orderBy } =
                await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js');

            // Get Firestore instance from existing Firebase app
            if (!Auth.app) {
                console.error('[DeviceService] Auth not initialized');
                return;
            }

            this.db = getFirestore(Auth.app);

            // Store Firestore methods for later use
            this._collection = collection;
            this._doc = doc;
            this._getDocs = getDocs;
            this._setDoc = setDoc;
            this._deleteDoc = deleteDoc;
            this._updateDoc = updateDoc;
            this._query = query;
            this._orderBy = orderBy;

            this._initialized = true;
            console.log('[DeviceService] Firestore initialized');

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
            const devicesCol = this._getDevicesCollection(userId);

            let snapshot;
            try {
                // Try with ordering first
                const q = this._query(devicesCol, this._orderBy('addedAt', 'desc'));
                snapshot = await this._getDocs(q);
            } catch (orderError) {
                // Fallback to unordered query if addedAt index doesn't exist
                console.warn('[DeviceService] Ordered query failed, using unordered:', orderError.message);
                snapshot = await this._getDocs(devicesCol);
            }

            const devices = [];
            snapshot.forEach(doc => {
                devices.push({ id: doc.id, ...doc.data() });
            });

            console.log(`[DeviceService] Loaded ${devices.length} devices for user`);
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

        console.log('[DeviceService] getDevice called:');
        console.log('[DeviceService]   userId:', userId);
        console.log('[DeviceService]   deviceId:', deviceId);

        try {
            const deviceRef = this._doc(this.db, 'users', userId, 'devices', deviceId);
            console.log('[DeviceService]   Firestore path: users/', userId, '/devices/', deviceId);

            const docSnap = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js')
                .then(module => module.getDoc(deviceRef));

            if (docSnap.exists()) {
                const data = docSnap.data();
                console.log('[DeviceService] ✅ Device found in Firebase:');
                console.log('[DeviceService]   Raw data:', JSON.stringify(data, null, 2));
                console.log('[DeviceService]   Has sleepHistory:', !!data.sleepHistory);
                console.log('[DeviceService]   sleepHistory length:', data.sleepHistory?.length || 0);
                return { id: docSnap.id, ...data };
            } else {
                console.log('[DeviceService] ⚠️ Device NOT found in Firebase:', deviceId);
                return null;
            }
        } catch (error) {
            console.error('[DeviceService] ❌ Error loading device:', error);
            console.error('[DeviceService]   Error code:', error.code);
            console.error('[DeviceService]   Error message:', error.message);
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

        try {
            const deviceRef = this._doc(this.db, 'users', userId, 'devices', device.id);

            await this._setDoc(deviceRef, {
                id: device.id,
                name: device.name || `LumiBot-${device.id}`,
                addedAt: Date.now()
            });

            console.log(`[DeviceService] Added device ${device.id} for user`);
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

        try {
            const deviceRef = this._doc(this.db, 'users', userId, 'devices', deviceId);
            await this._deleteDoc(deviceRef);

            console.log(`[DeviceService] Removed device ${deviceId} for user`);
            return true;

        } catch (error) {
            console.error('[DeviceService] Error removing device:', error);
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
            console.error('[DeviceService] Invalid parameters for updateDevice:', { userId: !!userId, deviceId: !!deviceId, updates: !!updates });
            return false;
        }

        // Debug: Log what we're about to save
        console.log('[DeviceService] updateDevice called:');
        console.log('[DeviceService]   userId:', userId);
        console.log('[DeviceService]   deviceId:', deviceId);
        console.log('[DeviceService]   updates:', JSON.stringify(updates, null, 2));

        try {
            const deviceRef = this._doc(this.db, 'users', userId, 'devices', deviceId);
            console.log('[DeviceService]   Firestore path: users/', userId, '/devices/', deviceId);

            // Use setDoc with merge to ensure we create the document if it doesn't exist (Upsert)
            await this._setDoc(deviceRef, updates, { merge: true });

            console.log(`[DeviceService] ✅ Successfully updated device ${deviceId} in Firebase`);
            return true;

        } catch (error) {
            console.error('[DeviceService] ❌ Error updating device:', error);
            console.error('[DeviceService]   Error code:', error.code);
            console.error('[DeviceService]   Error message:', error.message);
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
            return devices.some(d => d.id === deviceId);
        } catch (error) {
            console.error('[DeviceService] Error checking device existence:', error);
            return false;
        }
    },

    /**
     * Sync local storage devices to Firebase (migration helper)
     * Call this once when user first logs in to migrate their devices
     * @param {string} userId - Firebase user ID
     */
    async syncFromLocalStorage(userId) {
        if (!this._initialized) await this.init();
        if (!userId) return;

        const localDevices = Storage.get('LumiBot-devices', []);
        if (localDevices.length === 0) {
            console.log('[DeviceService] No local devices to sync');
            return;
        }

        console.log(`[DeviceService] Syncing ${localDevices.length} local devices to Firebase`);

        for (const device of localDevices) {
            const exists = await this.deviceExists(userId, device.id);
            if (!exists) {
                await this.addDevice(userId, device);
            }
        }

        console.log('[DeviceService] Local storage sync complete');
    }
};

// Export for modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { DeviceService };
}
