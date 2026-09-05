<h1 align="center"><img src="packages/rom-weaver-webapp/src/assets/app/root/logo.svg" alt="rom-weaver logo" width="64" height="64" align="middle"> rom-weaver</h1>

<p align="center">
  Local-first toolkit for ROMs and disc images: inspect, extract, compress, and apply, create, or bundle patches. Offline via a browser service-worker PWA or CLI.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/rom-weaver"><img alt="npm version" src="https://img.shields.io/npm/v/rom-weaver?logo=npm&amp;logoColor=white&amp;label=npm&amp;color=d9690f"></a>
  <a href="https://crates.io/crates/rom-weaver-cli"><img alt="crates.io version" src="https://img.shields.io/crates/v/rom-weaver-cli?logo=rust&amp;logoColor=white&amp;label=crates.io&amp;color=d9690f"></a>
  <a href="https://github.com/orgs/rom-weaver/packages/container/package/rom-weaver-cli"><img alt="Container images on GitHub Container Registry" src="https://img.shields.io/badge/ghcr.io-rom--weaver-d9690f?logo=docker&amp;logoColor=white"></a>
  <a href="https://github.com/rom-weaver/homebrew-tap"><img alt="Homebrew tap" src="https://img.shields.io/badge/homebrew-rom--weaver%2Ftap-d9690f?logo=homebrew&amp;logoColor=white"></a>
</p>

<p align="center">
  <a href="https://github.com/rom-weaver/rom-weaver/actions/workflows/ci.yml"><img alt="CI status" src="https://img.shields.io/github/actions/workflow/status/rom-weaver/rom-weaver/ci.yml?branch=main&amp;logo=githubactions&amp;logoColor=white&amp;label=CI&amp;color=365d82"></a>
  <a href="package.json"><img alt="Node.js 22 or newer" src="https://img.shields.io/badge/Node.js-22%2B-365d82?logo=nodedotjs&logoColor=white"></a>
  <a href=".config/mise.toml"><img alt="Rust 1.97.1" src="https://img.shields.io/badge/Rust-1.97.1-2c323b?logo=rust&logoColor=white"></a>
  <a href="LICENSE"><img alt="AGPL-3.0-or-later license" src="https://img.shields.io/badge/license-AGPL--3.0--or--later-365d82"></a>
</p>

<p align="center">
  <a href="https://rom-weaver.com/apply">Open the webapp</a>
  · <a href="https://github.com/sponsors/brandonocasey">Sponsor on GitHub</a>
  · <a href="https://ko-fi.com/brandonocasey">Support on Ko-fi</a>
</p>

<!-- START doctoc -->

- [Install](#install)
- [Webapp](#webapp)
- [Self-hosting](#self-hosting)
- [CLI](#cli)
- [Why](#why)
- [Performance](#performance)
- [Features](#features)
- [Notices](#notices)
- [Screenshots](#screenshots)
- [Documentation](#documentation)
- [Contributing and support](#contributing-and-support)
- [License](#license)

<!-- END doctoc -->

## Install

Choose the [webapp](#webapp), [self-hosting](#self-hosting), or [CLI](#cli) path below.

## Webapp

Open [rom-weaver.com/apply](https://rom-weaver.com/apply). Add your ROM and patches, then download the result. Files are processed on your device. No install or account is needed.

Start with [your first patch](docs/tutorials/first-patch.md) to practise on supplied homebrew files. The [browser guides](docs/README.md#in-the-browser) cover applying, creating, bundling, and testing ROM patches.

## Self-hosting

Use the published Docker image or static release archive. The [self-hosting guide](docs/hosting/self-hosting.md) covers both, including HTTPS, reverse proxies, and subpaths.

## CLI

Native release assets cover macOS arm64 and x86-64; Linux x86-64 GNU plus x86-64, arm64, and i686 musl; and Windows arm64, x86-64, and x86.

Three recommended ways to install:

```bash
brew install rom-weaver/tap/rom-weaver
```

```bash
curl --proto '=https' --tlsv1.2 -LsSf \
  https://raw.githubusercontent.com/rom-weaver/rom-weaver/main/install.sh | sh
```

```bash
npm install --global rom-weaver
```


Homebrew covers macOS arm64/Intel and Linux arm64/x86-64. The install script covers macOS and Linux: it downloads the latest release to `~/.local/bin` and checks its build provenance, refusing a definite verification failure. If the check cannot run, it warns and continues unless strict verification is enabled; see [Verify a download](docs/how-to/verify-downloads.md). npm is the only channel covering every supported target at once, and needs Node.js 22+.

<a name="build-from-source"></a>

Windows, Scoop, PowerShell, cargo-binstall, mise, Docker, shell completions, and building from source are all in [Install the CLI](./docs/how-to/install-cli.md).

Hitting `Permission denied`? See [File permissions](./docs/reference/cli.md#file-permissions).

The [development guide](./docs/development/development.md) covers the full toolchain setup, webapp builds, and tests.

## Why

A patch job can require extraction, several patches in order, checksum checks, and compression. rom-weaver runs those steps together and can save the recipe as a bundle.

[Browser and CLI](docs/explanation/browser-and-cli.md) explains the two interfaces. [Comparison with similar tools](docs/explanation/comparisons.md) covers alternatives.

## Performance

The [performance guide](docs/development/performance.md) records measured compression and extraction times, output sizes, hardware, and test settings. Results vary by format and input; some compression cases are slower than the reference tool.

The CLI and browser share one Rust engine. Browser workers and storage add costs, so native timings do not predict browser performance.

## Features

- **Apply and create patches.** Twenty-one formats, including IPS, BPS, UPS, xdelta/VCDIFF, PPF, RUP, BDF/BSDIFF40, APS, and DCP (Dreamcast), with ordered multi-patch chains, checksum validation when the format or bundle supplies expected values, and cheat-code baking. Three of them (DCP, BSP, and HDiffPatch) can only be applied, not created.
- **Inspect and extract containers.** ZIP, 7z, RAR, the tar family, CHD, RVZ, Z3DS, CSO, PBP, GCZ, WIA, WBFS, and more, including nested archives.
- **Create format-specific compressed containers.** ZIP, 7z, CHD, RVZ, and Z3DS with codec-aware compression settings. CHD and RVZ outputs are checked for round-trip compatibility with chdman and dolphin-tool.
- **Checksum and verify.** CRC32, MD5, SHA-1, SHA-256, BLAKE3, and friends, with copier-header detection, header repair, and header-aware checksum variants.
- **Trim and restore.** Trimming for NDS, GBA, 3DS, XISO, and RVZ scrub. NDS, GBA, and 3DS can be reverted, with an opt-in footer that restores the original file byte-for-byte.
- **Share workflows.** Distributable [`rom-weaver-bundle.json`](./docs/rom-weaver-bundle-v1.schema.json) bundles pin patch order, checksums, and output naming so others can replay the exact workflow.
- **Local-first and private.** Everything runs on your machine. The webapp is an installable PWA that works offline and never uploads your files.
- **One engine, two frontends.** The same Rust core powers the terminal CLI and the threaded WASM webapp. CLI operation commands can emit line-delimited JSON for scripting.

The complete format, codec, and checksum compatibility tables are maintained in [Supported formats](./docs/reference/formats.md).

## Notices

### Beta status

rom-weaver is beta software and follows Semantic Versioning, but until v1.0, breaking changes may still happen between minor releases. Patching, compressing, extracting, and bundling are covered by automated tests. Hands-on testing happens on macOS and Linux; Windows is covered by hosted CI but has seen much less real-world use, so expect rougher edges there and please report anything Windows-specific. If you rely on the APIs or CLI flags, expect things to be a bit tougher: those interfaces may still change as the project heads toward v1.0. Trim and Tools are still beta, so they are disabled by default in the webapp and can be enabled in Settings. The `rom-weaver-core`, `-checksum`, `-containers`, and `-patches` crates are published to crates.io only so `rom-weaver-cli` can use them. The CLI and the webapp are the supported interfaces; using those crates as libraries in another project is not supported.

### First complete public release

v0.7.2 was the first complete public release. The changelog and the git history go back further, but v0.6.0 through v0.7.1 failed partway through the release pipeline or were only partially published. v0.7.1 completed most of the pipeline, but it still missed the crates.io CLI package, shipped a broken unscoped npm launcher, and built the static webapp archive with mismatched release metadata. Starting with v0.7.2, all public install methods were intended to work together. Install commands below resolve the current release unless you explicitly pin a version.

### LLM-assisted development

rom-weaver is built by a full-time software engineer in my spare time. Claude and ChatGPT are used during development for brainstorming, implementation, debugging, and review. I make the engineering decisions and review and test the resulting work myself; the goal is high-quality, dependable software, but AI-assisted code may still need extra scrutiny.

### Translations

Localized translations are early and may be entirely wrong in places. Manual edits and corrections are welcome.

## Screenshots

[View every screenshot at full size.](./docs/development/screenshots.md)

<table>
  <thead>
    <tr>
      <th scope="col">Name</th>
      <th scope="col">Screenshot</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Desktop: ordered patch stack</td>
      <td>
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/apply-patches-desktop-dark.webp">
          <img src="docs/screenshots/apply-patches-desktop-light.webp" alt="Focused Apply patch stack with two ordered sample patches on desktop">
        </picture>
      </td>
    </tr>
    <tr>
      <td>Desktop: create output</td>
      <td>
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/create-output-desktop-dark.webp">
          <img src="docs/screenshots/create-output-desktop-light.webp" alt="Focused Create output card with BPS selected on desktop">
        </picture>
      </td>
    </tr>
    <tr>
      <td>Mobile: Original and Modified</td>
      <td align="center">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/create-inputs-mobile-dark.webp">
          <img src="docs/screenshots/create-inputs-mobile-light.webp" alt="Focused Create Original and Modified cards on mobile" width="390">
        </picture>
      </td>
    </tr>
    <tr>
      <td>Mobile: bundle output options</td>
      <td align="center">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/bundle-output-mobile-dark.webp">
          <img src="docs/screenshots/bundle-output-mobile-light.webp" alt="Focused patch-only bundle controls on mobile" width="390">
        </picture>
      </td>
    </tr>
  </tbody>
</table>

## Documentation

Start with the browser-first [documentation home](https://rom-weaver.com/docs) or the repository [documentation index](./docs/README.md). The web docs include a task and tool picker, guided samples, focused screenshots, and a [FAQ](./docs/faq.md). CLI, deployment, integration, development, architecture, and format references each have their own guides.

## Contributing and support

Bug reports and contributions are welcome. Read the [contribution guide](CONTRIBUTING.md) and [code of conduct](.github/CODE_OF_CONDUCT.md) before submitting a change. Because rom-weaver is dual-licensed, code and documentation changes need a one-time signature on the [Contributor License Agreement](CLA.md). The `CLA Signed` check asks for it on your first pull request. One signature covers every repository in the [`rom-weaver` organization](https://github.com/rom-weaver) whose contribution process references the agreement. You keep the copyright in your work. Report suspected vulnerabilities through GitHub's private reporting form in the [security policy](.github/SECURITY.md). If rom-weaver has been useful to you, you can support continued development through [GitHub Sponsors](https://github.com/sponsors/brandonocasey) or [Ko-fi](https://ko-fi.com/brandonocasey).

## License

Copyright © Brandon Casey and rom-weaver contributors

The public distribution is licensed under [AGPL-3.0-or-later](LICENSE). [Commercial licensing](COMMERCIAL.md) is also available for first-party rom-weaver code. Bundled third-party components retain their own licenses. Release builds include a generated [combined attribution and license inventory](https://rom-weaver.com/NOTICE) and corresponding license texts. Those third-party terms continue to apply under every rom-weaver licensing option.
