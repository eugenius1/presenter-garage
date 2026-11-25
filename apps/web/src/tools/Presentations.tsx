import { useEffect, useMemo, useRef, useState } from "react";
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
import { download, stamp } from "@presenter-garage/core/lib/download";
import {
  examine,
  fixFiles,
  fixKey,
  planFixes,
  unreadable,
  type Examined,
  type LineFix,
} from "@presenter-garage/core/lib/fixes";
import {
  SPACE_CLASS,
  TRAILING_PUNCTUATION,
  type TextIssue,
  type TextIssueKind,
  type TrailingPunctuation,
} from "@presenter-garage/core/lib/presentation";
import { groupBy, toggled } from "@presenter-garage/core/lib/collections";
import {
  checkRules,
  parseRules,
  libraryOfSong,
  RulesError,
  type CheckName,
  type Finding,
  type RuleSet,
} from "@presenter-garage/core/lib/rules";
import { describeFinding, findingTags } from "@presenter-garage/core/i18n/rules";
import {
  desktopBridge,
  type DesktopBridge,
  type NativeFileOutcome,
  type NativeFolder,
  type NativeRules,
  type NativeWorkspace,
  type RunRefusal,
} from "@presenter-garage/core/lib/desktop";
import { zip } from "@presenter-garage/core/lib/zip";
import { useI18n } from "../i18n";

/**
 * Every kind the checker reports, and the ones shown without being asked for.
 *
 * Trailing punctuation is always detected -- it costs one test per line -- but
 * stays out of the way until it is switched on. Detecting it regardless is
 * what makes the switch instant: it filters what is already in hand rather
 * than sending the whole library back through the reader.
 *
 * One switch each rather than one for all three. They are not one decision: a
 * library of 24,181 lines ends nearly a thousand of them with a full stop and
 * 43 with a semicolon, and a house that strips commas may well keep the full
 * stop that closes a verse.
 */
const OPTIONAL_KINDS = Object.keys(TRAILING_PUNCTUATION) as readonly TrailingPunctuation[];
const ALL_KINDS: TextIssueKind[] = [
  "leadingSpace",
  "trailingSpace",
  "blankLine",
  "repeatedSpace",
  ...OPTIONAL_KINDS,
];
/** The same set, for asking whether a kind is one of them. */
const OPTIONAL = new Set<TextIssueKind>(OPTIONAL_KINDS);

/** The rule that stands for each optional check, for starting the switches from a team's rules. */
const RULE_OF: Record<TrailingPunctuation, CheckName> = {
  trailingComma: "trailing-comma",
  trailingSemicolon: "trailing-semicolon",
  trailingFullStop: "trailing-full-stop",
};

/** The switches a set of rules asks for: a check is on when a rule runs it, and off when none does or it is `off`. */
const optionalFrom = (set: RuleSet) =>
  new Set<TextIssueKind>(
    OPTIONAL_KINDS.filter((kind) => set.rules.some((r) => r.check === RULE_OF[kind] && r.tier !== "off"))
  );

/** The rules a person loaded, and where they came from. */
interface LoadedRules {
  set: RuleSet;
  /** The file's name, or the path the desktop app found them at. */
  source: string;
  team: boolean;
}

/**
 * Let the browser paint, at most once a frame.
 *
 * Reading, decoding, editing and re-encoding a file are quick enough that a
 * run of several hundred never gives the main thread back on its own: the
 * awaits inside it resolve as microtasks, so React flushes the progress state
 * and nothing is drawn. Measured on a real run of 57 files, the bar painted
 * three times -- it showed 14, then 56, then disappeared.
 *
 * Yielding on every file would cost more than it buys: `setTimeout` is clamped
 * to about four milliseconds, which on a whole library is seconds of waiting
 * added to make a bar move. So the main thread goes back only once the frame
 * it would have been drawn in has passed, and through `scheduler.yield` where
 * the browser has it, which returns without the clamp.
 */
function painter() {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  let last = performance.now();

  return async () => {
    const now = performance.now();
    if (now - last < 16) return;
    last = now;
    if (scheduler?.yield) await scheduler.yield();
    else await new Promise((resolve) => setTimeout(resolve, 0));
  };
}

/** How far a run has got, and which phase it is. */
interface Progress {
  /**
   * Which phase: "Saving {n}…", "Backing up {n}…", "Fixing {n}…". A key into
   * the dictionary rather than its text, so a language switched mid-run is
   * the language the caption is in.
   */
  verb: "applying" | "backingUp" | "fixing";
  path: string;
  /** Files finished, and how many there are altogether. */
  done: number;
  total: number;
}

/**
 * What a run did with one file: the web app's own outcome, or the desktop
 * shell's, which can refuse for more reasons -- a backup that failed, a
 * workspace's formatting that cannot be moved.
 */
type Outcome = Pick<NativeFileOutcome, "path" | "reason" | "rangeReason">;

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

/** One line of one file, as the list shows it and the fix run names it. */
interface Row {
  key: string;
  slideIndex: number;
  lineIndex: number;
  groupName?: string;
  text: string;
  kinds: TextIssueKind[];
  fix?: LineFix;
}

/** Address a line uniquely across the whole library. */
const rowKey = (filename: string, line: { boxIndex: number; lineIndex: number }) =>
  `${filename} ${fixKey(line)}`;

/**
 * Gather the findings on one line into a single row.
 *
 * One line can be guilty of three things at once, and listing it three times
 * asks the reader to approve three edits to the same characters. One row, one
 * before, one after, one decision.
 */
function rowsOf(filename: string, issues: TextIssue[], fixes: LineFix[]): Row[] {
  const fixFor = new Map(fixes.map((fix) => [fixKey(fix), fix]));

  return [...groupBy(issues, fixKey)].map(([line, [first, ...rest]]) => ({
    key: rowKey(filename, first),
    slideIndex: first.slideIndex,
    lineIndex: first.lineIndex,
    groupName: first.groupName,
    text: first.text,
    kinds: [first.kind, ...rest.map((issue) => issue.kind)],
    fix: fixFor.get(line),
  }));
}

/** A file's rows for the kinds on screen. */
function rowsFor({ report, fixable }: Examined, shown: ReadonlySet<TextIssueKind>): Row[] {
  const issues = report.issues.filter((i) => shown.has(i.kind));
  return issues.length === 0 ? [] : rowsOf(report.filename, issues, planFixes(fixable, issues));
}

/** The file a row's key belongs to: everything before its line's address. */
const fileOfKey = (key: string) => key.slice(0, key.lastIndexOf(" "));

/**
 * A fixable line by its box and what it says rather than where it is: a line
 * a save removed above it moves it up, and its address with it. Not by what
 * it becomes, which depends on the kinds on screen.
 */
const lineOf = (row: Row) => JSON.stringify([row.fix!.boxIndex, row.text]);

/** Every kind, for what has to hold whichever are on screen. */
const EVERY_KIND: ReadonlySet<TextIssueKind> = new Set(ALL_KINDS);

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
  const { t, f, num, plural } = i18n;
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
   * The open whose folder is on screen. A read or a save that finds it moved
   * on was for a folder no longer shown, and leaves the screen to this one:
   * otherwise a slow first folder finishing last shows its findings beside
   * the second folder's files.
   */
  const displayed = useRef(0);

  const [scanned, setScanned] = useState<Examined[] | null>(null);
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

  /**
   * The team's rules, when a person has loaded some. Read-only: they decide
   * what is listed beside the text fixes and which optional checks start on,
   * and nothing in the fix run reads them.
   */
  const [rules, setRules] = useState<LoadedRules | null>(null);
  /** Why a rules file was refused, a line each; or what the desktop app said of the team's rules. */
  const [rulesProblems, setRulesProblems] = useState<string[]>([]);
  const [rulesNote, setRulesNote] = useState<NativeRules | "none" | null>(null);
  /**
   * The rules a scan checks with, read at the moment each file is checked: a
   * scan under way when the rules change is overtaken by a new one, but a
   * save's partial rescan must use the rules on screen, not those of its start.
   */
  const rulesInUse = useRef<RuleSet | null>(null);
  const rulesInput = useRef<HTMLInputElement>(null);

  /**
   * The lines the reader has taken *out* of the run, rather than the ones left
   * in.
   *
   * Pressing a filter or switching a check on changes which fixes exist, and a
   * set of exclusions survives that where a set of inclusions would quietly
   * drop whatever appeared since.
   */
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  /** Whether the system would not open the backup folder when asked. */
  const [backupsUnshown, setBackupsUnshown] = useState(false);
  const [backup, setBackup] = useState<{ name: string; paths: Set<string> } | null>(null);
  const [outcomes, setOutcomes] = useState<Outcome[] | null>(null);
  const [savedZip, setSavedZip] = useState<string | null>(null);
  // The permission refusal is ours to word, so it is kept as a fact and
  // worded at render; anything else is an error's own message.
  const [fixError, setFixError] = useState<"permissionNeeded" | { message: string } | null>(null);
  /**
   * Whether a run is under way, and how far through it is.
   *
   * A library is hundreds of files and every one is decoded, edited,
   * re-encoded and read back, so a run lasts long enough that a reader needs
   * to see it moving. Kept as a count rather than a fraction so the caption
   * can say "12 of 57" -- a bar alone shows that something is happening but
   * not how much of it is left.
   */
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);

  /** In the desktop app, the folder its shell opened, with its real path. */
  const [native, setNative] = useState<NativeFolder | null>(null);
  /** In the desktop app, ProPresenter 22's workspaces on this computer. */
  const [workspaces, setWorkspaces] = useState<NativeWorkspace[]>([]);
  /** What the last desktop run said of itself as a whole: where its backups went, or why it wrote nothing. */
  const [nativeRun, setNativeRun] = useState<{
    backupFolder?: string;
    refused?: { code: RunRefusal; detail: string };
  } | null>(null);

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
   * What the rules found, file by file. Text problems are left out: the list
   * of fixes shows each of them with the line it would become, and listing
   * them again here would say everything twice.
   */
  const ruleFindings = useMemo(
    () =>
      examined
        .map((one) => ({
          report: one.report,
          findings: (one.findings ?? []).filter((finding) => finding.detail.kind !== "text"),
        }))
        .filter((one) => one.findings.length > 0),
    [examined]
  );
  const ruleFindingCount = ruleFindings.reduce((n, one) => n + one.findings.length, 0);

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

  /** A ProPresenter Cloud workspace: read here, and not written until #55 says how. */
  const cloud = native?.workspace?.cloud === true;

  /** Whether anything could be written back at all, before the reader chooses. */
  const canWrite = bridge ? native !== null && !cloud : access === "readwrite" && handle !== null;

  function clearRun() {
    setBackup(null);
    setOutcomes(null);
    setSavedZip(null);
    setFixError(null);
    setNativeRun(null);
    setBackupsUnshown(false);
  }

  /** Read and check each file, saying which one is being read, until a later folder overtakes it. */
  async function examineAll(list: FolderFile[], mine: number): Promise<Examined[] | null> {
    const out: Examined[] = [];
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
      const set = rulesInUse.current;
      // The chosen folder's name too: a library chosen on its own keeps its name, so rules kept to it still run.
      const library = libraryOfSong(folderName, file.path.split("/"));
      out.push(
        examine(
          file.path,
          bytes,
          set ? (doc) => checkRules(doc, set, { song: doc.name, ...(library ? { library } : {}) }) : undefined
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

  /**
   * Use these rules from now on, or none. The rules look at every slide, group
   * and macro, which a scan does not keep, so a folder already read is read
   * again; a scan under way is overtaken, as a new folder overtakes one.
   */
  function adoptRules(next: LoadedRules | null) {
    rulesInUse.current = next?.set ?? null;
    setRules(next);
    if (next) setOptional(optionalFrom(next.set));
    if (files.length === 0) return;
    const mine = ++opening.current;
    displayed.current = mine;
    // Read again as after a save, so a line the person unticked stays unticked.
    void rescan(files, mine);
  }

  /** A rules.json the person chose: parsed as `parseRules` has it, and every problem shown if it will not. */
  async function loadRulesFile(file: File) {
    setRulesNote(null);
    let value: unknown;
    try {
      value = JSON.parse(await file.text());
    } catch (e) {
      setRulesProblems([f(p.teamRules.notJson, { reason: (e as Error).message })]);
      return;
    }
    try {
      adoptRules({ set: parseRules(value), source: file.name, team: false });
      setRulesProblems([]);
    } catch (e) {
      if (!(e instanceof RulesError)) throw e;
      setRulesProblems(e.problems);
    }
  }

  /** The team's own rules, through the desktop shell, which reads them and writes nothing. */
  async function loadTeamRules() {
    setRulesProblems([]);
    setRulesNote(null);
    try {
      const found = await bridge!.loadTeamRules();
      // Nothing written down is not a reason to start checking by the
      // defaults: the page stays as it was and says so.
      if (!found.markdown && !found.json) {
        setRulesNote("none");
        return;
      }
      setRulesNote(found);
      adoptRules({ set: found.set, source: found.json ?? found.markdown!, team: true });
    } catch (e) {
      setRulesProblems([f(p.teamRules.error, { message: (e as Error).message })]);
    }
  }

  function clearRules() {
    setRulesProblems([]);
    setRulesNote(null);
    adoptRules(null);
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
    setScanned((prev) => (prev ?? []).map((one) => fresh.get(one.report.filename) ?? one));
    // A line left unticked stays unticked, or the next save would take it
    // without anyone choosing it: in a file not read again, by its address;
    // in one that was, by what it says, since the save may have moved it.
    // Every kind, not just those on screen: a line unticked and then hidden
    // by a filter is still unticked when the filter is lifted.
    const before = new Map((scanned ?? []).map((one) => [one.report.filename, one]));
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
    clearRun();
    // The last folder's findings go with it: left up while this one is read,
    // a line of one could be saved against a file of the same name in the other.
    setScanned(null);
    setExcluded(new Set());
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
          if (last) await loadNative(shell, last, mine);
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
        if (!cancelled) await load(folder, saved, mine);
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
    setFolderName("");
    clearRun();
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

  /** Whether the backup on hand covers every file about to be written. */
  const backedUp = backup !== null && chosen.every((plan) => backup.paths.has(plan.path));

  const fileByPath = useMemo(() => new Map(files.map((file) => [file.path, file])), [files]);

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
    setOutcomes(null);
    setExcluded((prev) => toggled(prev, key));
  }

  function setFileSelected(filename: string, on: boolean) {
    setOutcomes(null);
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
    setOutcomes(null);
    if (on) {
      setExcluded(new Set());
      return;
    }
    const every = new Set<string>();
    for (const lines of rows.values()) for (const row of lines) if (row.fix) every.add(row.key);
    setExcluded(every);
  }

  /**
   * Run one of the long jobs below, reporting each file as it starts.
   *
   * `step` is shaped to be handed straight to `fixFiles` as `onFile`.
   */
  async function run(
    verb: Progress["verb"],
    body: (step: (path: string, done: number, total: number) => Promise<void>) => Promise<void>
  ) {
    setFixError(null);
    setRunning(true);
    const paint = painter();
    try {
      await body(async (path, done, total) => {
        setProgress({ verb, path, done, total });
        await paint();
      });
    } catch (e) {
      setFixError({ message: (e as Error).message });
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }

  /** The files about to change, exactly as they stand, as one archive. */
  const downloadBackup = () =>
    run("backingUp", async (step) => {
      const entries: { path: string; bytes: Uint8Array }[] = [];
      for (const [index, plan] of chosen.entries()) {
        await step(plan.path, index, chosen.length);
        const file = fileByPath.get(plan.path);
        if (file) entries.push({ path: plan.path, bytes: await file.read() });
      }
      // Compressing the lot gets no step of its own: a whole library is 37 MB
      // of presentations and deflates in under three hundred milliseconds.
      const name = `propresenter-backup-${stamp()}.zip`;
      download(name, await zip(entries), "application/zip");
      setBackup({ name, paths: new Set(entries.map((entry) => entry.path)) });
    });

  const readFile = async (path: string) => {
    const file = fileByPath.get(path);
    if (!file) throw new Error(path);
    return file.read();
  };

  /**
   * Save through the desktop shell, which does the whole of it: reads each
   * file again, works its fixes out again, and backs up, writes and reads
   * back only the lines that come out as they were shown here.
   */
  async function saveNative() {
    // The checks on screen now, which decided what every fix shown does.
    const kinds = [...shown];
    // The folder the save is for: one opened while it runs has files of its own.
    const mine = displayed.current;
    await run("applying", async (step) => {
      await step(chosen[0]?.path ?? "", 0, chosen.length);
      const result = await bridge!.applyFixes(
        chosen.map((plan) => {
          const native = fileByPath.get(plan.path)?.native;
          return {
            path: native?.path ?? plan.path,
            sha256: native?.sha256 ?? "",
            kinds,
            lines: plan.fixes.map(({ boxIndex, lineIndex, before, after }) => ({ boxIndex, lineIndex, before, after })),
          };
        })
      );
      if (mine !== displayed.current) return;
      const shownAs = new Map(files.map((file) => [file.native?.path, file.path]));
      setNativeRun({ backupFolder: result.backupFolder, refused: result.refused });
      setBackupsUnshown(false);
      // A refused run replaces the last run's outcomes too: an earlier success is not this run's.
      setOutcomes(result.refused ? null : result.files.map((file) => ({ ...file, path: shownAs.get(file.path) ?? file.path })));
      // Read again what the run may have changed, so what is on screen is what is on disk.
      await rescan(chosen.flatMap((plan) => fileByPath.get(plan.path) ?? []), mine);
    });
  }

  async function saveFixes() {
    if (bridge) return saveNative();
    setFixError(null);
    // Taken before the prompt, which waits on the person: a folder opened
    // while it is up is not the one whose handle and files this save holds.
    const mine = displayed.current;
    // Scanning only ever asked to read. Writing is a separate promise, made
    // here where the reader has just asked for it and a gesture is in hand.
    if ((await requestHandlePermission(handle, "readwrite")) !== "granted") {
      if (mine === displayed.current) setFixError("permissionNeeded");
      return;
    }
    if (mine !== displayed.current) return;

    await run("applying", async (onFile) => {
      const result = await fixFiles(chosen, {
        read: readFile,
        write: async (path, bytes) => {
          const file = fileByPath.get(path);
          if (!file?.write) throw new Error(path);
          await file.write(bytes);
        },
        onFile,
      });
      if (mine !== displayed.current) return;
      setOutcomes(result);
      // The backup describes files that no longer look like that.
      setBackup(null);
      // Read the folder again, so what is on screen is what is on disk.
      await scan(files, mine);
    });
  }

  /** The fallback where nothing can be written: hand over corrected copies. */
  const downloadFixed = () =>
    run("fixing", async (onFile) => {
      const result = await fixFiles(chosen, { read: readFile, onFile });
      const entries = result
        .filter((outcome) => outcome.bytes)
        .map((outcome) => ({ path: outcome.path, bytes: outcome.bytes! }));
      const name = `propresenter-fixed-${stamp()}.zip`;
      download(name, await zip(entries), "application/zip");
      setOutcomes(result);
      setSavedZip(name);
    });

  /** What the fix card says of saving, which depends on what this app can do with the folder. */
  function fixWhy(): string {
    if (bridge) {
      if (cloud) return nativeText.cloudReadOnly;
      return native?.workspace ? `${nativeText.backupWhy} ${nativeText.closeProPresenter}` : nativeText.backupWhy;
    }
    if (!canWrite) return p.downloadFixedWhy;
    if (!backup) return `${plural(p.backupCount, chosen.length)}. ${p.backupWhy}`;
    return backedUp ? f(p.backupDone, { name: backup.name }) : p.backupStale;
  }

  const saved = outcomes?.filter((outcome) => !outcome.reason) ?? [];
  const refused = outcomes?.filter((outcome) => outcome.reason) ?? [];

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

        {/* ProPresenter 22 keeps its libraries in its own support folder,
            which nobody finds in a dialog, so the ones its registry knows
            are offered directly. */}
        {bridge && workspaces.length > 0 && (
          <>
            <p className="sub">{nativeText.workspaces}</p>
            <ul className="rows">
              {workspaces.map((workspace) => (
                <li key={workspace.root}>
                  <div className="fix-head">
                    <button
                      className="btn"
                      onClick={() => void chooseNative(() => bridge.openWorkspace(workspace.root))}
                      disabled={busy !== null || running}
                    >
                      {nativeText.open}
                    </button>
                    <span>
                      {workspace.name}
                      <span className="node-count">
                        {[workspace.active && nativeText.inUse, workspace.cloud && nativeText.cloud]
                          .filter(Boolean)
                          .map((tag) => ` · ${tag}`)
                          .join("")}
                      </span>
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}

        {/* The team's rules. Loading them only adds a list of findings and sets
            where the optional checks start: the fix run does not read them. */}
        <h4>{p.teamRules.title}</h4>
        <p className="sub">{p.teamRules.hint}</p>
        <div className="editor-bar">
          <button className="btn" onClick={() => rulesInput.current?.click()} disabled={busy !== null || running}>
            {p.teamRules.load}
          </button>
          {bridge && (
            <button className="btn" onClick={() => void loadTeamRules()} disabled={busy !== null || running}>
              {p.teamRules.useTeam}
            </button>
          )}
          {rules && (
            <button className="btn" onClick={clearRules} disabled={busy !== null || running}>
              {p.teamRules.clear}
            </button>
          )}
          <input
            ref={rulesInput}
            type="file"
            hidden
            accept=".json,application/json"
            aria-label={p.teamRules.load}
            onChange={(e) => {
              const picked = e.target.files?.[0];
              // Cleared, or choosing the same file again after an edit fires nothing.
              e.target.value = "";
              if (picked) void loadRulesFile(picked);
            }}
          />
        </div>
        {rules && (
          <p className="why">
            {rules.team
              ? f(p.teamRules.loadedTeam, { file: rules.source })
              : f(p.teamRules.loaded, { name: rules.source })}
          </p>
        )}
        {rulesNote === "none" && <p className="why warn-inline">{p.teamRules.none}</p>}
        {rulesNote && rulesNote !== "none" && rulesNote.stale && <p className="why warn-inline">{p.teamRules.stale}</p>}
        {rulesNote && rulesNote !== "none" && rulesNote.defaulted && (
          <p className="why warn-inline">{p.teamRules.defaulted}</p>
        )}
        {rulesProblems.length > 0 && (
          <div className="why warn-inline">
            {p.teamRules.problems}
            <ul className="rows">
              {rulesProblems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </div>
        )}

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

      {reports.length > 0 && (
        <div className="card">
          <h2>{p.summary}</h2>
          <div className="stats">
            <div className="stat">
              <div className="n">{num(reports.length)}</div>
              <div className="l">{p.name}</div>
            </div>
            {kinds.map((kind) => (
              <div className="stat" key={kind}>
                <div className="n">{num(countOf(kind))}</div>
                <div className="l">{p.kinds[kind]}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Above the findings rather than below them: on a library of hundreds
          the list is long, and a control at the bottom of it is a control
          nobody finds. It stays on screen after a run that leaves nothing to
          fix, because that is exactly when the reader wants to know what
          happened. */}
      {(fixableLines > 0 || outcomes) && (
        <div className="card">
          <h2>{p.fix}</h2>
          <p className="sub">{p.fixHint}</p>

          <div className="editor-bar">
            <span className="editor-count">
              {plural(p.fixable, chosenLines)} {plural(p.inFilesFix, chosen.length)}
            </span>
            <span className="spacer" />
            <button
              className="btn"
              onClick={() => setAllSelected(excluded.size > 0)}
              disabled={running}
            >
              {excluded.size > 0 ? p.selectAll : p.selectNone}
            </button>

            {bridge ? (
              // No backup to take first: the shell makes one of every file
              // before it changes, and writes nothing if it cannot.
              <button
                className="btn primary"
                onClick={() => void saveFixes()}
                disabled={!canWrite || chosenLines === 0 || running}
              >
                {plural(p.applyFixes, chosenLines)}
              </button>
            ) : canWrite ? (
              <>
                <button
                  className={backedUp ? "btn" : "btn primary"}
                  onClick={() => void downloadBackup()}
                  disabled={chosenLines === 0 || running}
                >
                  {p.downloadBackup}
                </button>
                <button
                  className="btn primary"
                  onClick={() => void saveFixes()}
                  disabled={!backedUp || chosenLines === 0 || running}
                >
                  {plural(p.applyFixes, chosenLines)}
                </button>
              </>
            ) : (
              <button
                className="btn primary"
                onClick={() => void downloadFixed()}
                disabled={chosenLines === 0 || running}
              >
                {p.downloadFixed}
              </button>
            )}
          </div>

          {progress && <ProgressBar progress={progress} />}

          <p className="why">{fixWhy()}</p>

          {nativeRun?.refused && (
            <p className="why warn-inline">
              {nativeRun.refused.code === "failed"
                ? f(p.runRefusals.failed, { detail: nativeRun.refused.detail })
                : p.runRefusals[nativeRun.refused.code]}
            </p>
          )}
          {nativeRun?.backupFolder && (
            <div className="editor-bar" style={{ paddingTop: 0 }}>
              <span className="editor-count">{f(nativeText.backedUpTo, { folder: nativeRun.backupFolder })}</span>
              <span className="spacer" />
              <button
                className="btn"
                onClick={() => {
                  setBackupsUnshown(false);
                  // Moved or removed since: the path above still says where they were.
                  bridge?.showBackups(nativeRun.backupFolder!).catch(() => setBackupsUnshown(true));
                }}
              >
                {nativeText.showBackups}
              </button>
            </div>
          )}
          {nativeRun?.backupFolder && backupsUnshown && <p className="why warn-inline">{nativeText.backupsUnshown}</p>}

          {savedZip && <p className="why">{f(p.downloadedFixed, { name: savedZip })}</p>}
          {fixError && (
            <p className="why warn-inline">
              {fixError === "permissionNeeded" ? p.permissionNeeded : fixError.message}
            </p>
          )}

          {outcomes && (
            <p className="sub">
              {saved.length > 0 ? plural(p.fixedFiles, saved.length) : p.fixedNone}
              {refused.length > 0 && ` · ${plural(p.fixFailed, refused.length)}`}
            </p>
          )}
          {refused.length > 0 && (
            <ul className="rows">
              {refused.map((outcome) => (
                <li key={outcome.path}>
                  <span className="path">{outcome.path}</span>{" "}
                  <span className="node-count">
                    {p.refusals[outcome.reason!]}
                    {outcome.rangeReason && `: ${p.rangeRefusals[outcome.rangeReason]}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {reports.length > 0 && (
        <div className="card">
          <h2>
            {totalIssues === 0
              ? p.clean
              : plural(p.issuesFound, totalIssues, {
                  files: plural(p.inFiles, withIssues.length),
                })}
          </h2>
          <p className="sub">{p.emptyBoxesNote}</p>

          <div className="filters">
            {kinds.map((kind) => (
              <button
                key={kind}
                className="pill"
                aria-pressed={active.has(kind)}
                disabled={countOf(kind) === 0}
                title={p.why[kind]}
                onClick={() => toggle(kind)}
              >
                {p.kinds[kind]} {num(countOf(kind))}
              </button>
            ))}
          </div>

          {withIssues.map((report) => {
            const lines = rows.get(report.filename) ?? [];
            const fixable = lines.filter((row) => row.fix);
            const allOn = fixable.length > 0 && fixable.every((row) => !excluded.has(row.key));

            return (
              <div className="finding" key={report.filename}>
                <h3>
                  {showFolders && (
                    <span className="finding-folder">{folderLabel(report.filename)}</span>
                  )}
                  {report.name || report.filename}
                  <span className="count-badge">{report.error ? "!" : num(lines.length)}</span>
                </h3>
                <p className="why">
                  {report.error
                    ? report.error === "unreadable"
                      ? f(p.problems.unreadable, { reason: report.errorDetail ?? "" })
                      : p.problems[report.error]
                    : f(p.slidesAndBoxes, {
                        slides: num(report.slideCount),
                        empty: num(report.emptyTextBoxes),
                      })}
                </p>

                {fixable.length > 0 && (
                  <label className="option">
                    <input
                      type="checkbox"
                      checked={allOn}
                      onChange={(e) => setFileSelected(report.filename, e.target.checked)}
                      disabled={running}
                    />
                    <span>{p.selectFile}</span>
                  </label>
                )}

                {!report.error && (
                  <ul className="rows">
                    {lines.map((row) => (
                      <li key={row.key}>
                        <div className="fix-head">
                          {row.fix && (
                            <input
                              type="checkbox"
                              // Named by where the line is rather than by what
                              // it says: the text is on screen beside it, and
                              // a label of " leading space" would announce the
                              // problem instead of the choice.
                              aria-label={`${f(p.slide, { n: num(row.slideIndex + 1) })} ${f(
                                p.line,
                                { n: num(row.lineIndex + 1) }
                              )}`}
                              checked={!excluded.has(row.key)}
                              onChange={() => toggleRow(row.key)}
                              disabled={running}
                            />
                          )}
                          <span>
                            {row.kinds.map((kind) => (
                              <span className={`tag ${kind}`} key={kind}>
                                {p.kinds[kind]}
                              </span>
                            ))}{" "}
                            <span className="node-count">
                              {f(p.slide, { n: num(row.slideIndex + 1) })}
                              {row.groupName ? ` · ${row.groupName}` : ""} {"·"}{" "}
                              {f(p.line, { n: num(row.lineIndex + 1) })}
                            </span>
                          </span>
                        </div>

                        {/* Rendered with the whitespace made visible, since the
                            whole point is characters you cannot otherwise see. */}
                        <div className="path whitespace">
                          {row.text === "" ? "—" : visibleWhitespace(row.text)}
                        </div>

                        {row.fix ? (
                          <div className="path whitespace becomes">
                            <span className="becomes-label">{p.becomes}</span>{" "}
                            {row.fix.after === null ? (
                              <em>{p.lineRemoved}</em>
                            ) : row.fix.after === "" ? (
                              "—"
                            ) : (
                              visibleWhitespace(row.fix.after)
                            )}
                          </div>
                        ) : (
                          <div className="why">{p.noFixFor}</div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}

      {rules && scanned && (
        <div className="card">
          <h2>{p.teamRules.title}</h2>
          <p className="sub">
            {ruleFindingCount === 0 ? p.teamRules.nothingFound : plural(p.teamRules.findings, ruleFindingCount)}
          </p>
          {ruleFindings.map(({ report, findings }) => (
            <div className="finding" key={report.filename}>
              <h3>
                {showFolders && <span className="finding-folder">{folderLabel(report.filename)}</span>}
                {report.name || report.filename}
                <span className="count-badge">{num(findings.length)}</span>
              </h3>
              <ul className="rows">
                {findings.map((finding, i) => (
                  <RuleFindingRow key={i} finding={finding} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/** One finding of the rules: read-only, with nothing to tick, and dimmed when a person has said it is fine. */
function RuleFindingRow({ finding }: { finding: Finding }) {
  const i18n = useI18n();
  const { f, num } = i18n;
  const p = i18n.t.tools.presentations;
  return (
    <li style={finding.excepted === undefined ? undefined : { opacity: 0.55 }}>
      <span className="node-count">
        {f(p.slide, { n: num(finding.slideIndex + 1) })}
        {finding.groupName ? ` · ${finding.groupName}` : ""}
      </span>{" "}
      <span>{describeFinding(i18n, finding)}</span>{" "}
      <span className="node-count">({findingTags(i18n, finding)})</span>
      {finding.text !== undefined && (
        <div className="path whitespace">{finding.text === "" ? "—" : visibleWhitespace(finding.text)}</div>
      )}
    </li>
  );
}

/**
 * How far a run has got.
 *
 * `role="progressbar"` rather than a native `<progress>`: the vendor
 * pseudo-elements a native one needs before it can be styled for both themes
 * buy nothing these four aria attributes do not already say.
 *
 * The caption names the file as well as the count, because when a run of
 * several hundred reports a refusal afterwards, the useful question is which
 * file it was on at the time.
 */
function ProgressBar({ progress }: { progress: Progress }) {
  const { t, f, num } = useI18n();
  const p = t.tools.presentations;
  const { done, total, path, verb } = progress;
  // Files finished rather than files started, so the bar is never ahead of
  // the work it is reporting.
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  const counted = f(p.progressCount, { done: num(done), total: num(total) });

  return (
    <div className="progress-block">
      <div
        className="progress"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        aria-valuetext={counted}
      >
        <div className="progress-fill" style={{ width: `${percent}%` }} />
      </div>
      <p className="why progress-caption">
        <span className="progress-file">{f(p[verb], { n: path })}</span>
        <span className="progress-count">{counted}</span>
      </p>
    </div>
  );
}

/**
 * Show whitespace that is the finding as middle dots, so it can be seen.
 *
 * The edges of a line and any run of two or more inside it -- the three things
 * the checks report. Tabs and non-breaking spaces count: they are exactly as
 * invisible as a plain space and rather more surprising to find.
 */
// Built from the checker's own class, so whatever it reports is what shows.
const GAP = new RegExp(SPACE_CLASS, "g");
const EDGES = new RegExp(`^${SPACE_CLASS}+|${SPACE_CLASS}+$`, "g");
const INSIDE = new RegExp(`${SPACE_CLASS}{2,}`, "g");

function visibleWhitespace(text: string): string {
  const dots = (run: string) => "\u00b7".repeat(run.length);
  return text.replace(EDGES, dots).replace(INSIDE, dots).replace(GAP, (c) => (c === " " ? c : dots(c)));
}
