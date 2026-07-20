#!/usr/bin/env node
// Verify a built production WASM artifact set before anything downstream
// consumes it.
//
// Two failure modes this exists to catch early:
//
//   1. An incomplete artifact set - most likely a partial cache restore, which
//      would otherwise surface as a confusing failure in the browser suite or
//      a broken deploy.
//   2. A module whose imported memory does not declare the 4 GiB ceiling. The
//      --max-memory link-arg lives in .cargo/config.toml, and cargo's rustflags
//      sources are mutually exclusive: any RUSTFLAGS override replaces that
//      list wholesale and silently drops it. The result still compiles and
//      still passes wasm-opt, then fails at instantiation with "memory import
//      has a larger maximum size 65536 than the module's declared maximum".
//
// Node's WebAssembly.Module.imports() reports only {module, name, kind} - the
// js-types reflection that would expose limits is not available - so the
// import section is decoded directly.
//
// Usage: node scripts/wasm/verify-wasm-artifact.mjs <wasm-dir>

import { readFileSync, statSync } from "node:fs";
import path from "node:path";

const EXPECTED_MAX_PAGES = 65536; // 4 GiB / 64 KiB
const REQUIRED_FILES = [
  "rom-weaver-app.wasm",
  "rom-weaver-app.wasm.br",
  "NOTICE",
  "THIRD_PARTY_LICENSES.md",
];
const REQUIRED_DIRS = ["third_party/licenses"];

const EXTERNAL_KIND = { func: 0, table: 1, memory: 2, global: 3 };
const LIMITS_HAS_MAX = 0x01;
const LIMITS_SHARED = 0x02;

class Reader {
  constructor(buf) {
    this.buf = buf;
    this.at = 0;
  }

  byte() {
    if (this.at >= this.buf.length) {
      throw new Error("unexpected end of module");
    }
    return this.buf[this.at++];
  }

  /** LEB128 unsigned varint. */
  varuint() {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = this.byte();
      result |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result >>> 0;
      shift += 7;
      if (shift > 35) throw new Error("varint too long");
    }
  }

  skip(n) {
    this.at += n;
  }
}

/** Decode the limits that follow a memory or table import. */
function readLimits(r) {
  const flags = r.varuint();
  const minimum = r.varuint();
  const maximum = flags & LIMITS_HAS_MAX ? r.varuint() : undefined;
  return { minimum, maximum, shared: Boolean(flags & LIMITS_SHARED) };
}

/** Find the imported memory's declared limits, or null if there is none. */
export function readImportedMemoryLimits(bytes) {
  const r = new Reader(bytes);
  const magic = bytes.subarray(0, 4).toString("binary");
  if (magic !== "\0asm") throw new Error("not a wasm module (bad magic)");
  r.skip(8); // magic + version

  while (r.at < bytes.length) {
    const id = r.byte();
    const size = r.varuint();
    const end = r.at + size;

    if (id !== 2) {
      // Not the import section; sections are ordered but we do not rely on it.
      r.at = end;
      continue;
    }

    const count = r.varuint();
    for (let i = 0; i < count; i++) {
      r.skip(r.varuint()); // module name
      r.skip(r.varuint()); // field name
      const kind = r.byte();
      switch (kind) {
        case EXTERNAL_KIND.func:
          r.varuint(); // type index
          break;
        case EXTERNAL_KIND.table:
          r.byte(); // element type
          readLimits(r);
          break;
        case EXTERNAL_KIND.memory:
          return readLimits(r);
        case EXTERNAL_KIND.global:
          r.byte(); // value type
          r.byte(); // mutability
          break;
        default:
          throw new Error(`unknown import kind ${kind}`);
      }
    }
    r.at = end;
  }
  return null;
}

function fail(message) {
  console.error(`::error::${message}`);
  process.exitCode = 1;
}

function main() {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: verify-wasm-artifact.mjs <wasm-dir>");
    process.exit(2);
  }

  let ok = true;
  for (const name of REQUIRED_FILES) {
    const file = path.join(dir, name);
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      fail(`missing artifact: ${file}`);
      ok = false;
      continue;
    }
    if (size === 0) {
      fail(`empty artifact: ${file}`);
      ok = false;
    }
  }
  for (const name of REQUIRED_DIRS) {
    const target = path.join(dir, name);
    try {
      if (!statSync(target).isDirectory()) throw new Error("not a directory");
    } catch {
      fail(`missing attribution bundle: ${target}`);
      ok = false;
    }
  }
  if (!ok) return;

  const wasmPath = path.join(dir, "rom-weaver-app.wasm");
  const limits = readImportedMemoryLimits(readFileSync(wasmPath));
  if (!limits) {
    fail(`${wasmPath}: no imported memory - this is not a threaded build`);
    return;
  }
  if (!limits.shared) {
    fail(`${wasmPath}: imported memory is not shared - threads will not work`);
    return;
  }
  if (limits.maximum !== EXPECTED_MAX_PAGES) {
    fail(
      `${wasmPath}: memory maximum is ${limits.maximum} pages, expected ${EXPECTED_MAX_PAGES} (4 GiB). ` +
        "The --max-memory link-arg from .cargo/config.toml was lost; the usual cause is a " +
        "RUSTFLAGS override replacing the [target.wasm32-wasip1-threads] rustflags list.",
    );
    return;
  }

  console.log(
    `ok: shared imported memory, minimum ${limits.minimum} pages, maximum ${limits.maximum} pages (4 GiB)`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
