import { createLogger } from "../../lib/logging.ts";
import { markWarmupDone, markWarmupEnd, markWarmupStart } from "../../lib/perf/op-perf-marks.ts";
import { recycleWarmRomWeaverRunner } from "../../workers/rom-weaver/runner-control.ts";

// Checksums the real first ROM-load op computes inline during ingest. The warmup requests them too so
// the inline StreamingChecksum decode path is warm; measured on a prod build, that path is ~25ms of the
// first op and is NOT warmed by an extract without checksums.
const WARMUP_CHECKSUM_ALGORITHMS = ["crc32", "md5", "sha1"];

// Tiny embedded ZIP for a silent page-load ingest. Unlike a CHD fixture, it
// warms both shared worker/OPFS setup and the common libarchive+checksum path,
// while finishing quickly enough to precede most first drops.
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

// Best-effort, single-flight warmup of the real ingest path. Cleans only its own
// returned outputs and never scans another tab's OPFS entries.
const warmupBrowserRuntimeExtraction = async (): Promise<void> => {
  if (warmupExtractionStarted) return;
  warmupExtractionStarted = true;
  const { browserRuntime } = await import("./workflow-runtime.ts");
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
      identify: false,
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
  // Still inside the idle warmup task, trim surplus runners while retaining the one that just exercised
  // extraction. This keeps first-drop worker/JIT state warm without leaving the whole preload pool resident.
  // Self-guards (no-op if disabled or a run is active). Best-effort, like the warmup itself.
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
