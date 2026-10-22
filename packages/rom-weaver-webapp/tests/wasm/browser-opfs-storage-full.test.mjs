import { expect, it } from "vitest";
import { joinGuestPath, withTempFixture, writeGuestFile } from "./test-helpers.mjs";

const MiB = 1024 * 1024;
// Chromium caps an ephemeral profile's in-memory OPFS at a share of physical RAM (about 1 GiB on a
// 16 GB host). The probe stops here so a host with a larger cap does not hold gigabytes in memory.
const FILL_LIMIT_BYTES = 2048 * MiB;
const FILLER_NAME = "rom-weaver-storage-full-filler.bin";
// quality-reason: filling origin storage fails any wasm test file running alongside in the same
// browser context, so this runs only on request, alone: ROM_WEAVER_WASM_STORAGE_FULL=1 npm run test:browser:wasm -- <this file>.
const RUN_STORAGE_FULL = import.meta.env.ROM_WEAVER_WASM_STORAGE_FULL === "1";

// Runs in a Dedicated Worker because sync access handles are unavailable on the main thread. Writes
// until Chromium reports its out-of-storage count (2^32 - 8) instead of the bytes it wrote.
const fillerWorkerSource = `
onmessage = async ({ data: { name, limit } }) => {
  const root = await navigator.storage.getDirectory();
  const handle = await (await root.getFileHandle(name, { create: true })).createSyncAccessHandle();
  const chunk = new Uint8Array(${64 * MiB});
  let offset = 0;
  let full = false;
  try {
    while (offset < limit) {
      const count = handle.write(chunk, { at: offset });
      if (count !== chunk.byteLength) { full = true; break; }
      offset += count;
    }
  } catch (error) {
    full = error?.name === "QuotaExceededError";
  } finally {
    handle.close();
  }
  postMessage({ full, offset });
};`;

async function fillOriginStorage() {
  const worker = new Worker(URL.createObjectURL(new Blob([fillerWorkerSource], { type: "text/javascript" })));
  try {
    return await new Promise((resolve, reject) => {
      worker.onmessage = ({ data }) => resolve(data);
      worker.onerror = (event) => reject(new Error(`storage filler worker failed: ${event.message}`));
      worker.postMessage({ limit: FILL_LIMIT_BYTES, name: FILLER_NAME });
    });
  } finally {
    worker.terminate();
  }
}

async function gzipZeros(byteLength) {
  const chunk = new Uint8Array(16 * MiB);
  let remaining = byteLength;
  const zeros = new ReadableStream({
    pull(controller) {
      if (remaining <= 0) return controller.close();
      const size = Math.min(remaining, chunk.byteLength);
      controller.enqueue(chunk.subarray(0, size));
      remaining -= size;
    },
  });
  return new Uint8Array(await new Response(zeros.pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
}

it.runIf(RUN_STORAGE_FULL)(
  "reports a wasm write past full browser storage as no space left, not a generic I/O error",
  async (ctx) => {
    const compressed = await gzipZeros(256 * MiB);
    const root = await navigator.storage.getDirectory();
    try {
      await withTempFixture(async ({ dir, opfsHandle, worker }) => {
        const input = joinGuestPath(dir, "zeros.bin.gz");
        await writeGuestFile(opfsHandle, input, compressed);
        const fill = await fillOriginStorage();
        // quality-reason: only an origin whose storage fills within FILL_LIMIT_BYTES (Chromium's ephemeral
        // test profile on CI-sized hosts) reaches the out-of-storage write path.
        if (!fill.full) ctx.skip(`origin storage did not fill within ${fill.offset} bytes`);

        const failed = await worker.runJson(["extract", "--input", input, "--out-dir", joinGuestPath(dir, "out")]);
        const report = JSON.stringify({
          error: failed.error?.message,
          events: failed.events?.slice(-2),
          ok: failed.ok,
        });
        expect(failed.ok, report).toBe(false);
        expect(report).toMatch(/no space left|os error 51/i);
        expect(report).not.toMatch(/os error 29/);
      });
    } finally {
      await root.removeEntry(FILLER_NAME).catch(() => undefined);
    }
  },
);
