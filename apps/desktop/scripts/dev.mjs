// Run the desktop app against the web app's dev server, so the page reloads
// as it is edited. Start that first, from the root: `npm run dev`. The main
// process and preload are built once here; restart this to pick up a change
// to them.
import { spawn, spawnSync } from "node:child_process";
import electron from "electron";

const url = process.env.VITE_DEV_SERVER_URL ?? "http://localhost:5173/";
for (const config of ["vite.config.ts", "vite.preload.config.ts"]) {
  const built = spawnSync(process.execPath, ["../../node_modules/vite/bin/vite.js", "build", "--logLevel", "warn", "-c", config], { stdio: "inherit" });
  if (built.status !== 0) process.exit(built.status ?? 1);
}
const child = spawn(electron, ["."], { stdio: "inherit", env: { ...process.env, VITE_DEV_SERVER_URL: url } });
child.on("exit", (code) => process.exit(code ?? 0));
