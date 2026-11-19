import path from "node:path";

/**
 * Which file of the web app's build answers a request on the app's own
 * scheme.
 *
 * The page is served from `app://garage/` rather than `file://`, because ES
 * modules are blocked on `file://`, and because a scheme of our own is an
 * origin the main process can tell its page's calls by. The web app routes
 * on `location.pathname` (see `routing.ts` there), so a path with no
 * extension is a tool's page and gets `index.html`, as GitHub Pages' 404
 * fallback gives it on the web.
 *
 * Nothing outside the build is ever served: the path is decoded, normalised
 * and held to the folder, and a request that climbs out of it is answered
 * with the app's own page instead.
 */
export function assetPath(webDir: string, url: string): string {
  const index = path.join(webDir, "index.html");
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(url).pathname);
  } catch {
    return index;
  }
  if (pathname.includes("\0")) return index;
  const file = path.join(webDir, path.normalize(pathname));
  const rel = path.relative(webDir, file);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return index;
  return path.extname(file) ? file : index;
}

/** The content type for a file of the build, which `net.fetch` on a `file:` URL does not always set. */
export function contentType(file: string): string {
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".webmanifest": "application/manifest+json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".wasm": "application/wasm",
    ".woff2": "font/woff2",
  };
  return types[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}
