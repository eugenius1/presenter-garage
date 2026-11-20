// The app was a PWA, and every browser that opened it kept its service worker:
// cache first, so it would go on serving that last build for ever. Nothing
// registers a worker any more, but a browser still asks this URL whether its
// worker changed, and this is the answer -- clear the cache and unregister, so
// the next page load comes from the network. Open pages are not reloaded: one
// may hold Media Bin moves queued but not yet exported, which a reload loses.
//
// Temporary: delete it once each browser that had the site installed has
// opened it once since this was deployed. One that has not would keep the old
// worker, still serving the old build.
self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Only the old worker's, by the names Workbox gave it: another app on
      // this origin may use Workbox too, and its caches are not ours to clear.
      const precache = `workbox-precache-v2-${self.registration.scope}`;
      for (const name of [precache, `${precache}-temp`]) await caches.delete(name);
      await self.registration.unregister();
    })()
  );
});
