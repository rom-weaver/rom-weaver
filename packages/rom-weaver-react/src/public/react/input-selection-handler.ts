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

const useInputSelectionHandler = (selectFile: SelectCandidateFile) => {
  const selectFileRef = useRef(selectFile);
  selectFileRef.current = selectFile;

  useEffect(() => {
    setInputSelectionHandler(async (requestJson) => {
      const parsed = parseHostSelectionRequest(requestJson);
      const rawCandidates = Array.isArray(parsed?.candidates) ? parsed.candidates : [];
      const heading = String(parsed?.heading || "Select an entry");
      const multiSelect = parsed?.mode === "many";
      if (!rawCandidates.length) {
        logger.trace("selection prompt skipped — no candidates in request", { heading, multiSelect });
        return [];
      }
      const candidates = createHostSelectionCandidates(rawCandidates);
      const sourceName = getSelectionSourceName(heading);
      const indexOfId = (id: string | undefined): number => candidates.findIndex((candidate) => candidate.id === id);
      logger.trace("prompting user to select entries to extract", {
        candidateCount: candidates.length,
        heading,
        multiSelect,
        sourceName,
      });
      try {
        const choice = await selectFileRef.current({
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
          logger.trace("user dismissed selection prompt without a valid choice — cancelling", {
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
        logger.trace("selection prompt rejected — cancelling", {
          error: error instanceof Error ? error.message : String(error),
          heading,
          multiSelect,
        });
        return [];
      }
    });
    return () => setInputSelectionHandler(undefined);
  }, []);
};

export { useInputSelectionHandler };
