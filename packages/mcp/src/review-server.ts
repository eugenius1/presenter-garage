import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { LibraryError } from "@presenter-garage/node/library";
import { mergeChoices, readReview, saveChoices, writtenIn, type Review } from "@presenter-garage/node/review";
import { reviewPage } from "./review-page";
import { changeWhere, describeChange, lineSaid, lineWhere } from "./wording";

/**
 * The loopback server a review page is served from: one per MCP server,
 * listening on 127.0.0.1 only, started when the first review is opened.
 *
 * Each review is reached at a path holding a random token. With the `Host`
 * check, that keeps other websites open in the same browser from reading a
 * review or posting choices to the port: a page elsewhere cannot guess the
 * token, and a DNS name rebound to 127.0.0.1 arrives with its own name in
 * `Host`. A save must also be JSON, which a cross-site form cannot send
 * without a preflight this server never answers. None of it is meant to stop
 * the model: see docs/design/guard3-review-file.md.
 *
 * Every request reads the review from disk afresh, so the page always shows
 * what an apply would use, and a `plan.json` changed since is refused here
 * as it is there.
 */

/** A review's choices, sent whole: room for 2,000 changes with a note on each. */
const MAX_BODY = 4 * 1024 * 1024;

export interface ReviewHost {
  /** Serve the review in `folder`, answering the URL its page is at. */
  serve(folder: string): Promise<string>;
  close(): Promise<void>;
}

/** What the page is sent: every change in words, with the person's choices and what earlier runs wrote. */
export function reviewData(review: Review) {
  return {
    title: `Review: ${review.plan.files.length === 1 ? review.plan.files[0].name : `${review.plan.files.length} presentations`}`,
    files: review.plan.files.map((file) => ({
      name: file.name,
      path: file.path,
      items: [
        ...file.lines.map(({ n, fix, styling }) => ({ n, where: lineWhere(fix), said: lineSaid(fix, styling) })),
        ...file.changes.map(({ n, change }) => ({ n, where: changeWhere(change), said: describeChange(change) })),
      ],
    })),
    choices: review.choices.changes,
    written: [...writtenIn(review)],
    runs: review.runs.map((run) => ({
      at: run.at,
      files: run.files.map(({ name, written, reason, detail }) => ({ name, written, reason, detail })),
    })),
  };
}

const SECURITY = {
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
  // The token is in the path: no page this one links to may learn it.
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
};

export function reviewHost(reviewsDir: string): ReviewHost {
  const tokens = new Map<string, string>();
  let listening: Promise<number> | undefined;
  let server: http.Server | undefined;

  const handle = async (request: http.IncomingMessage, response: http.ServerResponse, port: number) => {
    const send = (status: number, body: string, type = "text/plain; charset=utf-8", headers: Record<string, string> = {}) => {
      response.writeHead(status, { ...SECURITY, "Content-Type": type, ...headers });
      response.end(body);
    };
    const origin = `127.0.0.1:${port}`;
    // Another name for this address -- a DNS name rebound to it -- is another site, whatever it resolves to.
    if (request.headers.host !== origin) return send(403, "This page is served to 127.0.0.1 only.");
    const [, r, token, rest = "", ...more] = (request.url ?? "").split("?")[0].split("/");
    const folder = r === "r" && more.length === 0 ? tokens.get(token) : undefined;
    if (!folder) return send(404, "No such review.");

    if (request.method === "GET" && rest === "") {
      const nonce = randomBytes(16).toString("base64");
      return send(200, reviewPage(nonce), "text/html; charset=utf-8", {
        "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      });
    }
    if (request.method === "GET" && rest === "review.json") {
      return send(200, JSON.stringify(reviewData(await readReview(folder, reviewsDir))), "application/json");
    }
    if (request.method === "PUT" && rest === "choices") {
      const sentFrom = request.headers.origin;
      if (sentFrom !== undefined && sentFrom !== `http://${origin}`) return send(403, "Choices are taken only from the review page.");
      if (!request.headers["content-type"]?.startsWith("application/json")) return send(415, "Choices are sent as JSON.");
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY) return send(413, "Too much was sent.");
        chunks.push(chunk as Buffer);
      }
      let sent: unknown;
      try {
        sent = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return send(400, "The choices are not JSON.");
      }
      const review = await readReview(folder, reviewsDir);
      await saveChoices(review, mergeChoices(review, sent));
      return send(200, JSON.stringify({ saved: true }), "application/json");
    }
    return send(405, "Not something this page does.");
  };

  const start = () =>
    (listening ??= new Promise<number>((resolve, reject) => {
      server = http.createServer((request, response) => {
        const port = (server!.address() as AddressInfo).port;
        handle(request, response, port).catch((e) => {
          if (response.headersSent) return response.destroy();
          // A refusal is the person's to read; anything else says only that it failed.
          response.writeHead(e instanceof LibraryError ? 409 : 500, { ...SECURITY, "Content-Type": "text/plain; charset=utf-8" });
          response.end(e instanceof LibraryError ? e.message : "The review could not be read or saved.");
        });
      });
      server.on("error", reject);
      // Loopback only: nothing on the network can reach it, and Windows asks no firewall question for it.
      server.listen(0, "127.0.0.1", () => resolve((server!.address() as AddressInfo).port));
      // The MCP server's stdio keeps the process alive; a review page alone must not.
      server.unref();
    }));

  return {
    async serve(given) {
      // Read first: a folder that is not a review, or whose plan has changed, is refused before it is served.
      const review = await readReview(given, reviewsDir);
      const port = await start();
      let token = [...tokens].find(([, folder]) => folder === review.folder)?.[0];
      if (!token) tokens.set((token = randomBytes(24).toString("base64url")), review.folder);
      return `http://127.0.0.1:${port}/r/${token}/`;
    },
    async close() {
      if (!server) return;
      const closing = new Promise<void>((resolve) => server!.close(() => resolve()));
      server.closeAllConnections();
      await closing;
    },
  };
}

/** Open a URL in the system's browser; false when it could not be started. Only ever this server's own loopback URL. */
export function openInBrowser(url: string): Promise<boolean> {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/r\/[\w-]+\/$/.test(url)) return Promise.resolve(false);
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? // `start` is cmd's own; its first quoted argument is a window title. The URL holds no character cmd treats specially.
          ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore", detached: true, windowsHide: true });
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}
