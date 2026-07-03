import { expect, test } from "vitest";
import { getDefaultWebappLogLevel } from "../../src/webapp/development-defaults.ts";
import {
  buildSettingsForWebapp,
  getDefaultSettings,
  getSettingsUiState,
  isSettingsFieldDisabled,
  LOCAL_STORAGE_SETTINGS_ID,
  loadSettings,
  SETTINGS_PANEL_FIELD_ORDER,
  SETTINGS_STORAGE_VERSION,
  serializeSettingsForStorage,
  validateSettingsDraft,
} from "../../src/webapp/settings/settings-state.ts";

const createMemoryStorage = () => {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, String(value)),
  };
};

test("development webapp defaults enable trace logging", () => {
  const developmentEnvironment = { DEV: true, MODE: "development" };
  expect(getDefaultWebappLogLevel(developmentEnvironment)).toBe("trace");

  expect(getDefaultWebappLogLevel({ DEV: true, MODE: "test" })).toBe("info");
  expect(getDefaultWebappLogLevel({ DEV: false, MODE: "production" })).toBe("info");
});

test("settings persistence round-trips every visible settings field", () => {
  const settings = {
    ...getDefaultSettings(),
    chdCreateCdCodecs: "cdzs:5,cdlz:6,cdfl:7",
    chdCreateDvdCodecs: "zstd:12,lzma:7,zlib:6,huff,flac:5",
    compressionProfile: "medium",
    defaultCompression: "7z only",
    fixChecksum: true,
    language: "fr",
    logLevel: "debug",
    requireInputChecksumMatch: false,
    rvzBlockSize: 262144,
    rvzCodec: "zstd:7",
    rvzCompressionLevel: 7,
    rvzScrub: true,
    sevenZipCodec: "lzma2:8",
    sevenZipLevel: 8,
    workerThreads: 2,
    z3dsCompressionLevel: 12,
    zipCodec: "zstd:13",
    zipLevel: 13,
  };

  const serializedSettings = serializeSettingsForStorage(settings);
  expect(serializedSettings).not.toBeNull();

  const storedSettings = JSON.parse(serializedSettings);
  expect(storedSettings.common.defaultCompression).toBe("7z only");
  expect(storedSettings.apply.compression.rvzCodec).toBe("zstd:7");
  expect(storedSettings.apply.compression.rvzCompressionLevel).toBeUndefined();
  expect(storedSettings.apply.compression.sevenZipLevel).toBeUndefined();
  expect(storedSettings.apply.compression.z3dsCompressionLevel).toBeUndefined();
  expect(storedSettings.apply.compression.zipLevel).toBeUndefined();

  const storage = createMemoryStorage();
  storage.setItem(LOCAL_STORAGE_SETTINGS_ID, serializedSettings);

  const loadedSettings = loadSettings(storage);
  expect(SETTINGS_PANEL_FIELD_ORDER).not.toContain("rvzScrub");
  expect(SETTINGS_PANEL_FIELD_ORDER).not.toEqual(
    expect.arrayContaining(["rvzCompressionLevel", "sevenZipLevel", "z3dsCompressionLevel", "zipLevel"]),
  );
  expect(loadedSettings.rvzScrub).toBe(true);
  expect(loadedSettings.rvzCompressionLevel).toBe("");
  expect(loadedSettings.sevenZipLevel).toBe("");
  expect(loadedSettings.z3dsCompressionLevel).toBe("");
  expect(loadedSettings.zipLevel).toBe("");
  const roundTrippedFields = Object.fromEntries(
    SETTINGS_PANEL_FIELD_ORDER.map((fieldKey) => [fieldKey, loadedSettings[fieldKey]]),
  );
  const expectedFields = Object.fromEntries(
    SETTINGS_PANEL_FIELD_ORDER.map((fieldKey) => [fieldKey, settings[fieldKey]]),
  );

  expect(roundTrippedFields).toEqual(expectedFields);
});

test("old default archive settings are ignored", () => {
  const storage = createMemoryStorage();
  storage.setItem(
    LOCAL_STORAGE_SETTINGS_ID,
    JSON.stringify({
      common: {
        defaultArchive: "7z",
        specialCompression: false,
      },
      version: SETTINGS_STORAGE_VERSION,
    }),
  );

  expect(loadSettings(storage).defaultCompression).toBe(getDefaultSettings().defaultCompression);
});

test("removed auto container preference settings load as zip or ROM specific", () => {
  const storage = createMemoryStorage();
  storage.setItem(
    LOCAL_STORAGE_SETTINGS_ID,
    JSON.stringify({
      common: {
        defaultCompression: "auto",
      },
      version: SETTINGS_STORAGE_VERSION,
    }),
  );

  expect(loadSettings(storage).defaultCompression).toBe("zip/special");
});

test("codec text settings derive runtime codec levels", () => {
  const runtimeSettings = buildSettingsForWebapp({
    ...getDefaultSettings(),
    rvzCodec: "zstd:-7",
    sevenZipCodec: "lzma2:8",
    zipCodec: "zstd:-7",
  });

  expect(runtimeSettings.rvzCodec).toBe("zstd");
  expect(runtimeSettings.rvzCompressionLevel).toBe(-7);
  expect(runtimeSettings.sevenZipCodec).toBe("lzma2");
  expect(runtimeSettings.sevenZipLevel).toBe(8);
  expect(runtimeSettings.zipCodec).toBe("zstd");
  expect(runtimeSettings.zipLevel).toBe(-7);
});

test("7z codec remains editable when 7z is not the container preference", () => {
  const settings = {
    ...getDefaultSettings(),
    defaultCompression: "zip/special",
  };

  expect(isSettingsFieldDisabled("sevenZipCodec", settings, getSettingsUiState(settings))).toBe(false);
});

test("codec text settings validate codecs and levels", () => {
  const negativeZstdValidation = validateSettingsDraft({
    ...getDefaultSettings(),
    rvzCodec: "zstd:-7",
    zipCodec: "zstd:-7",
  });
  expect(negativeZstdValidation.invalidFields).not.toContain("settings-rvz-codec");
  expect(negativeZstdValidation.invalidFields).not.toContain("settings-zip-codec");

  const zipValidation = validateSettingsDraft({
    ...getDefaultSettings(),
    zipCodec: "zstd:23",
  });
  expect(zipValidation.invalidFields).toContain("settings-zip-codec");

  const zipMinValidation = validateSettingsDraft({
    ...getDefaultSettings(),
    zipCodec: "zstd:-8",
  });
  expect(zipMinValidation.invalidFields).toContain("settings-zip-codec");

  const sevenZipValidation = validateSettingsDraft({
    ...getDefaultSettings(),
    defaultCompression: "7z/special",
    sevenZipCodec: "lzma2:10",
  });
  expect(sevenZipValidation.invalidFields).toContain("settings-7z-codec");

  const storeValidation = validateSettingsDraft({
    ...getDefaultSettings(),
    zipCodec: "store:1",
  });
  expect(storeValidation.invalidFields).toContain("settings-zip-codec");

  const rvzValidation = validateSettingsDraft({
    ...getDefaultSettings(),
    rvzCodec: "zlib",
  });
  expect(rvzValidation.invalidFields).toContain("settings-rvz-codec");
});
