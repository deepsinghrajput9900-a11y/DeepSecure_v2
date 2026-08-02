/**
 * DeepSecure service worker.
 * Handles background push notifications ("DeepSecure Access Request")
 * and lets the app be installed as a PWA / wrapped into an APK.
 */

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let payload = { title: 'DeepSecure Access Request', body: 'A receiver requested access to a shared file.', data: {} };
  if (event.data) {
    try { payload = event.data.json(); } catch (e) { /* keep default */ }
  }
  const options = {
    body: payload.body,
    icon: '/icon-192.png',
   badge: '/icon-192.png',
    data: payload.data || {},
    tag: 'deepsecure-access-request',
  };
  event.waitUntil(self.registration.showNotification(payload.title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('/');
    })
  );
});
