import type { DesktopBridge } from "@presenter-garage/core/lib/desktop";
import { useI18n } from "../../i18n";
import type { FixRun, Progress } from "./useFixRun";

/**
 * The controls that write: select all or none, back up, save, or download
 * corrected copies where nothing can be written, and what the last run did.
 */
export function FixCard({
  run,
  bridge,
  canWrite,
  cloud,
  workspace,
  chosenFiles,
  chosenLines,
  anyExcluded,
  onSelectAll,
}: {
  run: FixRun;
  bridge: DesktopBridge | undefined;
  /** Whether anything could be written back at all, before the reader chooses. */
  canWrite: boolean;
  /** A ProPresenter Cloud workspace, read here and not written. */
  cloud: boolean;
  /** Whether the folder is a ProPresenter 22 workspace. */
  workspace: boolean;
  chosenFiles: number;
  chosenLines: number;
  anyExcluded: boolean;
  onSelectAll: (on: boolean) => void;
}) {
  const { t, f, plural } = useI18n();
  const p = t.tools.presentations;
  const nativeText = p.native;
  const { backup, backedUp, outcomes, savedZip, fixError, running, progress, nativeRun, backupsUnshown } = run;

  /** What the fix card says of saving, which depends on what this app can do with the folder. */
  function fixWhy(): string {
    if (bridge) {
      if (cloud) return nativeText.cloudReadOnly;
      return workspace ? `${nativeText.backupWhy} ${nativeText.closeProPresenter}` : nativeText.backupWhy;
    }
    if (!canWrite) return p.downloadFixedWhy;
    if (!backup) return `${plural(p.backupCount, chosenFiles)}. ${p.backupWhy}`;
    return backedUp ? f(p.backupDone, { name: backup.name }) : p.backupStale;
  }

  const saved = outcomes?.filter((outcome) => !outcome.reason) ?? [];
  const refused = outcomes?.filter((outcome) => outcome.reason) ?? [];

  return (
    <div className="card">
      <h2>{p.fix}</h2>
      <p className="sub">{p.fixHint}</p>

      <div className="editor-bar">
        <span className="editor-count">
          {plural(p.fixable, chosenLines)} {plural(p.inFilesFix, chosenFiles)}
        </span>
        <span className="spacer" />
        <button
          className="btn"
          onClick={() => onSelectAll(anyExcluded)}
          disabled={running}
        >
          {anyExcluded ? p.selectAll : p.selectNone}
        </button>

        {bridge ? (
          // No backup to take first: the shell makes one of every file
          // before it changes, and writes nothing if it cannot.
          <button
            className="btn primary"
            onClick={() => void run.saveFixes()}
            disabled={!canWrite || chosenLines === 0 || running}
          >
            {plural(p.applyFixes, chosenLines)}
          </button>
        ) : canWrite ? (
          <>
            <button
              className={backedUp ? "btn" : "btn primary"}
              onClick={() => void run.downloadBackup()}
              disabled={chosenLines === 0 || running}
            >
              {p.downloadBackup}
            </button>
            <button
              className="btn primary"
              onClick={() => void run.saveFixes()}
              disabled={!backedUp || chosenLines === 0 || running}
            >
              {plural(p.applyFixes, chosenLines)}
            </button>
          </>
        ) : (
          <button
            className="btn primary"
            onClick={() => void run.downloadFixed()}
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
              run.setBackupsUnshown(false);
              // Moved or removed since: the path above still says where they were.
              bridge?.showBackups(nativeRun.backupFolder!).catch(() => run.setBackupsUnshown(true));
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
