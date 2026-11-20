import { contextBridge, ipcRenderer } from "electron";
import { BRIDGE_GLOBAL, type DesktopBridge } from "@presenter-garage/core/lib/desktop";
import { CHANNELS, channelName, type Channel, type Reply } from "./channels";

/**
 * The page's only way out of its sandbox: one function per channel, each an
 * IPC call the main process checks and answers. Nothing from Node or
 * Electron itself is handed to the page.
 */

const call =
  (channel: Channel) =>
  async (...args: unknown[]) => {
    const reply = (await ipcRenderer.invoke(channelName(channel), ...args)) as Reply<unknown>;
    if (!reply.ok) throw new Error(reply.error);
    return reply.value;
  };

const bridge = Object.fromEntries(CHANNELS.map((channel) => [channel, call(channel)])) as unknown as DesktopBridge;

contextBridge.exposeInMainWorld(BRIDGE_GLOBAL, bridge);
