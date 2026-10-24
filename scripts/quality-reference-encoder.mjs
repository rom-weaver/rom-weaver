#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cargoTargetDir } from "./cargo-target-dir.mjs";
import { zstdDecompressSync } from "node:zlib";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function generatedInput(format) {
  const bytes = Buffer.alloc(format === "rvz" ? 0x440 + 262144 : format === "chd" ? 4096 : 8193);
  if (format === "rvz") {
    bytes.write("RWTEST");
    bytes.writeUInt32BE(0xc2339f3d, 0x1c);
    bytes.write("rom-weaver-test\0", 0x20);
    for (let i = 0x440; i < bytes.length; i++) bytes[i] = (i - 0x440) % 251;
  } else
    for (let i = 0; i < bytes.length; i++)
      bytes[i] =
        format === "chd" ? (Math.floor(i / 64) + (i % 17)) & 255 : (i * 13 + (i >> 8)) & 255;
  return bytes;
}
function range(bytes, offset, length) {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length <= 0 ||
    offset + length > bytes.length
  )
    throw new Error("invalid reference payload range");
  return bytes.subarray(offset, offset + length);
}
// These fixtures deliberately contain one CHD hunk / one unencoded 7z stream.
// RVZ comparison excludes layout and Zstd frame headers, retaining every compressed block byte.
export function canonicalPayloads(format, bytes) {
  if (format === "7z") {
    if (!bytes.subarray(0, 6).equals(Buffer.from("377abcaf271c", "hex")))
      throw new Error("invalid 7z signature");
    return [range(bytes, 32, Number(bytes.readBigUInt64LE(12)))];
  }
  if (format === "chd") {
    if (
      bytes.toString("ascii", 0, 8) !== "MComprHD" ||
      bytes.readUInt32BE(12) !== 5 ||
      bytes.readBigUInt64BE(32) !== 4096n ||
      bytes.readUInt32BE(56) !== 4096
    )
      throw new Error("unsupported CHD oracle shape");
    let start = 124;
    if (bytes.readBigUInt64BE(48) === 124n) start += 16 + (bytes.readUInt32BE(128) & 0xffffff);
    return [range(bytes, start, Number(bytes.readBigUInt64BE(40)) - start)];
  }
  if (
    format !== "rvz" ||
    bytes.toString("hex", 0, 4) !== "52565a01" ||
    bytes.readUInt32BE(76) !== 5 ||
    bytes.readUInt32BE(268) !== 3
  )
    throw new Error("unsupported RVZ oracle shape");
  const table = zstdDecompressSync(
    range(bytes, Number(bytes.readBigUInt64BE(272)), bytes.readUInt32BE(280)),
    { maxOutputLength: 36 },
  );
  if (table.length !== 36) throw new Error("invalid RVZ group table");
  return Array.from({ length: 3 }, (_, i) => {
    const flags = table.readUInt32BE(i * 12 + 4);
    if (!(flags & 0x80000000) || table.readUInt32BE(i * 12 + 8) !== 0)
      throw new Error("unsupported RVZ packing");
    const frame = range(bytes, table.readUInt32BE(i * 12) * 4, flags & 0x7fffffff);
    if (frame.readUInt32LE(0) !== 0xfd2fb528) throw new Error("invalid Zstd frame");
    zstdDecompressSync(frame, { maxOutputLength: 131072 });
    const descriptor = frame[4],
      single = (descriptor >> 5) & 1;
    if (descriptor & 0x1c) throw new Error("unsupported Zstd frame flags");
    const header =
      5 +
      (single ? 0 : 1) +
      [0, 1, 2, 4][descriptor & 3] +
      [single ? 1 : 0, 2, 4, 8][descriptor >> 6];
    return range(frame, header, frame.length - header);
  });
}
export function runEncoderReferences({
  root = process.cwd(),
  binary,
  execute = spawnSync,
  fixtures,
} = {}) {
  fixtures ??= JSON.parse(
    fs.readFileSync(new URL("./quality-reference-encoder.json", import.meta.url)),
  );
  if (
    !Array.isArray(fixtures) ||
    fixtures.length !== 3 ||
    new Set(fixtures.map((fixture) => fixture.format)).size !== 3 ||
    fixtures.some((fixture) => !["chd", "rvz", "7z"].includes(fixture.format))
  )
    throw new Error("missing encoder reference signals");
  const parent = path.join(root, ".agent/quality-reference-encoder");
  fs.mkdirSync(parent, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(parent, "run-"));
  try {
    return fixtures.map((fixture) => {
      const inputBytes = generatedInput(fixture.format),
        oracle = Buffer.from(fixture.archiveBase64, "base64");
      if (
        !fixture.referenceTool ||
        hash(inputBytes) !== fixture.inputSha256 ||
        hash(oracle) !== fixture.archiveSha256
      )
        throw new Error("encoder oracle hash mismatch");
      const expected = canonicalPayloads(fixture.format, oracle).map(hash);
      const input = path.join(
          scratch,
          fixture.format === "rvz"
            ? "input.iso"
            : fixture.format === "chd"
              ? "input.img"
              : "payload.bin",
        ),
        output = path.join(scratch, `output.${fixture.format}`);
      fs.writeFileSync(input, inputBytes);
      const args = [
        "compress",
        "--input",
        input,
        "--output",
        output,
        "--format",
        fixture.format,
        "--threads",
        "1",
        "--json",
      ];
      if (fixture.format !== "chd")
        args.push("--codec", fixture.format === "rvz" ? "zstd:5" : "lzma2:5");
      const result = execute(
        binary ||
          path.join(
            cargoTargetDir(root),
            "debug",
            process.platform === "win32" ? "rom-weaver.exe" : "rom-weaver",
          ),
        args,
        { cwd: root, encoding: "utf8", timeout: 120000 },
      );
      if (result.error || result.status !== 0)
        throw new Error(
          `encoder CLI failed: ${result.error?.message || result.stderr || result.status}`,
        );
      const actual = canonicalPayloads(fixture.format, fs.readFileSync(output)).map(hash);
      if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error(
          `${fixture.format} compressed payload reference mismatch: expected=${expected} actual=${actual}`,
        );
      return {
        signal: "pinned encoder reference",
        status: "passed",
        format: fixture.format,
        referenceTool: fixture.referenceTool,
        inputSha256: fixture.inputSha256,
        compressedPayloadSha256: actual,
      };
    });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(
      JSON.stringify(runEncoderReferences({ binary: process.env.QUALITY_REFERENCE_BIN }), null, 2),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
