<p align="center">
  <img
    src="packages/rom-weaver-react/design/github-social-preview.svg"
    alt="RomWeaver: inspect, patch, transform, and preserve video game ROMs and disc images"
    width="960"
  >
</p>

<h1 align="center">RomWeaver</h1>

<p align="center">
  A local-first toolkit for working with video game ROMs and disc images in your browser or terminal.
</p>

<p align="center">
  <a href="https://github.com/brandonocasey/rom-weaver/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/brandonocasey/rom-weaver?sort=semver&amp;label=version&amp;color=d9690f"></a>
  <a href="package.json"><img alt="Node.js 22 or newer" src="https://img.shields.io/badge/Node.js-22%2B-4a6d63?logo=nodedotjs&logoColor=white"></a>
  <a href=".mise.toml"><img alt="Rust 1.95" src="https://img.shields.io/badge/Rust-1.95-2c323b?logo=rust&logoColor=white"></a>
  <a href="LICENSE.md"><img alt="AGPL-3.0-or-later license" src="https://img.shields.io/badge/license-AGPL--3.0--or--later-4a6d63"></a>
</p>

<p align="center">
  <a href="https://brandonocasey.github.io/rom-weaver/">Open the webapp</a>
  · <a href="docs/README.md">Documentation</a>
  · <a href="https://github.com/brandonocasey/rom-weaver/issues">Issues</a>
  · <a href="https://ko-fi.com/brandonocasey">Support on Ko-fi</a>
</p>

RomWeaver can inspect, extract, checksum, compress, trim, patch, and create
patches for many cartridge and disc formats. The browser app processes files
locally with WebAssembly; the native CLI exposes the same command core for
scripts and terminal workflows.

## Start here

### Use the webapp

Open the [hosted webapp](https://brandonocasey.github.io/rom-weaver/).
No installation or account is required.

1. Choose **Weave** to add a ROM or disc image and one or more patch files.
2. Review the detected formats, checksums, patch order, and output settings.
3. Run the workflow and save the result.

Use **Make Patch** to compare an original file with a modified file and create
a distributable patch. Optional Trim and Tools workflows can be enabled in the
webapp settings.

### Use the CLI

Install the current tagged CLI from source:

```bash
cargo install \
  --git https://github.com/brandonocasey/rom-weaver.git \
  --tag v0.5.0 \
  rom-weaver-cli
rom-weaver --help
```

Common commands:

```bash
# Identify a file or the payload inside a container
rom-weaver probe game.sfc

# Apply a patch and write an uncompressed ROM
rom-weaver patch apply \
  --input game.sfc \
  --patch translation.bps \
  --output game-translated.sfc \
  --no-compress

# Create a BPS patch
rom-weaver patch create \
  --original original.sfc \
  --modified modified.sfc \
  --format bps \
  --output release.bps

# Extract and checksum files
rom-weaver extract collection.7z --out-dir extracted
rom-weaver checksum game.sfc --algo sha256
```

See the [CLI guide](docs/cli.md) for installation alternatives, command
behavior, supported formats, compression codecs, checksums, and JSON output.

## What it supports

- Patch apply and creation for IPS, BPS, UPS, xdelta/VCDIFF, PPF, RUP,
  BSDIFF40, DCP, and many other formats.
- Container inspection and extraction for ZIP, 7z, RAR, tar-family archives,
  CHD, RVZ, Z3DS, CSO, PBP, GCZ, WIA, WBFS, and more.
- ZIP, 7z, CHD, RVZ, and Z3DS creation with codec-aware compression settings.
- CRC, MD5, SHA, BLAKE3, ROM-header detection, checksum repair, and reversible
  trimming for supported systems.
- Ordered, shareable workflows through `rom-weaver-bundle.json` bundles.

The complete compatibility tables are maintained in the
[CLI guide](docs/cli.md#supported-formats).

## Self-host the webapp

RomWeaver is a static webapp and can run on a dedicated HTTPS subdomain or
under a path such as `/rom-weaver/`.

### Docker

Build and start the complete webapp with Docker Compose:

```bash
docker compose up --build --detach
```

No local Rust, Node.js, WASI SDK, or mise installation is required. The first
image build downloads the build toolchains and compiles the WASM module, so it
takes longer than later cached builds. The container is available at
`http://localhost:8080`. In production, put it behind an HTTPS reverse proxy.
The image supplies the required cross-origin isolation headers, SPA fallback,
and precompressed Brotli assets.

### Static hosting

```bash
mise run build-wasm-prod
npm ci --prefix packages/rom-weaver-react
npm --prefix packages/rom-weaver-react run build
```

Upload `packages/rom-weaver-react/dist/` to an HTTPS host that can serve the
required COOP/COEP/CORP headers. The [self-hosting guide](docs/self-hosting.md)
covers reverse-proxy examples, subpath routing, service-worker scope, static
hosts, and embedding RomWeaver into another application.

## Develop

Clone the repository with its submodules, then install the pinned toolchains
and JavaScript dependencies:

```bash
git clone --recurse-submodules https://github.com/brandonocasey/rom-weaver.git
cd rom-weaver
mise install
mise trust
npm ci
npm ci --prefix packages/rom-weaver-react
mise run build-wasm
npm run dev
```

The WASM build also needs WASI SDK and Brotli. See the
[development guide](docs/development.md) for prerequisites, native CLI builds,
browser tests, worktrees, and the full `mise run ci` quality gate.

## Documentation

Start with the [documentation index](docs/README.md), or jump directly to:

- [CLI usage and supported formats](docs/cli.md)
- [Self-hosting and Docker](docs/self-hosting.md)
- [Development and testing](docs/development.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Runtime configuration](docs/env-vars.md)

Format specifications and reference implementations are collected in
[`REFERENCES.md`](REFERENCES.md).

## Contributing and support

Bug reports and contributions are welcome in the
[issue tracker](https://github.com/brandonocasey/rom-weaver/issues). Read the
[contribution guide](CONTRIBUTING.md) and [code of conduct](CODE_OF_CONDUCT.md)
before submitting a change, and report
suspected vulnerabilities through the private channel in the
[security policy](SECURITY.md). If RomWeaver has been useful to you, you can
support continued development on [Ko-fi](https://ko-fi.com/brandonocasey).

## License

Copyright (C) Brandon O'Casey

RomWeaver is licensed under the
[GNU Affero General Public License](LICENSE.md), version 3 or later. Modified
versions offered over a network must make their corresponding source available
under the same license. Separate commercial terms are available from the
author. Bundled third-party components retain their own licenses; see
[`NOTICE`](NOTICE) and [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md).
