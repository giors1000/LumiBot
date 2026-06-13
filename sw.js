const APP_VERSION = '446';
const CACHE_NAME = `zaylo-v${APP_VERSION}`;
const NETWORK_FIRST_EXTENSIONS = new Set(['.html', '.js', '.css']);
const ASSETS_TO_CACHE = [
    './',
    './index.html',
    './index.js',
    './groups.html',
    './groups.js',
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
    './blind-schema.js',
    './blind-sync.js',
    './blind-renderer.js',
    './qrcode-gen.js',
    './home-service.js',
    './icon-splash.png'
];

// Install event - cache assets
// Uses cache:'reload' to bypass HTTP cache and ensure fresh copies are fetched,
// avoiding mismatch with query-string versioned URLs in HTML pages.
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                console.log(`[SW] Caching app shell v${APP_VERSION}`);
                // Fetch each asset with cache:'reload' to bypass browser HTTP cache,
                // then store the fresh response in the service worker cache.
                // allSettled (NOT all): a single failed asset must not abort the
                // whole service-worker install, which would leave the app with no
                // offline shell at all. Failures are logged; that asset is just
                // fetched from the network at runtime (stale-while-revalidate).
                return Promise.allSettled(
                    ASSETS_TO_CACHE.map(url =>
                        fetch(url, { cache: 'reload' })
                            .then(response => {
                                if (!response.ok) {
                                    throw new Error(`Failed to fetch ${url}: ${response.status}`);
                                }
                                return cache.put(url, response);
                            })
                    )
                ).then(results => {
                    const failed = results.filter(r => r.status === 'rejected');
                    if (failed.length) {
                        console.warn(`[SW] ${failed.length} asset(s) failed to precache:`,
                            failed.map(f => f.reason && f.reason.message));
                    }
                });
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

    const path = url.pathname;
    const dotIndex = path.lastIndexOf('.');
    const ext = dotIndex >= 0 ? path.slice(dotIndex).toLowerCase() : '';
    const isCriticalAppAsset = event.request.mode === 'navigate' || NETWORK_FIRST_EXTENSIONS.has(ext);

    // Critical app code is Network-First so a missed cache-name bump cannot leave
    // the installed PWA running stale blind control logic when the network is
    // available. Offline still falls back to the cached copy.
    if (isOrigin) {
        if (isCriticalAppAsset) {
            event.respondWith(
                fetch(event.request, { cache: 'no-cache' })
                    .then((networkResponse) => {
                        if (networkResponse && networkResponse.status === 200) {
                            const responseToCache = networkResponse.clone();
                            const cacheKey = url.origin + url.pathname;
                            caches.open(CACHE_NAME).then((cache) => {
                                cache.put(cacheKey, responseToCache);
                            });
                        }
                        return networkResponse;
                    })
                    .catch(() => {
                        return caches.match(event.request, { ignoreSearch: true })
                            .then((cachedResponse) => cachedResponse ||
                                (event.request.mode === 'navigate' ? caches.match('./index.html') : null));
                    })
            );
            return;
        }

        // Static media/icons: Serve cached immediately, update cache in background.
        event.respondWith(
            caches.match(event.request, { ignoreSearch: true })
                .then((cachedResponse) => {
                    // Start network fetch in background regardless
                    const networkFetch = fetch(event.request).then((networkResponse) => {
                        if (networkResponse && networkResponse.status === 200) {
                            const responseToCache = networkResponse.clone();
                            // Normalize the cache key to the path WITHOUT the ?v=
                            // query so repeated version bumps overwrite a single
                            // entry instead of piling up stale ?v=N copies that
                            // ignoreSearch could later serve. Matches the install
                            // precache, which stores bare paths.
                            const cacheKey = url.origin + url.pathname;
                            caches.open(CACHE_NAME).then((cache) => {
                                cache.put(cacheKey, responseToCache);
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
