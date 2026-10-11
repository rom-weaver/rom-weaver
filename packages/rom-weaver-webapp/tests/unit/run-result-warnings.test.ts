import { describe, expect, it } from "vitest";
import { getRunResultWarnings, type RomWeaverRunJsonResult } from "../../src/lib/runtime/run-result-parsing.ts";

const resultWith = (event: Record<string, unknown>) =>
  ({
    events: [{ status: "succeeded", ...event }],
    exitCode: 0,
    ok: true,
    stderr: "",
  }) as unknown as RomWeaverRunJsonResult;

describe("getRunResultWarnings", () => {
  it("returns nothing for a clean run or a run without events", () => {
    expect(getRunResultWarnings(resultWith({ details: {}, label: "applied IPS patch" }))).toEqual([]);
    expect(getRunResultWarnings({ events: [], exitCode: 0, ok: true, stderr: "" } as never)).toEqual([]);
  });

  it("reads details.warnings", () => {
    expect(
      getRunResultWarnings(resultWith({ details: { warnings: ["inputs are identical", 4, ""] }, label: "created" })),
    ).toEqual(["inputs are identical"]);
  });

  it("falls back to the handler `; warning=` label segments and stops at the next label key", () => {
    const label =
      "applied IPS patch; warning=did not change output; input may already be patched; warning=second; elapsed=3";
    expect(getRunResultWarnings(resultWith({ details: {}, label }))).toEqual([
      "did not change output; input may already be patched",
      "second",
    ]);
  });

  it("ignores the label when details.warnings is present", () => {
    expect(
      getRunResultWarnings(
        resultWith({
          details: { warnings: ["IPS patch did not change output"] },
          label: "applied IPS patch; warning=IPS patch did not change output; input header stripped (512 bytes, snes)",
        }),
      ),
    ).toEqual(["IPS patch did not change output"]);
  });

  it("cuts known CLI suffixes off label-only warnings", () => {
    const label =
      "applied IPS patch; warning=did not change output; input header stripped (512 bytes, snes); patch apply input source resolved via 1 container extract step(s)";
    expect(getRunResultWarnings(resultWith({ details: {}, label }))).toEqual(["did not change output"]);
  });

  it("does not repeat a warning present in both details and the label", () => {
    expect(
      getRunResultWarnings(resultWith({ details: { warnings: ["a warning"] }, label: "done; warning=a warning" })),
    ).toEqual(["a warning"]);
  });
});
