import { useEffect, useRef } from "react";
import { createLogger } from "../../lib/logging.ts";
import { getPathBaseName } from "../../lib/path-utils.ts";
import type { SelectionCandidate } from "../../types/selection.ts";
import { setInputSelectionHandler } from "../../workers/rom-weaver/rom-weaver-runner.ts";
import type { CandidateSelectionChoice, CandidateSelectionPrompt } from "./public-types.ts";

const logger = createLogger("input-selection-handler");

const HEADING_BACKTICK_PATH_REGEX = /`([^`]+)`/;

/**
 * Host prompt headings are CLI sentences with the source path in backticks
 * (e.g. "extract input payload selection for `/work/a.7z` is ambiguous. …").
 * The dialog title should be just the file name; the dialog supplies its own
 * instruction subtitle.
 */
const getSelectionSourceName = (heading: string): string => {
  const backtickedPath = heading.match(HEADING_BACKTICK_PATH_REGEX)?.[1];
  if (!backtickedPath) return heading;
  return getPathBaseName(backtickedPath, heading);
};

type SelectCandidateFile = (request: CandidateSelectionPrompt) => Promise<CandidateSelectionChoice>;

const parseHostSelectionRequest = (
  requestJson: string,
): {
  heading?: string;
  mode?: string;
  candidates?: Array<{ label?: string; value?: string; size?: number | null }>;
} | null => {
  try {
    const parsed = JSON.parse(requestJson);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
};

const createHostSelectionCandidates = (
  rawCandidates: Array<{ label?: string; value?: string; size?: number | null }>,
): SelectionCandidate[] =>
  rawCandidates.map((candidate, index) => ({
    fileName: String(candidate?.label || candidate?.value || `Entry ${index + 1}`),
    id: String(index),
    kind: "rom",
    patchable: true,
    selectable: true,
    ...(typeof candidate?.size === "number" && Number.isFinite(candidate.size) ? { size: candidate.size } : {}),
    type: "file",
  }));

/**
 * All three workflow forms stay mounted at once (webapp-root keeps every visited
 * tab alive), so a single module-global handler was last-mounted-wins: mid-command
 * prompts routed to whichever form mounted last, and cancelling that dialog
 * destroyed the wrong form's staged state. Instead each form registers its
 * `selectFile` under a stable id and the one installed host handler routes each
 * prompt to the active form (the visible tab set via `setActiveSelectionForm`),
 * falling back to the sole/last registered handler for single-form library embeds
 * that never publish an active form.
 */
const selectionHandlers = new Map<string, SelectCandidateFile>();
let activeSelectionFormId: string | undefined;
let hostHandlerInstalled = false;

const resolveActiveSelectFile = (): SelectCandidateFile | undefined => {
  if (activeSelectionFormId) {
    const active = selectionHandlers.get(activeSelectionFormId);
    if (active) return active;
  }
  // ponytail: fallback to the last-registered handler (Map preserves insertion
  // order) for single-form embeds that never call setActiveSelectionForm.
  let fallback: SelectCandidateFile | undefined;
  for (const handler of selectionHandlers.values()) fallback = handler;
  return fallback;
};

/** Route subsequent host selection prompts to the given form id (the visible tab). */
const setActiveSelectionForm = (formId: string | undefined) => {
  if (activeSelectionFormId === formId) return;
  logger.trace("active selection form changed", { formId: formId ?? null });
  activeSelectionFormId = formId;
};

const installHostSelectionHandler = () => {
  if (hostHandlerInstalled) return;
  hostHandlerInstalled = true;
  setInputSelectionHandler(async (requestJson) => {
    const parsed = parseHostSelectionRequest(requestJson);
    const rawCandidates = Array.isArray(parsed?.candidates) ? parsed.candidates : [];
    const heading = String(parsed?.heading || "Select an entry");
    const multiSelect = parsed?.mode === "many";
    if (!rawCandidates.length) {
      logger.trace("selection prompt skipped - no candidates in request", { heading, multiSelect });
      return [];
    }
    const selectFile = resolveActiveSelectFile();
    if (!selectFile) {
      logger.trace("selection prompt has no registered form handler - cancelling", { heading, multiSelect });
      return [];
    }
    const candidates = createHostSelectionCandidates(rawCandidates);
    const sourceName = getSelectionSourceName(heading);
    const indexOfId = (id: string | undefined): number => candidates.findIndex((candidate) => candidate.id === id);
    logger.trace("prompting user to select entries to extract", {
      activeFormId: activeSelectionFormId ?? null,
      candidateCount: candidates.length,
      heading,
      multiSelect,
      sourceName,
    });
    try {
      const choice = await selectFile({
        candidates,
        multiSelect,
        role: "input",
        sourceName,
        warnings: [],
      });
      // Multi-select choices carry the full ordered set in `ids`; single-select uses `id`.
      const chosenIds = multiSelect && Array.isArray(choice?.ids) ? choice.ids : [choice?.id];
      const selectedIndexes = chosenIds.map((id) => indexOfId(id)).filter((index) => index >= 0);
      if (!selectedIndexes.length) {
        logger.trace("user dismissed selection prompt without a valid choice - cancelling", {
          choiceId: choice?.id ?? null,
          heading,
          multiSelect,
        });
        return [];
      }
      logger.trace("user selected entries to extract", {
        heading,
        multiSelect,
        selectedCount: selectedIndexes.length,
        selectedIndexes,
      });
      return selectedIndexes;
    } catch (error) {
      logger.trace("selection prompt rejected - cancelling", {
        error: error instanceof Error ? error.message : String(error),
        heading,
        multiSelect,
      });
      return [];
    }
  });
};

const useInputSelectionHandler = (formId: string, selectFile: SelectCandidateFile) => {
  const selectFileRef = useRef(selectFile);
  selectFileRef.current = selectFile;

  useEffect(() => {
    installHostSelectionHandler();
    // A stable indirection so per-render selectFile identity changes don't thrash
    // the registry; the latest selectFile is read via the ref at prompt time.
    const handler: SelectCandidateFile = (request) => selectFileRef.current(request);
    selectionHandlers.set(formId, handler);
    logger.trace("registered form selection handler", { formId });
    return () => {
      // Only deregister our own entry - never clobber a handler a remount of the
      // same id installed after us.
      if (selectionHandlers.get(formId) === handler) {
        selectionHandlers.delete(formId);
        logger.trace("deregistered form selection handler", { formId });
      }
    };
  }, [formId]);
};

export { setActiveSelectionForm, useInputSelectionHandler };
