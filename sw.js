const COOP = 'same-origin';
const COEP = 'require-corp';

self.addEventListener('install', function (e) {
    self.skipWaiting();
});

self.addEventListener('activate', function (e) {
    e.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', function (event) {
    if (event.request.mode === 'navigate') {
        event.respondWith(
            fetch(event.request).then(function (response) {
                const headers = new Headers(response.headers);
                headers.set('Cross-Origin-Opener-Policy', COOP);
                headers.set('Cross-Origin-Embedder-Policy', COEP);
                return new Response(response.body, {
                    status: response.status,
                    statusText: response.statusText,
                    headers: headers
                });
            })
        );
    }
});