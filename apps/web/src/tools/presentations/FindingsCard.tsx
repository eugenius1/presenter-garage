import type { ReactNode } from "react";
import type { PresentationReport, TextIssueKind } from "@presenter-garage/core/lib/presentation";
import { useI18n } from "../../i18n";
import type { ContextSlide } from "@presenter-garage/core/lib/slide-context";
import { reviewRuns, type ReviewSlide, type Row } from "./rows";
import { visibleWhitespace } from "@presenter-garage/core/lib/whitespace";

/**
 * Every line with something wrong, file by file, each one as it is and as it
 * would read, with a tick box on every line a fix exists for, among the
 * slides around it. The run writes only the lines left ticked.
 */
export function FindingsCard({
  withIssues,
  totalIssues,
  kinds,
  active,
  countOf,
  onToggleKind,
  rows,
  contextOf,
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
  /** The slides around a file's findings, shown with its rows to read them by. */
  contextOf: (filename: string) => readonly ContextSlide[];
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
              <Review
                rows={lines}
                context={contextOf(report.filename)}
                slideCount={report.slideCount}
                excluded={excluded}
                running={running}
                onToggleRow={onToggleRow}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * A file's rows among the slides around them, two either side, with each
 * slide's group and macros: whether a line is right is often plain only
 * from the lines around it. The slides and lines only there to read are set
 * apart from the rows and offer nothing to tick; only a row does, as before.
 */
function Review({
  rows,
  context,
  slideCount,
  excluded,
  running,
  onToggleRow,
}: {
  rows: Row[];
  context: readonly ContextSlide[];
  slideCount: number;
  excluded: ReadonlySet<string>;
  running: boolean;
  onToggleRow: (key: string) => void;
}) {
  const { runs, stray } = reviewRuns(rows, context, slideCount);
  const item = (row: Row) => (
    <FindingRow key={row.key} row={row} checked={!excluded.has(row.key)} running={running} onToggle={onToggleRow} />
  );
  return (
    <>
      {runs.map((run) => (
        <div className="context-run" key={run[0].slideIndex}>
          {run.map((slide) => (
            <ContextSlideView key={slide.slideIndex} slide={slide} item={item} />
          ))}
        </div>
      ))}
      {stray.length > 0 && <ul className="rows">{stray.map(item)}</ul>}
    </>
  );
}

/** One slide of a run: its number, group and macros, then its lines, a row in place of each line it is about. */
function ContextSlideView({ slide, item }: { slide: ReviewSlide; item: (row: Row) => ReactNode }) {
  const { t, f, num } = useI18n();
  const p = t.tools.presentations;
  const macros = slide.macros.map((m) => (m.enabled ? m.name : f(p.macroOff, { name: m.name }))).join(", ");
  return (
    <div className={slide.holdsRow ? "context-slide holds-row" : "context-slide"}>
      <div className="context-head">
        {f(p.slide, { n: num(slide.slideIndex + 1) })}
        {slide.groupName ? ` · ${slide.groupName}` : ""}
        {macros ? ` · ${macros}` : ""}
      </div>
      <ul className="rows">
        {slide.items.length === 0 && <li className="context-line empty">{p.noTextOnSlide}</li>}
        {slide.items.map((entry) =>
          "row" in entry ? (
            item(entry.row)
          ) : (
            <li className="context-line" key={`${entry.line.boxIndex}:${entry.line.lineIndex}`}>
              {entry.line.text === "" ? "—" : entry.line.text}
            </li>
          )
        )}
      </ul>
    </div>
  );
}

/** One line with something wrong: as it is, as it would read, and the tick box choosing it where a fix exists. */
function FindingRow({
  row,
  checked,
  running,
  onToggle,
}: {
  row: Row;
  checked: boolean;
  running: boolean;
  onToggle: (key: string) => void;
}) {
  const { t, f, num } = useI18n();
  const p = t.tools.presentations;
  return (
    <li className="finding-row">
      <div className="fix-head">
        {row.fix && (
          <input
            type="checkbox"
            // Named by where the line is rather than by what
            // it says: the text is on screen beside it, and
            // a label of " leading space" would announce the
            // problem instead of the choice.
            aria-label={`${f(p.slide, { n: num(row.slideIndex + 1) })} ${f(p.line, { n: num(row.lineIndex + 1) })}`}
            checked={checked}
            onChange={() => onToggle(row.key)}
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
            {row.groupName ? ` · ${row.groupName}` : ""} {"·"} {f(p.line, { n: num(row.lineIndex + 1) })}
          </span>
        </span>
      </div>

      {/* Rendered with the whitespace made visible, since the
          whole point is characters you cannot otherwise see. */}
      <div className="path whitespace">{row.text === "" ? "—" : visibleWhitespace(row.text)}</div>

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
