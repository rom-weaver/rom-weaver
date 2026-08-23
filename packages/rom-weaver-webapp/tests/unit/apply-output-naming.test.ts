import { describe, expect, it } from "vitest";
import {
  createApplyOutputState,
  recomputeApplyOutputState,
} from "../../src/lib/workflow/apply-output-state-machine.ts";
import { resolvePatchOutputName } from "../../src/lib/workflow/apply-patch-output-naming.ts";
import type { ApplyWorkflowInputState, ApplyWorkflowResolvedInput } from "../../src/types/apply-workflow.ts";
import type { ParsedIdentifyResolution } from "../../src/types/identify.ts";
import type { ApplySettings } from "../../src/types/settings.ts";

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

const autoOutputName = (
  input: ApplyWorkflowInputState,
  patchOutputNames: string[] = [],
  settings: Partial<ApplySettings> = {},
): string => {
  const state = createApplyOutputState(settings);
  recomputeApplyOutputState(state, settings, { input, inputSession: undefined, patchOutputNames });
  return state.outputName;
};

const identified = (status: ParsedIdentifyResolution["status"], ...names: string[]): ParsedIdentifyResolution => ({
  matches: names.map((name) => ({
    algorithm: "crc32",
    database: "No-Intro",
    name,
    platform: "Nintendo Game Boy Advance",
    variant: "raw",
  })),
  status,
});

describe("apply automatic output name", () => {
  it("uses the input stem for a plain ROM with no patches", () => {
    expect(autoOutputName(makeInput({ fileName: "game.gba" }))).toBe("game");
  });

  it("appends patch names to the input stem", () => {
    expect(autoOutputName(makeInput({ fileName: "game.gba" }), ["Hard Mode.ips"])).toBe("game [Hard Mode]");
  });

  it("uses a generated metadata label before the patch filename", () => {
    expect(
      resolvePatchOutputName(
        {
          source: { _generatedPatchName: "[Hard Mode Jane Doe 1.2]" },
          state: {
            candidates: [
              { fileName: "hard-mode.ips", id: "patch-file", kind: "patch", selectable: true, type: "file" },
            ],
            selectedCandidateId: "patch-file",
          },
        } as never,
        0,
      ),
    ).toBe("[Hard Mode Jane Doe 1.2]");
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

describe("apply automatic output name from the identified title", () => {
  const input = makeInput({
    fileName: "rom_final_v2.gba",
    identification: identified("matched", "Pokemon - Emerald Version (UE) [!]"),
  });

  it("names the output after the title by default", () => {
    expect(autoOutputName(input)).toBe("Pokemon - Emerald Version (USA, Europe)");
  });

  it("keeps the patch labels after the title", () => {
    expect(autoOutputName(input, ["Randomizer v3"])).toBe("Pokemon - Emerald Version (USA, Europe) [Randomizer v3]");
  });

  it("falls back to the file stem when the setting is off", () => {
    expect(autoOutputName(input, [], { output: { identifiedName: false } })).toBe("rom_final_v2");
  });

  it("leaves the file stem alone for two loose ROMs, which have no single title", () => {
    expect(
      autoOutputName(
        makeInput({
          fileName: "rom_final_v2.gba",
          identification: identified("matched", "Pokemon - Emerald Version (UE) [!]"),
          resolvedInputs: [makeResolved({ id: "a", kind: "rom" }), makeResolved({ id: "b", kind: "rom" })],
        }),
      ),
    ).toBe("rom_final_v2");
  });

  it("names a multi-track disc after its title - the tracks are one logical ROM", () => {
    expect(
      autoOutputName(
        makeInput({
          fileName: "disc.cue",
          identification: identified("matched", "Some Game (U) [!]"),
          resolvedInputs: [
            makeResolved({ groupId: "disc-1", id: "t1", kind: "track" }),
            makeResolved({ groupId: "disc-1", id: "t2", kind: "track" }),
            makeResolved({ id: "sheet", kind: "cue" }),
          ],
        }),
      ),
    ).toBe("Some Game (USA)");
  });

  it("falls back to the file stem without one confident title", () => {
    expect(autoOutputName(makeInput({ fileName: "rom_final_v2.gba", identification: identified("unknown") }))).toBe(
      "rom_final_v2",
    );
  });
});
