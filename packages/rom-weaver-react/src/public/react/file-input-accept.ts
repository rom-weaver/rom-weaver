import {
  hasChromeToken,
  hasMobileToken,
  hasSafariToken,
  isAppleTouchDesktop,
} from "../../platform/shared/webkit-runtime.ts";
import { ARCHIVE_FILE_EXTENSIONS, PATCH_FILE_EXTENSION_VARIANTS, ROM_FILE_EXTENSIONS } from "./file-classification.ts";

/**
 * Accept attributes for the unified drop surface's browse/folder pickers. The
 * extension sets come from {@link file-classification.ts} so the picker and the
 * drop-time classifier never drift apart. Two variants mirror the CLI filters:
 *
 *   - `unifiedApply` - ROMs, patches, bundles, and archives (`--rom-filter`
 *     + `--patch-filter`), used by the Apply tab.
 *   - `unifiedRom` - ROMs and archives only (`--rom-filter`), used by the
 *     Make Patch and Trim tabs, which have no patch bucket.
 *
 * Mobile Safari ignores extension-only `accept` lists, so it falls back to a
 * MIME + archive-extension list that still lets any binary ROM/patch through.
 */

type FileInputAcceptEnvironment = {
  userAgent?: string;
  maxTouchPoints?: number;
  platform?: string;
};

const unique = <TValue>(values: readonly TValue[]) => [...new Set(values)];
const toAcceptList = (extensions: readonly string[]) =>
  unique(extensions.map((extension) => `.${extension}`)).join(",");

const ROM_FILTER_ACCEPT = toAcceptList([...ROM_FILE_EXTENSIONS, ...ARCHIVE_FILE_EXTENSIONS]);
const ROM_AND_PATCH_FILTER_ACCEPT = toAcceptList([
  ...ROM_FILE_EXTENSIONS,
  ...ARCHIVE_FILE_EXTENSIONS,
  ...PATCH_FILE_EXTENSION_VARIANTS,
  "json",
]);

const FILE_ONLY_MIME_TYPES = [
  "application/octet-stream",
  "application/zip",
  "application/x-zip-compressed",
  "multipart/x-zip",
  "application/x-7z-compressed",
  "application/vnd.rar",
  "application/x-rar-compressed",
  "application/gzip",
  "application/x-bzip2",
  "application/x-xz",
  "application/zstd",
];
const FILE_ONLY_ACCEPT = [...FILE_ONLY_MIME_TYPES, ...ARCHIVE_FILE_EXTENSIONS.map((extension) => `.${extension}`)].join(
  ", ",
);

const getNavigatorAcceptEnvironment = (): FileInputAcceptEnvironment => {
  if (typeof navigator === "undefined") return {};
  return {
    maxTouchPoints: navigator.maxTouchPoints,
    platform: navigator.platform,
    userAgent: navigator.userAgent,
  };
};

const isMobileSafari = (environment: FileInputAcceptEnvironment) => {
  // Site-specific "Safari": only the bare `Chrome` token is excluded (so iOS
  // Chrome/Firefox/Edge - CriOS/FxiOS/EdgiOS - still count as Safari here),
  // unlike isSafariBrowser. Kept distinct on purpose; see webkit-runtime.ts.
  const isSafari = hasSafariToken(environment) && !hasChromeToken(environment);
  const isMobile = hasMobileToken(environment) || (isSafari && isAppleTouchDesktop(environment));
  return isSafari && isMobile;
};

const getFileInputAcceptAttributes = (environment = getNavigatorAcceptEnvironment()) => {
  if (isMobileSafari(environment)) {
    return {
      unifiedApply: FILE_ONLY_ACCEPT,
      unifiedRom: FILE_ONLY_ACCEPT,
    };
  }

  return {
    unifiedApply: ROM_AND_PATCH_FILTER_ACCEPT,
    unifiedRom: ROM_FILTER_ACCEPT,
  };
};

export { getFileInputAcceptAttributes };
