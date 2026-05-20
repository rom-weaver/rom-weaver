import { useCallback, useState } from "react";
import { formatSelectionDialogMessage, getCandidateDisplayItems } from "../../presentation/formatting/candidates.ts";
import { createBrowserLocalizer } from "../../presentation/localization/index.ts";
import type { CandidateSelectionChoice, CandidateSelectionPrompt } from "./public-types.ts";
import { buttonClasses, cx, dialogClasses } from "./tailwind-classes";

type CandidateSelectionState = {
  request: CandidateSelectionPrompt;
  resolve: (choice: CandidateSelectionChoice) => void;
  reject: (error: Error) => void;
};

type CandidateSelectionError = Error & { code: string };
type UseCandidateSelectionOptions = {
  onCancelSelection?: (request: CandidateSelectionPrompt) => void;
};

const createSelectionSkippedError = (): CandidateSelectionError => {
  const error = new Error("Selection skipped") as CandidateSelectionError;
  error.code = "WORKFLOW_SELECTION_SKIPPED";
  return error;
};

function CandidateSelectionDialog({
  state,
  onCancel,
  onSelect,
}: {
  state: CandidateSelectionState | null;
  onCancel: () => void;
  onSelect: (id: string) => void;
}) {
  if (!state) return null;
  const { request } = state;
  const localizer = createBrowserLocalizer();
  const displayItems = getCandidateDisplayItems(request, localizer);
  const selectableCount = displayItems.filter(({ candidate }) => candidate.selectable).length;
  return (
    <>
      <div aria-hidden="true" className={dialogClasses.backdrop} />
      <div className="fixed inset-0 z-50 grid place-items-center p-0">
        <dialog
          aria-labelledby="rom-weaver-candidate-selection-message"
          className={cx(
            dialogClasses.panel,
            "static top-auto left-auto m-0 w-[min(1040px,100vw)] max-w-none max-h-[100vh] translate-x-0 translate-y-0 transform-none overflow-hidden rounded-[14px] p-0 text-left",
          )}
          data-testid="candidate-selection-dialog"
          id="rom-weaver-candidate-selection-dialog"
          onCancel={(event) => {
            event.preventDefault();
            onCancel();
          }}
          open
        >
          <div className="px-2.5 pt-2 pb-1.5">
            <div className={cx(dialogClasses.title, "mb-0")} id="rom-weaver-candidate-selection-message">
              {formatSelectionDialogMessage(request, localizer)}
            </div>
            <div className="text-[11px] leading-[1.2] text-[var(--rom-weaver-color-muted)]">
              {selectableCount
                ? "Select one candidate from the table below."
                : "No selectable candidates are available in this source."}
            </div>
          </div>
          <div className="max-h-[min(580px,calc(100vh-116px))] overflow-y-auto px-0 py-0.5">
            <table
              aria-label="Candidate selection table"
              className="w-full table-fixed [border-collapse:separate] [border-spacing:0_2px]"
              id="rom-weaver-candidate-selection-table"
            >
              <colgroup>
                <col className="w-[74%]" />
                <col className="w-[10%]" />
                <col className="w-[16%]" />
              </colgroup>
              <thead>
                <tr className="text-[10px] font-bold uppercase tracking-[0.04em] text-[var(--rom-weaver-color-muted)]">
                  <th className="px-2 pb-0.5 text-left" scope="col">
                    Candidate
                  </th>
                  <th className="px-2 pb-0.5 text-right" scope="col">
                    Size
                  </th>
                  <th className="px-2 pb-0.5 text-right" scope="col">
                    Action
                  </th>
                </tr>
              </thead>
              <tbody id="rom-weaver-candidate-selection-list">
                {displayItems.map(({ candidate, metadata, warningLabel }) => {
                  const primaryLabel = candidate.type === "file" ? candidate.fileName : candidate.label;
                  const breadcrumbLabel = candidate.breadcrumbs?.join(" > ") || "";
                  const uniqueBreadcrumbLabel =
                    breadcrumbLabel.trim() && breadcrumbLabel.trim() !== primaryLabel.trim() ? breadcrumbLabel : "";
                  const detailLabel = [uniqueBreadcrumbLabel, warningLabel].filter(Boolean).join(" • ");
                  const buttonLabel = candidate.selectable ? "Select" : "Unavailable";
                  const rowToneClass = candidate.selectable
                    ? "bg-[var(--rom-weaver-color-surface)] hover:bg-[var(--rom-weaver-color-surface-muted)] hover:border-[var(--rom-weaver-color-border-strong)]"
                    : "bg-[var(--rom-weaver-color-surface)] opacity-[.62]";
                  return (
                    <tr className={candidate.selectable ? "group" : undefined} key={candidate.id}>
                      <td
                        className={cx(
                          "rounded-l-[10px] border border-r-0 border-[var(--rom-weaver-color-border)] px-2 py-1 align-top transition-[background-color,border-color] duration-100",
                          rowToneClass,
                        )}
                      >
                        <div className="min-w-0">
                          <div className="text-[12px] font-semibold leading-[1.3] text-[var(--rom-weaver-color-text)] [overflow-wrap:anywhere] break-words">
                            {primaryLabel}
                          </div>
                          {detailLabel ? (
                            <div className="text-[10px] leading-[1.2] text-[var(--rom-weaver-color-muted)] [overflow-wrap:anywhere] break-words">
                              {detailLabel}
                            </div>
                          ) : null}
                        </div>
                      </td>
                      <td
                        className={cx(
                          "border border-x-0 border-[var(--rom-weaver-color-border)] px-2 py-1 text-right align-middle transition-[background-color,border-color] duration-100",
                          rowToneClass,
                        )}
                      >
                        <span className="whitespace-nowrap text-[11px] font-semibold tabular-nums text-[var(--rom-weaver-color-text-soft)]">
                          {metadata || "\u2014"}
                        </span>
                      </td>
                      <td
                        className={cx(
                          "rounded-r-[10px] border border-l-0 border-[var(--rom-weaver-color-border)] px-2 py-1 text-right align-middle transition-[background-color,border-color] duration-100",
                          rowToneClass,
                        )}
                      >
                        <button
                          className={cx(
                            "inline-flex h-[26px] min-w-[84px] items-center justify-center rounded-[999px] border px-2.5 text-[10px] font-bold uppercase tracking-[0.03em] transition-[background-color,border-color,color,box-shadow] duration-100",
                            candidate.selectable
                              ? "cursor-pointer border-[rgba(63,166,108,.45)] bg-[rgba(63,166,108,.18)] text-[oklch(0.43_0.09_160)] hover:border-[rgba(63,166,108,.7)] hover:bg-[rgba(63,166,108,.26)] focus-visible:shadow-[0_0_0_2px_var(--rom-weaver-color-primary-focus)]"
                              : "cursor-not-allowed border-[rgba(198,56,77,.35)] bg-[rgba(198,56,77,.14)] text-[var(--rom-weaver-color-danger)]",
                          )}
                          disabled={!candidate.selectable}
                          onClick={() => onSelect(candidate.id)}
                          title={primaryLabel}
                          type="button"
                        >
                          {buttonLabel}
                          <span className="sr-only"> {primaryLabel}</span>
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className={cx(dialogClasses.actions, "!mt-0 px-2 py-1")}>
            <button
              className={cx(buttonClasses.primary, buttonClasses.secondary, "!mt-0 !h-9 !w-auto !px-3")}
              onClick={onCancel}
              type="button"
            >
              Cancel
            </button>
          </div>
        </dialog>
      </div>
    </>
  );
}

const useCandidateSelection = ({ onCancelSelection }: UseCandidateSelectionOptions = {}) => {
  const [selectionState, setSelectionState] = useState<CandidateSelectionState | null>(null);
  const selectFile = useCallback(
    (request: CandidateSelectionPrompt) =>
      new Promise<CandidateSelectionChoice>((resolve, reject) => {
        setSelectionState({ reject, request, resolve });
      }),
    [],
  );
  const cancelSelection = useCallback(() => {
    setSelectionState((current) => {
      if (current) onCancelSelection?.(current.request);
      current?.reject(createSelectionSkippedError());
      return null;
    });
  }, [onCancelSelection]);
  const chooseCandidate = useCallback((id: string) => {
    setSelectionState((current) => {
      current?.resolve({ id });
      return null;
    });
  }, []);
  return {
    cancelSelection,
    candidateSelectionDialog: (
      <CandidateSelectionDialog onCancel={cancelSelection} onSelect={chooseCandidate} state={selectionState} />
    ),
    selectFile,
  };
};

export type { CandidateSelectionState };
export { CandidateSelectionDialog, useCandidateSelection };
