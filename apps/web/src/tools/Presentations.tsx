// Kept whole: one folder on screen and its scan. The counters that say which
// open, scan or save is still the current one (`opening`, `displayed`) are
// read by every handler here; split across files they would be one invariant
// kept in several places. What stands alone -- the rows, the write path, the
// team's rules, the cards -- is under `presentations/`.

import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { FolderOpen, X } from "lucide-react";
import {
  folderAccess,
  FolderReadError,
  isPresentationFile,
  pickFolder,
  readFolderFromInput,
  readFolderHandle,
  type FolderFile,
} from "@presenter-garage/core/lib/folder";
import {
  forget,
  handlePermission,
  keep,
  KEYS,
  remember,
  requestHandlePermission,
} from "../lib/persistence";
import { examine, unreadable, type Examined } from "@presenter-garage/core/lib/fixes";
import type { TextIssueKind, TrailingPunctuation } from "@presenter-garage/core/lib/presentation";
import { toggled } from "@presenter-garage/core/lib/collections";
import { checkRules, libraryOfSong, type RuleConfiguration } from "@presenter-garage/core/lib/rules";
import {
  desktopBridge,
  type DesktopBridge,
  type NativeFolder,
  type NativeWorkspace,
} from "@presenter-garage/core/lib/desktop";
import { useI18n } from "../i18n";
import {
  ALL_KINDS,
  EVERY_KIND,
  fileOfKey,
  lineOf,
  OPTIONAL,
  OPTIONAL_KINDS,
  optionalFrom,
  rowsFor,
  type Row,
} from "./presentations/rows";
import { useFixRun } from "./presentations/useFixRun";
import { useTeamRules, type LoadedRules } from "./presentations/useTeamRules";
import { FixCard } from "./presentations/FixCard";
import { FindingsCard, SummaryCard } from "./presentations/FindingsCard";
import { WorkspaceList } from "./presentations/Workspaces";
import { RuleFindingsCard, TeamRulesControls } from "./presentations/TeamRules";

/**
 * A folder the desktop shell opened, as the files the scan reads. Each is
 * read through the shell, which hands back the hash it was read at; that is
 * kept on the file, for a save to send back.
 */
function nativeFiles(bridge: DesktopBridge, folder: NativeFolder): FolderFile[] {
  return folder.files.map((file) => {
    const native: NonNullable<FolderFile["native"]> = { path: file.path };
    return {
      path: file.relative,
      name: file.name,
      size: 0,
      native,
      read: async () => {
        const { bytes, sha256 } = await bridge.read(file.path);
        native.sha256 = sha256;
        return bytes;
      },
    };
  });
}

/**
 * Check the text of every presentation in a library, and put it right.
 *
 * Reads a whole folder at once, because the problems it looks for are the kind
 * nobody finds by opening thirty songs one at a time: a space at the start of a
 * line that shifts it right, a space at the end that spoils centring, a
 * paragraph that shows nothing but still takes up room.
 *
 * Writing is three deliberate acts rather than one button. The reader chooses
 * which lines; they take a backup of those files as they stand; only then does
 * the fix button do anything. Each file is checked against the schema and read
 * back after editing before it reaches the folder, so one that cannot be
 * written faithfully is left exactly as it was.
 */
export function Presentations() {
  const i18n = useI18n();
  const { t, f } = i18n;
  const p = t.tools.presentations;

  // What this browser can do with a folder does not change while it is open.
  const access = useMemo(() => folderAccess(), []);
  /** The desktop shell, when this is the desktop app, which is when `access` is `native`. */
  const bridge = useMemo(() => desktopBridge(), []);
  const nativeText = p.native;
  const input = useRef<HTMLInputElement>(null);
  /**
   * Bumped by every folder that starts opening. An open that finds it moved
   * on was overtaken by a later one, and is not shown at all.
   */
  const opening = useRef(0);
  /**
   * The name of the folder being read, for the library its songs are in. A
   * ref rather than the state beside it, because a scan starts in the same
   * call that sets the state, and would otherwise read the last folder's name.
   */
  const reading = useRef("");
  /** The files of the folder on screen, for the same reason: rules may arrive after another folder was opened. */
  const readingFiles = useRef<FolderFile[]>([]);
  /**
   * The open whose folder is on screen. A read or a save that finds it moved
   * on was for a folder no longer shown, and leaves the screen to this one:
   * otherwise a slow first folder finishing last shows its findings beside
   * the second folder's files.
   */
  const displayed = useRef(0);

  const [scanned, setScannedState] = useState<Examined[] | null>(null);
  /**
   * What `scanned` holds now, not as some earlier render saw it: a rescan
   * started by rules that took a while to load matches unticked lines
   * against the folder on screen when it ends, not the one when it began.
   */
  const scannedNow = useRef<Examined[] | null>(null);
  const setScanned = (next: Examined[] | null) => {
    scannedNow.current = next;
    setScannedState(next);
  };
  const [files, setFiles] = useState<FolderFile[]>([]);
  const [handle, setHandle] = useState<unknown>(null);
  const [folderName, setFolderName] = useState<string>("");
  const [fellBack, setFellBack] = useState(false);
  /** A remembered folder whose permission has lapsed and needs one click back. */
  const [pending, setPending] = useState<{ handle: unknown; name: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<Set<TextIssueKind>>(new Set(ALL_KINDS));
  /** Opt-in checks, remembered so the choices survive a refresh. */
  const [optional, setOptional] = useState<Set<TextIssueKind>>(new Set());

  const team = useTeamRules(bridge, rulesChanged);
  /** Why ProPresenter's own lists were not all there for the last scan, so a quiet result is not taken for a clean one. */
  const [listProblems, setListProblems] = useState<string[]>([]);
  /**
   * The lines the reader has taken *out* of the run, rather than the ones left
   * in.
   *
   * Pressing a filter or switching a check on changes which fixes exist, and a
   * set of exclusions survives that where a set of inclusions would quietly
   * drop whatever appeared since.
   */
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  /** In the desktop app, the folder its shell opened, with its real path. */
  const [native, setNative] = useState<NativeFolder | null>(null);
  /** In the desktop app, ProPresenter 22's workspaces on this computer. */
  const [workspaces, setWorkspaces] = useState<NativeWorkspace[]>([]);
  /**
   * The files in alphabetical order.
   *
   * Sorted here rather than in the scan because the order is a display
   * decision and depends on the language: a collator puts "élever" beside
   * "elever" rather than after "z", and `numeric` keeps "Psaume 9" ahead of
   * "Psaume 10". Doing it at render means switching language re-sorts rather
   * than leaving the previous locale's order on screen.
   *
   * By the name on screen rather than by the filename, because those are not
   * the same thing: the heading is the presentation's own name, which a reader
   * can change without renaming the file. Sorting by the path would leave a
   * list that is ordered by something invisible and looks wrong. The path
   * breaks ties, so two songs of the same name always sit in the same order.
   */
  const collator = useMemo(
    () => new Intl.Collator(t.meta.localeTag, { numeric: true, sensitivity: "base" }),
    [t.meta.localeTag]
  );

  const examined = useMemo(() => {
    const label = (one: Examined) => one.report.name || one.report.filename;
    return [...(scanned ?? [])].sort(
      (a, b) =>
        collator.compare(label(a), label(b)) ||
        collator.compare(a.report.filename, b.report.filename)
    );
  }, [scanned, collator]);

  const reports = useMemo(() => examined.map((one) => one.report), [examined]);

  /**
   * The folder each file sits in, shown only when they do not all share one.
   *
   * A library kept in subfolders can hold two songs of the same name, and the
   * heading is the presentation's own name rather than its filename -- so
   * without this there would be no way to tell them apart. Judged across every
   * file scanned rather than only those with findings, so the folder does not
   * appear and disappear as the filters change.
   */
  const folderOf = (filename: string) => filename.split("/").slice(0, -1).join("/");

  const showFolders = useMemo(
    () => new Set(reports.map((r) => folderOf(r.filename))).size > 1,
    [reports]
  );

  const folderLabel = (filename: string) =>
    [folderName, folderOf(filename)].filter(Boolean).join("/");

  const kinds = useMemo(
    () => ALL_KINDS.filter((kind) => !OPTIONAL.has(kind) || optional.has(kind)),
    [optional]
  );
  /** The kinds both switched on and not filtered out by a pill. */
  const shown = useMemo(() => new Set(kinds.filter((kind) => active.has(kind))), [kinds, active]);

  /** A ProPresenter Cloud workspace: written as any other, with a warning beside the button. */
  const cloud = native?.workspace?.cloud === true;

  /** Whether anything could be written back at all, before the reader chooses. */
  const canWrite = bridge ? native !== null : access === "readwrite" && handle !== null;

  const withIssues = useMemo(
    () => reports.filter((r) => r.issues.some((i) => shown.has(i.kind)) || r.error),
    [reports, shown]
  );

  const totalIssues = useMemo(
    () => reports.reduce((n, r) => n + r.issues.filter((i) => shown.has(i.kind)).length, 0),
    [reports, shown]
  );

  // One pass over every finding, rather than one per kind per use per render:
  // a large library holds thousands, and every tick of a box re-renders.
  const counts = useMemo(() => {
    const out = new Map<TextIssueKind, number>();
    for (const r of reports) for (const i of r.issues) out.set(i.kind, (out.get(i.kind) ?? 0) + 1);
    return out;
  }, [reports]);
  const countOf = (kind: TextIssueKind) => counts.get(kind) ?? 0;

  /**
   * What is wrong and what could be done about it, file by file.
   *
   * Recomputed from the boxes kept during the scan rather than by reading the
   * folder again, so pressing a filter stays instant on a library of hundreds.
   */
  const rows = useMemo(() => {
    const byFile = new Map<string, Row[]>();
    for (const one of examined) {
      const lines = rowsFor(one, shown);
      if (lines.length > 0) byFile.set(one.report.filename, lines);
    }
    return byFile;
  }, [examined, shown]);

  /** The slides around each file's findings, which its rows are shown among. */
  const contextByFile = useMemo(() => new Map(examined.map((one) => [one.report.filename, one.context])), [examined]);
  const contextOf = (filename: string) => contextByFile.get(filename) ?? [];

  /** The fixes still ticked, grouped by file, in the order they were listed. */
  const chosen = useMemo(
    () =>
      [...rows]
        .map(([path, lines]) => ({
          path,
          fixes: lines.filter((row) => row.fix && !excluded.has(row.key)).map((row) => row.fix!),
        }))
        .filter((plan) => plan.fixes.length > 0),
    [rows, excluded]
  );

  const chosenLines = useMemo(() => chosen.reduce((n, plan) => n + plan.fixes.length, 0), [chosen]);
  const fixableLines = useMemo(
    () => [...rows.values()].reduce((n, lines) => n + lines.filter((r) => r.fix).length, 0),
    [rows]
  );

  const fileByPath = useMemo(() => new Map(files.map((file) => [file.path, file])), [files]);

  const fixRun = useFixRun({ bridge, handle, files, fileByPath, chosen, shown, displayed, scan, rescan });
  const { running } = fixRun;

  /** Read and check each file, saying which one is being read, until a later folder overtakes it. */
  async function examineAll(list: FolderFile[], mine: number): Promise<Examined[] | null> {
    const out: Examined[] = [];
    // In the desktop app, ProPresenter's own lists for the folder open, so a
    // macro renamed since it was put on a slide is still matched by its uuid.
    // A browser cannot reach them, and matches by the names slides recorded.
    let config: RuleConfiguration = {};
    let problems: string[] = [];
    if (team.inUse.current && bridge && list.some((file) => file.native)) {
      try {
        ({ problems, ...config } = await bridge.readConfiguration());
      } catch (e) {
        // No lists is what a browser has too, and is said so.
        problems = [(e as Error).message];
      }
    }
    // Only the scan on screen says why: one overtaken while the lists were read must not leave its answer behind.
    if (mine !== displayed.current) return null;
    setListProblems(problems);
    for (const file of list) {
      if (mine !== displayed.current) return null;
      setBusy(file.name);
      let bytes: Uint8Array;
      try {
        bytes = await file.read();
      } catch (e) {
        // A file locked or removed mid-scan is that file's problem, not the
        // folder's: report it like any other file that will not open.
        out.push(unreadable(file.path, "unreadable", (e as Error).message));
        continue;
      }
      const set = team.inUse.current;
      // The chosen folder's name too: a library chosen on its own keeps its name, so rules kept to it still run.
      const parts = file.path.split("/");
      const library = libraryOfSong(reading.current, parts);
      // The file's name, as the command line and the server name a song, so an exception for a song matches it everywhere.
      const song = parts.at(-1)!.replace(/\.pro$/i, "");
      out.push(
        examine(
          file.path,
          bytes,
          set ? (doc) => checkRules(doc, set, { song, ...(library ? { library } : {}) }, config) : undefined
        )
      );
    }
    if (mine !== displayed.current) return null;
    setBusy(null);
    return out;
  }

  async function scan(list: FolderFile[], mine = displayed.current) {
    const examined = await examineAll(list, mine);
    if (!examined || mine !== displayed.current) return;
    setScanned(examined);
    setExcluded(new Set());
  }

  /** The rules in use changed: the optional checks start where they say, and the folder on screen is read again with them. */
  function rulesChanged(next: LoadedRules | null) {
    if (next) setOptional(optionalFrom(next.set));
    const current = readingFiles.current;
    if (current.length === 0) return;
    const mine = ++opening.current;
    displayed.current = mine;
    // Read again as after a save, so a line the person unticked stays unticked.
    void rescan(current, mine);
  }

  /**
   * Read again only the files a save in the desktop app touched, keeping
   * what is in hand for the rest: nothing else can have changed, and reading
   * a whole library through the shell again is seconds of copying for nothing.
   */
  async function rescan(list: FolderFile[], mine: number) {
    const examined = await examineAll(list, mine);
    if (!examined || mine !== displayed.current) return;
    const fresh = new Map(examined.map((one) => [one.report.filename, one]));
    const was = scannedNow.current;
    // A folder whose first read was overtaken has nothing to merge into: this read is its first.
    setScanned(was === null ? examined : was.map((one) => fresh.get(one.report.filename) ?? one));
    // A line left unticked stays unticked, or the next save would take it
    // without anyone choosing it: in a file not read again, by its address;
    // in one that was, by what it says, since the save may have moved it.
    // Every kind, not just those on screen: a line unticked and then hidden
    // by a filter is still unticked when the filter is lifted.
    const before = new Map((was ?? []).map((one) => [one.report.filename, one]));
    setExcluded((prev) => {
      const next = new Set([...prev].filter((key) => !fresh.has(fileOfKey(key))));
      for (const [filename, one] of fresh) {
        // Lines that had a copy unticked. Copies of one line cannot be told
        // apart once the file may have changed -- the save changed some, or
        // something else did, and neither count nor order says which -- so
        // every copy of such a line is unticked: an unticked line must never
        // come back ticked. A line that occurs once keeps its own choice.
        const unticked = new Set<string>();
        const was = before.get(filename);
        for (const row of was ? rowsFor(was, EVERY_KIND) : []) {
          if (row.fix && prev.has(row.key)) unticked.add(lineOf(row));
        }
        for (const row of rowsFor(one, EVERY_KIND)) {
          if (row.fix && unticked.has(lineOf(row))) next.add(row.key);
        }
      }
      return next;
    });
  }

  /**
   * Make a freshly opened folder the one on screen, and read it. `mine` is
   * the caller's, taken before its own first wait, where it has one.
   */
  function load(folder: { name: string; files: FolderFile[] }, folderHandle: unknown, mine = ++opening.current) {
    if (mine !== opening.current) return Promise.resolve();
    displayed.current = mine;
    setPending(null);
    fixRun.clearRun();
    // The last folder's findings go with it: left up while this one is read,
    // a line of one could be saved against a file of the same name in the other.
    setScanned(null);
    setExcluded(new Set());
    reading.current = folder.name;
    readingFiles.current = folder.files;
    setFolderName(folder.name);
    setFiles(folder.files);
    setHandle(folderHandle);
    return scan(folder.files, mine);
  }

  /** Make a folder the desktop shell opened the one on screen. */
  function loadNative(shell: DesktopBridge, folder: NativeFolder, mine: number) {
    if (mine !== opening.current) return Promise.resolve();
    setNative(folder);
    return load({ name: folder.name, files: nativeFiles(shell, folder) }, null, mine);
  }

  // The reopen on mount calls these through effect events: it must run once,
  // yet always reach the latest render's `load`, not the first one's.
  const loadOnMount = useEffectEvent(load);
  const loadNativeOnMount = useEffectEvent(loadNative);

  /** Open a folder through the desktop shell: its dialog, or a workspace it listed. */
  async function chooseNative(open: () => Promise<NativeFolder | null>) {
    setError(null);
    const mine = ++opening.current;
    try {
      const folder = await open();
      if (folder) await loadNative(bridge!, folder, mine);
    } catch (e) {
      // An open a later one overtook says so; the one on screen has nothing to answer for.
      if (mine === opening.current) setError((e as Error).message);
    }
  }

  /**
   * Pick up where the last visit left off.
   *
   * A directory handle survives in IndexedDB, but permission may not: it can
   * lapse once the last tab for the origin closes. Where it is still granted
   * the folder is simply reread; where it is not, asking again needs a user
   * gesture, so the folder is offered as a button rather than re-requested on
   * load.
   */
  useEffect(() => {
    void (async () => {
      // A record rather than a flag, so a dictionary that gains another
      // optional check reads back what was stored before it existed.
      const saved = await remember<Partial<Record<TextIssueKind, boolean>>>(
        KEYS.presentationsChecks
      );
      if (saved) setOptional(new Set<TextIssueKind>(OPTIONAL_KINDS.filter((k) => saved[k])));
    })();
  }, []);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      // The desktop app keeps the folder itself, as a path, so there is no
      // permission to lapse and nothing to ask for again. Asked for afresh
      // rather than taken from `bridge`, so this runs once, on mount.
      const shell = desktopBridge();
      if (shell) {
        const mine = ++opening.current;
        try {
          const [last, listed] = await Promise.all([shell.reopenLast(), shell.workspaces()]);
          if (cancelled) return;
          setWorkspaces(listed);
          if (last) await loadNativeOnMount(shell, last, mine);
        } catch (e) {
          if (!cancelled) setError((e as Error).message);
        }
        return;
      }

      const mine = ++opening.current;
      const saved = await remember<unknown>(KEYS.presentationsFolder);
      if (!saved || cancelled) return;

      const name = (saved as { name?: string }).name ?? "";
      if ((await handlePermission(saved, "read")) === "granted") {
        let folder;
        try {
          folder = await readFolderHandle(saved, isPresentationFile);
        } catch {
          // The folder may have moved or been removed since.
          await forget(KEYS.presentationsFolder);
          return;
        }
        if (!cancelled) await loadOnMount(folder, saved, mine);
        return;
      }

      if (!cancelled && mine === opening.current) setPending({ handle: saved, name });
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  async function reopen() {
    if (!pending) return;
    if ((await requestHandlePermission(pending.handle, "read")) !== "granted") return;
    try {
      await load(await readFolderHandle(pending.handle, isPresentationFile), pending.handle);
    } catch (e) {
      setPending(null);
      setError((e as Error).message);
    }
  }

  function forgetFolder() {
    // An open still under way, or a scan, belongs to the folder just cleared:
    // landing later, it would show a folder the shell has already let go of.
    opening.current++;
    displayed.current = opening.current;
    setBusy(null);
    setPending(null);
    setFellBack(false);
    setError(null);
    setScanned(null);
    setFiles([]);
    setHandle(null);
    setNative(null);
    reading.current = "";
    readingFiles.current = [];
    setListProblems([]);
    setFolderName("");
    fixRun.clearRun();
    if (bridge) void bridge.forgetLast();
    else void forget(KEYS.presentationsFolder);
  }

  async function chooseFolder() {
    setError(null);
    setFellBack(false);
    let folder;
    try {
      folder = await pickFolder(isPresentationFile);
    } catch (e) {
      if (e instanceof FolderReadError) {
        setError(e.message);
        return;
      }
      // The picker can be unavailable for reasons the reader cannot act on --
      // an embedded frame, a policy, a browser that claims the API and then
      // refuses. Falling back to the directory input gets them a result
      // instead of an error, at the cost of not being able to write back.
      // Only the picker: a folder that was picked and then failed to read is
      // not a picker that is missing.
      setFellBack(true);
      input.current?.click();
      return;
    }
    if (!folder) return;
    // Only a real handle is worth keeping; the input fallback hands over
    // copies with no path back to the folder.
    if (folder.handle) void keep(KEYS.presentationsFolder, folder.handle);
    await load(folder, folder.handle ?? null);
  }

  /** The system's dialog in the desktop app, the picker where this browser has one, the directory input otherwise. */
  const choose = () =>
    bridge
      ? void chooseNative(() => bridge.pickFolder())
      : access === "readwrite"
        ? void chooseFolder()
        : input.current?.click();

  const toggle = (kind: TextIssueKind) =>
    setActive((prev) => {
      const next = toggled(prev, kind);
      // Switching every pill off would show nothing at all, so it means "all".
      return kinds.some((k) => next.has(k)) ? next : new Set(ALL_KINDS);
    });

  function toggleOptional(kind: TrailingPunctuation, on: boolean) {
    const next = toggled(optional, kind, on);
    setOptional(next);
    // Turning one on should show it, even if the pill was switched off before.
    if (on) setActive((prev) => new Set(prev).add(kind));
    void keep(
      KEYS.presentationsChecks,
      Object.fromEntries(OPTIONAL_KINDS.map((k) => [k, next.has(k)]))
    );
  }

  function toggleRow(key: string) {
    fixRun.setOutcomes(null);
    setExcluded((prev) => toggled(prev, key));
  }

  function setFileSelected(filename: string, on: boolean) {
    fixRun.setOutcomes(null);
    setExcluded((prev) => {
      const next = new Set(prev);
      for (const row of rows.get(filename) ?? []) {
        if (!row.fix) continue;
        if (on) next.delete(row.key);
        else next.add(row.key);
      }
      return next;
    });
  }

  function setAllSelected(on: boolean) {
    fixRun.setOutcomes(null);
    if (on) {
      setExcluded(new Set());
      return;
    }
    const every = new Set<string>();
    for (const lines of rows.values()) for (const row of lines) if (row.fix) every.add(row.key);
    setExcluded(every);
  }

  return (
    <>
      <div className="card">
        <h2>{p.name}</h2>
        <p className="sub">{bridge ? nativeText.chooseHint : p.chooseHint}</p>

        <div className="editor-bar">
          {/* Once a folder is chosen it replaces the button, so what is loaded
              is on screen rather than implied. Only its name in a browser,
              which never reveals where the folder sits on disk, by design;
              the whole path in the desktop app, which knows it. */}
          {folderName ? (
            <>
              <span className="chosen" title={native?.root}>
                <FolderOpen size={15} aria-hidden="true" />
                <span className="chosen-name">{native?.root ?? folderName}</span>
              </span>
              {/* Not while a run is going either: it rereads the folder it
                  started with when it finishes, over whatever replaced it. */}
              <button className="btn" onClick={choose} disabled={busy !== null || running}>
                {p.changeFolder}
              </button>
              <button
                className="btn icon"
                aria-label={p.clearFolder}
                title={p.clearFolder}
                onClick={forgetFolder}
                disabled={busy !== null || running}
              >
                <X size={13} aria-hidden="true" />
              </button>
            </>
          ) : (
            /* One button, whichever route this browser supports. Offering both
               the picker and the input produced two controls with the same
               label and no way to tell them apart. */
            <button className="btn primary" onClick={choose} disabled={busy !== null}>
              {access === "unavailable" ? p.pickFiles : p.pickFolder}
            </button>
          )}
          <input
            ref={input}
            type="file"
            hidden
            multiple
            // Reading a folder this way works in every browser, including the
            // ones with no directory picker -- it just cannot write back.
            {...(access === "unavailable" ? {} : { webkitdirectory: "" })}
            onChange={(e) => {
              const picked = e.target.files;
              if (!picked) return;
              setError(null);
              // A folder chosen by hand supersedes the remembered one, as it
              // does when chosen through the picker. There is no handle to
              // keep in its place, so forget the old one rather than bring it
              // back on the next visit.
              void forget(KEYS.presentationsFolder);
              const folder = readFolderFromInput(picked, isPresentationFile);
              // Cleared, or choosing the same folder again to rescan it after
              // an edit would fire no change at all.
              e.target.value = "";
              void load(folder, null);
            }}
          />
          {busy && <span className="editor-count">{f(p.scanning, { n: busy })}</span>}
        </div>

        {bridge && workspaces.length > 0 && (
          <WorkspaceList
            workspaces={workspaces}
            onOpen={(root) => void chooseNative(() => bridge.openWorkspace(root))}
            disabled={busy !== null || running}
          />
        )}

        <TeamRulesControls
          rules={team}
          desktop={Boolean(bridge)}
          disabled={busy !== null || running}
          listProblems={listProblems}
        />

        {/* The opt-in checks, offered where the folder is chosen rather than
            among the findings: they change what counts as a problem, which is
            a decision made before reading rather than while sifting. */}
        {OPTIONAL_KINDS.map((kind) => (
          <label className="option" key={kind} title={p.optionalWhy[kind]}>
            <input
              type="checkbox"
              checked={optional.has(kind)}
              onChange={(e) => toggleOptional(kind, e.target.checked)}
            />
            <span>{p.optionalChecks[kind]}</span>
          </label>
        ))}

        <p className="why">
          {
            {
              native: nativeText.note,
              readwrite: p.readwriteNote,
              readonly: p.readonlyNote,
              unavailable: p.unavailableNote,
            }[access]
          }
        </p>
        {native?.truncated && <p className="why warn-inline">{nativeText.truncated}</p>}

        {pending && (
          <>
            <div className="editor-bar" style={{ paddingTop: 0 }}>
              <span className="editor-count">{f(p.remembered, { folder: pending.name })}</span>
              <span className="spacer" />
              <button className="btn primary" onClick={() => void reopen()} disabled={running}>
                {f(p.reconnect, { folder: pending.name })}
              </button>
              <button className="btn" onClick={forgetFolder} disabled={running}>
                {p.forgetFolder}
              </button>
            </div>
            <p className="why">{p.reconnectWhy}</p>
          </>
        )}
        {fellBack && <p className="why warn-inline">{p.pickerFailed}</p>}
        {error && <p className="why warn-inline">{error}</p>}

        {scanned && reports.length === 0 && (
          <p className="sub warn-inline">{f(p.noneFound, { folder: folderName || "—" })}</p>
        )}
      </div>

      {reports.length > 0 && <SummaryCard files={reports.length} kinds={kinds} countOf={countOf} />}

      {/* Above the findings rather than below them: on a library of hundreds
          the list is long, and a control at the bottom of it is a control
          nobody finds. It stays on screen after a run that leaves nothing to
          fix, because that is exactly when the reader wants to know what
          happened. */}
      {(fixableLines > 0 || fixRun.outcomes) && (
        <FixCard
          run={fixRun}
          bridge={bridge}
          canWrite={canWrite}
          cloud={cloud}
          workspace={Boolean(native?.workspace)}
          chosenFiles={chosen.length}
          chosenLines={chosenLines}
          anyExcluded={excluded.size > 0}
          onSelectAll={setAllSelected}
        />
      )}

      {reports.length > 0 && (
        <FindingsCard
          withIssues={withIssues}
          totalIssues={totalIssues}
          kinds={kinds}
          active={active}
          countOf={countOf}
          onToggleKind={toggle}
          rows={rows}
          contextOf={contextOf}
          excluded={excluded}
          running={running}
          showFolders={showFolders}
          folderLabel={folderLabel}
          onToggleRow={toggleRow}
          onSetFileSelected={setFileSelected}
        />
      )}

      {team.rules && scanned && (
        <RuleFindingsCard examined={examined} showFolders={showFolders} folderLabel={folderLabel} />
      )}
    </>
  );
}
