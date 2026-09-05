#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const [version, checksumDirectory, output = "bucket/rom-weaver.json"] = process.argv.slice(2);
if (!version || !checksumDirectory) {
  throw new Error("usage: generate-scoop-manifest.mjs <version> <checksum-directory> [output]");
}

const platforms = {
  "64bit": "win32-x64-msvc",
  "32bit": "win32-ia32-msvc",
  arm64: "win32-arm64-msvc",
};
const checksums = Object.fromEntries(
  Object.entries(platforms).map(([architecture, platform]) => {
    const asset = `rom-weaver-${platform}.tar.gz`;
    const checksum = readFileSync(resolve(checksumDirectory, `${asset}.sha256`), "utf8").match(
      /^[a-f0-9]{64}/,
    )?.[0];
    if (!checksum) throw new Error(`invalid checksum for ${asset}`);
    return [architecture, { asset, checksum }];
  }),
);
const identifyAsset = "rom-weaver-identify-data.tar.br";
const identifyChecksum = readFileSync(
  resolve(checksumDirectory, `${identifyAsset}.sha256`),
  "utf8",
).match(/^[a-f0-9]{64}/)?.[0];
if (!identifyChecksum) throw new Error(`invalid checksum for ${identifyAsset}`);

// Scoop extracts the binary tar.gz itself (fetching 7-Zip on demand). The
// Brotli data asset is decoded by the installer script because Scoop does not
// extract raw `.br` files.
const manifest = {
  version,
  description: "Local-first offline toolkit for ROMs and ROM hack patches",
  homepage: "https://rom-weaver.com",
  license: "AGPL-3.0-or-later",
  depends: ["brotli"],
  architecture: Object.fromEntries(
    Object.entries(checksums).map(([architecture, { asset, checksum }]) => [
      architecture,
      {
        url: [
          `https://github.com/rom-weaver/rom-weaver/releases/download/v${version}/${asset}`,
          `https://github.com/rom-weaver/rom-weaver/releases/download/v${version}/${identifyAsset}`,
        ],
        hash: [checksum, identifyChecksum],
      },
    ]),
  ),
  bin: "rom-weaver.exe",
  installer: {
    script: [
      `$identifyArchive = Join-Path $dir "${identifyAsset}"`,
      '$identifyTar = Join-Path $dir "rom-weaver-identify-data.tar"',
      '& brotli --decompress --force "--output=$identifyTar" $identifyArchive',
      'if ($LASTEXITCODE -ne 0) { throw "failed to decompress identify data" }',
      "& tar --extract --file $identifyTar --directory $dir",
      'if ($LASTEXITCODE -ne 0) { throw "failed to extract identify data" }',
      "Remove-Item $identifyArchive, $identifyTar -Force",
    ],
  },
};

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
