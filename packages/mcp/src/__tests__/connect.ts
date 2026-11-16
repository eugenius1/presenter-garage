import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { openRoots } from "@presenter-garage/node/library";
import { createServer, type ServerOptions } from "../server";

/** Call a tool and unwrap its one text answer. */
export async function callTool(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { type: string; text: string }[])[0].text;
  return { isError: !!result.isError, text, json: () => JSON.parse(text) };
}

/** A server over the given folders, and a client talking to it over an in-memory pipe. */
export async function connect(roots: string[], options: ServerOptions = {}, capabilities: ClientCapabilities = {}) {
  const server = createServer(await openRoots(roots), options);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" }, { capabilities });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, call: (name: string, args: Record<string, unknown> = {}) => callTool(client, name, args) };
}
