// The app was a PWA, and every browser that opened it kept its service worker:
// cache first, so it would go on serving that last build for ever. Nothing
// registers a worker any more, but a browser still asks this URL whether its
// worker changed, and this is the answer -- clear the cache, unregister, and
// reload each open page from the network.
//
// Temporary: delete it once each browser that had the site installed has
// opened it once since this was deployed. One that has not would keep the old
// worker, still serving the old build.
self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Only the old worker's: Workbox named its precache `workbox-precache-…`,
      // and any other cache on this origin is not ours to clear.
      for (const key of await caches.keys()) if (key.startsWith("workbox-")) await caches.delete(key);
      await self.registration.unregister();
      for (const client of await self.clients.matchAll({ type: "window" })) client.navigate(client.url);
    })()
  );
});
