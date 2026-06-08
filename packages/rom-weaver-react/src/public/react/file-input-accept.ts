import { ROM_WEAVER_FILE_FILTERS } from "rom-weaver-wasm/format-metadata";

const SAFARI_USER_AGENT_REGEX = /Safari/;
const CHROME_USER_AGENT_REGEX = /Chrome/;
const MOBILE_USER_AGENT_REGEX = /Mobile(\/\S+)? /;

type FileInputAcceptEnvironment = {
  userAgent?: string;
  maxTouchPoints?: number;
  platform?: string;
};

const stripLeadingExtensionDot = (extension: string) => extension.replace(/^\./, "");
const unique = <TValue>(values: readonly TValue[]) => [...new Set(values)];

const PATCH_FILE_EXTENSIONS = ROM_WEAVER_FILE_FILTERS.patchExtensions.map(stripLeadingExtensionDot);
const PATCH_FILE_EXTENSION_VARIANTS = unique([
  ...PATCH_FILE_EXTENSIONS,
  ...PATCH_FILE_EXTENSIONS.map((extension) => `${extension}1`),
]);
const ARCHIVE_FILE_EXTENSIONS = ROM_WEAVER_FILE_FILTERS.containerExtensions.map(stripLeadingExtensionDot);
const PATCH_INPUT_ACCEPT = [...PATCH_FILE_EXTENSION_VARIANTS, ...ARCHIVE_FILE_EXTENSIONS]
  .map((extension) => `.${extension}`)
  .join(",");

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
  const userAgent = environment.userAgent || "";
  const platform = environment.platform || "";
  const maxTouchPoints = typeof environment.maxTouchPoints === "number" ? environment.maxTouchPoints : 0;
  const isSafari = SAFARI_USER_AGENT_REGEX.test(userAgent) && !CHROME_USER_AGENT_REGEX.test(userAgent);
  const isMobile =
    MOBILE_USER_AGENT_REGEX.test(userAgent) || (isSafari && platform === "MacIntel" && maxTouchPoints > 1);
  return isSafari && isMobile;
};

const getFileInputAcceptAttributes = (environment = getNavigatorAcceptEnvironment()) => {
  if (isMobileSafari(environment)) {
    return {
      patch: FILE_ONLY_ACCEPT,
      rom: FILE_ONLY_ACCEPT,
    };
  }

  return {
    patch: PATCH_INPUT_ACCEPT,
    rom: undefined,
  };
};

export { getFileInputAcceptAttributes };
