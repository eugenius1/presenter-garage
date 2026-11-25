import type { PresentationReport, TextIssueKind } from "@presenter-garage/core/lib/presentation";
import { useI18n } from "../../i18n";
import type { Row } from "./rows";
import { visibleWhitespace } from "./whitespace";

/**
 * Every line with something wrong, file by file, each one as it is and as it
 * would read, with a tick box on every line a fix exists for. The run writes
 * only the lines left ticked.
 */
export function FindingsCard({
  withIssues,
  totalIssues,
  kinds,
  active,
  countOf,
  onToggleKind,
  rows,
  excluded,
  running,
  showFolders,
  folderLabel,
  onToggleRow,
  onSetFileSelected,
}: {
  /** The files with a finding of a kind on screen, or that would not open. */
  withIssues: PresentationReport[];
  totalIssues: number;
  /** The kinds switched on, one pill each. */
  kinds: TextIssueKind[];
  /** The kinds not filtered out by a pill. */
  active: ReadonlySet<TextIssueKind>;
  countOf: (kind: TextIssueKind) => number;
  onToggleKind: (kind: TextIssueKind) => void;
  rows: ReadonlyMap<string, Row[]>;
  /** The lines the reader has taken out of the run. */
  excluded: ReadonlySet<string>;
  running: boolean;
  showFolders: boolean;
  folderLabel: (filename: string) => string;
  onToggleRow: (key: string) => void;
  onSetFileSelected: (filename: string, on: boolean) => void;
}) {
  const { t, f, num, plural } = useI18n();
  const p = t.tools.presentations;

  return (
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
            onClick={() => onToggleKind(kind)}
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
                  onChange={(e) => onSetFileSelected(report.filename, e.target.checked)}
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
                          onChange={() => onToggleRow(row.key)}
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
  );
}

/** How many presentations were read, and how many findings of each kind switched on. */
export function SummaryCard({
  files,
  kinds,
  countOf,
}: {
  files: number;
  kinds: TextIssueKind[];
  countOf: (kind: TextIssueKind) => number;
}) {
  const { t, num } = useI18n();
  const p = t.tools.presentations;

  return (
    <div className="card">
      <h2>{p.summary}</h2>
      <div className="stats">
        <div className="stat">
          <div className="n">{num(files)}</div>
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
  );
}
