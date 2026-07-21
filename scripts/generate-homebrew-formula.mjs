#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const [version, checksumDirectory, output = "Formula/rom-weaver.rb"] = process.argv.slice(2);
if (!version || !checksumDirectory) {
  throw new Error("usage: generate-homebrew-formula.mjs <version> <checksum-directory> [output]");
}

const platforms = ["darwin-arm64", "darwin-x64", "linux-x64-gnu"];
const checksums = Object.fromEntries(
  platforms.map((platform) => {
    const asset = `rom-weaver-${platform}`;
    const checksum = readFileSync(resolve(checksumDirectory, `${asset}.sha256`), "utf8").match(
      /^[a-f0-9]{64}/,
    )?.[0];
    if (!checksum) throw new Error(`invalid checksum for ${asset}`);
    return [platform, checksum];
  }),
);

const releaseUrl = `https://github.com/brandonocasey/rom-weaver/releases/download/v${version}`;
const source = `class RomWeaver < Formula
  desc "Local-first offline toolkit for ROMs and ROM hack patches"
  homepage "https://rom-weaver.com"
  version "${version}"
  license "AGPL-3.0-or-later"

  on_macos do
    on_arm do
      url "${releaseUrl}/rom-weaver-darwin-arm64"
      sha256 "${checksums["darwin-arm64"]}"
    end
    on_intel do
      url "${releaseUrl}/rom-weaver-darwin-x64"
      sha256 "${checksums["darwin-x64"]}"
    end
  end

  on_linux do
    depends_on arch: :x86_64
    on_intel do
      url "${releaseUrl}/rom-weaver-linux-x64-gnu"
      sha256 "${checksums["linux-x64-gnu"]}"
    end
  end

  def install
    bin.install Dir["rom-weaver-*"].first => "rom-weaver"
  end

  test do
    system bin/"rom-weaver", "--version"
  end
end
`;

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, source);
