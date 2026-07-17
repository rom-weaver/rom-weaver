import { hasMobileToken, isAppleMobileWebKit } from "../../platform/shared/webkit-runtime.ts";
import type { RomWeaverCommand } from "../../wasm/index.ts";

// Stage 2 memory-aware admission. These estimates are deliberately coarse: their only job is to keep
// the scheduler from overlapping operations whose *combined* working set would exhaust the device. The
// thread gate already serializes two full-budget operations (the worst case), so this is a refinement
// for the medium-operation overlap case. We only restrict concurrency when there is positive evidence
// of a large working set - an operation of unknown size is treated as small so it still overlaps.

// Fixed per-operation overhead (wasm runtime, buffers, OPFS staging) charged on top of the input-scaled
// estimate. Also the value returned when the input size is unknown, so unknown ops never trip the gate.
const BASE_BYTES = 16 * 1024 * 1024;

// Working-set multipliers over the input size, keyed by what the operation does with the bytes.
const MULTIPLIER_METADATA = 0.25; // probe/list: scan headers, little resident payload
const MULTIPLIER_STREAMED = 1; // checksum/trim: stream through, roughly one copy resident
const MULTIPLIER_COMPRESS = 1.5; // compress: source window plus codec working buffers
const MULTIPLIER_DECODED = 2; // extract/patch: decoded payload can exceed the compressed input

const patchMultiplier = (command: Extract<RomWeaverCommand, { type: "patch" }>): number => {
  switch (command.args.type) {
    case "apply":
    case "validate":
    case "create":
      return MULTIPLIER_DECODED;
    default:
      return MULTIPLIER_DECODED;
  }
};

const operationMultiplier = (command: RomWeaverCommand): number => {
  switch (command.type) {
    case "probe":
      return MULTIPLIER_METADATA;
    case "checksum":
    case "trim":
      return MULTIPLIER_STREAMED;
    case "compress":
      return MULTIPLIER_COMPRESS;
    case "extract":
    // Ingest now drives disc decompression + archive extraction (formerly `extract`), so it
    // decodes the same working set - keep its memory multiplier equal to extract's.
    case "ingest":
      return MULTIPLIER_DECODED;
    case "patch":
      return patchMultiplier(command);
    default:
      return MULTIPLIER_STREAMED;
  }
};

/**
 * Estimate an operation's peak resident working set in bytes from its input size and what it does. A
 * non-positive/unknown `inputBytes` yields {@link BASE_BYTES} so the operation is treated as small and
 * still allowed to overlap others.
 */
export function estimateOpWorkingSetBytes(command: RomWeaverCommand, inputBytes: number): number {
  if (!(Number.isFinite(inputBytes) && inputBytes > 0)) return BASE_BYTES;
  return BASE_BYTES + Math.floor(inputBytes * operationMultiplier(command));
}

// Commands request "auto" threads (the whole budget) by default, but most do not actually use every
// core - a BPS/UPS apply runs a single-threaded codec, a trim just truncates, and small extracts are
// I/O-bound. The scheduler must gate on the cores an operation will REALISTICALLY use, otherwise one
// light operation reserves the whole machine and nothing runs beside it. Compress is the exception: it
// is genuinely CPU-parallel down to small chunk sizes, so it uses the whole budget (see below).
const LIGHT_BYTES_PER_THREAD = 64 * 1024 * 1024;

const isSequentialPatch = (command: RomWeaverCommand): boolean =>
  command.type === "patch" && (command.args.type === "apply" || command.args.type === "validate");

/**
 * Estimate how many worker threads an operation will actually use, given its requested count and input
 * size. Sequential operations (patch apply/validate, trim) reserve a single thread; compress scales
 * with size (so large compresses still run alone); other operations reserve little so many can overlap.
 * `requestedThreads` of 0 (thread-less probe/list) yields 0.
 */
export function estimateScheduledThreads(
  command: RomWeaverCommand,
  inputBytes: number,
  requestedThreads: number,
): number {
  if (requestedThreads <= 0) return 0;
  if (command.type === "trim" || isSequentialPatch(command)) return 1;
  // Compress is genuinely CPU-parallel down to small chunk sizes (CHD hunks ~19 KiB, RVZ chunks
  // 128 KiB-2 MiB), so it uses every configured thread regardless of input size - size-scaling here
  // would force small ROMs onto a single thread (this estimate is forced back onto the dispatched
  // command). The scheduler's memory gate still prevents two heavy ops from overlapping.
  if (command.type === "compress") return requestedThreads;
  // Note: extract/ingest/checksum no longer rely on this estimate - they are admitted by the Rust batch
  // planner (`plan-extract-batch`), which owns their thread split via `fair_thread_allotment`. This
  // function now governs only the remaining non-I/O ops, which stay light.
  const known = Number.isFinite(inputBytes) && inputBytes > 0;
  if (!known) return 1;
  return Math.min(requestedThreads, Math.max(1, Math.ceil(inputBytes / LIGHT_BYTES_PER_THREAD)));
}

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
