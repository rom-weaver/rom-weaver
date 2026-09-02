import { describe, expect, it } from "vitest";
import {
  inheritSourceIdentificationPolicy,
  shouldIdentifySource,
  skipSourceIdentification,
} from "../../src/lib/input/input-identification-policy.ts";
import { createBlobBackedPatchFile } from "../../src/lib/input/binary-service.ts";

describe("input identification policy", () => {
  it("identifies normal sources", () => {
    expect(shouldIdentifySource(new Blob(["rom"]))).toBe(true);
  });

  it("carries a skipped policy into a derived bundle ROM", () => {
    const bundle = new Blob(["bundle"]);
    const rom = new Blob(["rom"]);

    skipSourceIdentification(bundle);
    inheritSourceIdentificationPolicy(bundle, rom);

    expect(shouldIdentifySource(rom)).toBe(false);
  });

  it("carries a skipped policy into a lazy input file", async () => {
    const source = new Blob(["archive"]);
    skipSourceIdentification(source);

    const file = await createBlobBackedPatchFile(source, "sample.zip", undefined, undefined, {
      materialize: false,
    });

    expect(shouldIdentifySource(file)).toBe(false);
  });
});
