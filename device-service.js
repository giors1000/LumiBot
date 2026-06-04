/**
 * Zaylo - Firebase Device Service
 * Handles device storage in Firebase Firestore linked to homes (multi-user)
 * 
 * Firestore Structure:
 * homes/{homeId}/devices/{deviceId}
 *   - id: string (4-char device ID)
 *   - name: string
 *   - type: string (optional, 'lumibot' or 'blind')
 *   - addedAt: timestamp
 *
 * NOTE: saveDeviceOrder / getDeviceOrder remain on users/{userId}
 * because device order is a per-user preference, not shared.
 */

const DeviceService = {
    db: null,
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
            this._initialized = true;
            if (window.DEBUG) console.log('[DeviceService] Firestore initialized (compat)');

        } catch (error) {
            console.error('[DeviceService] Init error:', error);
            throw error;
        }
    },

    /**
     * Get devices collection reference for a home
     * @param {string} homeId - Home ID
     */
    _getDevicesCollection(homeId) {
        return this.db.collection('homes').doc(homeId).collection('devices');
    },

    /**
     * Subscribe to real-time updates for a SINGLE device
     * @param {string} homeId - Home ID
     * @param {string} deviceId - Device ID to watch
     * @param {function} onUpdate - Callback with device object
     * @returns {function} Unsubscribe function
     */
    async subscribeToDevice(homeId, deviceId, onUpdate) {
        if (!this._initialized) await this.init();
        if (!homeId || !deviceId) return () => { };

        const targetCleanId = deviceId.toUpperCase().replace(/[^A-F0-9]/g, '');

        try {
            const devicesCol = this._getDevicesCollection(homeId);

            // Listen to all devices in the home and filter client-side for case-insensitivity
            return devicesCol.onSnapshot((snapshot) => {
                let found = false;
                snapshot.forEach(doc => {
                    const cleanId = doc.id.toUpperCase().replace(/[^A-F0-9]/g, '');
                    if (cleanId === targetCleanId) {
                        found = true;
                        onUpdate({ id: cleanId, ...doc.data() });
                    }
                });
                if (!found) {
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
     * Subscribe to real-time device updates for a home
     * @param {string} homeId - Home ID
     * @param {function} onUpdate - Callback with devices array
     * @returns {function} Unsubscribe function
     */
    async subscribeToDevices(homeId, onUpdate) {
        if (!this._initialized) await this.init();
        if (!homeId) return () => { };

        try {
            const devicesCol = this._getDevicesCollection(homeId);

            return devicesCol.onSnapshot((snapshot) => {
                const devices = [];
                snapshot.forEach(doc => {
                    const rawId = doc.id;
                    const cleanId = rawId.toUpperCase().replace(/[^A-F0-9]/g, '');

                    // Filter out devices with unrecognized ID formats from the UI,
                    // but NEVER delete them from the database — the format may change
                    // with future firmware updates (e.g. lowercase hex, hyphens, shorter IDs).
                    if (rawId.includes('?') || cleanId === '' || !/^[A-F0-9]+$/i.test(cleanId) || cleanId.length < 4) {
                        console.warn(`[DeviceService] ⚠️ Skipping unrecognized device ID (not deleting): "${rawId}"`);
                        return; // Skip adding to local list
                    }

                    devices.push({ id: cleanId, ...doc.data() });
                });

                // Client-side sort to avoid Firebase index/permission errors
                devices.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));

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
     * Get all devices for a home
     * @param {string} homeId - Home ID
     * @returns {Array} array of device objects
     */
    async getDevices(homeId) {
        if (!this._initialized) await this.init();
        if (!homeId) {
            console.warn('[DeviceService] No home ID provided');
            return [];
        }

        try {
            const devicesCol = this._getDevicesCollection(homeId);
            const snapshot = await devicesCol.get();

            const devices = [];
            snapshot.forEach(doc => {
                const cleanId = doc.id.toUpperCase().replace(/[^A-F0-9]/g, '');
                if (cleanId) {
                    devices.push({ id: cleanId, ...doc.data() });
                } else {
                    console.warn(`[DeviceService] Skipping invalid/corrupt device ID in Firebase: "${doc.id}"`);
                }
            });

            // Client-side sort
            devices.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));

            if (window.DEBUG) console.log(`[DeviceService] Loaded ${devices.length} devices for home`);
            return devices;

        } catch (error) {
            console.error('[DeviceService] Error loading devices:', error);
            return [];
        }
    },

    /**
     * Get a single device from a home
     * @param {string} homeId - Home ID
     * @param {string} deviceId - Device ID to get
     * @returns {object|null} Device object or null if not found
     */
    async getDevice(homeId, deviceId) {
        if (!this._initialized) await this.init();
        if (!homeId || !deviceId) {
            console.warn('[DeviceService] getDevice: No home ID or device ID provided', { homeId: !!homeId, deviceId: !!deviceId });
            return null;
        }

        const targetCleanId = deviceId.toUpperCase().replace(/[^A-F0-9]/g, '');

        if (window.DEBUG) {
            console.log('[DeviceService] getDevice called:');
            console.log('[DeviceService]   homeId:', homeId);
            console.log('[DeviceService]   deviceId:', targetCleanId);
        }

        try {
            const devicesCol = this._getDevicesCollection(homeId);
            const snapshot = await devicesCol.get();
            
            let matchedDoc = null;
            snapshot.forEach(doc => {
                const cleanId = doc.id.toUpperCase().replace(/[^A-F0-9]/g, '');
                if (cleanId === targetCleanId) {
                    matchedDoc = doc;
                }
            });

            if (matchedDoc) {
                const data = matchedDoc.data();
                return { id: targetCleanId, ...data };
            } else {
                if (window.DEBUG) console.log('[DeviceService] ⚠️ Device NOT found in Firebase:', targetCleanId);
                return null;
            }
        } catch (error) {
            console.error('[DeviceService] ❌ Error loading device:', error);
            return null;
        }
    },

    /**
     * Add a device to a home's collection
     * @param {string} homeId - Home ID
     * @param {object} device - Device object with id and name
     * @returns {boolean} Success status
     */
    async addDevice(homeId, device) {
        if (!this._initialized) await this.init();
        if (!homeId || !device || !device.id) {
            console.error('[DeviceService] Invalid parameters for addDevice');
            return false;
        }

        const id = device.id.toUpperCase().replace(/[^A-F0-9]/g, '');

        try {
            const deviceRef = this._getDevicesCollection(homeId).doc(id);

            // Strict sanitization
            const defaultName = device.type === 'blind' ? `Blinds-${id}` : `Zaylo-${id}`;
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

            if (window.DEBUG) console.log(`[DeviceService] Added device ${id} to home ${homeId}`);
            return true;

        } catch (error) {
            console.error('[DeviceService] Error adding device:', error);
            return false;
        }
    },

    /**
     * Remove a device from a home's collection
     * @param {string} homeId - Home ID
     * @param {string} deviceId - Device ID to remove
     * @returns {boolean} Success status
     */
    async removeDevice(homeId, deviceId) {
        if (!this._initialized) await this.init();
        if (!homeId || !deviceId) {
            console.error('[DeviceService] Invalid parameters for removeDevice');
            return false;
        }

        const targetCleanId = deviceId.toUpperCase().replace(/[^A-F0-9]/g, '');

        try {
            if (window.DEBUG) console.log(`[DeviceService] Removing device matching clean ID ${targetCleanId} from home ${homeId}...`);
            const devicesCol = this._getDevicesCollection(homeId);
            const snapshot = await devicesCol.get();
            
            let deleteCount = 0;
            const deletePromises = [];
            
            snapshot.forEach(doc => {
                const docId = doc.id;
                const docCleanId = docId.toUpperCase().replace(/[^A-F0-9]/g, '');
                
                if (docCleanId === targetCleanId) {
                    if (window.DEBUG) console.log(`[DeviceService] Found matching document "${docId}" for clean ID "${targetCleanId}". Deleting...`);
                    deletePromises.push(doc.ref.delete());
                    deleteCount++;
                }
            });
            
            if (deleteCount > 0) {
                await Promise.all(deletePromises);
                if (window.DEBUG) console.log(`[DeviceService] ✅ Successfully removed ${deleteCount} document(s) from Firebase`);
                return true;
            } else {
                // Try fallback deletion for exact uppercase ID if no scan matches
                const fallbackRef = devicesCol.doc(deviceId.toUpperCase().trim());
                await fallbackRef.delete();
                if (window.DEBUG) console.log(`[DeviceService] Clean ID scan found no matches. Tried fallback deletion for: ${deviceId}`);
                return true;
            }

        } catch (error) {
            console.error('[DeviceService] ❌ Error removing device:', error);
            return false;
        }
    },

    /**
     * Update a device's properties
     * @param {string} homeId - Home ID
     * @param {string} deviceId - Device ID to update
     * @param {object} updates - Object with properties to update
     * @returns {boolean} Success status
     */
    async updateDevice(homeId, deviceId, updates) {
        if (!this._initialized) await this.init();
        if (!homeId || !deviceId || !updates) {
            console.error('[DeviceService] Invalid parameters for updateDevice');
            return false;
        }

        const targetCleanId = deviceId.toUpperCase().replace(/[^A-F0-9]/g, '');

        try {
            const devicesCol = this._getDevicesCollection(homeId);
            const snapshot = await devicesCol.get();
            
            let matchedDocRef = null;
            snapshot.forEach(doc => {
                const docId = doc.id;
                const docCleanId = docId.toUpperCase().replace(/[^A-F0-9]/g, '');
                
                if (docCleanId === targetCleanId) {
                    matchedDocRef = doc.ref;
                }
            });

            if (matchedDocRef) {
                if (window.DEBUG) console.log(`[DeviceService] Updating existing document "${matchedDocRef.id}" for clean ID "${targetCleanId}"`);
                await matchedDocRef.set(updates, { merge: true });
            } else {
                // Create using the clean ID if no matching document exists
                const newId = deviceId.toUpperCase().replace(/[^A-F0-9]/g, '');
                if (window.DEBUG) console.log(`[DeviceService] No existing document found for clean ID "${targetCleanId}". Creating new doc "${newId}"`);
                const deviceRef = devicesCol.doc(newId);
                await deviceRef.set(updates, { merge: true });
            }

            if (window.DEBUG) console.log(`[DeviceService] ✅ Successfully updated device ${targetCleanId} in Firebase`);
            return true;

        } catch (error) {
            console.error('[DeviceService] ❌ Error updating device:', error);
            return false;
        }
    },

    /**
     * Check if a device exists in a home
     * @param {string} homeId - Home ID
     * @param {string} deviceId - Device ID to check
     * @returns {boolean} Whether device exists
     */
    async deviceExists(homeId, deviceId) {
        if (!this._initialized) await this.init();
        if (!homeId || !deviceId) return false;

        try {
            const device = await this.getDevice(homeId, deviceId);
            return device !== null;
        } catch (error) {
            console.error('[DeviceService] Error checking device existence:', error);
            return false;
        }
    },

    /**
     * Save device display order for a user (per-user preference, NOT per-home)
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
     * Get saved device display order for a user (per-user preference)
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
     */
    async syncFromLocalStorage(userId) {
        console.warn('[DeviceService] ⚠️ syncFromLocalStorage is DEPRECATED - Firebase is source of truth');
    }
};

// Export for modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { DeviceService };
}
