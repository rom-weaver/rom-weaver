import { getManagedOpfsDirectory } from "../../workers/protocol/opfs-path.ts";
import { browserRuntime } from "./workflow-runtime.ts";

// OPFS scratch pool directory; never swept, it is the warm scratch pool real extractions reuse.
const SCRATCH_DIRECTORY_NAME = ".rom-weaver-opfs-scratch";
const WARMUP_ARTIFACT_MARKER = "rom-weaver-warmup";

type OpfsDirectoryEntriesHandle = FileSystemDirectoryHandle & {
  entries: () => AsyncIterableIterator<[string, FileSystemHandle]>;
};

// A tiny pre-generated CHD CD image (cue + bin, 355 bytes) embedded as base64. It is used only to run
// one silent end-to-end extraction on page load so the decode-path JIT, OPFS input/output sync-access
// handles, and the scratch/finalize paths are warm before the user's first real extraction. Profiling
// showed the first extract of a session pays ~20ms of this cold-path cost that runner init alone does
// not cover; pre-paying it here makes the first real extract start at steady state.
const WARMUP_CHD_BASE64 =
  "TUNvbXBySEQAAAB8AAAABWNkbHpjZHpsY2RmbAAAAAAAAAAAAACZAAAAAAAAAAFJAAAAAAAAAHwAAEyAAAAJkJdNQG3EBHyGraS7aIcpQFWO3F74ZGlORPPp" +
  "cYztSAcnZ/ftE4Tx2V8AAAAAAAAAAAAAAAAAAAAAAAAAAENIVDIBAABVAAAAAAAAAABUUkFDSzoxIFRZUEU6TU9ERTEgU1VCVFlQRTpOT05FIEZSQU1FUzox" +
  "NiBQUkVHQVA6MCBQR1RZUEU6TU9ERTEgUEdTVUI6Tk9ORSBQT1NUR0FQOjAAAAAz7cGxCQAgDAAwZ3/xCCcpqIX+f4x/SJKsWHHnHpWnNwAAAAAAAAAAAAAA" +
  "AAAAAAAAgP89Y2AYBaNg5AIA//h5GAAJL3YAAAAAAAA1h//4eRgBCS8dAAAAAAAAOCNjYBgFo2DkAgAAAAAKAAAAAADhAPoGAAAAARERCn+By6e8mA==";

const WARMUP_CHD_FILE_NAME = "rom-weaver-warmup.chd";

let warmupExtractionStarted = false;

const emitWarmupTrace = (message: string, details?: Record<string, unknown>) => {
  if (typeof console === "undefined") return;
  const log = typeof console.debug === "function" ? console.debug : console.log;
  log.call(console, `[rom-weaver trace] browser-runtime-warmup: ${message}`, details || {});
};

const decodeBase64ToBytes = (value: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

const createWarmupChdFile = (): File | null => {
  if (typeof File !== "function" || typeof atob !== "function") return null;
  return new File([decodeBase64ToBytes(WARMUP_CHD_BASE64)], WARMUP_CHD_FILE_NAME);
};

const cleanupWarmupOutputs = async (outputs: ReadonlyArray<{ cleanup?: () => Promise<void> | void }>) => {
  for (const output of outputs) {
    await Promise.resolve(output?.cleanup?.()).catch(() => undefined);
  }
};

// Removes warmup artifacts (staged input + extracted/cue outputs, all named with the warmup marker)
// left in OPFS by a previous page load, while preserving the warm scratch pool. The current session's
// staged input stays locked by the live worker pool and cannot be removed until the next load — this
// runs at the start of warmup so each session cleans the prior session's now-unlocked leftovers,
// bounding accumulation to a single ~700 byte generation.
const sweepWarmupArtifacts = async (): Promise<void> => {
  const root = await getManagedOpfsDirectory().catch(() => null);
  if (!root) return;
  const sweep = async (directory: FileSystemDirectoryHandle): Promise<void> => {
    const childDirectories: FileSystemDirectoryHandle[] = [];
    const staleFileNames: string[] = [];
    for await (const [name, handle] of (directory as OpfsDirectoryEntriesHandle).entries()) {
      if (handle.kind === "directory") {
        if (name !== SCRATCH_DIRECTORY_NAME) childDirectories.push(handle as FileSystemDirectoryHandle);
        continue;
      }
      if (name.includes(WARMUP_ARTIFACT_MARKER)) staleFileNames.push(name);
    }
    for (const name of staleFileNames) await directory.removeEntry(name).catch(() => undefined);
    for (const childDirectory of childDirectories) await sweep(childDirectory);
  };
  await sweep(root).catch(() => undefined);
};

// Runs one tiny CHD list + extract end-to-end so every per-extraction code path is warm. Best-effort
// only: it is single-flight, swallows all errors, and sweeps prior-load warmup artifacts so warmup can
// never surface to the user or grow OPFS storage without bound.
const warmupBrowserRuntimeExtraction = async (): Promise<void> => {
  if (warmupExtractionStarted) return;
  warmupExtractionStarted = true;
  const compression = browserRuntime.compression;
  if (!compression?.extract) return;
  const file = createWarmupChdFile();
  if (!file) return;
  await sweepWarmupArtifacts();
  const source = { fileName: file.name, source: file };
  emitWarmupTrace("warmup extraction start");
  try {
    const listed = await compression.list?.({ format: "chd", options: {}, source });
    const entries = (listed?.entries || [])
      .map((entry) => entry.filename)
      .filter((entry): entry is string => typeof entry === "string" && !!entry);
    const result = await compression.extract({ entries, format: "chd", options: {}, source });
    await cleanupWarmupOutputs(result?.outputs || []);
    emitWarmupTrace("warmup extraction done", { entryCount: entries.length });
  } catch (error) {
    emitWarmupTrace("warmup extraction skipped", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

// Defers the warmup extraction to browser idle time so it never competes with initial render or the
// runner init it follows. Falls back to a macrotask when requestIdleCallback is unavailable.
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
