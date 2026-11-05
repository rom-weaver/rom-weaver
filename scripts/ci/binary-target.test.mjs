import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { assertBinaryTarget, describeBinary, expectedBinary, readHeader } from "./binary-target.mjs";
import { elf, macho, pe } from "./binary-fixtures.mjs";

test("describes the executables each release target produces", () => {
  assert.deepEqual(describeBinary(elf({ arch: "x86_64", interpreter: "/lib64/ld-linux-x86-64.so.2" })), { format: "elf", arch: "x86_64", libc: "gnu", bits: 64 });
  assert.deepEqual(describeBinary(elf({ arch: "aarch64" })), { format: "elf", arch: "aarch64", libc: "musl", bits: 64 });
  assert.deepEqual(describeBinary(elf({ arch: "i686", wide: false })), { format: "elf", arch: "i686", libc: "musl", bits: 32 });
  assert.deepEqual(describeBinary(elf({ arch: "i686", wide: false, interpreter: "/lib/ld-linux.so.2" })), { format: "elf", arch: "i686", libc: "gnu", bits: 32 });
  assert.deepEqual(describeBinary(macho(0x01000007)), { format: "macho", arch: "x86_64" });
  assert.deepEqual(describeBinary(macho(0x0100000c)), { format: "macho", arch: "aarch64" });
  assert.deepEqual(describeBinary(pe(0x8664)), { format: "pe", arch: "x86_64" });
  assert.deepEqual(describeBinary(pe(0xaa64)), { format: "pe", arch: "aarch64" });
  assert.deepEqual(describeBinary(pe(0x14c)), { format: "pe", arch: "i686" });
  assert.equal(describeBinary(Buffer.from("#!/bin/sh\n")), null);
});

test("maps every shipped target triple to its header", () => {
  assert.deepEqual(expectedBinary("x86_64-unknown-linux-gnu"), { format: "elf", arch: "x86_64", libc: "gnu" });
  assert.deepEqual(expectedBinary("aarch64-unknown-linux-musl"), { format: "elf", arch: "aarch64", libc: "musl" });
  assert.deepEqual(expectedBinary("i686-unknown-linux-musl"), { format: "elf", arch: "i686", libc: "musl" });
  assert.deepEqual(expectedBinary("x86_64-apple-darwin"), { format: "macho", arch: "x86_64" });
  assert.deepEqual(expectedBinary("aarch64-apple-darwin"), { format: "macho", arch: "aarch64" });
  assert.deepEqual(expectedBinary("i686-pc-windows-msvc"), { format: "pe", arch: "i686" });
  assert.equal(expectedBinary("riscv64-unknown-linux-gnu"), null);
});

test("rejects a binary built for another architecture, libc, or operating system", () => {
  const directory = mkdtempSync(join(tmpdir(), "rom-weaver-binary-target-"));
  try {
    const check = (bytes, triple) => {
      const path = join(directory, "binary");
      writeFileSync(path, bytes);
      assertBinaryTarget(path, triple);
    };
    check(elf({ arch: "x86_64", interpreter: "/lib64/ld-linux-x86-64.so.2" }), "x86_64-unknown-linux-gnu");
    check(pe(0x8664), "x86_64-pc-windows-msvc");
    assert.throws(() => check(elf({ arch: "aarch64", interpreter: "/lib/ld-linux-aarch64.so.1" }), "x86_64-unknown-linux-gnu"), /arch aarch64, not x86_64/);
    assert.throws(() => check(elf({ arch: "x86_64", interpreter: "/lib64/ld-linux-x86-64.so.2" }), "x86_64-unknown-linux-musl"), /libc gnu, not musl/);
    assert.throws(() => check(elf({ arch: "x86_64" }), "x86_64-apple-darwin"), /format elf, not macho/);
    assert.throws(() => check(macho(0x01000007), "aarch64-apple-darwin"), /arch x86_64, not aarch64/);
    assert.throws(() => check(pe(0x14c), "x86_64-pc-windows-msvc"), /arch i686, not x86_64/);
    assert.throws(() => check(Buffer.from("not an executable"), "x86_64-unknown-linux-gnu"), /not a recognized/);
    assert.throws(() => check(pe(0x8664), "sparc-sun-solaris"), /unknown target/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reads a real executable's header from disk", { skip: process.platform !== "linux" || process.arch !== "x64" }, () => {
  const described = describeBinary(readHeader(process.execPath));
  assert.equal(described.format, "elf");
  assert.equal(described.arch, "x86_64");
});
