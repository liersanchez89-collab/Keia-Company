// Service worker de KEIA: solo recibe las notificaciones push (no guarda nada en caché).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || "KEIA", {
    body: d.body || "",
    icon: "/iconos/keia-192.png",
    badge: "/iconos/keia-192.png",
    tag: d.tag || "keia",
    renotify: true,
    data: { url: d.url || "/" },
  }));
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "/", self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).origin === self.location.origin) { await w.focus(); try { await w.navigate(url); } catch {} return; }
    }
    await self.clients.openWindow(url);
  })());
});
