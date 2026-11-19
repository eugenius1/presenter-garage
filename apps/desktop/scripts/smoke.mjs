// Launch the built app, check the page came up with its bridge and that the
// main process can open SQLite, then quit with the answer. CI runs this on
// macOS and Windows, which is the "a dev build launches" of #30.
import { spawn } from "node:child_process";
import electron from "electron";

const args = ["."];
// Linux runners have no GPU; the others need nothing extra.
if (process.platform === "linux") args.push("--no-sandbox", "--disable-gpu");
const child = spawn(electron, args, { stdio: "inherit", env: { ...process.env, PRESENTER_GARAGE_SMOKE: "1" } });
child.on("exit", (code) => process.exit(code ?? 1));
