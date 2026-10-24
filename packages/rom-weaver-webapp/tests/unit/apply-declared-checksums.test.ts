import { describe, expect, it } from "vitest";
import { getWeaveVerificationError } from "../../src/public/react/apply-declared-checksums.ts";
import type { PatchStackItemState } from "../../src/public/react/patcher-presentation.ts";
import type { useUiLocalizer } from "../../src/public/react/settings-context.tsx";

const localizer = {
  message: (id: string, values?: Record<string, string | number>) => `${id}:${values?.algorithm}`,
} as unknown as ReturnType<typeof useUiLocalizer>;

const verify = (checksums: Record<string, string>, patch?: Partial<PatchStackItemState>) =>
  getWeaveVerificationError(
    [{ inputChecks: { checksums } }],
    [{ validationValues: [], ...patch } as unknown as PatchStackItemState],
    localizer,
  );

describe("declared checksum shape", () => {
  it.each([
    ["crc32", 8],
    ["md5", 32],
    ["sha1", 40],
    ["sha256", 64],
    ["blake3", 64],
    ["crc32c", 8],
    ["crc16", 4],
    ["adler32", 8],
  ])("accepts a well-formed %s", (algorithm, length) => {
    expect(verify({ [algorithm]: "a".repeat(length) })).toBe("");
  });

  it("accepts an uppercase SHA-256 value", () => {
    expect(verify({ sha256: "AB".repeat(32) })).toBe("");
  });

  it.each([
    ["wrong length", "a".repeat(63)],
    ["non-hex characters", `${"a".repeat(63)}g`],
    ["a prefix", `sha256:${"a".repeat(64)}`],
  ])("still reports a sha256 with %s as malformed", (_label, value) => {
    expect(verify({ sha256: value })).toBe("ui.apply.validation.malformedChecksum:SHA256");
  });

  it("still reports an unknown algorithm as malformed", () => {
    expect(verify({ sha999: "a".repeat(64) })).toBe("ui.apply.validation.malformedChecksum:SHA999");
  });

  it("compares a sha256 against the patch's own embedded row", () => {
    const patch = { validationValues: [`in sha-256=${"b".repeat(64)}`] };
    expect(verify({ sha256: "a".repeat(64) }, patch)).toBe("ui.apply.validation.conflictingChecksum:SHA256");
    expect(verify({ sha256: "b".repeat(64) }, patch)).toBe("");
  });
});
