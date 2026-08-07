import { describe, expect, it } from "vitest";
import { getCompressionCodecLevelMax } from "../../src/lib/compression/codec-fields.ts";
import type { SettingsDraft, StorageLike } from "../../src/webapp/settings/settings-metadata.ts";
import {
  getSettingsFieldId,
  LOCAL_STORAGE_SETTINGS_ID,
  SETTINGS_FIELD_METADATA,
  SETTINGS_FIELD_ORDER,
} from "../../src/webapp/settings/settings-metadata.ts";
import {
  getDefaultSettings,
  loadSettings,
  SETTINGS_STORAGE_VERSION,
  serializeSettingsForStorage,
  validateSettingsDraft,
} from "../../src/webapp/settings/settings-schema.ts";

// A complete draft built from the real defaults so each invalid-branch test can mutate a
// single field in isolation; the unmodified draft must validate with zero messages.
const validDraft = (overrides: Record<string, unknown> = {}): SettingsDraft =>
  ({ ...getDefaultSettings(), ...overrides }) as SettingsDraft;

type StubStorage = StorageLike & { removedKeys: string[]; setValue: (value: string | null) => void };

const makeStorage = (initial?: string | null): StubStorage => {
  let value = initial ?? null;
  const removedKeys: string[] = [];
  return {
    getItem: () => value,
    removedKeys,
    removeItem: (key: string) => {
      removedKeys.push(key);
      value = null;
    },
    setValue: (next: string | null) => {
      value = next;
    },
  };
};

describe("getDefaultSettings", () => {
  it("returns every field in SETTINGS_FIELD_ORDER with the documented defaults", () => {
    const settings = getDefaultSettings();
    expect(SETTINGS_STORAGE_VERSION).toBe(6);
    expect(Object.keys(settings).sort()).toEqual([...SETTINGS_FIELD_ORDER].sort());
    expect(settings.defaultCompression).toBe("zip/special");
    expect(settings.compressionProfile).toBe("max");
    expect(settings.rvzBlockSize).toBe(131072);
    expect(settings.rvzCodec).toBe("zstd");
    expect(settings.sevenZipCodec).toBe("lzma2");
    expect(settings.zipCodec).toBe("deflate");
    expect(settings.chdCreateCdCodecs).toBe("cdlz,cdzl,cdfl");
    expect(settings.fixChecksum).toBe(false);
    expect(settings.bundlePackage).toBe("");
    expect(settings.postApplyRomBehavior).toBe("auto-download");
    expect(settings.requireInputChecksumMatch).toBe(true);
    expect(settings.betaToolsEnabled).toBe(false);
    expect(settings.threads).toBe("auto");
  });

  it("places post-apply behavior after the bundle output setting", () => {
    const field = SETTINGS_FIELD_METADATA.postApplyRomBehavior;
    expect(field.kind).toBe("select");
    expect(field.options?.map((option) => option.value)).toEqual([
      "auto-download",
      "auto-test",
      "auto-test-download",
      "none",
    ]);
    expect(SETTINGS_FIELD_ORDER.indexOf("postApplyRomBehavior")).toBeGreaterThan(
      SETTINGS_FIELD_ORDER.indexOf("bundlePackage"),
    );
  });

  it("returns a fresh object each call (no shared mutable defaults)", () => {
    const a = getDefaultSettings();
    const b = getDefaultSettings();
    expect(a).not.toBe(b);
    a.fixChecksum = true;
    expect(b.fixChecksum).toBe(false);
  });
});

describe("validateSettingsDraft", () => {
  it("accepts an all-defaults draft with no messages or invalid fields", () => {
    const result = validateSettingsDraft(validDraft());
    expect(result.messages).toEqual([]);
    expect(result.invalidFields).toEqual([]);
  });

  it("normalizes a valid choice value case-insensitively without flagging it", () => {
    const result = validateSettingsDraft(validDraft({ language: "DE" }));
    expect(result.settings.language).toBe("de");
    expect(result.invalidFields).not.toContain(getSettingsFieldId("language"));
  });

  it("accepts a bundle package default", () => {
    const result = validateSettingsDraft(validDraft({ bundlePackage: "ZIP:ROM" }));
    expect(result.settings.bundlePackage).toBe("zip:rom");
    expect(result.invalidFields).not.toContain(getSettingsFieldId("bundlePackage"));
  });

  it.each(["none", "auto-download", "auto-test", "auto-test-download"] as const)(
    "accepts post-apply behavior %s",
    (postApplyRomBehavior) => {
      const result = validateSettingsDraft(validDraft({ postApplyRomBehavior }));
      expect(result.settings.postApplyRomBehavior).toBe(postApplyRomBehavior);
      expect(result.invalidFields).not.toContain(getSettingsFieldId("postApplyRomBehavior"));
    },
  );

  it("rejects an unknown post-apply behavior", () => {
    const result = validateSettingsDraft(validDraft({ postApplyRomBehavior: "open-in-new-window" }));
    expect(result.invalidFields).toContain(getSettingsFieldId("postApplyRomBehavior"));
    expect(result.settings.postApplyRomBehavior).toBe("auto-download");
  });

  it("flags an out-of-range choice value and falls back to the first valid value", () => {
    const result = validateSettingsDraft(validDraft({ defaultCompression: "totally-bogus" }));
    expect(result.invalidFields).toContain(getSettingsFieldId("defaultCompression"));
    expect(result.messages.length).toBeGreaterThan(0);
    // first valid value for defaultCompression is "7z/special"
    expect(result.settings.defaultCompression).toBe("7z/special");
  });

  it("flags an unknown codec on an enabled codec field", () => {
    const result = validateSettingsDraft(validDraft({ rvzCodec: "not-a-real-codec" }));
    expect(result.invalidFields).toContain(getSettingsFieldId("rvzCodec"));
    expect(result.messages.length).toBeGreaterThan(0);
  });

  it("accepts an in-range codec level but rejects one above the codec max", () => {
    const rvzMax = getCompressionCodecLevelMax("rvzCodec", "zstd");
    expect(typeof rvzMax).toBe("number");
    const max = rvzMax as number;

    const inRange = validateSettingsDraft(validDraft({ rvzCodec: `zstd:${max}` }));
    expect(inRange.invalidFields).not.toContain(getSettingsFieldId("rvzCodec"));

    const outOfRange = validateSettingsDraft(validDraft({ rvzCodec: `zstd:${max + 1}` }));
    expect(outOfRange.invalidFields).toContain(getSettingsFieldId("rvzCodec"));
    expect(outOfRange.messages.length).toBeGreaterThan(0);
  });

  it("flags a below-minimum integer field (rvzBlockSize)", () => {
    const result = validateSettingsDraft(validDraft({ rvzBlockSize: "0" }));
    expect(result.invalidFields).toContain(getSettingsFieldId("rvzBlockSize"));
    expect(result.messages.length).toBeGreaterThan(0);
  });

  it("keeps `auto` worker threads and never flags them", () => {
    const result = validateSettingsDraft(validDraft({ threads: "auto" }));
    expect(result.settings.threads).toBe("auto");
    expect(result.invalidFields).not.toContain(getSettingsFieldId("threads"));
  });

  it("flags an out-of-range worker thread count and retains the current value", () => {
    const result = validateSettingsDraft(validDraft({ threads: "999" }));
    expect(result.invalidFields).toContain(getSettingsFieldId("threads"));
    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.settings.threads).toBe("auto");
  });

  it("treats only an explicit false as opting out of checksum-match requirements", () => {
    const enabled = validateSettingsDraft(validDraft({ requireInputChecksumMatch: true }));
    expect(enabled.settings.requireInputChecksumMatch).toBe(true);

    const disabled = validateSettingsDraft(validDraft({ requireInputChecksumMatch: false }));
    expect(disabled.settings.requireInputChecksumMatch).toBe(false);
  });
});

describe("serializeSettingsForStorage", () => {
  it("returns null when settings equal the defaults", () => {
    expect(serializeSettingsForStorage(getDefaultSettings())).toBeNull();
    expect(serializeSettingsForStorage(null)).toBeNull();
  });

  it("serializes a changed boolean field under apply.patch with the storage version", () => {
    const settings = { ...getDefaultSettings(), fixChecksum: true };
    const json = serializeSettingsForStorage(settings);
    expect(typeof json).toBe("string");
    const parsed = JSON.parse(json as string);
    expect(parsed.version).toBe(SETTINGS_STORAGE_VERSION);
    expect(parsed.apply.patch.fixChecksum).toBe(true);
  });

  it("serializes a changed common choice field under common", () => {
    const settings = { ...getDefaultSettings(), language: "de" };
    const json = serializeSettingsForStorage(settings);
    const parsed = JSON.parse(json as string);
    expect(parsed.common.language).toBe("de");
  });

  it("serializes and loads the beta tools setting under common", () => {
    const settings = { ...getDefaultSettings(), betaToolsEnabled: true };
    const json = serializeSettingsForStorage(settings);
    const parsed = JSON.parse(json as string);
    expect(parsed.common.betaToolsEnabled).toBe(true);
    expect(loadSettings(makeStorage(json)).betaToolsEnabled).toBe(true);
  });

  it("serializes and loads post-apply behavior under apply.output", () => {
    const settings = { ...getDefaultSettings(), postApplyRomBehavior: "auto-test-download" as const };
    const json = serializeSettingsForStorage(settings);
    const parsed = JSON.parse(json as string);
    expect(parsed.apply.output.postApplyRomBehavior).toBe("auto-test-download");
    expect(loadSettings(makeStorage(json)).postApplyRomBehavior).toBe("auto-test-download");
  });
});

describe("loadSettings", () => {
  it("returns defaults when storage is null", () => {
    expect(loadSettings(null)).toEqual(getDefaultSettings());
  });

  it("returns defaults when no value is stored (missing key)", () => {
    const storage = makeStorage(null);
    expect(loadSettings(storage)).toEqual(getDefaultSettings());
    expect(storage.removedKeys).toEqual([]);
  });

  it("applies a valid grouped payload round-tripped through serialize", () => {
    const modified = { ...getDefaultSettings(), fixChecksum: true, language: "de" };
    const stored = serializeSettingsForStorage(modified);
    const storage = makeStorage(stored);
    const loaded = loadSettings(storage);
    expect(loaded.fixChecksum).toBe(true);
    expect(loaded.language).toBe("de");
    expect(storage.removedKeys).toEqual([]);
  });

  it("loads a legacy stored workerThreads key into threads", () => {
    const storeThreads = (compression: Record<string, unknown>) =>
      makeStorage(JSON.stringify({ create: { compression }, version: SETTINGS_STORAGE_VERSION }));
    const legacy = loadSettings(storeThreads({ workerThreads: 3 }));
    expect(legacy.threads).not.toBe(getDefaultSettings().threads);
    expect(legacy.threads).toBe(loadSettings(storeThreads({ threads: 3 })).threads);
  });

  it("ignores removed compression-level keys while preserving live codec settings", () => {
    const storage = makeStorage(
      JSON.stringify({
        create: {
          compression: {
            profile: "high",
            rvzCodec: "zstd:12",
            rvzCompressionLevel: 3,
            sevenZipCodec: "lzma2:7",
            sevenZipLevel: 4,
            z3dsCompressionLevel: 5,
            zipCodec: "zstd:-7",
            zipLevel: 6,
          },
        },
        version: SETTINGS_STORAGE_VERSION,
      }),
    );
    const loaded = loadSettings(storage);

    expect(loaded).toMatchObject({
      compressionProfile: "high",
      rvzCodec: "zstd:12",
      sevenZipCodec: "lzma2:7",
      zipCodec: "zstd:-7",
    });
    for (const field of ["rvzCompressionLevel", "sevenZipLevel", "z3dsCompressionLevel", "zipLevel"])
      expect(loaded).not.toHaveProperty(field);

    const serialized = serializeSettingsForStorage(loaded);
    expect(serialized).not.toBeNull();
    for (const field of ["rvzCompressionLevel", "sevenZipLevel", "z3dsCompressionLevel", "zipLevel"])
      expect(serialized).not.toContain(field);
  });

  it("resets and returns defaults on corrupt JSON", () => {
    const storage = makeStorage("{not valid json");
    expect(loadSettings(storage)).toEqual(getDefaultSettings());
    expect(storage.removedKeys).toEqual([LOCAL_STORAGE_SETTINGS_ID]);
  });

  it("resets and returns defaults on an incompatible storage version", () => {
    const payload = JSON.stringify({ common: { language: "de" }, version: 4 });
    const storage = makeStorage(payload);
    expect(loadSettings(storage)).toEqual(getDefaultSettings());
    expect(storage.removedKeys).toEqual([LOCAL_STORAGE_SETTINGS_ID]);
  });

  it("loads a version 5 payload and defaults the post-apply behavior it predates", () => {
    const payload = JSON.stringify({ common: { language: "de" }, version: 5 });
    const storage = makeStorage(payload);
    const settings = loadSettings(storage);
    expect(settings.language).toBe("de");
    expect(settings.postApplyRomBehavior).toBe("auto-download");
    expect(storage.removedKeys).toEqual([]);
  });

  it("resets when the payload is the right version but not an object", () => {
    const storage = makeStorage("123");
    expect(loadSettings(storage)).toEqual(getDefaultSettings());
    expect(storage.removedKeys).toEqual([LOCAL_STORAGE_SETTINGS_ID]);
  });

  it("resets when the payload is the right version but not grouped", () => {
    const payload = JSON.stringify({ language: "de", version: SETTINGS_STORAGE_VERSION });
    const storage = makeStorage(payload);
    expect(loadSettings(storage)).toEqual(getDefaultSettings());
    expect(storage.removedKeys).toEqual([LOCAL_STORAGE_SETTINGS_ID]);
  });
});
