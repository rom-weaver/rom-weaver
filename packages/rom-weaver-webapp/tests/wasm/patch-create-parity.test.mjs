import { describe, expect, it } from "vitest";
import { PATCH_CREATE_PARITY_CASES, PATCH_CREATE_PARITY_FORMATS } from "./patch-create-parity-inputs.mjs";
import {
  assertRunJsonSucceeded,
  joinGuestPath,
  readGuestFile,
  withTempFixture,
  writeGuestFile,
} from "./test-helpers.mjs";

// Expected size and SHA-256 come from the native CLI (`patch create --format <fmt>`);
// regenerate with scripts/generate-patch-create-parity.mjs.
const EXPECTED_URL = new URL("../fixtures/patch-create-parity/expected.json", import.meta.url);

async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("wasm patch create matches the native CLI byte for byte", () => {
  it.each(PATCH_CREATE_PARITY_FORMATS)("%s", async (caseName) => {
    const expected = (await (await fetch(EXPECTED_URL)).json())[caseName];
    expect(expected, `no CLI fixture for ${caseName}`).toBeDefined();
    const inputs = PATCH_CREATE_PARITY_CASES[caseName];
    const format = inputs.format ?? caseName;

    await withTempFixture(async ({ dir, opfsHandle, worker }) => {
      const original = joinGuestPath(dir, "original.bin");
      const modified = joinGuestPath(dir, "modified.bin");
      const output = joinGuestPath(dir, `patch.${format}`);
      await writeGuestFile(opfsHandle, original, inputs.original);
      if (inputs.dldiSeed) {
        const seed = joinGuestPath(dir, "seed.dldi");
        await writeGuestFile(opfsHandle, seed, inputs.dldiSeed);
        assertRunJsonSucceeded(
          await worker.runJson([
            "patch",
            "apply",
            "--input",
            original,
            "--patch",
            seed,
            "--output",
            modified,
            "--no-compress",
            "--threads",
            "1",
          ]),
          { command: "patch-apply" },
        );
      } else {
        await writeGuestFile(opfsHandle, modified, inputs.modified);
      }
      assertRunJsonSucceeded(
        await worker.runJson([
          "patch",
          "create",
          "--original",
          original,
          "--modified",
          modified,
          "--format",
          format,
          "--output",
          output,
          "--threads",
          "1",
        ]),
        { command: "patch-create" },
      );
      const patch = await readGuestFile(opfsHandle, output);
      expect(patch.length).toBe(expected.bytes);
      expect(await sha256Hex(patch)).toBe(expected.sha256);
    });
  });
});
