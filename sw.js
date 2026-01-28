const CACHE_NAME = 'switchmote-v18';
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
                console.log('[Service Worker] Caching app shell');
                return cache.addAll(ASSETS_TO_CACHE);
            })
            .then(() => self.skipWaiting())
    );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (cacheName !== CACHE_NAME) {
                        console.log('[Service Worker] Deleting old cache:', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        }).then(() => self.clients.claim())
    );
});

// Fetch event - serve from cache first, then network
self.addEventListener('fetch', (event) => {
    // URL validation for caching
    const url = new URL(event.request.url);
    const isOrigin = url.origin === self.location.origin;
    const isFirebase = url.hostname === 'www.gstatic.com' || url.hostname === 'firebasestorage.googleapis.com';
    const isPaho = url.hostname.includes('cdnjs.cloudflare.com');

    // Skip cross-origin requests unless they are our known CDNs
    if (!isOrigin && !isFirebase && !isPaho) {
        return;
    }

    event.respondWith(
        caches.match(event.request, { ignoreSearch: true })
            .then((response) => {
                // Return cached response if found
                if (response) {
                    return response;
                }

                // Otherwise fetch from network
                return fetch(event.request).then(
                    (response) => {
                        // Check if we received a valid response
                        if (!response || response.status !== 200 || response.type !== 'basic') {
                            return response;
                        }

                        // Clone the response
                        const responseToCache = response.clone();

                        caches.open(CACHE_NAME)
                            .then((cache) => {
                                cache.put(event.request, responseToCache);
                            });

                        return response;
                    }
                );
            })
    );
});
