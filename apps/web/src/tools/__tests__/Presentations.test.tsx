/** @vitest-environment jsdom */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Presentations } from "../Presentations";
import { I18nProvider } from "../../i18n";
import {
  checkPresentation,
  decodePresentation,
  encodePresentation,
  readPresentation,
  writeTextBoxes,
} from "@presenter-garage/core/lib/presentation";
import { MACROS, rtfWithHeader, syntheticMacroSong, syntheticTextPresentation } from "@presenter-garage/core/lib/__tests__/synthetic";
import { applyFixes, examine, fixKey, planFixes } from "@presenter-garage/core/lib/fixes";
import { DEFAULT_RULES, parseRules } from "@presenter-garage/core/lib/rules";
import type { FolderAccess, PickedFolder } from "@presenter-garage/core/lib/folder";
import {
  BRIDGE_GLOBAL,
  type ChosenFile,
  type DesktopBridge,
  type NativeApplyResult,
  type NativeFolder,
  type NativeConfiguration,
  type NativeRules,
} from "@presenter-garage/core/lib/desktop";

/**
 * A folder held in memory, standing in for one on disk.
 *
 * The interesting behaviour is the gating -- what is offered, when, and what
 * finally reaches the folder -- and none of it needs a real directory handle.
 */
const store = new Map<string, Uint8Array>();
let access: FolderAccess = "readwrite";
let writable = true;
/** Set by a test that wants to watch a run part-way through. */
let beforeRead: ((path: string) => Promise<void>) | null = null;
/** The name of the folder a person chooses. */
let folderName = "Libraries";
/** Values kept by a previous visit, standing in for IndexedDB. */
const remembered = new Map<string, unknown>();

function fakeFolder(): PickedFolder {
  return {
    name: folderName,
    handle: writable ? { name: folderName } : undefined,
    files: [...store.keys()].map((path) => ({
      path,
      name: path.split("/").pop()!,
      size: 0,
      read: async () => {
        await beforeRead?.(path);
        return store.get(path)!;
      },
      write: writable ? async (bytes: Uint8Array) => void store.set(path, bytes) : undefined,
    })),
  };
}

vi.mock("@presenter-garage/core/lib/folder", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@presenter-garage/core/lib/folder")>()),
  folderAccess: () => access,
  pickFolder: async () => fakeFolder(),
  readFolderHandle: async () => fakeFolder(),
}));

vi.mock("../../lib/persistence", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/persistence")>()),
  requestHandlePermission: async () => "granted" as PermissionState,
  // What the last visit left behind; nothing, unless a test says otherwise.
  remember: async (key: string) => remembered.get(key) ?? null,
}));

/** Capture what a download hands the browser, instead of downloading it. */
function captureDownloads() {
  const captured: { name: string; blob: Blob }[] = [];
  let pending: Blob | undefined;

  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: (blob: Blob) => {
      pending = blob;
      return "blob:captured";
    },
    revokeObjectURL: () => {},
  });

  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(function (this: HTMLAnchorElement) {
      captured.push({ name: this.download, blob: pending! });
    });

  return { captured, restore: () => click.mockRestore() };
}

const issuesIn = (bytes: Uint8Array) =>
  checkPresentation("x", readPresentation(decodePresentation(bytes))).issues;

function renderTool() {
  return render(
    <I18nProvider>
      <Presentations />
    </I18nProvider>
  );
}

/** Choose the folder and wait for the scan to settle. */
async function openFolder(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: /Choose a folder/ }));
  await screen.findByRole("heading", { name: "Fix these" });
}

beforeEach(() => {
  vi.unstubAllGlobals();
  access = "readwrite";
  writable = true;
  beforeRead = null;
  folderName = "Libraries";
  remembered.clear();
  store.clear();
  store.set("Chants/Checked Song.pro", syntheticTextPresentation());
});

afterEach(() => vi.restoreAllMocks());

describe("reopening the last folder", () => {
  it("rereads a folder whose permission is still granted, without asking", async () => {
    remembered.set("presentations.folder", { name: "Libraries", queryPermission: async () => "granted" });
    renderTool();
    // Read straight away: nothing to click, and no offer to grant access again.
    expect(await screen.findByRole("heading", { name: "Fix these" })).toBeInTheDocument();
    expect(screen.getByText("leading space")).toBeInTheDocument();
  });
});

describe("finding and showing fixes", () => {
  it("shows each line as it is and as it would read", async () => {
    const user = userEvent.setup();
    renderTool();
    await openFolder(user);

    // A leading space, shown as a dot, and the line without it.
    expect(screen.getByText("·leading space")).toBeInTheDocument();
    expect(screen.getByText("leading space")).toBeInTheDocument();
    // A blank line is removed rather than rewritten.
    expect(screen.getByText("the line is removed")).toBeInTheDocument();
  });

  it("gathers several findings on one line into one decision", async () => {
    const user = userEvent.setup();
    renderTool();
    await openFolder(user);

    // Four findings in the fixture, on four separate lines.
    expect(screen.getByRole("button", { name: "Fix 4 lines" })).toBeInTheDocument();
  });

  it("follows the filters", async () => {
    const user = userEvent.setup();
    renderTool();
    await openFolder(user);

    await user.click(screen.getByRole("button", { name: /^Leading space/ }));
    await user.click(screen.getByRole("button", { name: /^Trailing space/ }));
    await user.click(screen.getByRole("button", { name: /^Double space/ }));

    // Only the blank line is left showing, so only it is offered.
    expect(await screen.findByRole("button", { name: "Fix 1 line" })).toBeInTheDocument();
  });
});

describe("showing each fix among the slides around it", () => {
  /** The context run's slides, each as its heading and the lines only there to read. */
  const slidesShown = () =>
    [...document.querySelectorAll(".context-slide")].map((slide) => [
      slide.querySelector(".context-head")!.textContent,
      [...slide.querySelectorAll(".context-line")].map((line) => line.textContent),
    ]);

  it("shows two slides either side, each with its group, the lines around set apart and nothing in them to tick", async () => {
    const user = userEvent.setup();
    renderTool();
    await openFolder(user);

    // The four findings sit on slides 2 to 5: one run, from slide 1 to slide 7.
    expect(slidesShown()).toEqual([
      ["slide 1 · Verse", ["A tidy line", "And another"]],
      ["slide 2 · Verse", ["Fine here"]],
      ["slide 3 · Chorus", ["Fine"]],
      ["slide 4 · Chorus", ["Above", "Below"]],
      ["slide 5 · Chorus", []],
      ["slide 6 · Chorus", ["no text on this slide"]],
      ["slide 7 · Chorus", ["Que ton nom,", "pour toujours ,", "sois glorifie"]],
    ]);
    expect(document.querySelectorAll(".context-slide.holds-row")).toHaveLength(4);
    // A tick box for each line a fix is offered for, and none anywhere else.
    expect(document.querySelectorAll(".context-line input")).toHaveLength(0);
    expect(screen.getAllByRole("checkbox", { name: /^slide \d+ line \d+$/ })).toHaveLength(4);
    // Each row still shows its line as it is and as it would read, in place among the others.
    const gap = [...document.querySelectorAll(".context-slide")][3];
    expect([...gap.querySelectorAll(".rows > li")].map((li) => li.className)).toEqual(["context-line", "finding-row", "context-line"]);
  });

  it("names each slide's macros, a switched-off one said so", async () => {
    store.set("Chants/Checked Song.pro", syntheticMacroSong());
    const user = userEvent.setup();
    renderTool();
    await openFolder(user);

    const heads = slidesShown().map(([head]) => head);
    expect(heads).toContain(`slide 1 · Couplet\u00a01 · ${MACROS.bienvenue.name}`);
    expect(heads).toContain(`slide 4 · Chorus · ${MACROS.louange.name}, ${MACROS.lumieres.name} (off)`);
  });

  it("gives each file its own run, with its own tick boxes", async () => {
    store.set("Chants/Other Song.pro", syntheticTextPresentation("Other Song"));
    const user = userEvent.setup();
    renderTool();
    await openFolder(user);

    expect(document.querySelectorAll(".context-run")).toHaveLength(2);
    expect(screen.getAllByRole("checkbox", { name: /^slide \d+ line \d+$/ })).toHaveLength(8);
  });
});

describe("the opt-in checks", () => {
  it("offers one switch per mark, all off to begin with", async () => {
    const user = userEvent.setup();
    renderTool();
    await openFolder(user);

    for (const label of [
      "Also look for trailing commas",
      "Also look for trailing semicolons",
      "Also look for trailing full stops",
    ]) {
      expect(screen.getByRole("checkbox", { name: label })).not.toBeChecked();
    }
    // Nothing punctuation-related is reported until one is asked for.
    expect(screen.queryByRole("button", { name: /^Trailing full stop/ })).not.toBeInTheDocument();
  });

  it("shows only the mark that was switched on", async () => {
    const user = userEvent.setup();
    renderTool();
    await openFolder(user);

    await user.click(screen.getByRole("checkbox", { name: "Also look for trailing full stops" }));

    expect(await screen.findByRole("button", { name: "Trailing full stop 1" })).toBeInTheDocument();
    // The comma check is a separate decision and stays off.
    expect(screen.queryByRole("button", { name: /^Trailing comma/ })).not.toBeInTheDocument();
    // One more line to fix than before, and it is the full stop.
    expect(screen.getByRole("button", { name: "Fix 5 lines" })).toBeInTheDocument();
    expect(screen.getByText("je te loue")).toBeInTheDocument();
  });

  it("leaves a line ending in an ellipsis alone", async () => {
    const user = userEvent.setup();
    renderTool();
    await openFolder(user);

    await user.click(screen.getByRole("checkbox", { name: "Also look for trailing full stops" }));
    await screen.findByRole("button", { name: "Trailing full stop 1" });

    // Both spellings are in the fixture and neither is a finding: each is
    // on screen only as a line around the full stop that is.
    const asFinding = (text: string | RegExp) => screen.queryAllByText(text).filter((el) => el.closest(".finding-row"));
    expect(asFinding(/chanterai/)).toEqual([]);
    expect(asFinding("Gloire...")).toEqual([]);
    expect(screen.getByText("Gloire...")).toHaveClass("context-line");
  });
});

describe("the order files are listed in", () => {
  /**
   * The file headings, in the order they appear on screen.
   *
   * The count badge lives inside the heading, so it is dropped by element
   * rather than by stripping trailing digits -- which would also eat the 9 in
   * "Psaume 9".
   */
  const headings = () =>
    screen.getAllByRole("heading", { level: 3 }).map((h) =>
      [...h.childNodes]
        .filter((n) => !(n instanceof Element && n.classList.contains("count-badge")))
        .map((n) => n.textContent)
        .join("")
    );

  /** A file whose presentation name differs from its path, as real ones do. */
  const put = (path: string, name: string) => store.set(path, syntheticTextPresentation(name));

  it("sorts by the name on screen, not by whatever the folder handed back", async () => {
    store.clear();
    put("Chants/zzz-01.pro", "Zacharie");
    put("Chants/aaa-02.pro", "Merveilleux");
    put("Chants/mmm-03.pro", "Acclamons");

    const user = userEvent.setup();
    renderTool();
    await openFolder(user);

    // Alphabetical by the heading, which is the presentation's own name --
    // sorting by the filename would have produced exactly the reverse.
    expect(headings()).toEqual(["Acclamons", "Merveilleux", "Zacharie"]);
  });

  it("ignores accents when sorting, and counts numbers as numbers", async () => {
    // A French library sorts "Élever" beside "Elever", not after "Z", and
    // "Psaume 9" comes before "Psaume 10" rather than after it.
    store.clear();
    for (const name of ["Psaume 10", "Zacharie", "Psaume 9", "Élever"]) {
      put(`Chants/${name}.pro`, name);
    }

    const user = userEvent.setup();
    renderTool();
    await openFolder(user);

    expect(headings()).toEqual(["Élever", "Psaume 9", "Psaume 10", "Zacharie"]);
  });

  it("puts two songs of the same name in a settled order", async () => {
    store.clear();
    put("Noël/Acclamons.pro", "Acclamons");
    put("Chants/Acclamons.pro", "Acclamons");

    const user = userEvent.setup();
    const view = renderTool();
    await openFolder(user);

    // The names tie, so the path decides -- and the path is what tells them
    // apart on screen.
    expect([...view.container.querySelectorAll(".finding-folder")].map((e) => e.textContent)).toEqual([
      "Libraries/Chants",
      "Libraries/Noël",
    ]);
  });

  it("names the folder only when the files are not all in one", async () => {
    store.clear();
    put("Chants/Acclamons.pro", "Acclamons");
    put("Chants/Zacharie.pro", "Zacharie");

    const user = userEvent.setup();
    const view = renderTool();
    await openFolder(user);
    expect(view.container.querySelector(".finding-folder")).toBeNull();

    put("Noël/Merveilleux.pro", "Merveilleux");
    await user.click(screen.getByRole("button", { name: "Change" }));
    await waitFor(() =>
      expect(
        [...view.container.querySelectorAll(".finding-folder")].map((e) => e.textContent)
      ).toEqual(["Libraries/Chants", "Libraries/Noël", "Libraries/Chants"])
    );
  });

  it("names an unreadable file by its own name, not its whole path", async () => {
    store.clear();
    store.set("Chants/Broken.pro", new Uint8Array([0x3c, 0xff, 0xfe]));
    put("Noël/Zacharie.pro", "Zacharie");

    const user = userEvent.setup();
    renderTool();
    await openFolder(user);

    // The folder is named once, beside the heading -- not again inside it.
    expect(headings()[0]).toBe("Libraries/ChantsBroken.pro");
  });
});

describe("the guard before anything is written", () => {
  it("will not save until a backup has been taken", async () => {
    const user = userEvent.setup();
    const original = store.get("Chants/Checked Song.pro")!;
    renderTool();
    await openFolder(user);

    expect(screen.getByRole("button", { name: "Fix 4 lines" })).toBeDisabled();
    expect(store.get("Chants/Checked Song.pro")).toBe(original);
  });

  it("backs up the files as they stand, then saves", async () => {
    const user = userEvent.setup();
    const downloads = captureDownloads();
    const original = store.get("Chants/Checked Song.pro")!;
    expect(issuesIn(original)).not.toHaveLength(0);

    renderTool();
    await openFolder(user);

    await user.click(screen.getByRole("button", { name: /Download a backup/ }));
    await waitFor(() => expect(downloads.captured).toHaveLength(1));
    expect(downloads.captured[0].name).toMatch(/^propresenter-backup-\d{8}-\d{4}\.zip$/);
    // The archive holds the file as it was, before anything was written.
    expect(downloads.captured[0].blob.size).toBeGreaterThan(0);
    expect(store.get("Chants/Checked Song.pro")).toBe(original);

    const save = await screen.findByRole("button", { name: "Fix 4 lines" });
    await waitFor(() => expect(save).toBeEnabled());
    await user.click(save);

    await screen.findByText("1 file fixed");
    const written = store.get("Chants/Checked Song.pro")!;
    expect(written).not.toBe(original);
    // Everything the reader was shown is gone. The trailing punctuation
    // remains because those checks are off by default, which is the point of
    // them being off: nothing is fixed that was never reported.
    expect(issuesIn(written).map((i) => i.kind)).toEqual([
      "trailingComma",
      "trailingComma",
      "trailingSemicolon",
      "trailingFullStop",
    ]);

    downloads.restore();
  });

  it("asks for the backup again once the selection outgrows it", async () => {
    const user = userEvent.setup();
    const downloads = captureDownloads();
    store.set("Chants/Second.pro", syntheticTextPresentation());

    renderTool();
    await openFolder(user);

    // Back up with one file deselected, then put it back in.
    const perFile = screen.getAllByRole("checkbox", { name: /Select every line/ });
    await user.click(perFile[1]);
    await user.click(screen.getByRole("button", { name: /Download a backup/ }));
    await waitFor(() => expect(downloads.captured).toHaveLength(1));

    await user.click(perFile[1]);
    expect(await screen.findByRole("button", { name: /^Fix 8 lines/ })).toBeDisabled();
    expect(
      screen.getByText(/selection now covers files the backup does not/)
    ).toBeInTheDocument();

    downloads.restore();
  });

  it("writes only the lines left ticked", async () => {
    const user = userEvent.setup();
    const downloads = captureDownloads();
    renderTool();
    await openFolder(user);

    // Leave one line out of the run.
    await user.click(screen.getByRole("checkbox", { name: "slide 2 line 2" }));
    expect(await screen.findByRole("button", { name: "Fix 3 lines" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Download a backup/ }));
    await user.click(await screen.findByRole("button", { name: "Fix 3 lines" }));

    await screen.findByText("1 file fixed");
    const kinds = issuesIn(store.get("Chants/Checked Song.pro")!).map((i) => i.kind);
    // The line left unticked is untouched; so is the punctuation nobody asked
    // for.
    expect(kinds).toEqual([
      "leadingSpace",
      "trailingComma",
      "trailingComma",
      "trailingSemicolon",
      "trailingFullStop",
    ]);

    downloads.restore();
  });
});

describe("showing how far a run has got", () => {
  const bar = () => screen.queryByRole("progressbar");

  /**
   * Reads that do not resolve until they are let go, one at a time.
   *
   * The whole point of a progress bar is the state part-way through, and fakes
   * that resolve straight away would only ever show it finished.
   */
  function holdReads() {
    const waiting: (() => void)[] = [];
    beforeRead = () => new Promise<void>((resolve) => waiting.push(resolve));
    return {
      /** Let the file currently being read through. */
      next: async () => {
        await waitFor(() => expect(waiting.length).toBeGreaterThan(0));
        waiting.shift()!();
      },
      release: () => {
        beforeRead = null;
        for (const resolve of waiting.splice(0)) resolve();
      },
    };
  }

  beforeEach(() => {
    store.clear();
    // Named so they sort Deux, Trois, Un -- the order the run works through.
    for (const name of ["Un", "Deux", "Trois"]) {
      store.set(`Chants/${name}.pro`, syntheticTextPresentation(name));
    }
  });

  it("shows nothing until a run starts", async () => {
    const user = userEvent.setup();
    renderTool();
    await openFolder(user);
    expect(bar()).not.toBeInTheDocument();
  });

  it("counts files finished, naming the one it is on", async () => {
    const user = userEvent.setup();
    const downloads = captureDownloads();
    renderTool();
    await openFolder(user);

    const held = holdReads();
    await user.click(screen.getByRole("button", { name: /Download a backup/ }));

    // Nothing finished yet, and the caption names the file being read.
    await waitFor(() => expect(bar()).toBeInTheDocument());
    expect(bar()).toHaveAttribute("aria-valuenow", "0");
    expect(bar()).toHaveAttribute("aria-valuemax", "3");
    expect(bar()).toHaveAttribute("aria-valuetext", "0 of 3");
    expect(screen.getByText("Backing up Chants/Deux.pro…")).toBeInTheDocument();

    await held.next();
    await waitFor(() => expect(bar()).toHaveAttribute("aria-valuenow", "1"));
    expect(screen.getByText("Backing up Chants/Trois.pro…")).toBeInTheDocument();
    expect(screen.getByText("1 of 3")).toBeInTheDocument();

    await held.next();
    await waitFor(() => expect(bar()).toHaveAttribute("aria-valuenow", "2"));

    held.release();
    await waitFor(() => expect(downloads.captured).toHaveLength(1));
    // Gone once there is nothing left to report.
    await waitFor(() => expect(bar()).not.toBeInTheDocument());

    downloads.restore();
  });

  it("never runs ahead of the work", async () => {
    // The bar counts files finished, not files started: a bar that reached the
    // end while the last file was still being written would be a lie at
    // exactly the moment it matters.
    const user = userEvent.setup();
    const downloads = captureDownloads();
    renderTool();
    await openFolder(user);

    const held = holdReads();
    await user.click(screen.getByRole("button", { name: /Download a backup/ }));
    await waitFor(() => expect(bar()).toBeInTheDocument());

    for (const expected of ["0", "1", "2"]) {
      await waitFor(() => expect(bar()).toHaveAttribute("aria-valuenow", expected));
      const fill = document.querySelector(".progress-fill") as HTMLElement;
      expect(fill.style.width).not.toBe("100%");
      await held.next();
    }

    held.release();
    await waitFor(() => expect(downloads.captured).toHaveLength(1));
    downloads.restore();
  });

  it("says what it is doing, which is not the same in every phase", async () => {
    const user = userEvent.setup();
    const downloads = captureDownloads();
    renderTool();
    await openFolder(user);

    await user.click(screen.getByRole("button", { name: /Download a backup/ }));
    await waitFor(() => expect(downloads.captured).toHaveLength(1));

    const held = holdReads();
    await user.click(await screen.findByRole("button", { name: /^Fix / }));

    // Writing back into the folder is a different phase from backing up, and
    // says so.
    await waitFor(() => expect(screen.getByText(/^Saving /)).toBeInTheDocument());
    expect(screen.queryByText(/^Backing up /)).not.toBeInTheDocument();

    held.release();
    await screen.findByText("3 files fixed");
    expect(bar()).not.toBeInTheDocument();

    downloads.restore();
  });

  it("reports the run that hands over a zip instead", async () => {
    writable = false;
    const user = userEvent.setup();
    const downloads = captureDownloads();
    renderTool();
    await openFolder(user);

    const held = holdReads();
    await user.click(screen.getByRole("button", { name: "Download the fixed files" }));

    await waitFor(() => expect(screen.getByText(/^Fixing /)).toBeInTheDocument());
    expect(bar()).toHaveAttribute("aria-valuemax", "3");

    held.release();
    await waitFor(() => expect(downloads.captured).toHaveLength(1));
    await waitFor(() => expect(bar()).not.toBeInTheDocument());

    downloads.restore();
  });
});

describe("a browser that cannot write", () => {
  // The folder came back without a handle, which is what the picker fallback
  // and the directory input both leave behind: files that can be read and no
  // way back to the originals.
  beforeEach(() => {
    writable = false;
  });

  it("hands over fixed copies and leaves the library alone", async () => {
    const user = userEvent.setup();
    const downloads = captureDownloads();
    const original = store.get("Chants/Checked Song.pro")!;

    renderTool();
    await openFolder(user);

    // No backup is asked for, because nothing is about to be overwritten.
    expect(screen.queryByRole("button", { name: /Download a backup/ })).not.toBeInTheDocument();
    expect(screen.getByText(/cannot write to the folder/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Download the fixed files" }));
    await waitFor(() => expect(downloads.captured).toHaveLength(1));

    expect(downloads.captured[0].name).toMatch(/^propresenter-fixed-\d{8}-\d{4}\.zip$/);
    expect(downloads.captured[0].blob.size).toBeGreaterThan(0);
    expect(await screen.findByText(/has not been touched/)).toBeInTheDocument();

    // The library is exactly as it was: the findings are all still there.
    expect(store.get("Chants/Checked Song.pro")).toBe(original);
    expect(issuesIn(original)).not.toHaveLength(0);

    downloads.restore();
  });
});

describe("the desktop app", () => {
  const ROOT = "/Users/someone/ProPresenter";
  let applied: ChosenFile[][];
  let result: NativeApplyResult;
  let shown: string[];
  let teamRules: () => Promise<NativeRules>;
  let configuration: NativeConfiguration;

  function fakeBridge(folder: Partial<NativeFolder> = {}): DesktopBridge {
    const opened = (): NativeFolder => ({
      root: ROOT,
      name: "ProPresenter",
      files: [...store.keys()].map((path) => ({ path: `${ROOT}/${path}`, relative: path, name: path.split("/").pop()! })),
      truncated: false,
      ...folder,
    });
    return {
      pickFolder: async () => opened(),
      reopenLast: async () => null,
      forgetLast: async () => {},
      workspaces: async () => [{ root: "/ws/1", name: "Church", active: true, cloud: false }],
      openWorkspace: async () => opened(),
      read: async (path) => ({ bytes: store.get(path.slice(ROOT.length + 1))!, sha256: `sha of ${path}` }),
      applyFixes: async (files) => {
        applied.push(files);
        return result;
      },
      showBackups: async (dir) => void shown.push(dir),
      loadTeamRules: async () => teamRules(),
      readConfiguration: async () => configuration,
    };
  }

  beforeEach(() => {
    access = "native";
    configuration = { problems: [] };
    applied = [];
    shown = [];
    result = { backupFolder: "/backups/run", files: [] };
    teamRules = async () => {
      throw new Error("not set up");
    };
  });

  it("reopens the folder the shell remembers, on start", async () => {
    const bridge = fakeBridge();
    const last = await bridge.pickFolder();
    vi.stubGlobal(BRIDGE_GLOBAL, { ...bridge, reopenLast: async () => last });
    renderTool();
    expect(await screen.findByRole("heading", { name: "Fix these" })).toBeInTheDocument();
    expect(screen.getByText(ROOT)).toBeInTheDocument();
  });

  it("shows the folder's real path and ProPresenter's workspaces", async () => {
    vi.stubGlobal(BRIDGE_GLOBAL, fakeBridge());
    const user = userEvent.setup();
    renderTool();
    expect(await screen.findByText("Church")).toBeInTheDocument();
    await openFolder(user);
    expect(screen.getByText(ROOT)).toBeInTheDocument();
  });

  it("sends the shell only the lines left ticked, as they were shown, and asks for no backup itself", async () => {
    vi.stubGlobal(BRIDGE_GLOBAL, fakeBridge());
    const user = userEvent.setup();
    renderTool();
    await openFolder(user);

    // The shell makes the backup; there is nothing to download first.
    expect(screen.queryByRole("button", { name: /Download a backup/ })).not.toBeInTheDocument();
    const boxes = screen.getAllByRole("checkbox", { name: /^slide \d+ line \d+$/ });
    await user.click(boxes[0]);
    await user.click(screen.getByRole("button", { name: /^Fix \d+ lines?$/ }));
    await waitFor(() => expect(applied).toHaveLength(1));

    const [file] = applied[0];
    expect(file.path).toBe(`${ROOT}/Chants/Checked Song.pro`);
    expect(file.sha256).toBe(`sha of ${ROOT}/Chants/Checked Song.pro`);
    expect(file.kinds).toEqual(["leadingSpace", "trailingSpace", "blankLine", "repeatedSpace"]);
    expect(file.lines).toHaveLength(boxes.length - 1);
    // What was shown, never bytes: the shell works the fix out again itself.
    for (const line of file.lines) expect(Object.keys(line).sort()).toEqual(["after", "before", "boxIndex", "lineIndex"]);
    // Every line as shown but the one unticked, which is the first.
    const { report, fixable } = examine("Checked Song.pro", store.get("Chants/Checked Song.pro")!);
    const every = planFixes(fixable, report.issues.filter((issue) => file.kinds.includes(issue.kind))).map(
      ({ boxIndex, lineIndex, before, after }) => ({ boxIndex, lineIndex, before, after })
    );
    expect(every).toHaveLength(boxes.length);
    expect(file.lines).toEqual(every.slice(1));

    await user.click(await screen.findByRole("button", { name: "Show backups" }));
    expect(shown).toEqual(["/backups/run"]);
  });

  it("says so when the backup folder will not open, and keeps its path in view", async () => {
    const shell = fakeBridge();
    shell.showBackups = async () => {
      throw new Error("not found");
    };
    vi.stubGlobal(BRIDGE_GLOBAL, shell);
    const user = userEvent.setup();
    renderTool();
    await openFolder(user);
    await user.click(screen.getByRole("button", { name: /^Fix \d+ lines?$/ }));
    await user.click(await screen.findByRole("button", { name: "Show backups" }));

    expect(await screen.findByText(/The backup folder could not be opened/)).toBeInTheDocument();
    expect(screen.getByText(/\/backups\/run/)).toBeInTheDocument();
  });

  it("keeps lines unticked in a file the save did not touch", async () => {
    store.set("Chants/Other Song.pro", syntheticTextPresentation("Other Song"));
    vi.stubGlobal(BRIDGE_GLOBAL, fakeBridge());
    result = { backupFolder: "/backups/run", files: [{ path: `${ROOT}/Chants/Other Song.pro`, lines: 1, written: true }] };
    const user = userEvent.setup();
    renderTool();
    await openFolder(user);

    // Leave out the whole of the first song; save the second.
    await user.click(screen.getAllByRole("checkbox", { name: "Select every line in this file" })[0]);
    await user.click(screen.getByRole("button", { name: /^Fix \d+ lines?$/ }));
    await waitFor(() => expect(applied).toHaveLength(1));
    expect(applied[0].map((file) => file.path)).toEqual([`${ROOT}/Chants/Other Song.pro`]);
    await screen.findByRole("button", { name: "Show backups" });

    await user.click(screen.getByRole("button", { name: /^Fix \d+ lines?$/ }));
    await waitFor(() => expect(applied).toHaveLength(2));
    expect(applied[1].map((file) => file.path)).toEqual([`${ROOT}/Chants/Other Song.pro`]);
  });

  it.each([
    ["shown", false],
    ["hidden by a filter while the file was saved", true],
  ])("keeps a line unticked in a file the save changed, though the save moved it: %s", async (_, hide) => {
    // A blank line, then a line ending in a space, in one box: removing the
    // first moves the second up.
    const doc = decodePresentation(syntheticTextPresentation());
    writeTextBoxes(doc, new Map([[3, rtfWithHeader("\\cb3 Above\\par\\pard\\li0\\qc\\fs200\\par\\pard\\cb3 Below ")]]));
    store.set("Chants/Checked Song.pro", encodePresentation(doc));
    const shell = fakeBridge();
    // Writes what it was sent, so the rescan reads the file as saved.
    shell.applyFixes = async (files) => {
      applied.push(files);
      for (const file of files) {
        const name = file.path.slice(ROOT.length + 1);
        const bytes = store.get(name)!;
        const { report, fixable } = examine(name, bytes);
        const sent = new Set(file.lines.map(fixKey));
        const fixes = planFixes(fixable, report.issues.filter((issue) => file.kinds.includes(issue.kind)));
        store.set(name, applyFixes(bytes, fixes.filter((fix) => sent.has(fixKey(fix)))));
      }
      return { backupFolder: "/backups/run", files: files.map((file) => ({ path: file.path, lines: file.lines.length, written: true })) };
    };
    vi.stubGlobal(BRIDGE_GLOBAL, shell);
    const user = userEvent.setup();
    renderTool();
    await openFolder(user);

    const kept = screen.getByRole("checkbox", { name: "slide 4 line 3" });
    await user.click(kept);
    if (hide) await user.click(screen.getByRole("button", { name: /^Trailing space/ }));
    await user.click(screen.getByRole("button", { name: /^Fix \d+ lines?$/ }));
    await screen.findByRole("button", { name: "Show backups" });
    if (hide) await user.click(screen.getByRole("button", { name: /^Trailing space/ }));

    // Moved up a line by the blank one's removal, and still unticked.
    expect(screen.queryByRole("checkbox", { name: "slide 4 line 3" })).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "slide 4 line 2" })).not.toBeChecked();
  });

  // Copies of one line cannot be told apart once the file may have changed:
  // neither their number nor their order says which was which.
  it.each([
    ["a save that wrote nothing", "\\cb3 Same \\par\\pard\\cb3 Same ", "slide 4 line 2", "\\cb3 Same \\par\\pard\\cb3 Same "],
    ["a copy removed elsewhere", "\\cb3 Same \\par\\pard\\cb3 Same \\par\\pard\\cb3 Same ", "slide 4 line 3", "\\cb3 Same \\par\\pard\\cb3 Same "],
    ["the copies moved elsewhere", "\\cb3 Same \\par\\pard\\cb3 Same \\par\\pard\\cb3 Other", "slide 4 line 2", "\\cb3 Same \\par\\pard\\cb3 Other\\par\\pard\\cb3 Same "],
  ])("unticks every copy of a line when one was unticked, after %s", async (_, lines, untick, after) => {
    const withBox = (rtf: string) => {
      const doc = decodePresentation(syntheticTextPresentation());
      writeTextBoxes(doc, new Map([[3, rtfWithHeader(rtf)]]));
      return encodePresentation(doc);
    };
    store.set("Chants/Checked Song.pro", withBox(lines));
    result = { files: [{ path: `${ROOT}/Chants/Checked Song.pro`, lines: 1, written: false, reason: "stale" }] };
    vi.stubGlobal(BRIDGE_GLOBAL, fakeBridge());
    const user = userEvent.setup();
    renderTool();
    await openFolder(user);

    await user.click(screen.getByRole("checkbox", { name: untick }));
    // Whatever changed the file before the save, the save is refused as stale.
    store.set("Chants/Checked Song.pro", withBox(after));
    await user.click(screen.getByRole("button", { name: /^Fix \d+ lines?$/ }));
    await waitFor(() => expect(applied).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("progressbar")).not.toBeInTheDocument());

    // Slide 4's only fixable lines are the copies, and every one waits for a new choice.
    const copies = screen.getAllByRole("checkbox", { name: /^slide 4 line \d+$/ });
    expect(copies).toHaveLength(2);
    for (const copy of copies) expect(copy).not.toBeChecked();
  });

  it("shows nothing that was still opening when the folder was cleared", async () => {
    let finishOpen: () => void = () => {};
    const shell = fakeBridge();
    const workspace = (): NativeFolder => ({
      root: "/ws/1",
      name: "Church",
      files: [...store.keys()].map((path) => ({ path: `/ws/1/${path}`, relative: path, name: path.split("/").pop()! })),
      truncated: false,
    });
    shell.openWorkspace = () => new Promise<NativeFolder>((resolve) => (finishOpen = () => resolve(workspace())));
    vi.stubGlobal(BRIDGE_GLOBAL, shell);
    const user = userEvent.setup();
    renderTool();
    await openFolder(user);

    await user.click(screen.getByRole("button", { name: "Open" }));
    await user.click(screen.getByRole("button", { name: "Clear" }));
    finishOpen();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.queryByText("/ws/1")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Fix these" })).not.toBeInTheDocument();
  });

  it("says nothing of an open a later one overtook", async () => {
    let failFirst: () => void = () => {};
    const shell = fakeBridge();
    shell.pickFolder = () => new Promise<NativeFolder>((_, reject) => (failFirst = () => reject(new Error("overtaken"))));
    vi.stubGlobal(BRIDGE_GLOBAL, shell);
    const user = userEvent.setup();
    renderTool();
    await user.click(await screen.findByRole("button", { name: /Choose a folder/ }));
    await user.click(await screen.findByRole("button", { name: "Open" }));
    await screen.findByRole("heading", { name: "Fix these" });

    failFirst();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText("overtaken")).not.toBeInTheDocument();
  });

  it("says why a run wrote nothing, in the reader's language", async () => {
    vi.stubGlobal(BRIDGE_GLOBAL, fakeBridge({ workspace: { name: "Church", cloud: false } }));
    result = { files: [], refused: { code: "propresenterOpen", detail: "English from the shell" } };
    const user = userEvent.setup();
    renderTool();
    await openFolder(user);
    expect(screen.getByText(/Quit ProPresenter before saving/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Fix \d+ lines?$/ }));
    expect(await screen.findByText(/ProPresenter has this workspace open, so nothing was written/)).toBeInTheDocument();
    expect(screen.queryByText("English from the shell")).not.toBeInTheDocument();
  });

  it("keeps the folder opened last when an earlier one finishes opening after it", async () => {
    let finishFirst: (folder: NativeFolder) => void = () => {};
    const shell = fakeBridge();
    // The dialog's folder takes its time; the workspace opened meanwhile does not.
    shell.pickFolder = () => new Promise<NativeFolder>((resolve) => (finishFirst = resolve));
    vi.stubGlobal(BRIDGE_GLOBAL, shell);
    const user = userEvent.setup();
    renderTool();
    await user.click(await screen.findByRole("button", { name: /Choose a folder/ }));
    await user.click(await screen.findByRole("button", { name: "Open" }));
    await screen.findByRole("heading", { name: "Fix these" });

    finishFirst({ root: "/Users/someone/Slow", name: "Slow", files: [], truncated: false });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.getByText(ROOT)).toBeInTheDocument();
    expect(screen.queryByText("/Users/someone/Slow")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Fix these" })).toBeInTheDocument();
  });

  it("leaves a folder opened during a save to itself when the save finishes", async () => {
    const WORKSPACE = "/ws/1";
    let finishOpen: () => void = () => {};
    let finishSave: () => void = () => {};
    let saved = false;
    const shell = fakeBridge();
    const workspace = (): NativeFolder => ({
      root: WORKSPACE,
      name: "Church",
      files: [...store.keys()].map((path) => ({ path: `${WORKSPACE}/${path}`, relative: path, name: path.split("/").pop()! })),
      truncated: false,
    });
    shell.openWorkspace = () => new Promise<NativeFolder>((resolve) => (finishOpen = () => resolve(workspace())));
    // Once saved, the first folder's copy can no longer be read: a rescan of it would say so.
    shell.read = async (path) => {
      if (saved && path.startsWith(ROOT)) throw new Error("moved away");
      return { bytes: store.get(path.replace(/^\/(Users\/someone\/ProPresenter|ws\/1)\//, ""))!, sha256: `sha of ${path}` };
    };
    shell.applyFixes = () =>
      new Promise<NativeApplyResult>((resolve) => (finishSave = () => ((saved = true), resolve(result))));
    result = { backupFolder: "/backups/run", files: [{ path: `${ROOT}/Chants/Checked Song.pro`, lines: 1, written: true }] };
    vi.stubGlobal(BRIDGE_GLOBAL, shell);
    const user = userEvent.setup();
    renderTool();
    await openFolder(user);

    await user.click(screen.getByRole("button", { name: "Open" }));
    await user.click(screen.getByRole("button", { name: /^Fix \d+ lines?$/ }));
    finishOpen();
    expect(await screen.findByText(WORKSPACE)).toBeInTheDocument();
    // Hidden while a run is in progress, so counted once it is over.
    finishSave();
    await waitFor(() => expect(screen.queryByRole("progressbar")).not.toBeInTheDocument());

    expect(screen.getByText(WORKSPACE)).toBeInTheDocument();
    expect(screen.getAllByRole("checkbox", { name: /^slide \d+ line \d+$/ })).toHaveLength(4);
    expect(screen.queryByText(/Could not be read/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show backups" })).not.toBeInTheDocument();
  });

  it("offers nothing to save from the last folder while the next one is read", async () => {
    let finishRead: () => void = () => {};
    const shell = fakeBridge();
    const plain = shell.read;
    shell.openWorkspace = async () => ({
      root: "/ws/1",
      name: "Church",
      files: [...store.keys()].map((path) => ({ path: `/ws/1/${path}`, relative: path, name: path.split("/").pop()! })),
      truncated: false,
    });
    shell.read = async (path) => {
      if (!path.startsWith("/ws/1/")) return plain(path);
      await new Promise<void>((resolve) => (finishRead = resolve));
      return plain(`${ROOT}/${path.slice("/ws/1/".length)}`);
    };
    vi.stubGlobal(BRIDGE_GLOBAL, shell);
    const user = userEvent.setup();
    renderTool();
    await openFolder(user);
    expect(screen.getByRole("button", { name: /^Fix \d+ lines?$/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(await screen.findByText("/ws/1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Fix \d+ lines?$/ })).not.toBeInTheDocument();
    expect(screen.queryAllByRole("checkbox", { name: /^slide \d+ line \d+$/ })).toHaveLength(0);

    finishRead();
    expect(await screen.findByRole("button", { name: /^Fix \d+ lines?$/ })).toBeInTheDocument();
  });

  it("writes to a Cloud workspace, with the Cloud warning beside the button", async () => {
    vi.stubGlobal(BRIDGE_GLOBAL, fakeBridge({ workspace: { name: "Church", cloud: true } }));
    const user = userEvent.setup();
    renderTool();
    await openFolder(user);
    expect(screen.getByText(/^This is a ProPresenter Cloud workspace\. A change made to the same text box on another computer/)).toBeInTheDocument();
    const fix = screen.getByRole("button", { name: /^Fix \d+ lines?$/ });
    expect(fix).toBeEnabled();
    await user.click(fix);
    expect(applied).toHaveLength(1);
  });

  it("gives no Cloud warning for a workspace kept on this computer", async () => {
    vi.stubGlobal(BRIDGE_GLOBAL, fakeBridge({ workspace: { name: "Church", cloud: false } }));
    const user = userEvent.setup();
    renderTool();
    await openFolder(user);
    expect(screen.queryByText(/ProPresenter Cloud workspace/)).not.toBeInTheDocument();
  });

  describe("the team's rules", () => {
    const RULES_PATH = "/Users/someone/Documents/ProPresenter/rules.json";
    const groupRules = { version: 1, rules: [{ id: "groups", check: "group-names", tier: 2, names: ["Refrain"] }], exceptions: [] };

    it("offers the team's rules, and checks with them", async () => {
      store.clear();
      store.set("Chants/Macro Song.pro", syntheticMacroSong());
      teamRules = async () => ({ set: parseRules(groupRules), stale: false, defaulted: false, json: RULES_PATH });
      vi.stubGlobal(BRIDGE_GLOBAL, fakeBridge());
      const user = userEvent.setup();
      renderTool();
      await openFolder(user);

      await user.click(screen.getByRole("button", { name: "Use the team's rules" }));
      expect((await screen.findAllByText(/is not in the group list/)).length).toBeGreaterThan(0);
      expect(screen.getByText(`The team's rules, from ${RULES_PATH}`)).toBeInTheDocument();
      expect(screen.queryByText(/has changed since/)).not.toBeInTheDocument();
    });

    it("matches a renamed macro by its uuid through the folder's own list", async () => {
      store.clear();
      store.set("Chants/Macro Song.pro", syntheticMacroSong());
      // ProPresenter's list calls the slides' "Louange" macro "Praise" now.
      configuration = { macros: [{ name: "Praise", uuid: MACROS.louange.uuid, collections: [] }], problems: [] };
      const rules = { version: 1, rules: [{ id: "praise", check: "slide-macros", tier: 3, where: "rest", required: ["Praise"] }], exceptions: [] };
      teamRules = async () => ({ set: parseRules(rules), stale: false, defaulted: false, json: RULES_PATH });
      vi.stubGlobal(BRIDGE_GLOBAL, fakeBridge());
      const user = userEvent.setup();
      renderTool();
      await openFolder(user);

      await user.click(screen.getByRole("button", { name: "Use the team's rules" }));
      // Only the slides with no macro at all, not the ones carrying it under its old name.
      expect(await screen.findAllByText(/Missing/)).toHaveLength(3);
    });

    it("falls back to the names slides recorded when the folder's lists cannot be read", async () => {
      store.clear();
      store.set("Chants/Macro Song.pro", syntheticMacroSong());
      const rules = { version: 1, rules: [{ id: "praise", check: "slide-macros", tier: 3, where: "rest", required: ["Praise"] }], exceptions: [] };
      teamRules = async () => ({ set: parseRules(rules), stale: false, defaulted: false, json: RULES_PATH });
      vi.stubGlobal(BRIDGE_GLOBAL, { ...fakeBridge(), readConfiguration: async () => Promise.reject(new Error("no lists")) });
      const user = userEvent.setup();
      renderTool();
      await openFolder(user);

      await user.click(screen.getByRole("button", { name: "Use the team's rules" }));
      // Nothing maps "Praise" to the slides' "Louange", so every slide lacks it.
      expect((await screen.findAllByText(/Missing/)).length).toBeGreaterThan(3);
    });

    it("says when ProPresenter's lists were not there to check against", async () => {
      configuration = { problems: ["No configured groups found."] };
      teamRules = async () => ({ set: parseRules(groupRules), stale: false, defaulted: false, json: RULES_PATH });
      vi.stubGlobal(BRIDGE_GLOBAL, fakeBridge());
      const user = userEvent.setup();
      renderTool();
      await openFolder(user);

      await user.click(screen.getByRole("button", { name: "Use the team's rules" }));
      expect(await screen.findByText("No configured groups found.")).toBeInTheDocument();
      expect(screen.getByText(/were not all there/)).toBeInTheDocument();
    });

    it("says when RULES.md has changed since rules.json was compiled", async () => {
      teamRules = async () => ({ set: parseRules(groupRules), stale: true, defaulted: false, json: RULES_PATH });
      vi.stubGlobal(BRIDGE_GLOBAL, fakeBridge());
      const user = userEvent.setup();
      renderTool();
      await openFolder(user);

      await user.click(screen.getByRole("button", { name: "Use the team's rules" }));
      expect(await screen.findByText(/RULES.md has changed since rules.json was compiled/)).toBeInTheDocument();
    });

    it("says when none were found, and keeps checking as before", async () => {
      teamRules = async () => ({ set: DEFAULT_RULES, stale: false, defaulted: true });
      vi.stubGlobal(BRIDGE_GLOBAL, fakeBridge());
      const user = userEvent.setup();
      renderTool();
      await openFolder(user);

      await user.click(screen.getByRole("button", { name: "Use the team's rules" }));
      expect(await screen.findByText(/No RULES.md or rules.json was found/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Stop using rules" })).not.toBeInTheDocument();
    });

    it("shows what the shell could not read", async () => {
      vi.stubGlobal(BRIDGE_GLOBAL, fakeBridge());
      const user = userEvent.setup();
      renderTool();
      await openFolder(user);

      await user.click(screen.getByRole("button", { name: "Use the team's rules" }));
      expect(await screen.findByText(/could not be loaded: not set up/)).toBeInTheDocument();
    });

    it("is not offered in a browser", async () => {
      access = "readwrite";
      renderTool();
      await screen.findByRole("button", { name: "Load rules.json…" });
      expect(screen.queryByRole("button", { name: "Use the team's rules" })).not.toBeInTheDocument();
    });
  });
});

describe("the team's rules", () => {
  const rulesFile = (value: unknown, text = JSON.stringify(value)) => new File([text], "rules.json", { type: "application/json" });
  const load = (user: ReturnType<typeof userEvent.setup>, file: File) => user.upload(screen.getByLabelText("Load rules.json…"), file);
  const groupRules = { version: 1, rules: [{ id: "groups", check: "group-names", tier: 2, names: ["Refrain"] }], exceptions: [] };

  beforeEach(() => {
    // Alone, so each finding is on the one song.
    store.clear();
    store.set("Chants/Macro Song.pro", syntheticMacroSong());
  });

  it("runs rules kept to a library on a library chosen on its own, rules loaded first", async () => {
    store.clear();
    store.set("Macro Song.pro", syntheticMacroSong());
    folderName = "Chants";
    const user = userEvent.setup();
    renderTool();
    await load(user, rulesFile({ ...groupRules, rules: [{ ...groupRules.rules[0], libraries: ["Chants"] }] }));
    await openFolder(user);
    expect((await screen.findAllByText(/is not in the group list/)).length).toBeGreaterThan(0);
  });

  it("reads the folder in full when rules arrive before its first read is done", async () => {
    let let_go: () => void = () => {};
    beforeRead = () => new Promise<void>((resolve) => (let_go = resolve));
    const user = userEvent.setup();
    renderTool();
    await user.click(await screen.findByRole("button", { name: /Choose a folder/ }));
    // The folder is part-way through its first read when the rules come in.
    await load(user, rulesFile(groupRules));
    beforeRead = null;
    let_go();
    await screen.findByRole("heading", { name: "Fix these" });
    expect((await screen.findAllByText(/is not in the group list/)).length).toBeGreaterThan(0);
  });

  it("keeps a line the person unticked unticked when rules are loaded", async () => {
    const user = userEvent.setup();
    renderTool();
    await openFolder(user);
    const fix = () => screen.getByRole("button", { name: /^Fix \d+ lines?$/ }).textContent;
    const all = fix();
    await user.click(screen.getAllByRole("checkbox", { name: "Select every line in this file" })[0]);
    const fewer = fix();
    expect(fewer).not.toBe(all);
    await load(user, rulesFile(groupRules));
    await screen.findAllByText(/is not in the group list/);
    expect(fix()).toBe(fewer);
  });

  it("names a song by its file, as the command line does, so an exception for it matches", async () => {
    store.clear();
    // A file renamed outside ProPresenter: the name stored inside it is still "Macro Song".
    store.set("Chants/Renamed.pro", syntheticMacroSong());
    const user = userEvent.setup();
    renderTool();
    await openFolder(user);
    await load(user, rulesFile({ ...groupRules, exceptions: [{ rule: "groups", song: "Renamed", reason: "ours" }] }));
    const rows = (await screen.findAllByText(/is not in the group list/)).map((found) => found.closest("li")!);
    for (const row of rows) expect(row.textContent).toContain("excepted: ours");
  });

  it("lists nothing of the kind until rules are loaded", async () => {
    const user = userEvent.setup();
    renderTool();
    await openFolder(user);
    expect(screen.queryByText(/by the rules/)).not.toBeInTheDocument();
    expect(screen.queryByText(/is not in the group list/)).not.toBeInTheDocument();
  });

  it("lists what a loaded rules.json finds, read-only, beside the slide and group", async () => {
    const user = userEvent.setup();
    renderTool();
    await openFolder(user);
    const before = screen.getByRole("button", { name: /^Fix \d+ lines?$/ }).textContent;

    await load(user, rulesFile(groupRules));
    expect((await screen.findAllByText(/is not in the group list/)).length).toBeGreaterThan(0);
    expect(screen.getAllByText("(tier 2)").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/^slide \d+ · \S/).length).toBeGreaterThan(0);
    expect(screen.getByText("Rules in use: rules.json")).toBeInTheDocument();
    // The text fixes are what they were, and the findings carry no tick boxes of their own.
    expect(screen.getByRole("button", { name: /^Fix \d+ lines?$/ }).textContent).toBe(before);
    for (const found of screen.getAllByText(/is not in the group list/)) {
      expect(found.closest("li")!.querySelector("input")).toBeNull();
    }
  });

  it("shows the line a finding is on, and dims one a person excepted", async () => {
    const user = userEvent.setup();
    renderTool();
    await openFolder(user);

    await load(
      user,
      rulesFile({
        version: 1,
        rules: [{ id: "groups", check: "group-names", tier: 2, names: ["Refrain"] }],
        exceptions: [{ rule: "groups", value: "Chorus", reason: "ours" }],
      })
    );
    const rows = (await screen.findAllByText(/is not in the group list/)).map((found) => found.closest("li")!);
    const excepted = rows.filter((row) => row.textContent!.includes("tier 2, excepted: ours"));
    expect(excepted).toHaveLength(1);
    expect(excepted[0]).toHaveStyle({ opacity: "0.55" });
    // Only the group a person excepted is dimmed.
    for (const row of rows.filter((r) => r !== excepted[0])) expect(row).not.toHaveStyle({ opacity: "0.55" });
  });

  it("shows every problem of a rules.json that will not do, and keeps the page as it was", async () => {
    const user = userEvent.setup();
    renderTool();
    await openFolder(user);

    await load(user, rulesFile({ version: 1, rules: [{ id: "x", check: "nope", tier: 9 }], exceptions: [] }));
    const problems = await screen.findByText("These rules cannot be used:");
    expect(problems.querySelectorAll("li").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Stop using rules" })).not.toBeInTheDocument();
    expect(screen.queryByText(/by the rules/)).not.toBeInTheDocument();
  });

  it("refuses a file that is not JSON", async () => {
    const user = userEvent.setup();
    renderTool();
    await openFolder(user);
    await load(user, rulesFile(null, "{ not json"));
    expect(await screen.findByText(/This file is not JSON/)).toBeInTheDocument();
  });

  it("starts the optional punctuation checks from the rules, and leaves them the person's to flip", async () => {
    const user = userEvent.setup();
    renderTool();
    await openFolder(user);

    await load(
      user,
      rulesFile({
        version: 1,
        rules: [
          { id: "commas", check: "trailing-comma", tier: 2 },
          { id: "stops", check: "trailing-full-stop", tier: "off" },
        ],
        exceptions: [],
      })
    );
    const comma = screen.getByRole("checkbox", { name: "Also look for trailing commas" });
    await waitFor(() => expect(comma).toBeChecked());
    expect(screen.getByRole("checkbox", { name: "Also look for trailing full stops" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Also look for trailing semicolons" })).not.toBeChecked();

    await user.click(screen.getByRole("checkbox", { name: "Also look for trailing full stops" }));
    expect(screen.getByRole("checkbox", { name: "Also look for trailing full stops" })).toBeChecked();
  });

  it("goes back to checking as before when the rules are put away", async () => {
    const user = userEvent.setup();
    renderTool();
    await openFolder(user);
    await load(user, rulesFile(groupRules));
    await screen.findAllByText(/is not in the group list/);

    await user.click(screen.getByRole("button", { name: "Stop using rules" }));
    await waitFor(() => expect(screen.queryByText(/is not in the group list/)).not.toBeInTheDocument());
  });
});
