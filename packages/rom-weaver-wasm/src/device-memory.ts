import { hasMobileToken, isAppleMobileWebKit } from "./webkit-runtime.ts";

// Device-memory ceilings for the browser wasm runtime. Split out of the webapp's
// op-memory-estimate so the wasm package owns the sizing primitives it reaches for
// (the thread pool and archive-stress paths); the command-shaped estimators that
// need `RomWeaverCommand` stay in the webapp and re-import these.

type DeviceMemoryNavigator = {
  deviceMemory?: number;
  maxTouchPoints?: number;
  platform?: string;
  userAgent?: string;
};
type DeviceMemoryRoot = { navigator?: DeviceMemoryNavigator };

const MIN_MEMORY_CEILING_BYTES = 512 * 1024 * 1024;
const MAX_MEMORY_CEILING_BYTES = 2 * 1024 * 1024 * 1024;
const FALLBACK_MEMORY_CEILING_BYTES = Math.floor(1.5 * 1024 * 1024 * 1024);
// Tighter ceiling on mobile. Phones/tablets - iOS/iPadOS especially - kill a tab that overcommits
// (the jetsam reloads we fought for large checksums), and their `deviceMemory` is optimistic or absent,
// so cap the combined concurrent working set well below the desktop ceiling regardless of what is
// reported. Only ever lowers the derived ceiling (`Math.min`), never raises a smaller one.
const MOBILE_MEMORY_CEILING_BYTES = 1024 * 1024 * 1024;
// Fraction of total device memory we let concurrent operations collectively reserve. Browsers report
// `navigator.deviceMemory` coarsely (and not at all on some engines), so stay well below total RAM.
const DEVICE_MEMORY_FRACTION = 0.5;
const BYTES_PER_GIB = 1024 * 1024 * 1024;
const WASM_PAGE_BYTES = 64 * 1024;

// Any phone/tablet web runtime: every iOS/iPadOS WebKit (incl. iPadOS desktop mode) plus Android and
// other engines that carry the `Mobile/<build>` UA marker. Composed from the centralized WebKit/mobile
// primitives so the UA vocabulary stays in one place. Desktop Chrome/Safari/Firefox match neither.
const isMobileWebRuntime = (navigatorLike: DeviceMemoryNavigator | undefined): boolean => {
  if (!navigatorLike) return false;
  const environment = {
    maxTouchPoints: navigatorLike.maxTouchPoints,
    platform: navigatorLike.platform,
    userAgent: navigatorLike.userAgent,
  };
  return isAppleMobileWebKit(environment) || hasMobileToken(environment);
};

/**
 * Resolve the ceiling on combined estimated working set for concurrent operations. Derived from
 * `navigator.deviceMemory` when available (a coarse GiB figure), clamped to a safe range; falls back to
 * a fixed ceiling when the engine does not expose it (Firefox/Safari). Mobile runtimes are additionally
 * capped at {@link MOBILE_MEMORY_CEILING_BYTES} so a phone/tablet never overlaps work that would OOM it.
 */
export function resolveMemoryCeilingBytes(root: DeviceMemoryRoot | null = globalThis as DeviceMemoryRoot): number {
  const deviceMemoryGib = Number(root?.navigator?.deviceMemory);
  const ceiling =
    Number.isFinite(deviceMemoryGib) && deviceMemoryGib > 0
      ? Math.max(
          MIN_MEMORY_CEILING_BYTES,
          Math.min(MAX_MEMORY_CEILING_BYTES, Math.floor(deviceMemoryGib * BYTES_PER_GIB * DEVICE_MEMORY_FRACTION)),
        )
      : FALLBACK_MEMORY_CEILING_BYTES;
  if (isMobileWebRuntime(root?.navigator)) return Math.min(ceiling, MOBILE_MEMORY_CEILING_BYTES);
  return ceiling;
}

export function resolveAppleMobileSharedMemoryMaximumPages(
  root: DeviceMemoryRoot | null = globalThis as DeviceMemoryRoot,
): number | undefined {
  const navigatorLike = root?.navigator;
  if (!navigatorLike) return undefined;
  if (
    !isAppleMobileWebKit({
      maxTouchPoints: navigatorLike.maxTouchPoints,
      platform: navigatorLike.platform,
      userAgent: navigatorLike.userAgent,
    })
  )
    return undefined;
  return Math.floor(resolveMemoryCeilingBytes(root) / WASM_PAGE_BYTES);
}

export type { DeviceMemoryNavigator, DeviceMemoryRoot };
