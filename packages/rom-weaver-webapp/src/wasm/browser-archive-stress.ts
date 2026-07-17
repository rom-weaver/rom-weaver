import {
  resolveAppleMobileSharedMemoryMaximumPages,
  resolveMemoryCeilingBytes,
} from "../lib/runtime/op-memory-estimate.ts";
import type { BrowserFormatMatrixStep, BrowserFormatMatrixSummary } from "./browser-format-matrix.ts";
import { createRomWeaverCommand } from "./rom-weaver-command.ts";
import type { RomWeaverRunJsonEvent } from "./rom-weaver-types.d.ts";
import { createBrowserWorkerClient } from "./workers/browser-worker-client.ts";

const ACTIVE_CASE_KEY = "rom-weaver-ios-stress-active-case";
const CORPUS_MANIFEST_URL = "/__rom_weaver_corpus__/manifest.json";
const OPFS_GUEST_ROOT = "/work";

type ArchiveStressCase = {
  compressedBytes: number;
  entryCount: number | null;
  expectedSha256: string | null;
  fileName: string;
  id: string;
  kind: "generated" | "local";
  sha256: string;
  uncompressedBytes: number | null;
  url: string;
};
type ArchiveStressManifest = { cases: ArchiveStressCase[]; generatedAt: string; version: number };
type ArchiveStressOptions = {
  onEvent?: (event: RomWeaverRunJsonEvent) => void;
  onStep?: (step: BrowserFormatMatrixStep) => void;
};

const getInterruptedArchiveStressCase = (): { id: string; startedAt: string } | null => {
  try {
    const raw = localStorage.getItem(ACTIVE_CASE_KEY);
    localStorage.removeItem(ACTIVE_CASE_KEY);
    const value = JSON.parse(raw || "null");
    return value && typeof value.id === "string" && typeof value.startedAt === "string" ? value : null;
  } catch {
    return null;
  }
};

const setActiveCase = (testCase: ArchiveStressCase | null) => {
  if (!testCase) {
    localStorage.removeItem(ACTIVE_CASE_KEY);
    return;
  }
  localStorage.setItem(ACTIVE_CASE_KEY, JSON.stringify({ id: testCase.id, startedAt: new Date().toISOString() }));
};

const getFileHandle = async (root: FileSystemDirectoryHandle, relativePath: string, create = false) => {
  const parts = relativePath.split("/").filter(Boolean);
  const fileName = parts.pop();
  if (!fileName) throw new Error(`Invalid OPFS path: ${relativePath}`);
  let directory = root;
  for (const part of parts) directory = await directory.getDirectoryHandle(part, { create });
  return directory.getFileHandle(fileName, { create });
};

const writeResponseToOpfs = async (root: FileSystemDirectoryHandle, guestPath: string, response: Response) => {
  if (!response.body) throw new Error(`Corpus response has no body: ${response.url}`);
  const relativePath = guestPath.replace(/^\/work\/?/, "");
  const handle = await getFileHandle(root, relativePath, true);
  const writable = await handle.createWritable();
  await response.body.pipeTo(writable);
};

const terminalEvent = (events: RomWeaverRunJsonEvent[]) => {
  const event = events.at(-1);
  if (!event) throw new Error("Archive stress command emitted no events");
  return event;
};

const getEmittedFiles = (event: RomWeaverRunJsonEvent) => {
  const details =
    event.details && typeof event.details === "object" && !Array.isArray(event.details) ? event.details : {};
  const emitted = (details as Record<string, unknown>).emitted_files;
  return Array.isArray(emitted) ? emitted.filter((entry) => entry && typeof entry === "object") : [];
};

const verifyEmittedFiles = (testCase: ArchiveStressCase, event: RomWeaverRunJsonEvent) => {
  const emitted = getEmittedFiles(event) as Array<Record<string, unknown>>;
  if (testCase.entryCount !== null && emitted.length !== testCase.entryCount) {
    throw new Error(`${testCase.id}: expected ${testCase.entryCount} emitted files, got ${emitted.length}`);
  }
  if (testCase.uncompressedBytes !== null) {
    const total = emitted.reduce((sum, entry) => sum + Number(entry.size_bytes || 0), 0);
    if (total !== testCase.uncompressedBytes) {
      throw new Error(`${testCase.id}: expected ${testCase.uncompressedBytes} output bytes, got ${total}`);
    }
  }
  if (testCase.expectedSha256) {
    const hashes = emitted
      .map((entry) => entry.checksums)
      .filter((checksums) => checksums && typeof checksums === "object")
      .map((checksums) => String((checksums as Record<string, unknown>).sha256 || ""));
    if (!hashes.includes(testCase.expectedSha256)) {
      throw new Error(`${testCase.id}: extracted sha256 did not match ${testCase.expectedSha256}`);
    }
  }
};

const loadManifest = async (): Promise<ArchiveStressManifest> => {
  const response = await fetch(CORPUS_MANIFEST_URL, { cache: "no-store" });
  if (!response.ok) throw new Error(`Archive corpus manifest failed: ${response.status} ${response.statusText}`);
  const manifest = (await response.json()) as ArchiveStressManifest;
  if (manifest.version !== 1 || !Array.isArray(manifest.cases)) throw new Error("Unsupported archive corpus manifest");
  return manifest;
};

const runBrowserArchiveStress = async (options: ArchiveStressOptions = {}): Promise<BrowserFormatMatrixSummary> => {
  const interrupted = getInterruptedArchiveStressCase();
  if (interrupted) {
    throw new Error(`Previous archive case ${interrupted.id} was interrupted after ${interrupted.startedAt}`);
  }
  const manifest = await loadManifest();
  const root = await navigator.storage.getDirectory();
  const steps: BrowserFormatMatrixStep[] = [];
  const startedAt = performance.now();

  for (const testCase of manifest.cases) {
    const caseStartedAt = performance.now();
    const running: BrowserFormatMatrixStep = {
      command: "extract",
      name: testCase.id,
      status: "running",
      timestamp: new Date().toISOString(),
    };
    steps.push(running);
    options.onStep?.(running);
    setActiveCase(testCase);
    const directoryName = `rom-weaver-ios-stress-${testCase.id}-${Date.now()}`;
    const sourcePath = `${OPFS_GUEST_ROOT}/${directoryName}/${testCase.fileName}`;
    const outDir = `${OPFS_GUEST_ROOT}/${directoryName}/out`;
    const worker = createBrowserWorkerClient({});
    try {
      const response = await fetch(testCase.url, { cache: "no-store" });
      if (!response.ok) throw new Error(`${testCase.id}: fixture fetch failed with ${response.status}`);
      await writeResponseToOpfs(root, sourcePath, response);
      const sharedMemoryMaximumPages = resolveAppleMobileSharedMemoryMaximumPages();
      await worker.init({
        runtimeMounts: [OPFS_GUEST_ROOT],
        ...(sharedMemoryMaximumPages ? { sharedMemoryMaximumPages } : {}),
        wasmUrl: new URL("./rom-weaver-app.wasm", import.meta.url).href,
        workGuestPath: OPFS_GUEST_ROOT,
      });
      const events: RomWeaverRunJsonEvent[] = [];
      const result = await worker.runJson(
        createRomWeaverCommand("extract", {
          checksum: ["sha256"],
          out_dir: outDir,
          source: sourcePath,
          threads: "auto",
        }),
        {
          onEvent(event) {
            events.push(event);
            options.onEvent?.(event);
          },
        },
      );
      const terminal = terminalEvent(events);
      if (!result.ok || result.exitCode !== 0 || terminal.status !== "succeeded") {
        throw new Error(`${testCase.id}: ${terminal.label || result.stderr || "extract failed"}`);
      }
      verifyEmittedFiles(testCase, terminal);
      const succeeded: BrowserFormatMatrixStep = {
        command: `extract ceiling=${resolveMemoryCeilingBytes()} effectiveThreads=${terminal.effective_threads ?? "unknown"}`,
        durationMs: Math.round(performance.now() - caseStartedAt),
        name: testCase.id,
        status: "succeeded",
        terminalStatus: terminal.status,
        timestamp: new Date().toISOString(),
      };
      steps.push(succeeded);
      options.onStep?.(succeeded);
      setActiveCase(null);
    } catch (error) {
      setActiveCase(null);
      const failed: BrowserFormatMatrixStep = {
        command: "extract",
        durationMs: Math.round(performance.now() - caseStartedAt),
        error: error instanceof Error ? error.message : String(error),
        name: testCase.id,
        status: "failed",
        timestamp: new Date().toISOString(),
      };
      steps.push(failed);
      options.onStep?.(failed);
      throw error;
    } finally {
      worker.terminate();
      await root.removeEntry(directoryName, { recursive: true }).catch(() => undefined);
    }
  }

  return {
    durationMs: Math.round(performance.now() - startedAt),
    failedSteps: steps.filter((step) => step.status === "failed").length,
    passedSteps: steps.filter((step) => step.status === "succeeded").length,
    steps,
  };
};

export { getInterruptedArchiveStressCase, runBrowserArchiveStress };
