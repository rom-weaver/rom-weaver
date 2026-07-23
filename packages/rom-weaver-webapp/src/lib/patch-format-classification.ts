import { ROM_WEAVER_PATCH_FORMATS } from "@rom-weaver/wasm/generated/rom-weaver-format-metadata";
import { getFileNameParts } from "./path-utils.ts";

// Patch families whose browser apply path gets special thread routing. The
// canonical Rust handler-descriptor names anchor the policy here (which family a
// format belongs to is a browser-perf decision); the matching extensions and
// format aliases are derived from the Rust-owned patch-format registry so they
// can never drift from the handlers. See [[patch-run-resolution]].
const XDELTA_FAMILY_FORMAT_NAMES = ["xdelta", "vcdiff"];
const BPS_FAMILY_FORMAT_NAMES = ["bps"];

const FORMAT_TOKEN_NORMALIZE_REGEX = /[^a-z0-9]+/g;
const LEADING_DOT_REGEX = /^\./;

const normalizeFormatToken = (value: string): string =>
  value.trim().toLowerCase().replace(FORMAT_TOKEN_NORMALIZE_REGEX, "");

const normalizeExtension = (value: string): string => value.trim().toLowerCase().replace(LEADING_DOT_REGEX, "");

type PatchFormatClassifier = {
  matchesFormatName: (value: unknown) => boolean;
  matchesExtension: (extension: string | null | undefined) => boolean;
  matchesPath: (pathOrName: string | null | undefined) => boolean;
};

const buildClassifier = (familyNames: readonly string[]): PatchFormatClassifier => {
  const formatTokens = new Set<string>();
  const extensions = new Set<string>();
  for (const format of ROM_WEAVER_PATCH_FORMATS) {
    if (!familyNames.includes(format.name)) continue;
    formatTokens.add(normalizeFormatToken(format.name));
    for (const alias of format.aliases) formatTokens.add(normalizeFormatToken(alias));
    for (const extension of format.extensions) {
      const normalized = normalizeExtension(extension);
      if (normalized) extensions.add(normalized);
    }
  }

  const matchesFormatName = (value: unknown): boolean =>
    typeof value === "string" && formatTokens.has(normalizeFormatToken(value));
  const matchesExtension = (extension: string | null | undefined): boolean =>
    typeof extension === "string" && extensions.has(normalizeExtension(extension));
  const matchesPath = (pathOrName: string | null | undefined): boolean => {
    if (typeof pathOrName !== "string" || !pathOrName.trim()) return false;
    return matchesExtension(getFileNameParts(pathOrName).extension);
  };
  return { matchesExtension, matchesFormatName, matchesPath };
};

const xdeltaClassifier = buildClassifier(XDELTA_FAMILY_FORMAT_NAMES);
const bpsClassifier = buildClassifier(BPS_FAMILY_FORMAT_NAMES);

const isXdeltaPatchFormatName = xdeltaClassifier.matchesFormatName;
const isXdeltaPatchExtension = xdeltaClassifier.matchesExtension;
const isXdeltaPatchPath = xdeltaClassifier.matchesPath;
const isBpsPatchFormatName = bpsClassifier.matchesFormatName;
const isBpsPatchPath = bpsClassifier.matchesPath;

export { isBpsPatchFormatName, isBpsPatchPath, isXdeltaPatchExtension, isXdeltaPatchFormatName, isXdeltaPatchPath };
