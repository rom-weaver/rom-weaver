import {
  getCompressionProfileFromIndex,
  getCompressionProfileIndex,
  getCompressionProfileLabel,
  resolveCompressionLevels,
} from "../../lib/compression/compression-settings.ts";
import OutputCompressionManager from "../../lib/compression/output-compression-manager.ts";
import {
  canUseThreadedWasm,
  getDefaultBrowserThreadCount,
  normalizeBrowserThreadCount,
  normalizeCodecList,
  normalizeCodecListWithFallback,
  normalizeIntegerInRange,
  parseIntegerInRange,
} from "../../platform/shared/compression-options.ts";

const { COMPRESSION_PROFILES, getChdCodecsForMode, normalizeCompressionProfile } = OutputCompressionManager;

export {
  COMPRESSION_PROFILES,
  canUseThreadedWasm,
  getChdCodecsForMode,
  getCompressionProfileFromIndex,
  getCompressionProfileIndex,
  getCompressionProfileLabel,
  getDefaultBrowserThreadCount,
  normalizeBrowserThreadCount,
  normalizeCodecList,
  normalizeCodecListWithFallback,
  normalizeCompressionProfile,
  normalizeIntegerInRange,
  parseIntegerInRange,
  resolveCompressionLevels,
};
