// Copy the web app's build into the desktop app's, where the main process
// serves it from (`dist/web`), so the app is one folder a packager can take
// whole. The web build is not made here: `npm run desktop:build` at the root
// makes it first.
import fs from "node:fs";
import path from "node:path";

const from = path.resolve("..", "web", "dist");
const to = path.resolve("dist", "web");

if (!fs.existsSync(path.join(from, "index.html"))) {
  console.error(`copy-web: no ${from}/index.html -- build the web app first (npm run build at the root)`);
  process.exit(1);
}
fs.rmSync(to, { recursive: true, force: true });
fs.cpSync(from, to, { recursive: true });
console.log(`copy-web -> ${path.relative(process.cwd(), to)}`);
