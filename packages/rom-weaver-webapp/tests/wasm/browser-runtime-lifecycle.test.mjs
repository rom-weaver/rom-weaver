import { afterEach, expect, it } from "vitest";
import { browserRuntime } from "../../src/platform/browser/workflow-runtime.ts";
import { resetRomWeaverRunner, setInputSelectionHandler } from "../../src/workers/rom-weaver/runner-control.ts";
import { createBrowserWorkerClient } from "../../src/wasm/workers/browser-worker-client.ts";
import { SELECT_REQUEST_COUNT_INDEX } from "../../src/wasm/workers/worker-protocol.ts";
import workerUrl from "../../src/wasm/workers/browser-runner-worker.ts?worker&url";
import { buildStoredZip } from "./stored-zip-fixture.mjs";
import { assertRunJsonSucceeded, toTypedRunInput, writeGuestFile } from "./test-helpers.mjs";

const HEAVY = typeof __ROM_WEAVER_WASM_EXHAUSTIVE__ !== "undefined" && __ROM_WEAVER_WASM_EXHAUSTIVE__;
const CASES = HEAVY ? 12 : 2;
const TIMEOUT = HEAVY ? 600000 : 120000;
const roots = new Set();
const clients = new Set();
const traceGauge = /live=(\d+) peak=(\d+) opened=(\d+) adapterBufferBytes=(\d+)/;

class MeasuredWorker extends Worker {
  listeners = new Map();
  terminated = false;

  addEventListener(type, listener, options) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
    return super.addEventListener(type, listener, options);
  }

  removeEventListener(type, listener, options) {
    this.listeners.get(type)?.delete(listener);
    return super.removeEventListener(type, listener, options);
  }

  terminate() {
    this.terminated = true;
    return super.terminate();
  }

  get listenerCount() {
    return [...this.listeners.values()].reduce((sum, entries) => sum + entries.size, 0);
  }
}

async function createClient(handle) {
  const worker = new MeasuredWorker(workerUrl, { type: "module" });
  const client = createBrowserWorkerClient({ worker, defaultThreads: 1 });
  clients.add(client);
  await client.init({
    defaultThreads: 1,
    opfsHandle: handle,
    runtimeMounts: ["/work"],
    wasmUrl: new URL("../../src/wasm/rom-weaver-app.wasm", import.meta.url).href,
    workGuestPath: "/work",
  });
  return { client, worker };
}

function assertResourceGauge(trace) {
  const line = trace.findLast((entry) => entry.includes("[perf] opfs proxy handles"));
  expect(line, "a completed native operation must report its handle census").toBeTruthy();
  const gauge = traceGauge.exec(line);
  expect(gauge).not.toBeNull();
  expect(Number(gauge[1])).toBeLessThanOrEqual(64);
  expect(Number(gauge[2])).toBeLessThanOrEqual(64);
  expect(Number(gauge[3])).toBeGreaterThan(0);
  expect(Number(gauge[4])).toBeLessThanOrEqual(64 * 1024 * 1024);
}

async function operationScopes() {
  const root = await navigator.storage.getDirectory();
  try {
    const operations = await root.getDirectoryHandle("operations");
    const names = [];
    for await (const [name] of operations.entries()) names.push(name);
    return names.sort();
  } catch (error) {
    if (error.name === "NotFoundError") return [];
    throw error;
  }
}

async function childNames(root, name) {
  try {
    const directory = await root.getDirectoryHandle(name);
    const names = [];
    for await (const [entry] of directory.entries()) names.push(entry);
    return names;
  } catch (error) {
    if (error.name === "NotFoundError") return [];
    throw error;
  }
}

afterEach(async () => {
  setInputSelectionHandler();
  for (const client of clients) client.terminate();
  clients.clear();
  await resetRomWeaverRunner({ terminate: true });
  const root = await navigator.storage.getDirectory();
  for (const name of roots) await root.removeEntry(name, { recursive: true });
  roots.clear();
});

it(
  "real worker isolates stale wire responses, disposes handles, and releases pending selections",
  async () => {
    for (let seed = 1; seed <= CASES; seed += 1) {
      console.debug("[quality-runtime] real worker lifecycle seed", seed);
      const root = await navigator.storage.getDirectory();
      const name = `lifecycle-real-${seed}-${crypto.randomUUID()}`;
      roots.add(name);
      const handle = await root.getDirectoryHandle(name, { create: true });
      await writeGuestFile(handle, "/work/source.bin", new Uint8Array([seed, 2, 3, 4]));
      await writeGuestFile(handle, "/work/archive.zip", buildStoredZip(2, 257));
      const { client, worker } = await createClient(handle);
      const wire = [];
      const capture = ({ data }) => {
        if (data.type === "result") wire.push(data);
      };
      worker.addEventListener("message", capture);
      const trace = [];
      assertRunJsonSucceeded(
        await client.runJson(
          toTypedRunInput([
            "checksum",
            "--input",
            "/work/source.bin",
            "--algo",
            "crc32",
            "--no-extract",
            "--threads",
            "1",
          ]),
          { onTraceNonJsonLine: (line) => trace.push(line) },
        ),
      );
      assertResourceGauge(trace);
      expect(client._pending.size).toBe(0);
      await expect.poll(() => wire.length).toBe(1);

      let answer;
      let selected = false;
      client.setSelectionHandler(() => {
        selected = true;
        return new Promise((resolve) => {
          answer = resolve;
        });
      });
      let settled = false;
      const run = client
        .runJson(
          toTypedRunInput(["extract", "--input", "/work/archive.zip", "--out-dir", "/work/selected", "--threads", "1"]),
          { interactive_selection_enabled: true },
        )
        .then((value) => {
          settled = true;
          return value;
        });
      await expect.poll(() => selected, { timeout: 60000 }).toBe(true);
      expect(client._pending.size).toBe(1);
      expect(client._openSelectResponders.size).toBe(1);
      worker.dispatchEvent(new MessageEvent("message", { data: wire[0] }));
      await Promise.resolve();
      expect(settled, `seed=${seed}: stale native response must not settle a newer request`).toBe(false);
      expect(client._pending.size).toBe(1);
      answer([seed % 2]);
      assertRunJsonSucceeded(await run);
      expect(client._pending.size).toBe(0);
      expect(client._openSelectResponders.size).toBe(0);
      expect(await childNames(handle, "selected")).toEqual([`entry-${String(seed % 2).padStart(5, "0")}.bin`]);
      await expect(client.dispose()).resolves.toEqual({ disposed: true });
      expect(client._pending.size).toBe(0);
      const sourceHandle = await handle.getFileHandle("source.bin");
      const writer = await sourceHandle.createWritable({ keepExistingData: true });
      await writer.close();
      worker.removeEventListener("message", capture);
      client.terminate();
      client.terminate();
      expect(worker.listenerCount).toBe(0);
      expect(worker.terminated).toBe(true);
      await expect(client.runJson(toTypedRunInput(["probe", "--input", "/work/source.bin"]))).rejects.toThrow(
        "terminated",
      );

      const replacement = await createClient(handle);
      let blocked = false;
      let lateAnswer;
      let selectionControl;
      const captureSelection = ({ data }) => {
        if (data.type === "selectRequest") selectionControl = new Int32Array(data.control);
      };
      replacement.worker.addEventListener("message", captureSelection);
      replacement.client.setSelectionHandler(() => {
        blocked = true;
        return new Promise((resolve) => {
          lateAnswer = resolve;
        });
      });
      const cancelled = replacement.client
        .runJson(
          toTypedRunInput([
            "extract",
            "--input",
            "/work/archive.zip",
            "--out-dir",
            "/work/cancelled",
            "--threads",
            "1",
          ]),
          { interactive_selection_enabled: true },
        )
        .catch((error) => error);
      await expect.poll(() => blocked, { timeout: 60000 }).toBe(true);
      await expect.poll(() => selectionControl).toBeDefined();
      replacement.worker.removeEventListener("message", captureSelection);
      replacement.client.terminate();
      expect(await cancelled).toBeInstanceOf(Error);
      lateAnswer([0]);
      await new Promise((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
          channel.port1.close();
          channel.port2.close();
          resolve();
        };
        channel.port2.postMessage(null);
      });
      expect(Atomics.load(selectionControl, SELECT_REQUEST_COUNT_INDEX)).toBeLessThan(0);
      expect(replacement.client._pending.size).toBe(0);
      expect(replacement.client._openSelectResponders.size).toBe(0);
      expect(replacement.worker.listenerCount).toBe(0);
      expect(await childNames(handle, "cancelled")).toEqual([]);
      const archiveHandle = await handle.getFileHandle("archive.zip");
      await expect
        .poll(
          async () => {
            try {
              const writer = await archiveHandle.createWritable({ keepExistingData: true });
              await writer.close();
              return true;
            } catch (error) {
              if (error.name === "NoModificationAllowedError" || error.name === "InvalidStateError") return false;
              throw error;
            }
          },
          { timeout: 30000 },
        )
        .toBe(true);
    }
  },
  TIMEOUT,
);

it(
  "real WASM cancellation and malformed input never publish outputs or poison a retry",
  async () => {
    for (let seed = 1; seed <= CASES; seed += 1) {
      console.debug("[quality-runtime] output ownership lifecycle seed", seed);
      await resetRomWeaverRunner({ terminate: true });
      // Scope checks MUST ignore other browser test pages sharing this origin's OPFS.
      const ownedIds = new Set();
      const originalDescriptor = Object.getOwnPropertyDescriptor(crypto, "randomUUID");
      const originalRandomUUID = crypto.randomUUID.bind(crypto);
      crypto.randomUUID = () => {
        const id = originalRandomUUID();
        ownedIds.add(id);
        return id;
      };
      const ownedScopes = async () => (await operationScopes()).filter((name) => ownedIds.has(name));
      let oldAnswer;
      const verifyAndDispose = async (outputs) => {
        expect(outputs).toHaveLength(2);
        for (const output of outputs) {
          expect(output.path).toMatch(/^\/work\/operations\/[^/]+\//);
          expect(ownedIds.has(output.path.split("/")[3])).toBe(true);
          const blob = await browserRuntime.publicOutput.getBlob(output);
          const bytes = new Uint8Array(await blob.arrayBuffer());
          expect(bytes).toEqual(Uint8Array.from({ length: 257 }, (_, index) => index & 255));
          await output.dispose();
          await output.dispose();
          expect(await browserRuntime.vfs.stat(output.path)).toBeNull();
        }
      };
      try {
        const archive = buildStoredZip(2, 257);
        const source = new File([archive], `runtime-${seed}.zip`, { type: "application/zip" });
        let requested = false;
        setInputSelectionHandler(() => {
          requested = true;
          return new Promise((resolve) => {
            oldAnswer = resolve;
          });
        });
        const abort = new AbortController();
        const pending = browserRuntime.ingest
          .run({
            source,
            identify: false,
            checksumAlgorithms: ["crc32"],
            interactiveSelectionEnabled: true,
            signal: abort.signal,
          })
          .then(
            (value) => ({ value }),
            (error) => ({ error }),
          );
        await expect.poll(() => requested, { timeout: 60000 }).toBe(true);
        abort.abort();
        const cancelled = await pending;
        expect(cancelled.value).toBeUndefined();
        expect(cancelled.error).toMatchObject({ name: "AbortError", code: "CANCELLED" });
        expect(await ownedScopes(), `seed=${seed}: cancellation leaked an output scope`).toEqual([]);
        if (seed % 2) await resetRomWeaverRunner({ terminate: true });

        const retry = browserRuntime.ingest.run({
          source,
          identify: false,
          checksumAlgorithms: ["crc32"],
          select: ["entry-00000.bin", "entry-00001.bin"],
        });
        oldAnswer([0]);
        setInputSelectionHandler();
        const result = await retry;
        await verifyAndDispose(result.outputs);
        expect(await ownedScopes()).toEqual([]);

        const corrupt = archive.slice();
        const localSize = 30 + new TextEncoder().encode("entry-00000.bin").length + 257;
        corrupt[localSize + 30 + new TextEncoder().encode("entry-00001.bin").length] ^= 1;
        const failure = await browserRuntime.ingest
          .run({
            source: new File([corrupt], `corrupt-${seed}.zip`, { type: "application/zip" }),
            identify: false,
            checksumAlgorithms: ["crc32"],
            select: ["entry-00000.bin", "entry-00001.bin"],
          })
          .then(
            (value) => ({ value }),
            (error) => ({ error }),
          );
        expect(failure.value).toBeUndefined();
        expect(failure.error).toBeInstanceOf(Error);
        expect(failure.error.message).toMatch(/bad crc|crc(?:32)? (?:mismatch|invalid)|checksum (?:mismatch|invalid)/i);
        expect(await ownedScopes(), `seed=${seed}: failed second member leaked the first output`).toEqual([]);
        const afterFailure = await browserRuntime.ingest.run({
          source,
          identify: false,
          select: ["entry-00000.bin", "entry-00001.bin"],
        });
        await verifyAndDispose(afterFailure.outputs);
        expect(await ownedScopes()).toEqual([]);
        await resetRomWeaverRunner({ terminate: true });
        await resetRomWeaverRunner({ terminate: true });
      } finally {
        oldAnswer?.([]);
        if (originalDescriptor) Object.defineProperty(crypto, "randomUUID", originalDescriptor);
        else Reflect.deleteProperty(crypto, "randomUUID");
      }
    }
  },
  TIMEOUT,
);
