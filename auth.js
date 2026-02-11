/**
 * LumiBot - Firebase Authentication Module
 * Handles user authentication with Firebase
 */

// Firebase configuration (from user's config)
const firebaseConfig = {
    apiKey: "AIzaSyDHbA6qr9oyjQpry_Q61CBNhbp4sur6ppg",
    authDomain: "lumibot-1bd34.firebaseapp.com",
    projectId: "lumibot-1bd34",
    storageBucket: "lumibot-1bd34.firebasestorage.app",
    messagingSenderId: "382264523843",
    appId: "1:382264523843:web:0ee865245009f20209e8f6",
    measurementId: "G-HPH12B7J7P"
};

// Auth module
const Auth = {
    app: null,
    auth: null,
    user: null,
    initialized: false,
    _initPromise: null,  // Track ongoing init to prevent race conditions
    authStateResolved: false,  // True once initial auth state is determined
    _authReadyResolve: null,   // Promise resolver for auth ready state

    /**
     * Initialize Firebase
     */
    async init() {
        // If already initialized, return immediately
        if (this.initialized) return;

        // If init is in progress, wait for it
        if (this._initPromise) {
            return this._initPromise;
        }

        // Create and track the init promise
        this._initPromise = this._doInit();
        try {
            await this._initPromise;
        } catch (error) {
            console.error('[Auth] Init failed with error:', error);
            // Don't throw - allow the app to continue in degraded mode
            // The safety checks in auth methods will return friendly errors
        } finally {
            this._initPromise = null;
        }
    },

    /**
     * Internal init implementation
     */
    async _doInit() {
        // CRITICAL: Check protocol to prevent crash on file://
        if (window.location.protocol === 'file:') {
            console.warn('[Auth] Running on file:// protocol - Firebase skipped to prevent errors.');
            console.warn('[Auth] Please use "start_server.bat" for full functionality.');
            // Mock auth state resolved to allow app to load in offline mode
            this.authStateResolved = true;
            this.initialized = true; // Mark as initialized (offline mode)
            if (this._authReadyResolve) {
                this._authReadyResolve();
                this._authReadyResolve = null;
            }
            return;
        }

        try {
            console.log('[Auth] Loading Firebase modules...');

            // Import Firebase modules dynamically
            const { initializeApp } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js');
            console.log('[Auth] firebase-app.js loaded');

            const authModule = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js');
            console.log('[Auth] firebase-auth.js loaded');

            const {
                getAuth,
                signInWithEmailAndPassword,
                signInWithPopup,
                GoogleAuthProvider,
                onAuthStateChanged,
                signOut,
                createUserWithEmailAndPassword
            } = authModule;

            // Initialize Firebase app
            console.log('[Auth] Initializing Firebase app...');
            this.app = initializeApp(firebaseConfig);
            this.auth = getAuth(this.app);
            console.log('[Auth] Firebase app initialized');

            // Store methods for later use
            this._signInWithEmailAndPassword = signInWithEmailAndPassword;
            this._signInWithPopup = signInWithPopup;
            this._GoogleAuthProvider = GoogleAuthProvider;
            this._onAuthStateChanged = onAuthStateChanged;
            this._signOut = signOut;
            this._createUserWithEmailAndPassword = createUserWithEmailAndPassword;

            console.log('[Auth] Auth methods stored:', {
                hasSignIn: !!this._signInWithEmailAndPassword,
                hasSignUp: !!this._createUserWithEmailAndPassword,
                hasSignOut: !!this._signOut,
                hasGoogle: !!this._GoogleAuthProvider
            });

            // Listen for auth state changes
            onAuthStateChanged(this.auth, (user) => {
                this.user = user;

                // Mark auth state as resolved on first callback
                if (!this.authStateResolved) {
                    this.authStateResolved = true;
                    console.log('[Auth] Auth state resolved');
                    // Resolve any waiting promises
                    if (this._authReadyResolve) {
                        this._authReadyResolve();
                        this._authReadyResolve = null;
                    }
                }

                this._onAuthStateChange(user);
            });

            this.initialized = true;
            console.log('[Auth] Firebase initialized successfully');

        } catch (error) {
            console.error('[Auth] Firebase init error:', error);
            console.error('[Auth] Error details:', {
                name: error.name,
                message: error.message,
                stack: error.stack
            });
            throw error;
        }
    },

    /**
     * Sign in with email and password
     */
    async signInWithEmail(email, password) {
        if (!this.initialized) await this.init();

        // Safety check - ensure Firebase is properly initialized
        if (!this._signInWithEmailAndPassword) {
            console.error('[Auth] Firebase not initialized properly - signInWithEmailAndPassword not available');
            return { success: false, error: 'Authentication service unavailable. Please refresh and try again.' };
        }

        try {
            const result = await this._signInWithEmailAndPassword(this.auth, email, password);
            console.log('[Auth] Signed in:', result.user.email);
            return { success: true, user: result.user };
        } catch (error) {
            console.error('[Auth] Sign in error:', error);
            return { success: false, error: this._parseError(error) };
        }
    },

    /**
     * Sign in with Google
     */
    async signInWithGoogle() {
        if (!this.initialized) await this.init();

        // Safety check - ensure Firebase is properly initialized
        if (!this._signInWithPopup || !this._GoogleAuthProvider) {
            console.error('[Auth] Firebase not initialized properly - Google sign-in not available');
            return { success: false, error: 'Authentication service unavailable. Please refresh and try again.' };
        }

        try {
            const provider = new this._GoogleAuthProvider();
            const result = await this._signInWithPopup(this.auth, provider);
            console.log('[Auth] Google sign in:', result.user.email);
            return { success: true, user: result.user };
        } catch (error) {
            console.error('[Auth] Google sign in error:', error);
            return { success: false, error: this._parseError(error) };
        }
    },

    /**
     * Create new account with email
     */
    async createAccount(email, password) {
        if (!this.initialized) await this.init();

        // Safety check - ensure Firebase is properly initialized
        if (!this._createUserWithEmailAndPassword) {
            console.error('[Auth] Firebase not initialized properly - createAccount not available');
            return { success: false, error: 'Authentication service unavailable. Please refresh and try again.' };
        }

        try {
            const result = await this._createUserWithEmailAndPassword(this.auth, email, password);
            console.log('[Auth] Account created:', result.user.email);
            return { success: true, user: result.user };
        } catch (error) {
            console.error('[Auth] Create account error:', error);
            return { success: false, error: this._parseError(error) };
        }
    },

    /**
     * Sign out
     */
    async signOut() {
        if (!this.initialized) await this.init();

        // Safety check - ensure Firebase is properly initialized
        if (!this._signOut) {
            console.error('[Auth] Firebase not initialized properly - signOut not available');
            return { success: false, error: 'Authentication service unavailable. Please refresh and try again.' };
        }

        try {
            await this._signOut(this.auth);
            console.log('[Auth] Signed out');
            return { success: true };
        } catch (error) {
            console.error('[Auth] Sign out error:', error);
            return { success: false, error: this._parseError(error) };
        }
    },

    /**
     * Check if user is authenticated
     */
    isAuthenticated() {
        return this.user !== null;
    },

    /**
     * Get current user
     */
    getUser() {
        return this.user;
    },

    /**
     * Wait for auth state to be determined (non-polling)
     * Returns immediately if auth state is already known
     * @returns {Promise<void>}
     */
    async waitForAuthReady() {
        // Already resolved - return immediately
        if (this.authStateResolved) {
            return;
        }

        // Not initialized yet - init first
        if (!this.initialized) {
            await this.init();
        }

        // If still not resolved, wait for the callback
        if (!this.authStateResolved) {
            return new Promise(resolve => {
                this._authReadyResolve = resolve;
            });
        }
    },

    /**
     * Handle auth state changes
     */
    _onAuthStateChange(user) {
        const path = window.location.pathname;
        const href = window.location.href;
        // Robust check for auth page (handles both file:// and http://)
        const isAuthPage = path.includes('auth.html') || href.includes('auth.html');

        if (user) {
            // User is signed in
            console.log('[Auth] User authenticated:', user.email);

            // If on auth page, redirect to app
            if (isAuthPage) {
                console.log('[Auth] Redirecting to App...');
                this._redirectToApp();
            }
        } else {
            // User is signed out
            console.log('[Auth] User not authenticated');

            // If NOT on auth page, redirect to auth
            if (!isAuthPage) {
                console.log('[Auth] Redirecting to Auth...');
                this._redirectToAuth();
            }
        }
    },

    /**
     * Redirect to main app
     */
    _redirectToApp() {
        // Animate out the card before redirect
        const card = document.querySelector('.auth-card');
        if (card) {
            card.style.animation = 'scaleIn 0.4s var(--spring) reverse forwards';
            setTimeout(() => {
                window.location.href = 'index.html';
            }, 400);
        } else {
            window.location.href = 'index.html';
        }
    },

    /**
     * Redirect to auth page
     */
    _redirectToAuth() {
        window.location.href = 'auth.html';
    },

    /**
     * Parse Firebase error to user-friendly message
     */
    _parseError(error) {
        const errorMessages = {
            'auth/invalid-email': 'Please enter a valid email address.',
            'auth/user-disabled': 'This account has been disabled.',
            'auth/user-not-found': 'No account found with this email.',
            'auth/wrong-password': 'Incorrect password. Please try again.',
            'auth/invalid-credential': 'Invalid email or password.',
            'auth/email-already-in-use': 'An account with this email already exists.',
            'auth/weak-password': 'Password should be at least 6 characters.',
            'auth/network-request-failed': 'Network error. Please check your connection.',
            'auth/too-many-requests': 'Too many attempts. Please try again later.',
            'auth/popup-closed-by-user': 'Sign-in popup was closed.',
            'auth/cancelled-popup-request': 'Sign-in was cancelled.',
            'auth/popup-blocked': 'Sign-in popup was blocked. Please allow popups.'
        };

        return errorMessages[error.code] || error.message || 'An error occurred. Please try again.';
    }
};

// ============================================
// Auto-initialize Firebase on page load
// ============================================

document.addEventListener('DOMContentLoaded', async () => {
    try {
        await Auth.init();
        console.log('[Auth] Firebase initialized successfully');
    } catch (error) {
        console.error('[Auth] Failed to initialize Firebase:', error);
    }
});

// Export for modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { Auth };
}
