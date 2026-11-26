import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { openLibrary } from "../library";
import { createServer, type ServerOptions } from "../server";

/** Call a tool and unwrap its one text answer. */
export async function callTool(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { type: string; text: string }[])[0].text;
  return { isError: !!result.isError, text, json: () => JSON.parse(text) };
}

/**
 * A server on the given library, and a client talking to it over an
 * in-memory pipe. ProPresenter 22's registry is this computer's only when a
 * test says so, so nothing on the machine running the tests can change them.
 */
export async function connect(
  /** The library to start on, or why there is none. */
  folder: string | { problem: string },
  options: ServerOptions = {},
  capabilities: ClientCapabilities = {},
  /** Handlers the client needs before it connects: the server asks for its roots as soon as it has. */
  setUp?: (client: Client) => void
) {
  const opts: ServerOptions = { registered: async () => [], ...options };
  const server = createServer(typeof folder === "string" ? await openLibrary(folder, "configured", opts) : folder, opts);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" }, { capabilities });
  setUp?.(client);
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, call: (name: string, args: Record<string, unknown> = {}) => callTool(client, name, args) };
}
