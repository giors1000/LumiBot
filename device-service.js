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
                // CRITICAL: Ensure ID is uppercase
                devices.push({ id: doc.id.toUpperCase(), ...doc.data() });
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

        const id = deviceId.toUpperCase().trim();

        console.log('[DeviceService] getDevice called:');
        console.log('[DeviceService]   userId:', userId);
        console.log('[DeviceService]   deviceId:', id);

        try {
            const deviceRef = this._doc(this.db, 'users', userId, 'devices', id);

            const docSnap = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js')
                .then(module => module.getDoc(deviceRef));

            if (docSnap.exists()) {
                const data = docSnap.data();
                return { id: docSnap.id.toUpperCase(), ...data };
            } else {
                console.log('[DeviceService] ⚠️ Device NOT found in Firebase:', id);
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

        const id = device.id.toUpperCase().trim();

        try {
            const deviceRef = this._doc(this.db, 'users', userId, 'devices', id);

            const deviceData = {
                id: id,
                name: device.name || `LumiBot-${id}`,
                addedAt: Date.now()
            };

            // Optional Servo Calibration Data (from Setup Wizard)
            if (device.angleOn !== undefined) deviceData.angleOn = device.angleOn;
            if (device.angleOff !== undefined) deviceData.angleOff = device.angleOff;

            await this._setDoc(deviceRef, deviceData);

            console.log(`[DeviceService] Added device ${id} for user`);
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
            console.log(`[DeviceService] Removing device ${id} for user ${userId}...`);
            const deviceRef = this._doc(this.db, 'users', userId, 'devices', id);

            // Wait for the delete to complete
            await this._deleteDoc(deviceRef);

            // Verify deletion
            const docSnap = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js')
                .then(module => module.getDoc(deviceRef));

            if (docSnap.exists()) {
                console.error('[DeviceService] ❌ Deletion verification failed: Device still exists');
                return false;
            }

            console.log(`[DeviceService] ✅ Successfully removed device ${id} from Firebase`);
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
            const deviceRef = this._doc(this.db, 'users', userId, 'devices', id);

            // Use setDoc with merge to ensure we create the document if it doesn't exist (Upsert)
            await this._setDoc(deviceRef, updates, { merge: true });

            console.log(`[DeviceService] ✅ Successfully updated device ${id} in Firebase`);
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
