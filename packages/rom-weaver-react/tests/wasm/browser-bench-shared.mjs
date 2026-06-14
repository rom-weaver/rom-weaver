import benchmarkDefaults from "../../../../scripts/bench-defaults.json";
import { getGuestFileSize, writeGuestGeneratedFile } from "./test-helpers.mjs";

export const MIB = 1024 * 1024;
export const WORK_GUEST_ROOT = "/work";
export const COMMAND_PATHS_DEFAULTS = benchmarkDefaults.command_paths;
export const CHECKSUM_THREADING_DEFAULTS = benchmarkDefaults.checksum_threading;
const FIXTURE_CACHE_VERSION = Number(benchmarkDefaults.fixture_cache_version);

export function defaultCsv(values) {
  return Array.isArray(values) ? values.join(",") : String(values);
}

export function createBenchOptions() {
  return {
    iterations: readPositiveIntEnv("ROM_WEAVER_WASM_BENCH_ITERATIONS", 1),
    time: readPositiveIntEnv("ROM_WEAVER_WASM_BENCH_TIME_MS", 50),
    warmupIterations: readNonNegativeIntEnv("ROM_WEAVER_WASM_BENCH_WARMUP_ITERATIONS", 0),
    warmupTime: readNonNegativeIntEnv("ROM_WEAVER_WASM_BENCH_WARMUP_TIME_MS", 0),
  };
}

export async function openPersistentBenchRoot(name) {
  const opfsRoot = await navigator.storage.getDirectory();
  const fixtureName = `rom-weaver-wasm-${name}-cache-v${FIXTURE_CACHE_VERSION}`;
  if (readBooleanEnv("ROM_WEAVER_WASM_BENCH_CLEAR_FIXTURE_CACHE", false)) {
    try {
      await opfsRoot.removeEntry(fixtureName, { recursive: true });
    } catch {
      // A missing cache is fine.
    }
  }
  const fixtureRootHandle = await opfsRoot.getDirectoryHandle(fixtureName, { create: true });
  return { fixtureName, fixtureRootHandle, opfsRoot };
}

export async function ensureGuestPseudoRandomFile(rootHandle, guestPath, byteLength, options = {}) {
  const { chunkSizeBytes = 4 * MIB, seed = 0x12345678, mutate = null } = options;

  if (await guestFileHasSize(rootHandle, guestPath, byteLength)) {
    return { fromCache: true };
  }

  let state = seed >>> 0;
  let absoluteOffset = 0;
  const mutationPlan = createMutationPlan(byteLength, mutate);
  await writeGuestGeneratedFile(
    rootHandle,
    guestPath,
    byteLength,
    (chunk) => {
      for (let index = 0; index < chunk.length; index += 1) {
        state = nextXorshift32(state);
        let value = state & 0xff;
        const delta = mutationPlan.deltaForOffset(absoluteOffset);
        if (delta !== 0) value = (value + delta) & 0xff;
        chunk[index] = value;
        absoluteOffset += 1;
      }
    },
    { chunkSizeBytes },
  );
  return { fromCache: false };
}

export async function ensureGuestGamecubeIsoFixture(rootHandle, guestPath, totalBytes, options = {}) {
  const { chunkSizeBytes = 4 * MIB } = options;
  const totalLen = Math.max(totalBytes, 0x440);
  if (await guestFileHasSize(rootHandle, guestPath, totalLen)) {
    return { fromCache: true };
  }

  const titleBytes = new TextEncoder().encode("rom-weaver-bench\0");
  await writeGuestGeneratedFile(
    rootHandle,
    guestPath,
    totalLen,
    (chunk, offset) => {
      chunk.fill(0);
      for (let index = 0; index < chunk.length; index += 1) {
        const absoluteOffset = offset + index;
        if (absoluteOffset < 6) {
          chunk[index] = [0x52, 0x57, 0x54, 0x45, 0x53, 0x54][absoluteOffset];
        } else if (absoluteOffset >= 0x1c && absoluteOffset < 0x20) {
          chunk[index] = [0xc2, 0x33, 0x9f, 0x3d][absoluteOffset - 0x1c];
        } else if (absoluteOffset >= 0x20 && absoluteOffset < 0x20 + titleBytes.length) {
          chunk[index] = titleBytes[absoluteOffset - 0x20];
        } else if (absoluteOffset >= 0x440) {
          chunk[index] = absoluteOffset % 251;
        }
      }
    },
    { chunkSizeBytes },
  );
  return { fromCache: false };
}

async function guestFileHasSize(rootHandle, guestPath, byteLength) {
  try {
    return (await getGuestFileSize(rootHandle, guestPath)) === byteLength;
  } catch {
    return false;
  }
}

export function parseIntegerList(raw) {
  const values = String(raw)
    .split(",")
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((value) => Number.isInteger(value) && value > 0);
  if (values.length === 0) {
    throw new TypeError(`expected at least one positive integer value; received: ${raw}`);
  }
  return values;
}

export function parseStringList(raw) {
  const values = String(raw)
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (values.length === 0) {
    throw new TypeError(`expected at least one value; received: ${raw}`);
  }
  return values;
}

export function readPositiveIntEnv(name, fallback) {
  const raw = readEnvValue(name);
  if (raw == null || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${name} must be a positive integer; received: ${raw}`);
  }
  return parsed;
}

function readNonNegativeIntEnv(name, fallback) {
  const raw = readEnvValue(name);
  if (raw == null || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new TypeError(`${name} must be a non-negative integer; received: ${raw}`);
  }
  return parsed;
}

export function readBooleanEnv(name, fallback) {
  const raw = readEnvValue(name);
  if (raw == null || raw.trim() === "") return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new TypeError(`${name} must be one of 1/0/true/false/yes/no/on/off; received: ${raw}`);
}

export function readEnvValue(name) {
  const injectedEnv =
    typeof __ROM_WEAVER_WASM_BENCH_ENV__ !== "undefined" &&
    __ROM_WEAVER_WASM_BENCH_ENV__ &&
    typeof __ROM_WEAVER_WASM_BENCH_ENV__ === "object"
      ? __ROM_WEAVER_WASM_BENCH_ENV__
      : {};
  const injectedValue = injectedEnv[name];
  if (typeof injectedValue === "string") return injectedValue;

  const viteEnv = import.meta?.env ?? {};
  const viteValue = viteEnv[name];
  if (typeof viteValue === "string") return viteValue;

  const processEnv = globalThis?.process?.env;
  const processValue = processEnv?.[name];
  if (typeof processValue === "string") return processValue;
  return null;
}

function nextXorshift32(value) {
  let next = value >>> 0;
  next ^= next << 13;
  next ^= next >>> 17;
  next ^= next << 5;
  return next >>> 0;
}

function createMutationPlan(byteLength, mutate) {
  if (!mutate) {
    return { deltaForOffset: () => 0 };
  }
  const editBudget = Math.min(512 * 1024, Math.max(64 * 1024, Math.floor(byteLength / 8)));
  const blockLen = 4096;
  const blockCount = Math.max(1, Math.floor(editBudget / blockLen));
  const stride = Math.max(blockLen, Math.floor(byteLength / blockCount));
  let blockIndex = 0;
  let start = 17;
  let end = Math.min(byteLength, start + blockLen);

  return {
    deltaForOffset(offset) {
      while (blockIndex < blockCount && offset >= end) {
        blockIndex += 1;
        start = Math.min(byteLength - 1, 17 + blockIndex * stride);
        end = Math.min(byteLength, start + blockLen);
      }
      if (blockIndex >= blockCount || offset < start || offset >= end) return 0;
      return 37 + (blockIndex % 11);
    },
  };
}
