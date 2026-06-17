import { useCallback, useRef, useState } from "react";
import { createLogger } from "../../lib/logging.ts";
import { getCandidateDisplayItems } from "../../presentation/formatting/candidates.ts";
import { createBrowserLocalizer } from "../../presentation/localization/index.ts";
import { Modal } from "./components/ds/modal.tsx";
import { SelectionCheckList, type SelectionItem, SelectionTree } from "./components/ds/selection.tsx";
import type { CandidateSelectionChoice, CandidateSelectionPrompt } from "./public-types.ts";

const logger = createLogger("candidate-selection");

const countSelectable = (request: CandidateSelectionPrompt): number =>
  request.candidates.filter((candidate) => candidate.selectable).length;

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
  onSelectMany,
}: {
  state: CandidateSelectionState | null;
  onCancel: () => void;
  onSelect: (id: string) => void;
  onSelectMany: (ids: string[]) => void;
}) {
  if (!state) return null;
  const { request } = state;
  const localizer = createBrowserLocalizer();
  const displayItems = getCandidateDisplayItems(request, localizer);
  const selectableCount = displayItems.filter(({ candidate }) => candidate.selectable).length;
  const items: SelectionItem[] = displayItems.map(({ candidate, sizeLabel, warningLabel }) => {
    const primaryLabel = candidate.type === "file" ? candidate.fileName : candidate.label;
    // breadcrumbs are [archive, …folders/nested-archives, ] — the first segment is the
    // source archive (shown as a sub-heading), the rest is the folder path within it
    // (folded into the name so the entry reads "folder › patch").
    const breadcrumbs = (candidate.breadcrumbs || []).map((segment) => segment.trim()).filter(Boolean);
    const [archiveLabel, ...folderSegments] = breadcrumbs;
    const nameWithFolder = folderSegments.length ? `${folderSegments.join(" › ")} › ${primaryLabel}` : primaryLabel;
    return {
      id: candidate.id,
      name: nameWithFolder,
      note: warningLabel || undefined,
      selectable: candidate.selectable,
      sizeLabel: sizeLabel || undefined,
      subheading: archiveLabel || undefined,
    };
  });
  const multiSelect = !!request.multiSelect && selectableCount > 1;
  return (
    <Modal
      onClose={onCancel}
      open
      subtitle={
        selectableCount
          ? multiSelect
            ? "Multiple patches found, select one or more"
            : "Multiple candidates found, select one"
          : "No selectable files in this source"
      }
      title={request.sourceName}
      variant="select-modal"
    >
      {multiSelect ? (
        <SelectionCheckList
          items={items}
          onCancel={onCancel}
          onSubmit={onSelectMany}
          submitLabel={(count) => (count === 1 ? "Add 1 patch" : `Add ${count} patches`)}
        />
      ) : (
        <SelectionTree items={items} onSelect={onSelect} />
      )}
    </Modal>
  );
}

const useCandidateSelection = ({ onCancelSelection }: UseCandidateSelectionOptions = {}) => {
  const [selectionState, setSelectionState] = useState<CandidateSelectionState | null>(null);
  const selectionStateRef = useRef<CandidateSelectionState | null>(null);
  const selectFile = useCallback(
    (request: CandidateSelectionPrompt) =>
      new Promise<CandidateSelectionChoice>((resolve, reject) => {
        logger.trace("opening candidate selection dialog", {
          candidateCount: request.candidates.length,
          role: request.role,
          selectableCount: countSelectable(request),
          sourceName: request.sourceName,
        });
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
    if (!current) {
      logger.trace("candidate selection cancel ignored — no dialog open");
      return;
    }
    logger.trace("candidate selection dialog cancelled by user", {
      role: current.request.role,
      sourceName: current.request.sourceName,
    });
    onCancelSelection?.(current.request);
    current.reject(createSelectionSkippedError());
  }, [onCancelSelection]);
  const chooseCandidate = useCallback((id: string) => {
    const current = selectionStateRef.current;
    selectionStateRef.current = null;
    setSelectionState(null);
    logger.trace("candidate selection dialog resolved with choice", {
      id,
      role: current?.request.role,
      sourceName: current?.request.sourceName,
    });
    current?.resolve({ id });
  }, []);
  const chooseCandidates = useCallback((ids: string[]) => {
    const current = selectionStateRef.current;
    if (!ids.length) return;
    selectionStateRef.current = null;
    setSelectionState(null);
    logger.trace("candidate selection dialog resolved with multiple choices", {
      idCount: ids.length,
      ids,
      role: current?.request.role,
      sourceName: current?.request.sourceName,
    });
    current?.resolve({ id: ids[0] as string, ids });
  }, []);
  return {
    cancelSelection,
    candidateSelectionDialog: (
      <CandidateSelectionDialog
        onCancel={cancelSelection}
        onSelect={chooseCandidate}
        onSelectMany={chooseCandidates}
        state={selectionState}
      />
    ),
    selectFile,
  };
};

export { CandidateSelectionDialog, useCandidateSelection };
