import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";

/**
 * The newest release's Claude Desktop extension. GitHub's `latest/download`
 * resolves against whichever release is newest in the whole repository, so
 * the release workflow attaches the file to every release, not only the ones
 * that change the server -- one release without it and this link 404s. The
 * file name is the one `packages/mcp/scripts/pack-mcpb.mjs` writes.
 */
export const MCPB_URL =
  "https://github.com/eugenius1/presenter-garage/releases/latest/download/presenter-garage.mcpb";

/** The same command the README gives, so the two never drift into two set-ups. */
export const CLI_COMMAND =
  "claude mcp add presenter-garage -- npx -y presenter-garage-mcp ~/Documents/ProPresenter";

const GUIDE_URL = "https://github.com/eugenius1/presenter-garage#for-ai-assistants-mcp";

type CopyState = "idle" | "copied" | "failed";

/**
 * Where a user of the app finds the MCP server: a download for Claude Desktop
 * and a command for everything else.
 *
 * Folded away by default. It is the one part of the page that is not about
 * the files in front of the reader, and the one that sends anything off the
 * machine, which it says plainly rather than leaving the "Runs offline" chip
 * to imply otherwise.
 */
export function AiAssistants() {
  const { t } = useI18n();
  const [copy, setCopy] = useState<CopyState>("idle");
  const command = useRef<HTMLElement>(null);

  // Back to "Copy" after a moment, so a second copy gets its own confirmation.
  useEffect(() => {
    if (copy === "idle") return;
    const timer = setTimeout(() => setCopy("idle"), 2000);
    return () => clearTimeout(timer);
  }, [copy]);

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(CLI_COMMAND);
      setCopy("copied");
    } catch {
      // No clipboard access (an insecure origin, a refused permission): select
      // the command instead, so one keystroke still copies it.
      const node = command.current;
      if (node) window.getSelection()?.selectAllChildren(node);
      setCopy("failed");
    }
  }

  const a = t.assistants;
  return (
    <details className="card assistants">
      <summary>
        <h2>{a.heading}</h2>
      </summary>
      <p className="sub">{a.lead}</p>
      <p className="sub">{a.privacy}</p>

      <h3>{a.desktopHeading}</h3>
      <p className="assistants-row">
        <a className="btn primary" href={MCPB_URL}>
          {a.desktopDownload}
        </a>
        <span className="sub">{a.desktopHelp}</span>
      </p>

      <h3>{a.cliHeading}</h3>
      <p className="sub">{a.cliHelp}</p>
      <div className="assistants-row">
        <code ref={command} className="command">
          {CLI_COMMAND}
        </code>
        <button className="btn" onClick={copyCommand} aria-live="polite">
          {copy === "copied" ? a.copied : copy === "failed" ? a.copyFailed : a.copy}
        </button>
      </div>

      <p className="sub">
        <a href={GUIDE_URL} target="_blank" rel="noreferrer">
          {a.guide}
        </a>
      </p>
    </details>
  );
}
