import { useRef, useState } from "react";
import { parseRules, RulesError, type RuleSet } from "@presenter-garage/core/lib/rules";
import type { DesktopBridge, NativeRules } from "@presenter-garage/core/lib/desktop";
import { useI18n } from "../../i18n";

/** The rules a person loaded, and where they came from. */
export interface LoadedRules {
  set: RuleSet;
  /** The file's name, or the path the desktop app found them at. */
  source: string;
  team: boolean;
}

/**
 * The team's rules, when a person has loaded some. Read-only: they decide
 * what is listed beside the text fixes and which optional checks start on,
 * and nothing in the fix run reads them.
 *
 * `onAdopt` is told of every change, after the rules in use have changed:
 * the folder on screen is read again with them.
 */
export function useTeamRules(bridge: DesktopBridge | undefined, onAdopt: (next: LoadedRules | null) => void) {
  const { f, t } = useI18n();
  const p = t.tools.presentations;

  const [rules, setRules] = useState<LoadedRules | null>(null);
  /** Why a rules file was refused, a line each; or what the desktop app said of the team's rules. */
  const [problems, setProblems] = useState<string[]>([]);
  const [note, setNote] = useState<NativeRules | "none" | null>(null);
  /**
   * The rules a scan checks with, read at the moment each file is checked: a
   * scan under way when the rules change is overtaken by a new one, but a
   * save's partial rescan must use the rules on screen, not those of its start.
   */
  const inUse = useRef<RuleSet | null>(null);

  /**
   * Use these rules from now on, or none. The rules look at every slide, group
   * and macro, which a scan does not keep, so a folder already read is read
   * again; a scan under way is overtaken, as a new folder overtakes one.
   */
  function adopt(next: LoadedRules | null) {
    inUse.current = next?.set ?? null;
    setRules(next);
    onAdopt(next);
  }

  /** A rules.json the person chose: parsed as `parseRules` has it, and every problem shown if it will not. */
  async function loadFile(file: File) {
    setNote(null);
    let value: unknown;
    try {
      value = JSON.parse(await file.text());
    } catch (e) {
      setProblems([f(p.teamRules.notJson, { reason: (e as Error).message })]);
      return;
    }
    try {
      adopt({ set: parseRules(value), source: file.name, team: false });
      setProblems([]);
    } catch (e) {
      if (!(e instanceof RulesError)) throw e;
      setProblems(e.problems);
    }
  }

  /** The team's own rules, through the desktop shell, which reads them and writes nothing. */
  async function loadTeam() {
    setProblems([]);
    setNote(null);
    try {
      const found = await bridge!.loadTeamRules();
      // Nothing written down is not a reason to start checking by the
      // defaults: the page stays as it was and says so.
      if (!found.markdown && !found.json) {
        setNote("none");
        return;
      }
      setNote(found);
      adopt({ set: found.set, source: found.json ?? found.markdown!, team: true });
    } catch (e) {
      setProblems([f(p.teamRules.error, { message: (e as Error).message })]);
    }
  }

  function clear() {
    setProblems([]);
    setNote(null);
    adopt(null);
  }

  return { rules, problems, note, inUse, loadFile, loadTeam, clear };
}

export type TeamRules = ReturnType<typeof useTeamRules>;
