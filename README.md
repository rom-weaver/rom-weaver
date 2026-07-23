<h1 align="center"><img src="packages/rom-weaver-webapp/src/assets/app/root/logo.svg" alt="rom-weaver logo" width="64" height="64" align="middle"> rom-weaver</h1>

<p align="center">
  Local-first toolkit for ROMs and disc images: inspect, extract, compress, and apply, create, or bundle patches. Offline via a browser service-worker PWA or CLI.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/rom-weaver"><img alt="npm version" src="https://img.shields.io/npm/v/rom-weaver?logo=npm&amp;logoColor=white&amp;label=npm&amp;color=d9690f"></a>
  <a href="https://crates.io/crates/rom-weaver-cli"><img alt="crates.io version" src="https://img.shields.io/crates/v/rom-weaver-cli?logo=rust&amp;logoColor=white&amp;label=crates.io&amp;color=d9690f"></a>
  <a href="https://github.com/users/brandonocasey/packages/container/package/rom-weaver-cli"><img alt="Container images on GitHub Container Registry" src="https://img.shields.io/badge/ghcr.io-rom--weaver-d9690f?logo=docker&amp;logoColor=white"></a>
  <a href="https://github.com/rom-weaver/homebrew-tap"><img alt="Homebrew tap" src="https://img.shields.io/badge/homebrew-rom--weaver%2Ftap-d9690f?logo=homebrew&amp;logoColor=white"></a>
</p>

<p align="center">
  <a href="https://github.com/rom-weaver/rom-weaver/actions/workflows/ci.yml"><img alt="CI status" src="https://img.shields.io/github/actions/workflow/status/rom-weaver/rom-weaver/ci.yml?branch=main&amp;logo=githubactions&amp;logoColor=white&amp;label=CI&amp;color=4a6d63"></a>
  <a href="package.json"><img alt="Node.js 22 or newer" src="https://img.shields.io/badge/Node.js-22%2B-4a6d63?logo=nodedotjs&logoColor=white"></a>
  <a href=".mise.toml"><img alt="Rust 1.95" src="https://img.shields.io/badge/Rust-1.95-2c323b?logo=rust&logoColor=white"></a>
  <a href="LICENSE"><img alt="AGPL-3.0-or-later license" src="https://img.shields.io/badge/license-AGPL--3.0--or--later-4a6d63"></a>
</p>

<p align="center">
  <a href="https://rom-weaver.com/weave">Open the webapp</a>
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
`-patches` crates are published to crates.io only so `rom-weaver-cli` can use
them. The CLI and the webapp are the supported interfaces; using those crates as
libraries in another project is not supported.

### First public release

v0.7.2 is the first public version to install. The changelog and the git
history go back further, but v0.6.0 through v0.7.1 failed partway through the
release pipeline or were only partially published. v0.7.1 completed most of
the pipeline, but it still missed the crates.io CLI package, shipped a broken
unscoped npm launcher, and built the static webapp archive with mismatched
release metadata. v0.7.2 is the first release intended to have all public
install methods working together. Earlier version numbers describe development
history or incomplete releases only.

### LLM-assisted development

rom-weaver is built by a full-time software engineer in my spare time. Claude
and ChatGPT are used during development for brainstorming, implementation,
debugging, and review. I make the engineering decisions and review and test
the resulting work myself; the goal is high-quality, dependable software, but
AI-assisted code may still need extra scrutiny.

### Translations

Localized translations are early and may be entirely wrong in places. Manual
edits and corrections are welcome.

## Install

### Webapp

Open the hosted webapp at **[rom-weaver.com/weave](https://rom-weaver.com/weave)**. You
do not need to install anything or create an account. Choose **Weave**, add a
ROM and one or more patches, review the detected formats and checksums, then run
the workflow and save the result. Use **Create** to generate a distributable
patch from an original and a modified file. Your files are processed locally
and never leave the device. Install it as a PWA from the browser menu to use it
offline.
New here? [Try the sample weave](https://rom-weaver.com/weave?bundle=first-weave.zip)
with tiny synthetic files.

<a name="self-host-the-webapp"></a>

<details>
<summary>Self-host the webapp</summary>

The Docker source build serves the full webapp: it builds the WASM module, adds
cross-origin isolation headers, supports client-side routes, and precompresses
assets. The
[self-hosting guide](docs/self-hosting.md) covers reverse proxies, subpath
routing, HTTPS certificates, service-worker scope, and the required COOP/COEP
headers.

Build and start it with Docker Compose:

```bash
git clone https://github.com/rom-weaver/rom-weaver.git
cd rom-weaver
docker compose up --build --detach
curl --fail --silent --show-error http://localhost:8080/health
```

Only Docker with Compose is required; the image installs its own build
toolchains. Set `PORT` to change the host port, for example
`PORT=3000 docker compose up --build --detach`.
For standalone TLS, mount a trusted certificate as described in the guide and
set `HTTPS_PORT` instead.

</details>

### CLI

Every method below installs the same prebuilt binary from the GitHub release.
The release covers macOS arm64 and x86-64; Linux x86-64 GNU plus x86-64,
arm64, and i686 musl; and Windows arm64, x86-64, and x86.

<details>
<summary>Homebrew (macOS arm64/Intel, Linux arm64/x86-64)</summary>

```bash
brew install rom-weaver/tap/rom-weaver
```

</details>

<details>
<summary>Scoop (Windows)</summary>

```powershell
scoop bucket add rom-weaver https://github.com/rom-weaver/scoop-bucket
scoop install rom-weaver
```

</details>

<details>
<summary>Install script (macOS, Linux)</summary>

Downloads the latest release to `~/.local/bin` and verifies its checksum.
Override with `ROM_WEAVER_INSTALL_DIR` or pin with `ROM_WEAVER_VERSION`.

```bash
curl --proto '=https' --tlsv1.2 -LsSf \
  https://raw.githubusercontent.com/rom-weaver/rom-weaver/main/install.sh | sh
```

</details>

<details>
<summary>Install script (Windows)</summary>

The same thing for PowerShell, installing to `%LOCALAPPDATA%\rom-weaver\bin`.

```powershell
irm https://raw.githubusercontent.com/rom-weaver/rom-weaver/main/install.ps1 | iex
```

</details>

<details>
<summary>npm</summary>

Cross-platform, and the only channel that covers every supported target at
once. Needs Node.js 22+. The package is a launcher that pulls the right
prebuilt binary through platform-specific optional dependencies, so only your
platform's binary is downloaded.

```bash
npm install --global rom-weaver
```

For a one-off run, or to add the scoped launcher for a repository's scripts,
use the scoped package directly:

```bash
npx @rom-weaver/cli probe --input game.iso
npm install --save-dev @rom-weaver/cli
```

</details>

<details>
<summary>cargo-binstall</summary>

Downloads the same release binary rather than compiling the workspace, so it is
minutes faster than `cargo install`:

```bash
cargo binstall rom-weaver-cli
```

</details>

<details>
<summary>mise</summary>

Useful when you want the CLI managed per project in `mise.toml`. mise verifies
the release's GitHub artifact attestations on install. The
`minimum_release_age=0s` option lets new releases resolve immediately on release
day; omit it if you prefer mise's default release-age delay.

```bash
mise use 'github:rom-weaver/rom-weaver[minimum_release_age=0s]'
```

</details>

<details>
<summary>Docker</summary>

Runs from the published Linux image without installing anything:

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

</details>

<a name="build-from-source"></a>

<details>
<summary>Build from source</summary>

```bash
git clone https://github.com/rom-weaver/rom-weaver.git
cd rom-weaver
cargo install --path crates/rom-weaver-cli --locked
rom-weaver --help
```

The source build requires Rust 1.95+, CMake, Clang, and a native compiler
toolchain.

</details>

Hitting `Permission denied`? See
[File permissions](docs/cli.md#file-permissions).

The [development guide](docs/development.md) covers the full toolchain setup,
webapp builds, and tests.

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
[contribution guide](CONTRIBUTING.md) and [code of conduct](.github/CODE_OF_CONDUCT.md)
before submitting a change, and report
suspected vulnerabilities through GitHub's private reporting form in the
[security policy](.github/SECURITY.md). If rom-weaver has been useful to you, you can
support continued development on [Ko-fi](https://ko-fi.com/brandonocasey).

## License

Copyright (C) Brandon Casey and rom-weaver contributors

The public distribution is licensed under
[AGPL-3.0-or-later](LICENSE). [Commercial licensing](COMMERCIAL_LICENSE.md) is
also available for first-party rom-weaver code. Bundled third-party components
retain their own licenses. Release builds include a generated
[attribution and license inventory](https://rom-weaver.com/NOTICE) and
corresponding license texts. Those third-party terms continue to apply under
every rom-weaver licensing option.
