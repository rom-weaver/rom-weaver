import { describe, expect, it } from "vitest";
import { getCompressionCodecLevelMax } from "../../src/lib/compression/codec-fields.ts";
import type { SettingsDraft, SettingsState, StorageLike } from "../../src/webapp/settings/settings-metadata.ts";
import {
  getSettingsFieldId,
  LOCAL_STORAGE_SETTINGS_ID,
  SETTINGS_FIELD_ORDER,
} from "../../src/webapp/settings/settings-metadata.ts";
import {
  buildSettingsForWebapp,
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
    expect(settings.requireInputChecksumMatch).toBe(true);
    expect(settings.betaToolsEnabled).toBe(false);
    expect(settings.workerThreads).toBe("auto");
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
    const result = validateSettingsDraft(validDraft({ language: "FR" }));
    expect(result.settings.language).toBe("fr");
    expect(result.invalidFields).not.toContain(getSettingsFieldId("language"));
  });

  it("accepts a bundle package default", () => {
    const result = validateSettingsDraft(validDraft({ bundlePackage: "ZIP:ROM" }));
    expect(result.settings.bundlePackage).toBe("zip:rom");
    expect(result.invalidFields).not.toContain(getSettingsFieldId("bundlePackage"));
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
    const result = validateSettingsDraft(validDraft({ workerThreads: "auto" }));
    expect(result.settings.workerThreads).toBe("auto");
    expect(result.invalidFields).not.toContain(getSettingsFieldId("workerThreads"));
  });

  it("flags an out-of-range worker thread count and retains the current value", () => {
    const result = validateSettingsDraft(validDraft({ workerThreads: "999" }));
    expect(result.invalidFields).toContain(getSettingsFieldId("workerThreads"));
    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.settings.workerThreads).toBe("auto");
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
    const settings = { ...getDefaultSettings(), language: "fr" };
    const json = serializeSettingsForStorage(settings);
    const parsed = JSON.parse(json as string);
    expect(parsed.common.language).toBe("fr");
  });

  it("serializes and loads the beta tools setting under common", () => {
    const settings = { ...getDefaultSettings(), betaToolsEnabled: true };
    const json = serializeSettingsForStorage(settings);
    const parsed = JSON.parse(json as string);
    expect(parsed.common.betaToolsEnabled).toBe(true);
    expect(loadSettings(makeStorage(json)).betaToolsEnabled).toBe(true);
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
    const modified = { ...getDefaultSettings(), fixChecksum: true, language: "fr" };
    const stored = serializeSettingsForStorage(modified);
    const storage = makeStorage(stored);
    const loaded = loadSettings(storage);
    expect(loaded.fixChecksum).toBe(true);
    expect(loaded.language).toBe("fr");
    expect(storage.removedKeys).toEqual([]);
  });

  it("resets and returns defaults on corrupt JSON", () => {
    const storage = makeStorage("{not valid json");
    expect(loadSettings(storage)).toEqual(getDefaultSettings());
    expect(storage.removedKeys).toEqual([LOCAL_STORAGE_SETTINGS_ID]);
  });

  it("resets and returns defaults on a storage version mismatch", () => {
    const payload = JSON.stringify({ common: { language: "fr" }, version: SETTINGS_STORAGE_VERSION - 1 });
    const storage = makeStorage(payload);
    expect(loadSettings(storage)).toEqual(getDefaultSettings());
    expect(storage.removedKeys).toEqual([LOCAL_STORAGE_SETTINGS_ID]);
  });

  it("resets when the payload is the right version but not an object", () => {
    const storage = makeStorage("123");
    expect(loadSettings(storage)).toEqual(getDefaultSettings());
    expect(storage.removedKeys).toEqual([LOCAL_STORAGE_SETTINGS_ID]);
  });

  it("resets when the payload is the right version but not grouped", () => {
    const payload = JSON.stringify({ language: "fr", version: SETTINGS_STORAGE_VERSION });
    const storage = makeStorage(payload);
    expect(loadSettings(storage)).toEqual(getDefaultSettings());
    expect(storage.removedKeys).toEqual([LOCAL_STORAGE_SETTINGS_ID]);
  });
});

describe("buildSettingsForWebapp", () => {
  it("materializes chd codecs and resolved compression levels from defaults", () => {
    const built = buildSettingsForWebapp(getDefaultSettings()) as SettingsState & Record<string, unknown>;
    expect(typeof built.chdCreateCdCodecs).toBe("string");
    expect((built.chdCreateCdCodecs as string).length).toBeGreaterThan(0);
    expect(typeof built.chdCreateDvdCodecs).toBe("string");
    expect(typeof built.rvzCodec).toBe("string");
    expect(built.requireInputChecksumMatch).toBe(true);
  });

  it("merges extraSettings over the materialized base", () => {
    const built = buildSettingsForWebapp(null, { extraFlag: 42, logLevel: "trace" }) as Record<string, unknown>;
    expect(built.extraFlag).toBe(42);
    expect(built.logLevel).toBe("trace");
    expect(typeof built.chdCreateCdCodecs).toBe("string");
  });
});
