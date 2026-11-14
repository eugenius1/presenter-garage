/** @vitest-environment jsdom */

import fs from "node:fs";
import path from "node:path";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AiAssistants, CLI_COMMAND, MCPB_URL } from "../AiAssistants";
import { I18nProvider } from "../../i18n";

const root = path.resolve(__dirname, "../../../../..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

function renderIt() {
  render(
    <I18nProvider>
      <AiAssistants />
    </I18nProvider>
  );
}

afterEach(() => vi.restoreAllMocks());

describe("AiAssistants", () => {
  it("links the extension the release workflow attaches", () => {
    renderIt();
    expect(screen.getByRole("link", { name: /download the extension/i })).toHaveAttribute(
      "href",
      MCPB_URL
    );
    // Three places name the file: the pack script writes it, the workflow
    // carries it to the release and uploads it, and this link fetches it. A
    // rename in one breaks the link. The upload is the line that names the
    // asset, so it is checked on its own rather than through the copy before it.
    const file = path.basename(MCPB_URL);
    const workflow = read(".github/workflows/release.yml");
    expect(read("packages/mcp/scripts/pack-mcpb.mjs")).toContain(`dist/${file}`);
    expect(workflow).toContain(`cp dist/${file} `);
    expect(workflow).toMatch(new RegExp(`gh release upload "\\$TAG" ${file.replace(".", "\\.")} `));
  });

  it("gives the same command as the README", () => {
    expect(read("README.md")).toContain(CLI_COMMAND);
  });

  it("copies the command", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    renderIt();

    await user.click(screen.getByRole("button", { name: "Copy" }));

    expect(writeText).toHaveBeenCalledWith(CLI_COMMAND);
    await waitFor(() => expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument());
  });

  it("goes back to Copy after a moment, so a second copy is confirmed too", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      vi.spyOn(navigator.clipboard, "writeText");
      renderIt();

      await user.click(screen.getByRole("button", { name: "Copy" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument());
      await act(() => vi.advanceTimersByTimeAsync(2000));

      expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("selects the command when the clipboard refuses", async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
    renderIt();

    await user.click(screen.getByRole("button", { name: "Copy" }));

    await waitFor(() => expect(window.getSelection()?.toString()).toBe(CLI_COMMAND));
    expect(screen.getByRole("button", { name: /select the command/i })).toBeInTheDocument();
  });
});
