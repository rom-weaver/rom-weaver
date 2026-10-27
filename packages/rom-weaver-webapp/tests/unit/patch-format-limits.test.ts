import { describe, expect, it } from "vitest";
import {
  CREATE_IPS_SIZE_LIMIT_BYTES,
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
