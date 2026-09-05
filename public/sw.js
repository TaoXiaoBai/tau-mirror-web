// Tau Service Worker — minimal, just enables PWA install
// No aggressive caching since Tau connects to a live local server

const CACHE_NAME = 'tau-v11';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll([
      '/',
      '/style.css',
      '/upgrade.css',
      '/app.js',
      '/i18n.js',
      '/state.js',
      '/themes.js',
      '/markdown.js',
      '/message-renderer.js',
      '/tool-card.js',
      '/dialogs.js',
      '/session-sidebar.js',
      '/websocket-client.js',
      '/manifest.json',
    ]))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(
      names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
    ))
  );
  self.clients.claim();
});

// Do not recache on every request. That fights the live local server and
// burns main-thread work while chatting. SW is only for install + offline.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (event.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) return;

  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request).then((cached) => {
      return cached || new Response('Tau is offline — start your pi session to connect.', {
        status: 503,
        headers: { 'Content-Type': 'text/plain' },
      });
    }))
  );
});
