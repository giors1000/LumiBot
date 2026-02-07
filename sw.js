const CACHE_NAME = 'switchmote-v324';
const ASSETS_TO_CACHE = [
    './',
    './index.html',
    './index.js',
    './styles.css',
    './app.js',
    './manifest.json',
    './icon-192.png',
    './icon-512.png',
    './auth.html',
    './auth.js',
    './setup.html',
    './setup.js',
    './mqtt.js',
    './device.js',
    './device.html',
    './device-service.js',
    './paho-mqtt.min.js'
];

// Install event - cache assets
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                console.log('[SW] Caching app shell v324');
                return cache.addAll(ASSETS_TO_CACHE);
            })
            .then(() => self.skipWaiting())
    );
});

// Activate event - clean up old caches and claim clients immediately
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (cacheName !== CACHE_NAME) {
                        console.log('[SW] Deleting old cache:', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        }).then(() => self.clients.claim())
    );
});

// Fetch event - Stale-While-Revalidate for app shell, Network-First for API
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    const isOrigin = url.origin === self.location.origin;
    const isFirebaseCDN = url.hostname === 'www.gstatic.com';
    const isFirebaseAPI = url.hostname.includes('firestore.googleapis.com') ||
                          url.hostname.includes('identitytoolkit.googleapis.com') ||
                          url.hostname.includes('securetoken.googleapis.com');
    const isFontCDN = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';

    // Never cache Firebase API calls (auth, firestore) - always go to network
    if (isFirebaseAPI) {
        return;
    }

    // Skip non-GET requests
    if (event.request.method !== 'GET') {
        return;
    }

    // Skip cross-origin requests except known CDNs
    if (!isOrigin && !isFirebaseCDN && !isFontCDN) {
        return;
    }

    // Stale-While-Revalidate: Serve cached immediately, update cache in background
    if (isOrigin) {
        event.respondWith(
            caches.match(event.request, { ignoreSearch: true })
                .then((cachedResponse) => {
                    // Start network fetch in background regardless
                    const networkFetch = fetch(event.request).then((networkResponse) => {
                        if (networkResponse && networkResponse.status === 200) {
                            const responseToCache = networkResponse.clone();
                            caches.open(CACHE_NAME).then((cache) => {
                                cache.put(event.request, responseToCache);
                            });
                        }
                        return networkResponse;
                    }).catch(() => {
                        // Network failed, return nothing (cached version already served)
                        return null;
                    });

                    // Return cached version immediately if available, otherwise wait for network
                    return cachedResponse || networkFetch;
                })
                .catch(() => {
                    // Offline fallback for navigation requests
                    if (event.request.mode === 'navigate') {
                        return caches.match('./index.html');
                    }
                })
        );
        return;
    }

    // CDN assets: Cache-First (fonts, Firebase SDK)
    event.respondWith(
        caches.match(event.request)
            .then((response) => {
                if (response) return response;

                return fetch(event.request).then((networkResponse) => {
                    if (networkResponse && networkResponse.status === 200) {
                        const responseToCache = networkResponse.clone();
                        caches.open(CACHE_NAME).then((cache) => {
                            cache.put(event.request, responseToCache);
                        });
                    }
                    return networkResponse;
                });
            })
            .catch(() => null)
    );
});
