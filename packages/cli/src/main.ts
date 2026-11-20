import { run } from "./cli";

// Piped into `head`, the reader goes away mid-write; that is the reader's
// choice, not a failure to report.
process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EPIPE") process.exit(0);
  throw e;
});

process.exitCode = await run(process.argv.slice(2), {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(text.startsWith("\r") ? text : `${text}\n`),
  interactive: process.stderr.isTTY,
});
