<h1 align="center"><img src="packages/rom-weaver-webapp/src/assets/app/root/logo.svg" alt="rom-weaver logo" width="64" height="64" align="middle"> rom-weaver</h1>

<p align="center">
  A local-first offline toolkit for ROMs and ROM hack patches. Inspect, extract, checksum, compress, trim, apply patches, create patches, or bundle shareable patch manifests at native speed. In your browser or terminal.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/rom-weaver"><img alt="npm version" src="https://img.shields.io/npm/v/rom-weaver?logo=npm&amp;logoColor=white&amp;label=npm&amp;color=d9690f"></a>
  <a href="https://crates.io/crates/rom-weaver-cli"><img alt="crates.io version" src="https://img.shields.io/crates/v/rom-weaver-cli?logo=rust&amp;logoColor=white&amp;label=crates.io&amp;color=d9690f"></a>
  <a href="https://github.com/brandonocasey/rom-weaver/pkgs/container/rom-weaver-cli"><img alt="Container images on GitHub Container Registry" src="https://img.shields.io/badge/ghcr.io-rom--weaver-d9690f?logo=docker&amp;logoColor=white"></a>
  <a href="https://github.com/brandonocasey/homebrew-tap"><img alt="Homebrew tap" src="https://img.shields.io/badge/homebrew-brandonocasey%2Ftap-d9690f?logo=homebrew&amp;logoColor=white"></a>
</p>

<p align="center">
  <a href="https://github.com/brandonocasey/rom-weaver/actions/workflows/ci.yml"><img alt="CI status" src="https://img.shields.io/github/actions/workflow/status/brandonocasey/rom-weaver/ci.yml?branch=main&amp;logo=githubactions&amp;logoColor=white&amp;label=CI&amp;color=4a6d63"></a>
  <a href="package.json"><img alt="Node.js 22 or newer" src="https://img.shields.io/badge/Node.js-22%2B-4a6d63?logo=nodedotjs&logoColor=white"></a>
  <a href=".mise.toml"><img alt="Rust 1.95" src="https://img.shields.io/badge/Rust-1.95-2c323b?logo=rust&logoColor=white"></a>
  <a href="LICENSE.md"><img alt="AGPL-3.0-or-later license" src="https://img.shields.io/badge/license-AGPL--3.0--or--later-4a6d63"></a>
</p>

<p align="center">
  <a href="https://rom-weaver.com/">Open the webapp</a>
  · <a href="docs/README.md">Docs index</a>
  · <a href="https://ko-fi.com/brandonocasey">Support on Ko-fi</a>
</p>

<!-- START doctoc -->

- [Features](#features)
- [Notices](#notices)
- [Install](#install)
- [Screenshots](#screenshots)
- [Documentation](#documentation)
- [Contributing and support](#contributing-and-support)
- [License](#license)

<!-- END doctoc -->

## Features

- **Apply and create patches.** IPS, BPS, UPS, xdelta/VCDIFF, PPF, RUP,
  BDF/BSDIFF40, APS, DCP (Dreamcast), and more than twenty formats in total,
  with ordered multi-patch chains, strict checksum validation, and cheat-code
  baking. A few - DCP, BSP, and HDiffPatch among them - are apply-only.
- **Inspect and extract containers.** ZIP, 7z, RAR, the tar family, CHD, RVZ,
  Z3DS, CSO, PBP, GCZ, WIA, WBFS, and more, including nested archives.
- **Create compressed containers.** ZIP, 7z, CHD, RVZ, and Z3DS with
  codec-aware compression settings, validated against reference tools such as
  chdman and dolphin-tool.
- **Checksum and verify.** CRC32, MD5, SHA-1, SHA-256, BLAKE3, and friends,
  with copier-header detection, header repair, and header-aware checksum
  variants.
- **Trim and restore.** Trimming for NDS, GBA, 3DS, XISO, and RVZ scrub. NDS,
  GBA, and 3DS can be reverted, with an opt-in footer that restores the
  original file byte-for-byte.
- **Share workflows.** Distributable [`rom-weaver-bundle.json`](docs/rom-weaver-bundle-v1.schema.json)
  bundles pin patch order, checksums, and output naming so others can replay
  the exact workflow.
- **Local-first and private.** Everything runs on your machine. The webapp is
  an installable PWA that works offline and never uploads your files.
- **One engine, two frontends.** The same Rust core powers the terminal CLI
  and the threaded WASM webapp, with line-delimited JSON output for scripting.

The complete format, codec, and checksum compatibility tables are maintained
in the [CLI guide](docs/cli.md#supported-formats).

## Notices

### Beta status

rom-weaver is beta software and follows Semantic Versioning, but until v1.0,
breaking changes may still happen between minor releases. Patching,
compressing, extracting, and bundling have all been tested extensively. That
hands-on testing happens on macOS and Linux; Windows runs the same automated
test suite in CI but has seen much less real-world use, so expect rougher
edges there and please report anything Windows-specific. If you
rely on the APIs or CLI flags, expect things to be a bit tougher: those
interfaces may still change as the project heads toward v1.0. Trim and Tools are
currently untested but theoretically working, so they are disabled in the
current webapp. The `rom-weaver-core`, `-checksum`, `-containers`, and
`-patches` crates are published to crates.io only so `rom-weaver-cli` can be;
the CLI and the webapp are the supported interfaces, and using those crates as
libraries elsewhere is not supported.

### First public release

v0.6.7 is the first public release available to install. The changelog and the
git history go back further, but v0.6.0 through v0.6.6 failed partway through
the release pipeline or were only partially published. v0.6.7 is the first
release with a complete set of artifacts across npm, Homebrew, and the
container registry. Earlier version numbers describe development history or
incomplete releases only.

### LLM-assisted development

rom-weaver is built by a full-time software engineer in my spare time. Claude
and ChatGPT are used during development for brainstorming, implementation,
debugging, and review. I make the engineering decisions and review and test
the resulting work myself; the goal is high-quality, dependable software, but
AI-assisted code may still need extra scrutiny.

## Install

### Webapp

Open the hosted webapp at **[rom-weaver.com](https://rom-weaver.com/)**. There
is nothing to install and no account: choose **Weave**, add a ROM and one or
more patches, review the detected formats and checksums, then run the workflow
and save the result. Use **Create** to generate a distributable patch from
an original and a modified file. Your files are processed locally and never
leave the device. Install it as a PWA from the browser menu to use it offline.
New here? [Try the sample weave](https://rom-weaver.com/?bundle=first-weave.zip#/weave)
with tiny synthetic files.

To run the webapp on your own infrastructure, see
[Self-host the webapp](#self-host-the-webapp) below.

### CLI

Prebuilt installers will become available with the first GitHub Release.

Install with Homebrew on macOS or x86-64 Linux:

```bash
brew install brandonocasey/tap/rom-weaver
```

Or download the latest release to `~/.local/bin`:

```bash
curl --proto '=https' --tlsv1.2 -LsSf \
  https://raw.githubusercontent.com/brandonocasey/rom-weaver/main/install.sh | sh
```

Or run it from the published Linux image, without installing anything:

```bash
docker run --rm \
  --user "$(id -u):$(id -g)" \
  --volume "$PWD:/work" \
  ghcr.io/brandonocasey/rom-weaver-cli:latest \
  probe --input /work/game.iso
```

Mount your ROM directory at `/work` and pass paths under it. `--user` matters:
bind-mounted files keep their host ownership, so without it the container cannot
read files it does not own and leaves anything it writes owned by an unknown uid.
See [Run in Docker](docs/cli.md#run-in-docker).

To install the current source build instead:

```bash
git clone https://github.com/brandonocasey/rom-weaver.git
cd rom-weaver
cargo install --path crates/rom-weaver-cli --locked
rom-weaver --help
```

The source build requires Rust 1.95+, CMake, Clang, and a native compiler
toolchain.

Hitting `Permission denied`? See
[File permissions](docs/cli.md#file-permissions).

The [development guide](docs/development.md) covers the full toolchain setup,
webapp builds, and tests.

### Self-host the webapp

The Docker source build serves the full webapp — WASM build, cross-origin
isolation headers, SPA fallback, and precompressed assets included. The
[self-hosting guide](docs/self-hosting.md) covers reverse proxies, subpath
routing, service-worker scope, and the required COOP/COEP headers.

Build and start it with Docker Compose:

```bash
git clone https://github.com/brandonocasey/rom-weaver.git
cd rom-weaver
docker compose up --build --detach
curl --fail --silent --show-error http://localhost:8080/health
```

Only Docker with Compose is required; the image installs its own build
toolchains. Set `PORT` to change the host port, for example
`PORT=3000 docker compose up --build --detach`.

## Screenshots

[View every screenshot at full size.](docs/screenshots.md)

<table>
  <thead>
    <tr>
      <th scope="col">Name</th>
      <th scope="col">Screenshot</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Desktop — Apply patches (Weave)</td>
      <td>
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="packages/rom-weaver-webapp/design/weave-desktop-dark.png">
          <img src="packages/rom-weaver-webapp/design/weave-desktop-light.png" alt="Filled Weave patch workflow on desktop">
        </picture>
      </td>
    </tr>
    <tr>
      <td>Desktop — Create a patch</td>
      <td>
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="packages/rom-weaver-webapp/design/create-desktop-dark.png">
          <img src="packages/rom-weaver-webapp/design/create-desktop-light.png" alt="Filled Create patch workflow on desktop">
        </picture>
      </td>
    </tr>
    <tr>
      <td>Mobile — Apply patches (Weave)</td>
      <td align="center">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="packages/rom-weaver-webapp/design/weave-mobile-dark.png">
          <img src="packages/rom-weaver-webapp/design/weave-mobile-light.png" alt="Filled Weave patch workflow on mobile" width="390">
        </picture>
      </td>
    </tr>
    <tr>
      <td>Mobile — Create a patch</td>
      <td align="center">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="packages/rom-weaver-webapp/design/create-mobile-dark.png">
          <img src="packages/rom-weaver-webapp/design/create-mobile-light.png" alt="Filled Create patch workflow on mobile" width="390">
        </picture>
      </td>
    </tr>
  </tbody>
</table>

## Documentation

The [documentation index](docs/README.md) routes to the CLI, deployment,
integration, development, architecture, and format-reference guides.

## Contributing and support

Bug reports and contributions are welcome. Read the
[contribution guide](.github/CONTRIBUTING.md) and [code of conduct](.github/CODE_OF_CONDUCT.md)
before submitting a change, and report
suspected vulnerabilities through GitHub's private reporting form in the
[security policy](.github/SECURITY.md). If rom-weaver has been useful to you, you can
support continued development on [Ko-fi](https://ko-fi.com/brandonocasey).

## License

Copyright (C) Brandon Casey

See [LICENSE.md](LICENSE.md) for the license terms. Bundled third-party
components retain their own licenses. Release builds include a generated
[attribution notice](https://rom-weaver.com/NOTICE),
[third-party license inventory](https://rom-weaver.com/THIRD_PARTY_LICENSES.md),
and corresponding license texts.
