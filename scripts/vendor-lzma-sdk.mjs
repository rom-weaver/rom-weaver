#!/usr/bin/env node

// Refreshes crates/rom-weaver-containers/lzma-sdk/vendor/C from an official
// 7-Zip LZMA SDK drop. Modeled on scripts/vendor-libarchive.mjs, but the SDK
// ships as a .7z tarball rather than a git repo, so the source of truth is the
// upstream URL plus its SHA-256 instead of a commit hash.
//
//   node scripts/vendor-lzma-sdk.mjs            # refresh the pinned version
//   node scripts/vendor-lzma-sdk.mjs 26.02      # move the pin
//
// Extraction needs a 7z reader on PATH (7zz, 7z, or 7za) - the SDK is only
// published as a .7z.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const PINNED_VERSION = "26.02";

// Only what the 7z read/write paths compile: the LZMA1/LZMA2 coders, their
// match finders, the SDK's own thread/mt-coder layer, and the shared headers
// those pull in. Everything else in the SDK's C/ directory (AES, PPMd, BCJ2,
// the 7z archive reader, the sample apps) stays out of the tree.
export const VENDORED_FILES = [
  "7zStream.c",
  "7zTypes.h",
  "7zWindows.h",
  "Compiler.h",
  "CpuArch.c",
  "CpuArch.h",
  "LzFind.c",
  "LzFind.h",
  "LzFindMt.c",
  "LzFindMt.h",
  "LzFindOpt.c",
  "LzHash.h",
  "Lzma2Dec.c",
  "Lzma2Dec.h",
  "Lzma2Enc.c",
  "Lzma2Enc.h",
  "LzmaDec.c",
  "LzmaDec.h",
  "LzmaEnc.c",
  "LzmaEnc.h",
  "MtCoder.c",
  "MtCoder.h",
  "MtDec.c",
  "MtDec.h",
  "Precomp.h",
  "RotateDefs.h",
  "Threads.c",
  "Threads.h",
];

// The ARM64 hand-written LZMA decoder inner loop. Same bitstream, ~35% faster
// than the C fallback, and it is what 7zz itself runs on arm64. GNU-as syntax,
// so clang assembles it directly. (The x86-64 equivalent is MASM-syntax .asm
// and needs an assembler we do not carry, so x86-64 stays on the C path.)
export const VENDORED_ASM_FILES = ["arm64/7zAsm.S", "arm64/LzmaDecOpt.S"];

const LICENSE_FILES = ["lzma-sdk.txt"];

const sdkUrl = (version) => `https://www.7-zip.org/a/lzma${version.replace(".", "")}.7z`;

const sevenZipBinary = () => {
  for (const candidate of ["7zz", "7z", "7za"]) {
    const probe = spawnSync(candidate, ["i"], { stdio: "ignore" });
    if (!probe.error) return candidate;
  }
  throw new Error("vendor-lzma-sdk: no 7z reader found on PATH (install p7zip / 7-Zip)");
};

const repoRoot = () => execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

export async function vendorLzmaSdk(version = PINNED_VERSION, root = repoRoot()) {
  const url = sdkUrl(version);
  const destination = join(root, "crates/rom-weaver-containers/lzma-sdk/vendor");
  const staging = mkdtempSync(join(tmpdir(), "lzma-sdk-"));

  try {
    process.stdout.write(`vendor-lzma-sdk: fetching ${url}\n`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`vendor-lzma-sdk: ${url} returned HTTP ${response.status}`);
    const archive = Buffer.from(await response.arrayBuffer());
    const digest = createHash("sha256").update(archive).digest("hex");
    const archivePath = join(staging, "lzma.7z");
    writeFileSync(archivePath, archive);

    const extracted = join(staging, "sdk");
    const extract = spawnSync(sevenZipBinary(), ["x", `-o${extracted}`, archivePath], { stdio: "ignore" });
    if (extract.status !== 0) throw new Error(`vendor-lzma-sdk: extraction failed with status ${extract.status}`);

    const sourceDir = join(extracted, "C");
    const asmDir = join(extracted, "Asm");
    const missing = [
      ...VENDORED_FILES.filter((file) => !existsSync(join(sourceDir, file))),
      ...VENDORED_ASM_FILES.filter((file) => !existsSync(join(asmDir, file))),
    ];
    if (missing.length > 0) throw new Error(`vendor-lzma-sdk: SDK ${version} is missing ${missing.join(", ")}`);

    const stagedVendor = join(staging, "vendor");
    mkdirSync(join(stagedVendor, "C"), { recursive: true });
    mkdirSync(join(stagedVendor, "Asm/arm64"), { recursive: true });
    for (const file of VENDORED_FILES) cpSync(join(sourceDir, file), join(stagedVendor, "C", file));
    for (const file of VENDORED_ASM_FILES) cpSync(join(asmDir, file), join(stagedVendor, "Asm", file));
    for (const file of LICENSE_FILES) {
      const licensePath = join(extracted, "DOC", file);
      if (existsSync(licensePath)) cpSync(licensePath, join(stagedVendor, file));
    }

    mkdirSync(dirname(destination), { recursive: true });
    rmSync(destination, { recursive: true, force: true });
    renameSync(stagedVendor, destination);
    writeFileSync(
      join(dirname(destination), "LZMA_SDK_VERSION"),
      [
        `source: ${url}`,
        `version: ${version}`,
        `sha256: ${digest}`,
        `files: ${VENDORED_FILES.join(" ")}`,
        `asm: ${VENDORED_ASM_FILES.join(" ")}`,
        "license: public domain (see vendor/lzma-sdk.txt)",
        "refreshed-by: scripts/vendor-lzma-sdk.mjs",
        "",
      ].join("\n"),
    );
    process.stdout.write(`vendor-lzma-sdk: wrote ${destination} (LZMA SDK ${version}, sha256 ${digest})\n`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export const pinnedVersionFromTree = (root = repoRoot()) => {
  const pin = readFileSync(join(root, "crates/rom-weaver-containers/lzma-sdk/LZMA_SDK_VERSION"), "utf8");
  return pin.match(/^version: (.+)$/m)?.[1];
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  vendorLzmaSdk(process.argv[2] ?? PINNED_VERSION).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
