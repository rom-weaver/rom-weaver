import {
  getCompressionProfileFromIndex,
  getCompressionProfileIndex,
  getCompressionProfileLabel,
} from "../../lib/compression/compression-settings.ts";
import OutputCompressionManager from "../../lib/compression/output-compression-manager.ts";
import {
  canUseThreadedWasm,
  getDefaultBrowserThreadCount,
  normalizeBrowserThreadCount,
  normalizeCodecList,
  normalizeCodecListWithFallback,
  parseIntegerInRange,
  parseRvzBlockSize,
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
  parseIntegerInRange,
  parseRvzBlockSize,
};
