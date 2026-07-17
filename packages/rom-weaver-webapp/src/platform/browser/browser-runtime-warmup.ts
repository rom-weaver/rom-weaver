import { createLogger } from "../../lib/logging.ts";
import { markWarmupDone, markWarmupEnd, markWarmupStart } from "../../lib/perf/op-perf-marks.ts";
import { recycleWarmRomWeaverRunner } from "../../workers/rom-weaver/rom-weaver-runner.ts";
import { browserRuntime } from "./workflow-runtime.ts";

// Checksums the real first ROM-load op computes inline during ingest. The warmup requests them too so
// the inline StreamingChecksum decode path is warm; measured on a prod build, that path is ~25ms of the
// first op and is NOT warmed by an extract without checksums.
const WARMUP_CHECKSUM_ALGORITHMS = ["crc32", "md5", "sha1"];

// A tiny deflate-compressed zip (one entry, 426 bytes) embedded as base64. It is used to run one silent
// end-to-end ingest (classify + extract + inline checksum) on page load so every per-op code path is
// warm before the user's first real op. The fixture is a zip rather than a CHD because the common first
// op is a dropped ROM archive, and a prod-build measurement showed the first archive extract+checksum
// pays ~50ms of one-time cost split roughly evenly between the shared thread-pool/OPFS spawn (which any
// extraction warms) and the libarchive/DEFLATE + inline-checksum JIT (which only an archive extract with
// checksums warms). A CHD warmup covered only the former half; this covers both, and being the lighter
// extract it also finishes sooner, narrowing the window where a quick first drop beats it. A disc-image
// (CHD) first op is rarer and still gets the shared-spawn half from this archive warmup.
const WARMUP_ZIP_BASE64 =
  "UEsDBBQAAAAIAHV70FxlzFsPNAEAAAAQAAAKAAAAd2FybXVwLmJpbuM2CK2af+Qln3FE7aLjbwTNohuWnnovYhnXvOLsJ3GbxLbVF75K2ad0rrv8Q9YpvWf" +
  "jtd8Krln9W27+U/bInbT9DqOad8HUXfdZNP2KZ+x9xK4TWDb7wFMu/ZDKeYdf8BqF1yw89lrANKp+ycl3whaxTcvPfBSzTmhddf6LpF1yx9pL32Uc07o3XP" +
  "0l75LZt/nGXyX3nInbbjOoeuVP2XmPWcO3aPqeh2zaAaWz9j/h1AuumHvoOY9hWPWCo6/4TSLrFp94K2Qe07js9AdRq/iWlec+S9gmta+5+E3aIbVr/ZWfcs" +
  "4ZvZuu/1F0y56w9dZ/Fc+8yTvuMqn7FE7b/YBVy79k5r7HHLpB5XMOPuMe9f+o/0f9P+r/Uf+P+n8E+t/RydllFI/iUTyKR/EoHsUjCwMAUEsBAhQDFAAA" +
  "AAgAdXvQXGXMWw80AQAAABAAAAoAAAAAAAAAAAAAAIABAAAAAHdhcm11cC5iaW5QSwUGAAAAAAEAAQA4AAAAXAEAAAAA";

const WARMUP_ZIP_FILE_NAME = "rom-weaver-warmup.zip";

let warmupExtractionStarted = false;

// Warmup runs on the page/main thread where configureLogger has applied the user's log level setting,
// so it logs through the shared logger directly (gated by that setting) rather than the console.
const logger = createLogger("browser-runtime-warmup");

const decodeBase64ToBytes = (value: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

const createWarmupZipFile = (): File | null => {
  if (typeof File !== "function" || typeof atob !== "function") return null;
  return new File([decodeBase64ToBytes(WARMUP_ZIP_BASE64)], WARMUP_ZIP_FILE_NAME);
};

const cleanupWarmupOutputs = async (outputs: ReadonlyArray<{ cleanup?: () => Promise<void> | void }>) => {
  for (const output of outputs) {
    await Promise.resolve(output?.cleanup?.()).catch(() => undefined);
  }
};

// Runs one tiny zip end-to-end through `ingest` (the real first-op path: classify + extract + inline
// checksum in one pass), so every per-op code path (decode JIT, inline checksum, OPFS input/output
// handles through the proxy, and the shared worker pool) is warm before the user's first real op.
// Best-effort only: it is single-flight, swallows all errors, and explicitly cleans the outputs returned
// by this warmup without inspecting or deleting any other tab's OPFS entries.
const warmupBrowserRuntimeExtraction = async (): Promise<void> => {
  if (warmupExtractionStarted) return;
  warmupExtractionStarted = true;
  const ingest = browserRuntime.ingest;
  if (!ingest?.run) return;
  const file = createWarmupZipFile();
  if (!file) return;
  logger.trace("warmup extraction start");
  markWarmupStart();
  try {
    const { outputs, patchOutputs } = await ingest.run({
      checksumAlgorithms: [...WARMUP_CHECKSUM_ALGORITHMS],
      fileName: file.name,
      source: { fileName: file.name, source: file },
    });
    await cleanupWarmupOutputs([...outputs, ...patchOutputs]);
    markWarmupDone();
    logger.trace("warmup extraction done", { outputCount: outputs.length });
  } catch (error) {
    logger.trace("warmup extraction skipped", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
  // Still inside the idle warmup task, release the heap-dirtied worker so an idle tab does not retain its
  // shared WASM heap. The compiled module remains cached, so the first real operation only creates a clean
  // runner. Self-guards (no-op if disabled or a run is active). Best-effort, like the warmup itself.
  await recycleWarmRomWeaverRunner().catch((error) => {
    logger.trace("warmup runner recycle skipped", {
      message: error instanceof Error ? error.message : String(error),
    });
  });
  // The warmup (extract + recycle) is fully done; resume user-operation latency instrumentation.
  markWarmupEnd();
};

// Defers the warmup extraction to browser idle time so it never competes with initial render or the
// runner init it follows. Falls back to a macrotask when requestIdleCallback is unavailable. Note: the
// warmup is chained off preload completion (wasm compile + runner warm), by which point the main thread
// is already idle, so the timeout below is a backstop, not the binding constraint - a measured sweep of
// 50/250/2000ms showed no effect on when warmup starts.
const scheduleBrowserRuntimeWarmupExtraction = (): void => {
  if (warmupExtractionStarted) return;
  const run = () => {
    void warmupBrowserRuntimeExtraction();
  };
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(run, { timeout: 2000 });
    return;
  }
  if (typeof setTimeout === "function") {
    setTimeout(run, 0);
    return;
  }
  run();
};

export { scheduleBrowserRuntimeWarmupExtraction, warmupBrowserRuntimeExtraction };
