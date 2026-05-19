const CACHE_NAME = 'zaylo-v412.2';
const ASSETS_TO_CACHE = [
    './',
    './index.html',
    './index.js',
    './styles.css',
    './app.js',
    './manifest.json',
    './icon-192.png',
    './icon-512.png',
    './icon-192-maskable.png',
    './icon-512-maskable.png',
    './auth.html',
    './auth.js',
    './setup.html',
    './setup.js',
    './mqtt.js',
    './device.js',
    './device.html',
    './device-service.js',
    './blind-device.html',
    './blind-device.js',
    './diagnostics.html',
    './diagnostics.js',
    './diagnostics.css',
    './paho-mqtt.min.js',
    './state-store.js',
    './automation-engine.js',
    './icon-splash.png'
];

// Install event - cache assets
// Uses cache:'reload' to bypass HTTP cache and ensure fresh copies are fetched,
// avoiding mismatch with query-string versioned URLs in HTML pages.
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                console.log('[SW] Caching app shell v412.2');
                // Fetch each asset with cache:'reload' to bypass browser HTTP cache,
                // then store the fresh response in the service worker cache.
                return Promise.all(
                    ASSETS_TO_CACHE.map(url =>
                        fetch(url, { cache: 'reload' })
                            .then(response => {
                                if (!response.ok) {
                                    throw new Error(`Failed to fetch ${url}: ${response.status}`);
                                }
                                return cache.put(url, response);
                            })
                    )
                );
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

    // DEFENSE IN DEPTH: Three layers of protection prevent accidental caching
    // 1. Skip ALL non-GET requests first (POST, PUT, WebSocket upgrades)
    if (event.request.method !== 'GET') {
        return;
    }

    // 2. Never cache Firebase API calls (auth, firestore) - always go to network
    if (isFirebaseAPI) {
        return;
    }

    // 3. Skip cross-origin requests except known CDNs
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
