import type { FixRefusal } from "./fixes";
import type { RuleConfiguration, RuleSet } from "./rules";
import type { TextIssueKind } from "./presentation";
import type { RangeRefusal } from "./workspace-edit";

/**
 * What the desktop app's shell offers the page, and nothing more.
 *
 * The page runs sandboxed, with no Node and no file system: everything it
 * reads comes through here, and the only thing it can change on disk is the
 * set of lines a person ticked. There is deliberately no call that writes
 * bytes to a path. The shell reads each file again, works the fixes out
 * again from what it read, and writes them through `packages/node`, the same
 * path the MCP server uses, where the four guards in AGENTS.md are kept.
 *
 * Types only, so the page, the shell's preload and its main process agree on
 * one contract without the page importing anything that needs Node.
 */

/** A presentation the shell found under a folder it opened. */
export interface NativeFile {
  /** Real and absolute: what the shell is asked to read, and what it resolves again inside the folder before it does. */
  path: string;
  /** Relative to the folder, with `/` between segments whatever the system. */
  relative: string;
  name: string;
}

export interface NativeFolder {
  /** The folder's real, absolute path, which the browser could never show. */
  root: string;
  name: string;
  /** Set when the folder is a ProPresenter 22 workspace: one database, no files. */
  workspace?: {
    /** As ProPresenter names it, when its registry lists it. */
    name?: string;
    /** Synced through ProPresenter Cloud, which the desktop app reads but does not write to yet: its interface does not give the Cloud warning. */
    cloud: boolean;
  };
  files: NativeFile[];
  /** The walk stopped at its limit, so some presentations are not listed. */
  truncated: boolean;
}

/** One ProPresenter 22 workspace from ProPresenter's own registry. */
export interface NativeWorkspace {
  root: string;
  name: string;
  /** The one ProPresenter opens. */
  active: boolean;
  cloud: boolean;
}

export interface NativeRead {
  bytes: Uint8Array;
  /**
   * What applying checks the file against: of the file's bytes, or for a
   * workspace document, of its stored snapshot. Handed back with the lines
   * chosen, so a file that changed since it was read is left alone.
   */
  sha256: string;
}

/** A line as the person saw it, ticked. */
export interface ChosenLine {
  boxIndex: number;
  lineIndex: number;
  before: string;
  /** Null when the line is removed. */
  after: string | null;
}

/** The lines ticked in one presentation, and what the page knew of it when they were shown. */
export interface ChosenFile {
  path: string;
  sha256: string;
  /** The checks that were switched on and shown, which decide what each fix does. */
  kinds: TextIssueKind[];
  lines: ChosenLine[];
}

/** Why a presentation was left alone. Every one has a sentence under `refusals` in the dictionaries. */
export type ApplyRefusal =
  | FixRefusal
  | "moved"
  | "backupFailed"
  | "writeFailed"
  | "readBackFailed"
  | "attributeRanges"
  | "rolledBack";

export interface NativeFileOutcome {
  path: string;
  /** Lines chosen in it. */
  lines: number;
  written: boolean;
  /** Where its copy from before the change is, once it was made. */
  backup?: string;
  reason?: ApplyRefusal;
  /** For `attributeRanges`, why the formatting could not be moved. */
  rangeReason?: RangeRefusal;
}

/**
 * Why a ProPresenter 22 workspace cannot be written at all, which refuses a
 * whole run before anything is written. `packages/node` throws these as
 * `WorkspaceRefused`, so a refusal added there has a sentence here or does
 * not compile.
 */
export type WorkspaceRefusalCode = "propresenterOpen" | "cloudWorkspace" | "unverifiedWorkspace";

/**
 * Why nothing at all was written. Each has a sentence under
 * `runRefusals` in the dictionaries; `failed` shows `detail`.
 */
export type RunRefusal = WorkspaceRefusalCode | "failed";

export interface NativeApplyResult {
  /** The folder this run's backups went into. */
  backupFolder?: string;
  files: NativeFileOutcome[];
  /** Set when the run refused before anything was written. */
  refused?: { code: RunRefusal; detail: string };
}

/** The team's rules as the shell found them, read and never written. */
export interface NativeRules {
  set: RuleSet;
  /** `RULES.md` has changed since `rules.json` was compiled from it. */
  stale: boolean;
  /** No `rules.json` was found, so the default text checks stand in. */
  defaulted: boolean;
  /** Where each was found, when it was. Neither means the team has no rules written down. */
  markdown?: string;
  json?: string;
}

/** ProPresenter's configured groups and macros for the folder open, and why a list is missing. */
export interface NativeConfiguration extends RuleConfiguration {
  problems: string[];
}

export interface DesktopBridge {
  /** Show the system's folder dialog. Null when it was dismissed. */
  pickFolder(): Promise<NativeFolder | null>;
  /** The folder open last time, read again, or null if there was none or it is gone. */
  reopenLast(): Promise<NativeFolder | null>;
  forgetLast(): Promise<void>;
  /** ProPresenter 22's workspaces on this computer, the active one first. */
  workspaces(): Promise<NativeWorkspace[]>;
  /** Open one of the workspaces `workspaces()` listed. Nothing else can be opened by path. */
  openWorkspace(root: string): Promise<NativeFolder>;
  /** Read one file the open folder listed. */
  read(path: string): Promise<NativeRead>;
  /** Back up, fix and read back the ticked lines. The only call that changes anything. */
  applyFixes(files: ChosenFile[]): Promise<NativeApplyResult>;
  /** Read the team's `RULES.md` and `rules.json` where the shell looks for them. Changes nothing. */
  loadTeamRules(): Promise<NativeRules>;
  /**
   * ProPresenter's configured groups and macros for the folder open, so the
   * rules match a slide's macro by uuid as everywhere else. Changes nothing.
   */
  readConfiguration(): Promise<NativeConfiguration>;
  /** Open a backup folder this session's runs made in the system's file manager. */
  showBackups(folder: string): Promise<void>;
}

/** The global the shell's preload puts the bridge on. */
export const BRIDGE_GLOBAL = "presenterGarage";

/** The desktop shell's bridge, when the page is running inside it. */
export function desktopBridge(): DesktopBridge | undefined {
  return (globalThis as Record<string, unknown>)[BRIDGE_GLOBAL] as DesktopBridge | undefined;
}
