import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The worker that retires the old PWA, run against stand-ins for the
 * browser's: it has no build step, so the file under test is the one served.
 */

const SCOPE = "https://example.test/presenter-garage/";
const source = fs.readFileSync(path.join(__dirname, "../../public/sw.js"), "utf8");

async function activate(cacheNames: string[]) {
  const listeners = new Map<string, (event: unknown) => void>();
  const caches = new Set(cacheNames);
  const navigated: string[] = [];
  let unregistered = false;
  const self = {
    addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
    skipWaiting: () => Promise.resolve(),
    registration: { scope: SCOPE, unregister: async () => (unregistered = true) },
    clients: { matchAll: async () => [{ url: SCOPE, navigate: async (url: string) => void navigated.push(url) }] },
  };
  const cacheStorage = { delete: async (name: string) => caches.delete(name) };
  new Function("self", "caches", source)(self, cacheStorage);

  let done: Promise<unknown> = Promise.resolve();
  listeners.get("activate")!({ waitUntil: (p: Promise<unknown>) => (done = p) });
  await done;
  return { caches: [...caches], navigated, unregistered };
}

describe("the worker that retires the PWA", () => {
  it("clears the old worker's cache and unregisters, leaving open pages as they are", async () => {
    const run = await activate([`workbox-precache-v2-${SCOPE}`, `workbox-precache-v2-${SCOPE}-temp`]);
    // Not reloaded: a page may hold work not yet exported.
    expect(run).toEqual({ caches: [], navigated: [], unregistered: true });
  });

  it("leaves alone the caches of another app on the same origin, Workbox or not", async () => {
    const others = ["workbox-precache-v2-https://example.test/other-app/", "workbox-runtime-https://example.test/", "my-cache"];
    const run = await activate([`workbox-precache-v2-${SCOPE}`, ...others]);
    expect(run.caches).toEqual(others);
  });
});
