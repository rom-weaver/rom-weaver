import { describe, expect, it } from "vitest";
import {
  CREATE_BPS_DEFAULT_LIMIT_BYTES,
  CREATE_BPS_MAX_COMBINED_INPUT_BYTES,
  CREATE_IPS_SIZE_LIMIT_BYTES,
  getCreatePatchFormatsForSizes,
  getPreferredCreatePatchFormat,
  getSelectableCreatePatchFormats,
} from "../../src/lib/create/patch-format-limits.ts";

describe("prepared Create input sizes", () => {
  it.each([
    CREATE_IPS_SIZE_LIMIT_BYTES - 1,
    CREATE_IPS_SIZE_LIMIT_BYTES,
    CREATE_IPS_SIZE_LIMIT_BYTES + 1,
    64 * 1024 * 1024 + 1,
  ])("offers the same formats for raw and archived %i-byte ROMs", (size) => {
    const rawFormats = getSelectableCreatePatchFormats({ originalSize: size, modifiedSize: size });
    const archiveFormats = getSelectableCreatePatchFormats({
      candidateFormats: getSelectableCreatePatchFormats({ originalSize: 1024, modifiedSize: 1024 }),
      originalSize: size,
      modifiedSize: size,
    });
    expect(archiveFormats).toEqual(rawFormats);
  });

  it.each(["originalSize", "modifiedSize"] as const)("rejects an IPS recommendation when %s is too large", (role) => {
    const options = {
      candidateDefaultFormat: "ips",
      candidateFormats: ["ips", "ebp", "bps", "xdelta"],
      originalSize: 1024,
      modifiedSize: 1024,
      [role]: CREATE_IPS_SIZE_LIMIT_BYTES,
      requestedFormat: "ips",
    };
    expect(getPreferredCreatePatchFormat(options)).toBe("bps");
    expect(getSelectableCreatePatchFormats(options)).toEqual(["bps", "xdelta"]);
  });
});

describe("BPS create memory cap", () => {
  const cap = CREATE_BPS_MAX_COMBINED_INPUT_BYTES;

  it("matches the Rust estimate: 1 GiB budget at 5 bytes per input byte", () => {
    expect(cap).toBe(Math.floor((1024 ** 3 - 4) / 5));
  });

  it.each([
    [cap, 0],
    [0, cap],
    [Math.floor(cap / 2), cap - Math.floor(cap / 2)],
    [CREATE_BPS_DEFAULT_LIMIT_BYTES, cap - CREATE_BPS_DEFAULT_LIMIT_BYTES],
  ])("offers BPS when the pair totals at most the cap (%i + %i)", (originalSize, modifiedSize) => {
    expect(getCreatePatchFormatsForSizes(originalSize, modifiedSize)).toContain("bps");
  });

  it.each([
    [cap + 1, 0],
    [0, cap + 1],
    [Math.floor(cap / 2) + 1, cap - Math.floor(cap / 2)],
    [CREATE_BPS_DEFAULT_LIMIT_BYTES, cap - CREATE_BPS_DEFAULT_LIMIT_BYTES + 1],
    [130 * 1024 * 1024, 130 * 1024 * 1024],
  ])("drops BPS and keeps xdelta when the pair totals above the cap (%i + %i)", (originalSize, modifiedSize) => {
    const formats = getCreatePatchFormatsForSizes(originalSize, modifiedSize);
    expect(formats).not.toContain("bps");
    expect(formats).toContain("xdelta");
    expect(getSelectableCreatePatchFormats({ originalSize, modifiedSize })).not.toContain("bps");
  });

  it("prefers xdelta over a requested or planned BPS above the cap", () => {
    const sizes = { originalSize: cap, modifiedSize: cap };
    expect(getPreferredCreatePatchFormat({ ...sizes, requestedFormat: "bps" })).toBe("xdelta");
    expect(
      getPreferredCreatePatchFormat({
        ...sizes,
        candidateDefaultFormat: "bps",
        candidateFormats: ["bps", "xdelta"],
        automaticFormatSelection: false,
        requestedFormat: "bps",
      }),
    ).toBe("xdelta");
  });

  it("measures the BPS pair with a separate cap size while other limits keep the modified size", () => {
    const mib = 1024 * 1024;
    const sizes = { originalSize: 120 * mib, modifiedSize: 120 * mib };
    expect(getSelectableCreatePatchFormats(sizes)).not.toContain("bps");
    expect(getSelectableCreatePatchFormats({ ...sizes, bpsCapModifiedSize: 60 * mib })).toContain("bps");
    expect(getSelectableCreatePatchFormats({ ...sizes, bpsCapModifiedSize: 100 * mib })).not.toContain("bps");
    expect(getPreferredCreatePatchFormat({ ...sizes, bpsCapModifiedSize: 60 * mib, requestedFormat: "bps" })).toBe(
      "bps",
    );
  });
});
