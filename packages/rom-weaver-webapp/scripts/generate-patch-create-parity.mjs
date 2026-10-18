// Regenerates tests/fixtures/patch-create-parity/expected.json from the native CLI.
// Usage: npm run generate:patch-create-parity -- <path-to-rom-weaver-binary>
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PATCH_CREATE_PARITY_CASES } from "../tests/wasm/patch-create-parity-inputs.mjs";

const binary = process.argv[2];
if (!binary) {
  throw new Error("usage: generate-patch-create-parity.mjs <rom-weaver-binary>");
}
const run = (...args) => execFileSync(binary, [...args, "--threads", "1"], { stdio: ["ignore", "pipe", "inherit"] });
const expected = {};
const dir = mkdtempSync(join(tmpdir(), "patch-create-parity-"));
try {
  for (const [caseName, inputs] of Object.entries(PATCH_CREATE_PARITY_CASES)) {
    const format = inputs.format ?? caseName;
    const work = join(dir, caseName);
    mkdirSync(work);
    const original = join(work, "original.bin");
    let modified = join(work, "modified.bin");
    const output = join(work, `patch.${format}`);
    writeFileSync(original, inputs.original);
    if (inputs.dldiSeed) {
      const seed = join(work, "seed.dldi");
      writeFileSync(seed, inputs.dldiSeed);
      run("patch", "apply", "--input", original, "--patch", seed, "--output", modified, "--no-compress");
    } else {
      writeFileSync(modified, inputs.modified);
    }
    run("patch", "create", "--original", original, "--modified", modified, "--format", format, "--output", output);
    const bytes = readFileSync(output);
    expected[caseName] = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  }
} finally {
  rmSync(dir, { force: true, recursive: true });
}
writeFileSync(
  new URL("../tests/fixtures/patch-create-parity/expected.json", import.meta.url),
  `${JSON.stringify(expected, null, 2)}\n`,
);
