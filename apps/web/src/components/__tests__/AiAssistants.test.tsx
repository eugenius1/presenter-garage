/** @vitest-environment jsdom */

import fs from "node:fs";
import path from "node:path";
import { render, screen, waitFor } from "@testing-library/react";
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
    // uploads it, and this link fetches it. A rename in one breaks the link.
    const file = path.basename(MCPB_URL);
    expect(read("packages/mcp/scripts/pack-mcpb.mjs")).toContain(`dist/${file}`);
    expect(read(".github/workflows/release.yml")).toContain(`dist/${file}`);
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

  it("selects the command when the clipboard refuses", async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
    renderIt();

    await user.click(screen.getByRole("button", { name: "Copy" }));

    await waitFor(() => expect(window.getSelection()?.toString()).toBe(CLI_COMMAND));
    expect(screen.getByRole("button", { name: /select the command/i })).toBeInTheDocument();
  });
});
