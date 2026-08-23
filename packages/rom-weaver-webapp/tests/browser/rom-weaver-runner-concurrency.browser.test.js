import { afterEach, expect, test } from "vitest";
import { browserRuntime } from "../../src/platform/browser/workflow-runtime.ts";
import {
  resetRomWeaverRunner,
  runRomWeaverJson,
  warmupRomWeaverRunner,
} from "../../src/workers/rom-weaver/rom-weaver-runner.ts";
import { WORKER_OPFS_MOUNTPOINT } from "../../src/workers/shared/worker-storage/storage-layout.ts";

// Stage 1 parallel-operation support: with the runner pool + scheduler, distinct operations can run on
// separate pooled runners at the same time. The scheduler's admission logic (thread budget, concurrency
// cap, path exclusivity) is unit-tested in runner-scheduler.test.ts; these tests close the integration
// gap by proving two *real* wasm runners (two workers, two wasm memories, two OPFS handle sets) coexist.

const encoder = new TextEncoder();

const failureDetails = (result) =>
  [
    `exitCode=${result?.exitCode}`,
    `ok=${result?.ok}`,
    result?.stderr,
    ...(Array.isArray(result?.nonJsonLines) ? result.nonJsonLines : []),
    result?.error?.message,
  ]
    .filter(Boolean)
    .join("\n");

const expectRunSucceeded = (result) => {
  expect(result?.exitCode, failureDetails(result)).toBe(0);
  expect(result?.ok, failureDetails(result)).toBe(true);
};

const canUseSharedMemory = () => typeof SharedArrayBuffer === "function" && globalThis.crossOriginIsolated === true;

const requireSharedMemory = () => {
  expect(
    canUseSharedMemory(),
    "threaded runner integration tests require SharedArrayBuffer and crossOriginIsolated",
  ).toBe(true);
};

const isRunnerLifecycleTrace = (line) =>
  line.includes("[browser-runner] runJson dispatch") ||
  line.includes("[runner-worker] runJson invoking runner") ||
  line.includes("[runner-worker] runJson runner returned");

const runnerLifecyclePhase = (line) => {
  if (line.includes("[browser-runner] runJson dispatch")) return "dispatch";
  return line.includes("runJson invoking runner") ? "invoke" : "return";
};

const stageBin = async (name, contents) => {
  const sourcePath = `${WORKER_OPFS_MOUNTPOINT}/${name}.bin`;
  await browserRuntime.vfs.truncate(sourcePath, 0);
  await browserRuntime.vfs.write(sourcePath, encoder.encode(contents), { fileOffset: 0 });
  return sourcePath;
};

afterEach(async () => {
  await resetRomWeaverRunner();
});

test("reuses an in-flight warmup runner for the first operation", async () => {
  requireSharedMemory();

  const runnerDiagnostics = [];
  const diagnosticChannel = new BroadcastChannel("rom-weaver-runtime-diagnostics");
  diagnosticChannel.addEventListener("message", ({ data }) => {
    if (data?.context === "rom-weaver browser runner") runnerDiagnostics.push(data);
  });

  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const input = await stageBin(`warmup-race-${runId}`, "rom-weaver warmup fixture\n".repeat(256));
  const output = `${WORKER_OPFS_MOUNTPOINT}/warmup-race-${runId}.zip`;

  try {
    const [, result] = await Promise.all([
      warmupRomWeaverRunner(),
      runRomWeaverJson({ args: { format: "zip", input: [input], output, threads: 1 }, type: "compress" }),
    ]);
    expectRunSucceeded(result);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(runnerDiagnostics).toHaveLength(1);
  } finally {
    diagnosticChannel.close();
    await browserRuntime.vfs.remove(input).catch(() => undefined);
    await browserRuntime.vfs.remove(output).catch(() => undefined);
  }
});

test("runs two compress operations concurrently on separate pooled runners", async () => {
  // Concurrency requires the threaded runtime; the single-threaded fallback serializes regardless.
  requireSharedMemory();
  // Prewarm both pooled runners so lifecycle traces observe operation overlap, not runner startup.
  await Promise.all([warmupRomWeaverRunner(), warmupRomWeaverRunner()]);

  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const aIn = await stageBin(`concurrent-a-${runId}`, "rom-weaver concurrency fixture A\n".repeat(256));
  const bIn = await stageBin(`concurrent-b-${runId}`, "rom-weaver concurrency fixture B\n".repeat(256));
  const aOut = `${WORKER_OPFS_MOUNTPOINT}/concurrent-a-${runId}.zip`;
  const bOut = `${WORKER_OPFS_MOUNTPOINT}/concurrent-b-${runId}.zip`;
  const cleanup = [aIn, bIn, aOut, bOut];
  const lifecycle = [];
  const collectLifecycle = (operation) => (line) => {
    if (isRunnerLifecycleTrace(line)) lifecycle.push({ operation, phase: runnerLifecyclePhase(line) });
  };

  try {
    // Fire both without awaiting between them - each requests a single thread, so the scheduler admits
    // both at once (1 + 1 <= budget, two disjoint path sets, concurrency cap 2).
    const [aResult, bResult] = await Promise.all([
      runRomWeaverJson(
        { args: { format: "zip", input: [aIn], output: aOut, threads: 1 }, type: "compress" },
        { onTraceNonJsonLine: collectLifecycle("a") },
      ),
      runRomWeaverJson(
        { args: { format: "zip", input: [bIn], output: bOut, threads: 1 }, type: "compress" },
        { onTraceNonJsonLine: collectLifecycle("b") },
      ),
    ]);
    expectRunSucceeded(aResult);
    expectRunSucceeded(bResult);
    const dispatches = lifecycle.filter(({ phase }) => phase === "dispatch");
    const workerLifecycle = lifecycle.filter(({ phase }) => phase !== "dispatch");
    expect(dispatches, `runner lifecycle: ${JSON.stringify(lifecycle)}`).toHaveLength(2);
    expect(new Set(dispatches.map(({ operation }) => operation)).size).toBe(2);
    expect(workerLifecycle, `runner lifecycle: ${JSON.stringify(lifecycle)}`).toHaveLength(4);
    expect(workerLifecycle.map(({ phase }) => phase)).toEqual(["invoke", "invoke", "return", "return"]);
    expect(new Set(workerLifecycle.slice(0, 2).map(({ operation }) => operation)).size).toBe(2);
    expect((await browserRuntime.vfs.stat(aOut))?.size || 0).toBeGreaterThan(0);
    expect((await browserRuntime.vfs.stat(bOut))?.size || 0).toBeGreaterThan(0);

    // Both outputs are independently valid archives.
    const [aChecksum, bChecksum] = await Promise.all([
      runRomWeaverJson({ args: { algo: ["crc32"], no_extract: true, input: aOut }, type: "checksum" }),
      runRomWeaverJson({ args: { algo: ["crc32"], no_extract: true, input: bOut }, type: "checksum" }),
    ]);
    expectRunSucceeded(aChecksum);
    expectRunSucceeded(bChecksum);
  } finally {
    for (const path of cleanup) await browserRuntime.vfs.remove(path).catch(() => undefined);
  }
});

test("safely serializes two operations that read the same source path", async () => {
  requireSharedMemory();
  await warmupRomWeaverRunner();

  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const shared = await stageBin(`shared-source-${runId}`, "rom-weaver shared-source fixture\n".repeat(256));
  const out1 = `${WORKER_OPFS_MOUNTPOINT}/shared-source-${runId}-1.zip`;
  const out2 = `${WORKER_OPFS_MOUNTPOINT}/shared-source-${runId}-2.zip`;
  const cleanup = [shared, out1, out2];
  const lifecycle = [];
  const collectLifecycle = (operation) => (line) => {
    if (isRunnerLifecycleTrace(line)) lifecycle.push({ operation, phase: runnerLifecyclePhase(line) });
  };

  try {
    // Both single-thread compresses read the same input. The scheduler's path-exclusivity guard runs
    // them one at a time so they never contend on the same OPFS sync access handle; both still succeed.
    const [r1, r2] = await Promise.all([
      runRomWeaverJson(
        { args: { format: "zip", input: [shared], output: out1, threads: 1 }, type: "compress" },
        { onTraceNonJsonLine: collectLifecycle("first") },
      ),
      runRomWeaverJson(
        { args: { format: "zip", input: [shared], output: out2, threads: 1 }, type: "compress" },
        { onTraceNonJsonLine: collectLifecycle("second") },
      ),
    ]);
    expectRunSucceeded(r1);
    expectRunSucceeded(r2);
    const workerLifecycle = lifecycle.filter(({ phase }) => phase !== "dispatch");
    expect(workerLifecycle, `runner lifecycle: ${JSON.stringify(lifecycle)}`).toHaveLength(4);
    expect(workerLifecycle[0]?.phase).toBe("invoke");
    expect(workerLifecycle[1]?.phase).toBe("return");
    expect(workerLifecycle[1]?.operation).toBe(workerLifecycle[0]?.operation);
    expect(workerLifecycle[2]?.phase).toBe("invoke");
    expect(workerLifecycle[2]?.operation).not.toBe(workerLifecycle[0]?.operation);
    expect(workerLifecycle[3]?.phase).toBe("return");
    expect(workerLifecycle[3]?.operation).toBe(workerLifecycle[2]?.operation);
    expect((await browserRuntime.vfs.stat(out1))?.size || 0).toBeGreaterThan(0);
    expect((await browserRuntime.vfs.stat(out2))?.size || 0).toBeGreaterThan(0);
  } finally {
    for (const path of cleanup) await browserRuntime.vfs.remove(path).catch(() => undefined);
  }
});
