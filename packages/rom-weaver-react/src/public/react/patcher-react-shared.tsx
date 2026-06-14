import { useEffect, useRef, useSyncExternalStore } from "react";
import type { DialogController } from "./patcher-form.ts";
import { createInitialDialogState } from "./patcher-ui-state.ts";

/**
 * Legacy archive-entry picker used by the apply workflow when an archive
 * exposes a single choice list (the multi-select flows use the candidate
 * selection modal instead). A native modal dialog in the loom picker style;
 * the ids/test hooks (rom-weaver-dialog-zip*) are load-bearing for the browser
 * tests.
 */

const inertDialogState = (() => {
  const { open, title, entries } = createInitialDialogState();
  return { entries, open, title };
})();

const createStaticStoreController = <State,>(state: State) => ({
  getState: () => state,
  subscribe: () => () => undefined,
});

export function ArchiveDialog({ controller }: { controller?: DialogController }) {
  const activeController: DialogController = controller || createStaticStoreController(inertDialogState);
  const state = useSyncExternalStore(activeController.subscribe, activeController.getState, activeController.getState);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (state.open && !dialog.open) dialog.showModal();
    else if (!state.open && dialog.open) dialog.close();
  }, [state.open]);
  return (
    <dialog className="dlg picker-dlg" data-testid="archive-dialog" id="rom-weaver-dialog-zip" ref={dialogRef}>
      <div className="dlg-frame">
        <header className="dlg-head">
          <h2 className="dlg-title mono" id="rom-weaver-dialog-zip-message">
            {state.title}
          </h2>
        </header>
        <div className="dlg-body">
          <ul className="picklist" id="rom-weaver-dialog-zip-file-list">
            {state.entries.map((entry) => (
              <li key={entry.id}>
                <button
                  className="pick-row pick-btn"
                  onClick={() => activeController.selectEntry?.(entry.id)}
                  title={entry.label}
                  type="button"
                >
                  <span className="pick-main">
                    <span className="pick-name mono">{entry.label}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </dialog>
  );
}
