import { describe, expect, it } from "vitest";
import {
  assertRunJsonSucceeded,
  getGuestFileSize,
  joinGuestPath,
  toBytes,
  toTypedRunInput,
  withTempFixture,
  writeGuestFile,
} from "./test-helpers.mjs";

const SCRATCH_DIRECTORY_NAME = ".rom-weaver-opfs-scratch";

async function countScratchEntries(rootHandle) {
  try {
    const scratchHandle = await rootHandle.getDirectoryHandle(SCRATCH_DIRECTORY_NAME, { create: false });
    let count = 0;
    for await (const _entry of scratchHandle.entries()) count += 1;
    return count;
  } catch {
    return 0;
  }
}

async function readGuestFile(rootHandle, guestPath) {
  // rootHandle is the /work mount itself, so strip the mount prefix to get a relative path.
  const relative = guestPath.replace(/^\/work\/?/, "");
  const parts = relative.split("/").filter(Boolean);
  let dir = rootHandle;
  for (const part of parts.slice(0, -1)) {
    dir = await dir.getDirectoryHandle(part, { create: false });
  }
  const fileHandle = await dir.getFileHandle(parts.at(-1), { create: false });
  return new Uint8Array(await (await fileHandle.getFile()).arrayBuffer());
}

describe("opfs async proxy (end-to-end)", () => {
  it("applies an IPS patch through the proxy with no scratch directory", async () => {
    await withTempFixture(
      async ({ worker, opfsHandle, dir }) => {
        const runJson = (args) => worker.runJson(toTypedRunInput(args));
        const originalPath = joinGuestPath(dir, "original.bin");
        const modifiedPath = joinGuestPath(dir, "modified.bin");
        const patchPath = joinGuestPath(dir, "update.ips");
        const outputPath = joinGuestPath(dir, "applied.bin");

        const modifiedBytes = toBytes("a1XYZf!!!");
        await writeGuestFile(opfsHandle, originalPath, toBytes("abcdefgh"));
        await writeGuestFile(opfsHandle, modifiedPath, modifiedBytes);

        assertRunJsonSucceeded(
          await runJson([
            "patch",
            "create",
            "--original",
            originalPath,
            "--modified",
            modifiedPath,
            "--format",
            "ips",
            "--output",
            patchPath,
            "--threads",
            "1",
          ]),
          { command: "patch-create" },
        );

        assertRunJsonSucceeded(
          await runJson([
            "patch",
            "apply",
            "--input",
            originalPath,
            "--patch",
            patchPath,
            "--output",
            outputPath,
            "--threads",
            "1",
            "--no-compress",
          ]),
          { command: "patch-apply" },
        );

        // The proxy created the patch + applied output as real OPFS files (no scratch staging).
        expect(await getGuestFileSize(opfsHandle, patchPath)).toBeGreaterThan(0);
        expect(await getGuestFileSize(opfsHandle, outputPath)).toBe(modifiedBytes.byteLength);
        const applied = await readGuestFile(opfsHandle, outputPath);
        expect(Array.from(applied)).toEqual(Array.from(modifiedBytes));

        // Proxy mode must not create the scratch pool directory at all.
        expect(await countScratchEntries(opfsHandle)).toBe(0);
      },
      { initOptions: { opfsProxyEnabled: true } },
    );
  });

  it("compresses and extracts a zip through the proxy with worker threads", async () => {
    await withTempFixture(
      async ({ worker, opfsHandle, dir }) => {
        const runJson = (args) => worker.runJson(toTypedRunInput(args));
        const sourcePath = joinGuestPath(dir, "payload.bin");
        const zipPath = joinGuestPath(dir, "archive.zip");
        const extractDir = joinGuestPath(dir, "extracted");

        const payload = new Uint8Array(48 * 1024);
        for (let i = 0; i < payload.length; i += 1) payload[i] = (i * 7) % 251;
        await writeGuestFile(opfsHandle, sourcePath, payload);

        assertRunJsonSucceeded(
          await runJson(["compress", sourcePath, "--format", "zip", "--output", zipPath, "--threads", "2"]),
          { command: "compress" },
        );
        assertRunJsonSucceeded(await runJson(["extract", zipPath, "--out-dir", extractDir, "--threads", "2"]), {
          command: "extract",
        });

        // The extracted file (written by worker threads through the proxy) matches the source bytes.
        const extracted = await readGuestFile(opfsHandle, joinGuestPath(extractDir, "payload.bin"));
        expect(extracted.byteLength).toBe(payload.byteLength);
        expect(Array.from(extracted.subarray(0, 64))).toEqual(Array.from(payload.subarray(0, 64)));

        // Still no scratch directory: threaded outputs went straight to OPFS via the proxy.
        expect(await countScratchEntries(opfsHandle)).toBe(0);
      },
      { initOptions: { opfsProxyEnabled: true } },
    );
  });
});
