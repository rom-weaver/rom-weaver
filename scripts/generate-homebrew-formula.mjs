#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const [version, checksumDirectory, output = "Formula/rom-weaver.rb"] = process.argv.slice(2);
if (!version || !checksumDirectory) {
  throw new Error("usage: generate-homebrew-formula.mjs <version> <checksum-directory> [output]");
}

const platforms = ["darwin-arm64", "darwin-x64", "linux-arm64-musl", "linux-x64-gnu"];
const checksums = Object.fromEntries(
  platforms.map((platform) => {
    const asset = `rom-weaver-${platform}.tar.gz`;
    const checksum = readFileSync(resolve(checksumDirectory, `${asset}.sha256`), "utf8").match(
      /^[a-f0-9]{64}/,
    )?.[0];
    if (!checksum) throw new Error(`invalid checksum for ${asset}`);
    return [platform, checksum];
  }),
);
const assetsChecksum = readFileSync(
  resolve(checksumDirectory, "rom-weaver-cli-assets.tar.gz.sha256"),
  "utf8",
).match(/^[a-f0-9]{64}/)?.[0];
if (!assetsChecksum) throw new Error("invalid checksum for rom-weaver-cli-assets.tar.gz");
const identifyChecksum = readFileSync(
  resolve(checksumDirectory, "rom-weaver-identify-data.tar.br.sha256"),
  "utf8",
).match(/^[a-f0-9]{64}/)?.[0];
if (!identifyChecksum) throw new Error("invalid checksum for rom-weaver-identify-data.tar.br");

const releaseUrl = `https://github.com/rom-weaver/rom-weaver/releases/download/v${version}`;
const source = `class RomWeaver < Formula
  desc "Local-first toolkit for ROMs and disc images: inspect, extract, compress, and apply, create, or bundle patches. Offline via a browser service-worker PWA or CLI."
  homepage "https://rom-weaver.com"
  version "${version}"
  license "AGPL-3.0-or-later"
  depends_on "brotli" => :build

  resource "cli-assets" do
    url "${releaseUrl}/rom-weaver-cli-assets.tar.gz"
    sha256 "${assetsChecksum}"
  end

  resource "identify-data" do
    url "${releaseUrl}/rom-weaver-identify-data.tar.br", using: :nounzip
    sha256 "${identifyChecksum}"
  end

  on_macos do
    on_arm do
      url "${releaseUrl}/rom-weaver-darwin-arm64.tar.gz"
      sha256 "${checksums["darwin-arm64"]}"
    end
    on_intel do
      url "${releaseUrl}/rom-weaver-darwin-x64.tar.gz"
      sha256 "${checksums["darwin-x64"]}"
    end
  end

  on_linux do
    on_arm do
      url "${releaseUrl}/rom-weaver-linux-arm64-musl.tar.gz"
      sha256 "${checksums["linux-arm64-musl"]}"
    end
    on_intel do
      url "${releaseUrl}/rom-weaver-linux-x64-gnu.tar.gz"
      sha256 "${checksums["linux-x64-gnu"]}"
    end
  end

  def install
    bin.install "rom-weaver"
    resource("cli-assets").stage do
      man1.install Dir["man/*.1"]
      bash_completion.install "completions/rom-weaver.bash" => "rom-weaver"
      zsh_completion.install "completions/_rom-weaver"
      fish_completion.install "completions/rom-weaver.fish"
    end
    resource("identify-data").stage do
      system "brotli", "--decompress", "--force", "--output=identify-data.tar", "rom-weaver-identify-data.tar.br"
      system "tar", "--extract", "--file", "identify-data.tar"
      share.install "share/rom-weaver"
    end
  end

  test do
    system bin/"rom-weaver", "--version"
  end
end
`;

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, source);
