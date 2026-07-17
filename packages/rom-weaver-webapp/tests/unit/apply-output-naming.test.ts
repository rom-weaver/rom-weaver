import { describe, expect, it } from "vitest";
import {
  createApplyOutputState,
  recomputeApplyOutputState,
} from "../../src/lib/workflow/apply-output-state-machine.ts";
import type { ApplyWorkflowInputState, ApplyWorkflowResolvedInput } from "../../src/types/apply-workflow.ts";

// Pins the controller's automatic apply output-name derivation - the single source of truth the
// apply form reads from `snapshot.output`. The disc cases guard the multi-track behaviour the form
// used to special-case (`getDiscInputOutputFileName`): a disc's "primary" resolved file is a track
// (e.g. `track01.bin`), a poor output name, so the disc/archive/cue sheet name is used instead.

const makeInput = (overrides: Partial<ApplyWorkflowInputState> = {}): ApplyWorkflowInputState => ({
  candidates: [],
  id: "input-1",
  parentCompressions: [],
  status: "ready",
  warnings: [],
  ...overrides,
});

const makeResolved = (overrides: Partial<ApplyWorkflowResolvedInput> = {}): ApplyWorkflowResolvedInput => ({
  id: "resolved-1",
  parentCompressions: [],
  selected: true,
  ...overrides,
});

const autoOutputName = (input: ApplyWorkflowInputState, patchOutputNames: string[] = []): string => {
  const state = createApplyOutputState({});
  recomputeApplyOutputState(state, {}, { input, inputSession: undefined, patchOutputNames });
  return state.outputName;
};

describe("apply automatic output name", () => {
  it("uses the input stem for a plain ROM with no patches", () => {
    expect(autoOutputName(makeInput({ fileName: "game.gba" }))).toBe("game");
  });

  it("appends patch names to the input stem", () => {
    expect(autoOutputName(makeInput({ fileName: "game.gba" }), ["Hard Mode.ips"])).toBe("game - Hard Mode");
  });

  it("uses the .cue sheet name for a loose multi-track disc, not the primary track", () => {
    const input = makeInput({
      fileName: "track01.bin",
      resolvedInputs: [
        makeResolved({ fileName: "track01.bin", id: "t1", kind: "track" }),
        makeResolved({ fileName: "Great Game.cue", id: "cue", kind: "cue", selected: false }),
      ],
    });
    expect(autoOutputName(input)).toBe("Great Game");
  });

  it("uses the source archive name for an archived disc, not the primary track", () => {
    const input = makeInput({
      fileName: "track01.bin",
      parentCompressions: [{ depth: 0, fileName: "Great Game.zip", kind: "zip" }],
      resolvedInputs: [makeResolved({ fileName: "track01.bin", id: "t1", kind: "track" })],
    });
    expect(autoOutputName(input)).toBe("Great Game");
  });

  it("leaves the output name untouched when there is no input file", () => {
    const state = createApplyOutputState({});
    state.outputName = "preserved";
    recomputeApplyOutputState(state, {}, { input: null, inputSession: undefined, patchOutputNames: [] });
    expect(state.outputName).toBe("preserved");
  });
});
