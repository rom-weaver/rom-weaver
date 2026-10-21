import { expect, it } from "vitest";
import { createBrowserOpfsSourceRef } from "../../src/workers/protocol/browser-opfs-source-ref.ts";
import { getActiveBrowserVirtualFiles } from "../../src/workers/protocol/browser-virtual-files.ts";
import {
  assertRunJsonSucceeded,
  joinGuestPath,
  readGuestFile,
  withTempFixture,
  writeGuestFile,
} from "./test-helpers.mjs";

const payload = Uint8Array.from([...new TextEncoder().encode("unicode payload"), 0, 255]);
const decode = (value) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

it.each(["zip", "7z"])("extracts exact Unicode and ASCII member names and bytes from %s", async (format) => {
  await withTempFixture(async ({ dir, opfsHandle, worker }) => {
    const input = joinGuestPath(dir, `unicode.${format}`);
    await writeGuestFile(opfsHandle, input, decode(fixtures[format]));
    const output = joinGuestPath(dir, "extracted");
    const result = await worker.runJson(["extract", "--input", input, "--out-dir", output]);
    assertRunJsonSucceeded(result, { command: "extract" });
    for (const name of ["ゲーム.bin", "café.bin", "game.bin"]) {
      expect(await readGuestFile(opfsHandle, joinGuestPath(output, name))).toEqual(payload);
    }
  });
});

it.each(["zip", "7z"])("round-trips a Unicode File through %s creation and extraction", async (format) => {
  const ref = await createBrowserOpfsSourceRef(new File([payload], "café.bin"), "input.bin", { mountPoint: "/work" });
  try {
    await withTempFixture(async ({ dir, opfsHandle, worker }) => {
      const archive = joinGuestPath(dir, `created.${format}`);
      const created = await worker.runJson(
        ["compress", "--input", ref.filePath, "--format", format, "--output", archive],
        { virtualFiles: getActiveBrowserVirtualFiles() },
      );
      assertRunJsonSucceeded(created, { command: "compress" });
      if (format === "zip") {
        const bytes = await readGuestFile(opfsHandle, archive);
        expect(new DataView(bytes.buffer, bytes.byteOffset).getUint16(6, true) & 0x800).not.toBe(0);
      }
      const output = joinGuestPath(dir, "created-output");
      const extracted = await worker.runJson(["extract", "--input", archive, "--out-dir", output]);
      assertRunJsonSucceeded(extracted, { command: "extract" });
      expect(await readGuestFile(opfsHandle, joinGuestPath(output, "café.bin"))).toEqual(payload);
    });
  } finally {
    await ref.cleanup();
  }
});

it("preserves a Unicode File basename through gzip stream extraction", async () => {
  const compressed = await new Response(
    new Blob([payload]).stream().pipeThrough(new CompressionStream("gzip")),
  ).arrayBuffer();
  const ref = await createBrowserOpfsSourceRef(new File([compressed], "café.bin.gz"), "input.gz", {
    mountPoint: "/work",
  });
  try {
    await withTempFixture(async ({ dir, opfsHandle, worker }) => {
      const output = joinGuestPath(dir, "stream");
      const result = await worker.runJson(["extract", "--input", ref.filePath, "--out-dir", output], {
        virtualFiles: getActiveBrowserVirtualFiles(),
      });
      assertRunJsonSucceeded(result, { command: "extract" });
      expect(await readGuestFile(opfsHandle, joinGuestPath(output, "café.bin"))).toEqual(payload);
    });
  } finally {
    await ref.cleanup();
  }
});

// ZIP is Python zipfile STORE with UTF-8 flags; 7z is bsdtar --format 7zip.
const fixtures = {
  zip: "UEsDBBQAAAAAAOcJVV0E9M/4EQAAABEAAAAIAAAAZ2FtZS5iaW51bmljb2RlIHBheWxvYWQA/1BLAwQUAAAIAADnCVVdBPTP+BEAAAARAAAACQAAAGNhZsOpLmJpbnVuaWNvZGUgcGF5bG9hZAD/UEsDBBQAAAgAAOcJVV0E9M/4EQAAABEAAAANAAAA44Ky44O844OgLmJpbnVuaWNvZGUgcGF5bG9hZAD/UEsBAhQDFAAAAAAA5wlVXQT0z/gRAAAAEQAAAAgAAAAAAAAAAAAAAIABAAAAAGdhbWUuYmluUEsBAhQDFAAACAAA5wlVXQT0z/gRAAAAEQAAAAkAAAAAAAAAAAAAAIABNwAAAGNhZsOpLmJpblBLAQIUAxQAAAgAAOcJVV0E9M/4EQAAABEAAAANAAAAAAAAAAAAAACAAW8AAADjgrLjg7zjg6AuYmluUEsFBgAAAAADAAMAqAAAAKsAAAAAAA==",
  "7z": "N3q8ryccAAMA1dXWlgAAAAAAAAAhAAAAAAAAAPTEQk0AOpuJYMVDBkmJTS79GlfLLZu06NY9Btj///2McAAAAIEzB64Pz+swFA/r6p4BDWIDjdNMQj8Oo6RZ+biK3kjIFJUoC/uhVsjSPEQEmfr30caeA4SOUE+Ye8aU6w4JQ0+0olzngkqz+LgsSbaTWhJQ35kdfc3qVXdDNq6nTjx/eR43tOIjtqZrlOYoZ+0hU6Vf/3UkAAAXBh4BCXgABwsBAAEjAwEBBV0AAIAADIDPCgHMs0DVAAA=",
};
