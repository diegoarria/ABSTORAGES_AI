// ABSTORAGES AI — Service Worker
// Gestiona caché offline + notificaciones push

const CACHE = 'abs-v1';
const PRECACHE = [
  '/',
  '/index.html',
  '/ops-center.html',
  '/login.html',
  '/css/styles.css',
  '/js/features.js',
  '/manifest.json',
  '/icons/icon.svg',
];

// ── Instalación: cachear assets estáticos ─────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

// ── Activación: limpiar cachés viejos ─────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ── Fetch: network-first para API, cache-first para estáticos ─────────────────
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // API y SSE siempre van a red, nunca a caché
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/actividad')) return;

  e.respondWith(
    fetch(e.request)
      .then(res => {
        // Guardar copia fresca en caché
        if (res.ok && e.request.method === 'GET') {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});

// ── Push Notifications ────────────────────────────────────────────────────────
self.addEventListener('push', e => {
  let data = { title: 'ABSTORAGES AI', body: 'Nueva actividad', tag: 'abs-default' };

  try {
    data = { ...data, ...e.data.json() };
  } catch (_) {
    data.body = e.data?.text() || data.body;
  }

  const options = {
    body: data.body,
    tag: data.tag || 'abs-notif',
    icon: '/icons/icon.svg',
    badge: '/icons/icon.svg',
    vibrate: data.urgente ? [200, 100, 200, 100, 400] : [200, 100, 200],
    data: { url: data.url || '/', ts: Date.now() },
    actions: data.actions || [],
    requireInteraction: !!data.urgente,
    silent: false,
  };

  // Color de fondo según tipo
  if (data.tipo === 'NUEVA_ORDEN')       options.badge = '/icons/icon.svg';
  if (data.tipo === 'PROVEEDOR_GANADOR') options.badge = '/icons/icon.svg';

  e.waitUntil(self.registration.showNotification(data.title, options));
});

// ── Click en notificación: abrir o enfocar la app ────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/';

  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clients => {
        // Si ya hay una ventana abierta, enfocarla y navegar
        for (const client of clients) {
          if ('focus' in client) {
            client.focus();
            client.navigate(url);
            return;
          }
        }
        // Si no, abrir nueva
        return self.clients.openWindow(url);
      })
  );
});
