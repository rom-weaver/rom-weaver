import { expect, test } from "vitest";
import {
  getDefaultSettings,
  LOCAL_STORAGE_SETTINGS_ID,
  loadSettings,
  SETTINGS_PANEL_FIELD_ORDER,
  serializeSettingsForStorage,
} from "../../src/webapp/settings/settings-state.ts";

const createMemoryStorage = () => {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, String(value)),
  };
};

test("settings persistence round-trips every visible settings field", () => {
  const settings = {
    ...getDefaultSettings(),
    chdCreateCdCodecs: "cdzs:5,cdlz:6,cdfl:7",
    chdCreateDvdCodecs: "zstd:12,lzma:7,zlib:6,huff,flac:5",
    compressionProfile: "medium",
    defaultArchive: "7z",
    erudaDevTools: true,
    fixChecksum: true,
    language: "fr",
    logLevel: "debug",
    requireInputChecksumMatch: false,
    requireOutputChecksumMatch: false,
    rvzBlockSize: 262144,
    rvzCompression: "lzma",
    rvzCompressionLevel: 7,
    rvzScrub: true,
    sevenZipCodec: "zstd",
    sevenZipLevel: 21,
    specialCompression: false,
    workerThreads: 2,
    z3dsCompressionLevel: 12,
    zipCodec: "zstd",
    zipLevel: 13,
  };

  const serializedSettings = serializeSettingsForStorage(settings);
  expect(serializedSettings).not.toBeNull();

  const storedSettings = JSON.parse(serializedSettings);
  expect(storedSettings.common.defaultArchive).toBe("7z");
  expect(storedSettings.common.specialCompression).toBe(false);

  const storage = createMemoryStorage();
  storage.setItem(LOCAL_STORAGE_SETTINGS_ID, serializedSettings);

  const loadedSettings = loadSettings(storage);
  expect(SETTINGS_PANEL_FIELD_ORDER).not.toContain("rvzScrub");
  expect(loadedSettings.rvzScrub).toBe(true);
  const roundTrippedFields = Object.fromEntries(
    SETTINGS_PANEL_FIELD_ORDER.map((fieldKey) => [fieldKey, loadedSettings[fieldKey]]),
  );
  const expectedFields = Object.fromEntries(
    SETTINGS_PANEL_FIELD_ORDER.map((fieldKey) => [fieldKey, settings[fieldKey]]),
  );

  expect(roundTrippedFields).toEqual(expectedFields);
});
