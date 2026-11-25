import type { NativeWorkspace } from "@presenter-garage/core/lib/desktop";
import { useI18n } from "../../i18n";

/**
 * ProPresenter 22 keeps its libraries in its own support folder, which
 * nobody finds in a dialog, so the desktop app offers the ones its registry
 * knows directly.
 */
export function WorkspaceList({
  workspaces,
  onOpen,
  disabled,
}: {
  workspaces: NativeWorkspace[];
  onOpen: (root: string) => void;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const nativeText = t.tools.presentations.native;

  return (
    <>
      <p className="sub">{nativeText.workspaces}</p>
      <ul className="rows">
        {workspaces.map((workspace) => (
          <li key={workspace.root}>
            <div className="fix-head">
              <button className="btn" onClick={() => onOpen(workspace.root)} disabled={disabled}>
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
  );
}
