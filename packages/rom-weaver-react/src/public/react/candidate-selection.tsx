import X from "lucide-react/dist/esm/icons/x.js";
import { useCallback, useRef, useState } from "react";
import { getCandidateDisplayItems } from "../../presentation/formatting/candidates.ts";
import { createBrowserLocalizer } from "../../presentation/localization/index.ts";
import type { CandidateSelectionChoice, CandidateSelectionPrompt } from "./public-types.ts";
import { buttonClasses, cx, dialogClasses, settingsClasses } from "./tailwind-classes";

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
          className="static m-0 box-border min-w-0 w-fit max-w-[min(1040px,calc(100vw-8px))] max-h-[calc(100vh-8px)] overflow-hidden rounded-[14px] border border-[var(--rom-weaver-color-border)] bg-[var(--rom-weaver-color-surface)] p-0 align-middle text-left text-[var(--rom-weaver-color-text-soft)] shadow-[0_24px_44px_-22px_rgba(0,0,0,.65)]"
          data-testid="candidate-selection-dialog"
          id="rom-weaver-candidate-selection-dialog"
          onCancel={(event) => {
            event.preventDefault();
            onCancel();
          }}
          open
        >
          <div className="relative px-3 pt-2.5 pb-1.5 pr-[3rem]">
            <button
              aria-label="Close selection dialog"
              className={cx(
                buttonClasses.primary,
                settingsClasses.actionButton,
                settingsClasses.actionDanger,
                "absolute right-2.5 top-2.5",
              )}
              onClick={onCancel}
              title="Close"
              type="button"
            >
              <X aria-hidden="true" className={settingsClasses.actionIcon} />
            </button>
            <div
              className="m-0 text-left text-[18px] font-bold leading-[1.25] text-[var(--rom-weaver-color-text)]"
              id="rom-weaver-candidate-selection-message"
            >
              {request.sourceName}
            </div>
            <div className="mt-px text-[11px] leading-[1.15] text-[var(--rom-weaver-color-muted)]">
              {selectableCount
                ? "Select one file from the table below."
                : "No selectable files are available in this source."}
            </div>
          </div>
          <div className="max-h-[min(580px,calc(100vh-120px))] overflow-y-auto px-3 pt-1.5 pb-2">
            <table
              aria-label="Candidate selection table"
              className="max-w-full table-auto border-separate border-spacing-x-0 border-spacing-y-0"
              id="rom-weaver-candidate-selection-table"
            >
              <colgroup>
                <col />
                <col className="w-[8.25rem]" />
              </colgroup>
              <thead>
                <tr className="text-[10px] font-bold uppercase tracking-[0.04em] text-[var(--rom-weaver-color-muted)]">
                  <th className="px-2 pb-0.5 text-left" scope="col">
                    File
                  </th>
                  <th className="px-1 pb-0.5 text-left" scope="col">
                    Size
                  </th>
                </tr>
              </thead>
              <tbody id="rom-weaver-candidate-selection-list">
                {displayItems.map(({ candidate, sizeLabel, warningLabel }) => {
                  const primaryLabel = candidate.type === "file" ? candidate.fileName : candidate.label;
                  const breadcrumbLabel = candidate.breadcrumbs?.join(" > ") || "";
                  const uniqueBreadcrumbLabel =
                    breadcrumbLabel.trim() && breadcrumbLabel.trim() !== primaryLabel.trim() ? breadcrumbLabel : "";
                  const detailLabel = [uniqueBreadcrumbLabel, warningLabel].filter(Boolean).join(" • ");
                  const rowToneClass = candidate.selectable
                    ? "bg-[var(--rom-weaver-color-surface)] group-hover:bg-[var(--rom-weaver-color-surface-muted)] group-hover:border-[var(--rom-weaver-color-border-strong)] group-focus-within:bg-[var(--rom-weaver-color-surface-muted)] group-focus-within:border-[var(--rom-weaver-color-border-strong)]"
                    : "bg-[var(--rom-weaver-color-surface)] opacity-[.62]";
                  return (
                    <tr
                      className={candidate.selectable ? "group cursor-pointer" : "group"}
                      key={candidate.id}
                      onKeyDown={
                        candidate.selectable
                          ? (event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                onSelect(candidate.id);
                              }
                            }
                          : undefined
                      }
                      onClick={candidate.selectable ? () => onSelect(candidate.id) : undefined}
                      role={candidate.selectable ? "button" : undefined}
                      tabIndex={candidate.selectable ? 0 : undefined}
                    >
                      <td
                        className={cx(
                          "rounded-l-[10px] border border-r-0 border-[var(--rom-weaver-color-border)] px-2 py-1 align-top transition-[background-color,border-color] duration-100",
                          rowToneClass,
                        )}
                      >
                        <div className="min-w-0">
                          <div className="min-w-0 text-[12px] font-semibold leading-[1.3] text-[var(--rom-weaver-color-text)]">
                            <span className="[overflow-wrap:anywhere] break-words">{primaryLabel}</span>
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
                          "rounded-r-[10px] border border-l-0 border-[var(--rom-weaver-color-border)] px-1 py-1 align-middle text-left transition-[background-color,border-color] duration-100",
                          rowToneClass,
                        )}
                      >
                        <span className="block whitespace-nowrap text-[11px] leading-[1.2] font-semibold tabular-nums text-[var(--rom-weaver-color-text-soft)]">
                          {sizeLabel || "—"}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </dialog>
      </div>
    </>
  );
}

const useCandidateSelection = ({ onCancelSelection }: UseCandidateSelectionOptions = {}) => {
  const [selectionState, setSelectionState] = useState<CandidateSelectionState | null>(null);
  const selectionStateRef = useRef<CandidateSelectionState | null>(null);
  const selectFile = useCallback(
    (request: CandidateSelectionPrompt) =>
      new Promise<CandidateSelectionChoice>((resolve, reject) => {
        const nextState = { reject, request, resolve };
        selectionStateRef.current = nextState;
        setSelectionState(nextState);
      }),
    [],
  );
  const cancelSelection = useCallback(() => {
    const current = selectionStateRef.current;
    selectionStateRef.current = null;
    setSelectionState(null);
    if (!current) return;
    onCancelSelection?.(current.request);
    current.reject(createSelectionSkippedError());
  }, [onCancelSelection]);
  const chooseCandidate = useCallback((id: string) => {
    const current = selectionStateRef.current;
    selectionStateRef.current = null;
    setSelectionState(null);
    current?.resolve({ id });
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
