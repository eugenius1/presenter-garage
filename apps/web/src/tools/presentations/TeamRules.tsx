import { useMemo, useRef } from "react";
import type { Examined } from "@presenter-garage/core/lib/fixes";
import type { Finding } from "@presenter-garage/core/lib/rules";
import { describeFinding, findingTags } from "@presenter-garage/core/i18n/rules";
import { useI18n } from "../../i18n";
import type { TeamRules } from "./useTeamRules";
import { visibleWhitespace } from "@presenter-garage/core/lib/whitespace";

/**
 * The team's rules. Loading them only adds a list of findings and sets
 * where the optional checks start: the fix run does not read them.
 */
export function TeamRulesControls({
  rules: team,
  desktop,
  disabled,
  listProblems,
}: {
  rules: TeamRules;
  /** Whether this is the desktop app, which can find the team's own rules. */
  desktop: boolean;
  disabled: boolean;
  /** Why ProPresenter's own lists were not all there for the last scan, so a quiet result is not taken for a clean one. */
  listProblems: string[];
}) {
  const { t, f } = useI18n();
  const p = t.tools.presentations;
  const rulesInput = useRef<HTMLInputElement>(null);
  const { rules, note, problems } = team;

  return (
    <>
      <h4>{p.teamRules.title}</h4>
      <p className="sub">{p.teamRules.hint}</p>
      <div className="editor-bar">
        <button className="btn" onClick={() => rulesInput.current?.click()} disabled={disabled}>
          {p.teamRules.load}
        </button>
        {desktop && (
          <button className="btn" onClick={() => void team.loadTeam()} disabled={disabled}>
            {p.teamRules.useTeam}
          </button>
        )}
        {rules && (
          <button className="btn" onClick={team.clear} disabled={disabled}>
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
            if (picked) void team.loadFile(picked);
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
      {note === "none" && <p className="why warn-inline">{p.teamRules.none}</p>}
      {note && note !== "none" && note.stale && <p className="why warn-inline">{p.teamRules.stale}</p>}
      {note && note !== "none" && note.defaulted && (
        <p className="why warn-inline">{p.teamRules.defaulted}</p>
      )}
      {rules && listProblems.length > 0 && (
        <div className="why warn-inline">
          {p.teamRules.lists}
          <ul className="rows">
            {listProblems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      )}
      {problems.length > 0 && (
        <div className="why warn-inline">
          {p.teamRules.problems}
          <ul className="rows">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

/** What the rules found, file by file, beside the text fixes. */
export function RuleFindingsCard({
  examined,
  showFolders,
  folderLabel,
}: {
  examined: Examined[];
  showFolders: boolean;
  folderLabel: (filename: string) => string;
}) {
  const { t, num, plural } = useI18n();
  const p = t.tools.presentations;

  /**
   * Text problems are left out: the list of fixes shows each of them with
   * the line it would become, and listing them again here would say
   * everything twice.
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

  return (
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
