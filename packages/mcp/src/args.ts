/**
 * The command line: at most one library folder, and two options.
 *
 * One folder, because the server serves one library at a time: a song is
 * checked against its own library's configured groups and macros, and a
 * second folder's songs would be checked against the wrong lists. Another
 * library is opened with `use_library`, or by the client's roots.
 *
 * `--read-only` also takes `=true` or `=false`, because the Claude Desktop
 * extension can only pass a setting's value inside a fixed argument, and an
 * unticked box arrives as `--read-only=false`.
 */
export interface Args {
  folder?: string;
  readOnly: boolean;
  backupDir?: string;
}

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = { readOnly: false };
  for (const arg of argv) {
    if (!arg.startsWith("--")) {
      if (args.folder !== undefined) {
        throw new Error(
          `One library folder at a time: ${args.folder} and ${arg} were both given. ` +
            "Start the server on one; another can be opened with use_library."
        );
      }
      args.folder = arg;
      continue;
    }
    const eq = arg.indexOf("=");
    const flag = eq < 0 ? arg : arg.slice(0, eq);
    const value = eq < 0 ? undefined : arg.slice(eq + 1);
    if (flag === "--read-only") {
      if (value !== undefined && value !== "true" && value !== "false") {
        throw new Error(`--read-only takes true or false, not ${value}`);
      }
      args.readOnly = value !== "false";
    } else if (flag === "--backup-dir") {
      if (!value) throw new Error("--backup-dir needs a folder: --backup-dir=<folder>");
      args.backupDir = value;
    } else {
      throw new Error(`Unknown option ${arg}`);
    }
  }
  return args;
}
