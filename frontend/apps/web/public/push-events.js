/* global self */
/* Loaded by the PWA worker. Reminder payloads contain no executable content. */
// Only a same-origin path is followed; anything else opens the planning page.
function reminderPath(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : '/plan';
}

self.addEventListener('push', (event) => {
  let payload;

  try {
    payload = event.data?.json();
  } catch {
    return;
  }

  if (!payload || typeof payload.title !== 'string') {
    return;
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: typeof payload.body === 'string' ? payload.body : '',
      tag: typeof payload.tag === 'string' ? payload.tag : 'memory-reminder',
      data: { url: reminderPath(payload.url) },
      icon: '/logo-192x192.png',
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const url = new URL(reminderPath(event.notification.data?.url), self.location.origin).href;
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = windows.find((client) => new URL(client.url).origin === self.location.origin);

      if (existing) {
        await existing.navigate(url);
        await existing.focus();
      } else {
        await self.clients.openWindow(url);
      }
    })(),
  );
});
