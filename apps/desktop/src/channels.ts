import type { DesktopBridge } from "@presenter-garage/core/lib/desktop";

/**
 * Every call the page can make into the main process, by name.
 *
 * The preload exposes exactly these and the main process answers exactly
 * these, both from this one list, and a test holds it to the bridge's own
 * methods. Adding a call means adding it here, where it is seen: there is no
 * call that writes bytes to a path, and there must never be one, since that
 * would be a second write path beside `applyFixes` (AGENTS.md).
 */
export const CHANNELS = [
  "pickFolder",
  "reopenLast",
  "forgetLast",
  "workspaces",
  "openWorkspace",
  "read",
  "applyFixes",
  "showBackups",
] as const satisfies readonly (keyof DesktopBridge)[];

export type Channel = (typeof CHANNELS)[number];

/** What crosses the IPC boundary: a thrown error does not keep its message intact through Electron, so it is sent as data. */
export type Reply<T> = { ok: true; value: T } | { ok: false; error: string };

/** The prefix every channel is registered under, so ours are told apart from Electron's own. */
export const channelName = (channel: Channel) => `presenter-garage:${channel}`;
