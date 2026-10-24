// libarchive's 7z writer spools compressed data into an unlinked temp file (`libarchive_XXXXXX`).
// The OPFS backing entry for that temp file MUST be gone once the run ends.

import { expect, it } from "vitest";
import { createRomWeaverCommand } from "../../src/wasm/rom-weaver-command.ts";
import { resetRomWeaverRunner, runRomWeaverJson } from "../../src/workers/rom-weaver/rom-weaver-runner.ts";
import { assertRunJsonSucceeded, joinGuestPath, withTempFixture, writeGuestFile } from "./test-helpers.mjs";

async function leakedTempNames(rootHandle) {
  const names = [];
  for await (const [name] of rootHandle.entries()) {
    if (name.startsWith("libarchive_")) names.push(name);
  }
  return names;
}

it("7z compress removes its libarchive temp file from OPFS", { timeout: 120000 }, async () => {
  await withTempFixture(async ({ dir, opfsHandle, worker }) => {
    const input = joinGuestPath(dir, "payload.bin");
    const bytes = new Uint8Array(256 * 1024);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 31) & 0xff;
    await writeGuestFile(opfsHandle, input, bytes);
    assertRunJsonSucceeded(
      await worker.runJson([
        "compress",
        "--input",
        input,
        "--format",
        "7z",
        "--output",
        joinGuestPath(dir, "out.7z"),
        "--threads",
        "1",
      ]),
      { command: "compress" },
    );
    expect(await leakedTempNames(opfsHandle)).toEqual([]);
  });
});

it("cancelled 7z compress leaves no libarchive temp or partial output in OPFS", { timeout: 180000 }, async () => {
  const root = await navigator.storage.getDirectory();
  const scope = `cancel-7z-${crypto.randomUUID()}`;
  const bytes = new Uint8Array(24 * 1024 * 1024);
  for (let offset = 0; offset < bytes.length; offset += 65536) {
    crypto.getRandomValues(bytes.subarray(offset, Math.min(offset + 65536, bytes.length)));
  }
  await writeGuestFile(root, `/work/${scope}/big.bin`, bytes);
  const abort = new AbortController();
  let started = false;
  try {
    const run = runRomWeaverJson(
      createRomWeaverCommand("compress", {
        input: [`/work/${scope}/big.bin`],
        format: "7z",
        output: `/work/${scope}/big.7z`,
        threads: "1",
      }),
      { onTraceNonJsonLine: () => (started = true), signal: abort.signal },
    ).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await expect.poll(() => started, { timeout: 60000 }).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    abort.abort();
    expect((await run).error).toMatchObject({ name: "AbortError" });
    await expect
      .poll(
        async () => {
          const names = [];
          for await (const [name] of root.entries()) {
            if (name.startsWith("libarchive_") || name.startsWith("rw-tmp-")) names.push(name);
          }
          return names;
        },
        { timeout: 30000 },
      )
      .toEqual([]);
  } finally {
    await resetRomWeaverRunner({ terminate: true });
    await root.removeEntry(scope, { recursive: true }).catch(() => undefined);
  }
});
