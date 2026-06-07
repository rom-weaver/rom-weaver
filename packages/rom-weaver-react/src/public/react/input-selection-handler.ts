import { useEffect, useRef } from "react";
import type { SelectionCandidate } from "../../types/selection.ts";
import { setInputSelectionHandler } from "../../workers/rom-weaver/rom-weaver-runner.ts";
import type { CandidateSelectionChoice, CandidateSelectionPrompt } from "./public-types.ts";

type SelectCandidateFile = (request: CandidateSelectionPrompt) => Promise<CandidateSelectionChoice>;

const parseHostSelectionRequest = (
  requestJson: string,
): { heading?: string; candidates?: Array<{ label?: string; value?: string; size?: number | null }> } | null => {
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
      if (!rawCandidates.length) return -1;
      const candidates = createHostSelectionCandidates(rawCandidates);
      try {
        const choice = await selectFileRef.current({
          candidates,
          role: "input",
          sourceName: String(parsed?.heading || "Select an entry"),
          warnings: [],
        });
        const selectedIndex = candidates.findIndex((candidate) => candidate.id === choice?.id);
        return selectedIndex >= 0 ? selectedIndex : -1;
      } catch {
        return -1;
      }
    });
    return () => setInputSelectionHandler(undefined);
  }, []);
};

export { useInputSelectionHandler };
