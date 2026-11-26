import path from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LibraryError, openRoots } from "@presenter-garage/node/library";
import { answer, CONFIRM_TIMEOUT_MS, READ_ONLY } from "./answer";
import { isProPresenterLibrary, type Library, type LibraryAnswer } from "./library";

/**
 * Which library is open, and opening another: `current_library` and
 * `use_library`. A switch is the person's to make, asked through their
 * client, never the model's: the library decides what every other tool can
 * read and write.
 */
export function registerLibraryTools(server: McpServer, library: Library): void {
  server.registerTool(
    "current_library",
    {
      title: "Which library is open",
      description:
        "Say which ProPresenter library the server reads now: its path, whether it is a folder of files or a " +
        "ProPresenter 22 workspace, where it came from (`configured`, `default`, `client` roots, or `approved` " +
        "through use_library), whether its slide text can be edited and where backups go, the team's rules as " +
        "found, and `notes`: what to know before trusting what it reads.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    () => answer(() => library.describe())
  );

  server.registerTool(
    "use_library",
    {
      title: "Open another library",
      description:
        "Open another ProPresenter library in place of the one open now: a folder of ProPresenter 7 files or a " +
        "ProPresenter 22 workspace, by its absolute path. The person is asked, by their app, to approve the switch, " +
        "shown both paths; nothing changes unless they do, and a client that cannot ask them gets a refusal. Every " +
        "tool then reads that library alone, and a plan made before the switch can no longer be applied.",
      inputSchema: { path: z.string().describe("The library's absolute path, or a file: URI.") },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ path: given }, { signal }) =>
      answer(async (): Promise<{ answer: "accept" | "decline" | "cancel"; unchanged?: true; library: LibraryAnswer }> => {
        const dir = given.startsWith("file:") ? fileURLToPath(given) : given;
        if (!path.isAbsolute(dir)) throw new LibraryError(`Give the library's absolute path, not ${given}.`);
        const [root] = await openRoots([dir]);
        // Once any change under way is made, so the person is shown the library they are really leaving.
        const current = await library.get().catch(() => undefined);
        if (current?.root === root) return { answer: "accept", unchanged: true, library: await library.describe() };

        if (!server.server.getClientCapabilities()?.elicitation?.form) {
          throw new LibraryError(
            "This MCP client cannot ask its user to approve opening another library, so the library was not " +
              `changed${current ? `: it is still ${current.root}` : ""}. Start the server on the library instead.`
          );
        }
        const doubt = (await isProPresenterLibrary(root))
          ? ""
          : " It does not look like a ProPresenter library: it holds no Libraries, Playlists or Configuration folder.";
        let reply;
        try {
          reply = await server.server.elicitInput(
            {
              message:
                `Open ${root} in place of ${current?.root ?? "no library"}? Presenter Garage would then work ` +
                `in that library alone.${doubt}`,
              requestedSchema: { type: "object", properties: {} },
            },
            { timeout: CONFIRM_TIMEOUT_MS, signal }
          );
        } catch (e) {
          throw new LibraryError(`No answer came back (${(e as Error).message}), so the library was not changed.`);
        }
        if (reply.action !== "accept") return { answer: reply.action, library: await library.describe() };
        if (signal.aborted) throw new LibraryError("The call was cancelled before the answer came back, so the library was not changed.");
        await library.switchTo(root);
        return { answer: "accept", library: await library.describe() };
      })
  );
}
