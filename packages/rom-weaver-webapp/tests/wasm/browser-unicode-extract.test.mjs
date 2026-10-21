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

it.each(["zip", "7z"].flatMap((format) => ["café.bin", "cafe\u0301.bin"].map((name) => [format, name])))(
  "round-trips a Unicode File through %s creation and extraction: %s",
  async (format, name) => {
    const ref = await createBrowserOpfsSourceRef(new File([payload], name), "input.bin", { mountPoint: "/work" });
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
        expect(await readGuestFile(opfsHandle, joinGuestPath(output, name))).toEqual(payload);
      });
    } finally {
      await ref.cleanup();
    }
  },
);

it.each(["zip", "7z"])("preserves distinct Unicode normalization names and payloads in %s", async (format) => {
  await withTempFixture(async ({ dir, opfsHandle, worker }) => {
    const input = joinGuestPath(dir, `normalization.${format}`);
    await writeGuestFile(opfsHandle, input, decode(normalizationFixtures[format]));
    for (const force of [false, true]) {
      const output = joinGuestPath(dir, `normalization-output-${force}`);
      const result = await worker.runJson([
        "extract",
        "--input",
        input,
        "--out-dir",
        output,
        ...(force ? ["--force"] : []),
      ]);
      assertRunJsonSucceeded(result, { command: "extract" });
      for (const [index, name] of ["cafe\u0301.bin", "café.bin"].entries()) {
        expect(await readGuestFile(opfsHandle, joinGuestPath(output, name))).toEqual(
          new TextEncoder().encode(`payload-${index}`),
        );
      }
    }
  });
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

const normalizationFixtures = {
  zip: "UEsDBBQAAAgAANUUVV3CVPjdCQAAAAkAAAAKAAAAY2FmZcyBLmJpbnBheWxvYWQtMFBLAwQUAAAIAADVFFVdVGT/qgkAAAAJAAAACQAAAGNhZsOpLmJpbnBheWxvYWQtMVBLAQIUAxQAAAgAANUUVV3CVPjdCQAAAAkAAAAKAAAAAAAAAAAAAAC0gQAAAABjYWZlzIEuYmluUEsBAhQDFAAACAAA1RRVXVRk/6oJAAAACQAAAAkAAAAAAAAAAAAAALSBMQAAAGNhZsOpLmJpblBLBQYAAAAAAgACAG8AAABhAAAAAAA=",
  "7z": "N3q8ryccAAPTgWC0hAAAAAAAAAAhAAAAAAAAACOAWggAOBhLmXUPRghqz5d65t/xJ//+3ugAAACBMweuD89dLwwHyEOAg4Fb/6x2z3g/Dnlvc62s/cW7dstwttb0skoo8C1fkUNkQex98qTakrY/aHh29BY+cZPJwh0Fig59iXVYZjRpI0evLb3+ofgdllekR1/zZeD9Ma/7/SUCq9///4cIAAAXBhYBCW4ABwsBAAEjAwEBBV0AAIAADICgCgGM0orEAAA=",
};
