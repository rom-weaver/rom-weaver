# Install the CLI

Every way to install the rom-weaver command-line tool: package managers, verified install scripts, npm, Docker, and building from source. Each method installs the same `rom-weaver` CLI; pick the one that fits your machine and move on to your [first apply](../tutorials/cli-first-weave.md#first-apply).

<!-- START doctoc -->
## Table of contents

- [Prebuilt install](#prebuilt-install)
  - [Homebrew (macOS arm64/Intel, Linux arm64/x86-64)](#homebrew-macos-arm64intel-linux-arm64x86-64)
  - [Scoop (Windows)](#scoop-windows)
  - [Install script (macOS, Linux)](#install-script-macos-linux)
  - [Install script (Windows)](#install-script-windows)
  - [npm](#npm)
  - [cargo-binstall](#cargo-binstall)
  - [mise](#mise)
- [Source install](#source-install)
  - [Install the data without a network](#install-the-data-without-a-network)
- [Run in Docker](#run-in-docker)
- [Install shell completions](#install-shell-completions)
- [Development checkout](#development-checkout)

<!-- END doctoc -->


## Prebuilt install

Every method here installs a binary built for the release: macOS arm64 and x86-64; Linux x86-64 GNU plus x86-64, arm64, and i686 musl; and Windows arm64, x86-64, and x86.

Some install methods deliver only the executable, so two extra steps finish them: `rom-weaver man --install` for the manpages, and `rom-weaver setup` for the identify and cheat databases. `identify`, `probe --identify`, and cheat baking read that data; every other command works without it.

| Method | Manpages | Identify and cheat data |
| --- | --- | --- |
| Homebrew | included | included |
| Scoop | included | included |
| Install script (macOS, Linux) | included | included |
| Install script (Windows) | included | included |
| npm | included | included |
| Docker | included | included |
| cargo-binstall | `rom-weaver man --install` | `rom-weaver setup` |
| mise | `rom-weaver man --install` | `rom-weaver setup` |
| `cargo install` (source) | `rom-weaver man --install` | `rom-weaver setup` |

Homebrew, the macOS/Linux install script, and global npm installs put the generated CLI manpages in a Unix manpath. The Windows installers store them under the installed package's `docs/man` directory. Cargo, cargo-binstall, and mise install the executable only; run `rom-weaver man --install` after any of them. The Docker image stores the pages under `/usr/local/share/man/man1`, but it has no `man(1)` program. See [Install shell completions](#install-shell-completions) for completion files, and [man pages](../reference/cli.md#man-pages) for the page commands.

### Homebrew (macOS arm64/Intel, Linux arm64/x86-64)

```bash
brew install rom-weaver/tap/rom-weaver
```

### Scoop (Windows)

```powershell
scoop bucket add rom-weaver https://github.com/rom-weaver/scoop-bucket
scoop install rom-weaver
```

Scoop stores the generated manpages under the app directory's `docs\\man` folder. Find that directory with `scoop prefix rom-weaver`; Windows has no standard manpath.

### Install script (macOS, Linux)

Downloads the latest release to `~/.local/bin` and checks its build provenance, refusing a definite verification failure. If the check cannot run, it warns and continues unless `ROM_WEAVER_REQUIRE_ATTESTATION=1` is set. Set `ROM_WEAVER_INSTALL_DIR` to choose another directory, or `ROM_WEAVER_VERSION` to install a specific release. See [Verify a download](verify-downloads.md) to run that check yourself or change how strict it is. It also installs manpages under `~/.local/share/man/man1` and completions under the standard per-user shell directories.

```bash
curl --proto '=https' --tlsv1.2 -LsSf \
  https://raw.githubusercontent.com/rom-weaver/rom-weaver/main/install.sh | sh
```

### Install script (Windows)

The PowerShell equivalent, installing to `%LOCALAPPDATA%\rom-weaver\bin`. It honors the same environment variables and runs the same checks. The generated manpages are stored under that directory's `docs\man` folder because Windows has no standard manpath. The PowerShell completion is installed under its `completions` folder.

```powershell
irm https://raw.githubusercontent.com/rom-weaver/rom-weaver/main/install.ps1 | iex
```

### npm

The only channel covering every supported target at once. Needs Node.js 22+. The unscoped `rom-weaver` package points at the `@rom-weaver/cli` launcher, whose binary arrives through a platform-specific optional dependency, so only your platform's binary is downloaded.

Global installs of either package install the generated manpages on Unix. A local npm install keeps the pages under the package's `docs/man` directory.

```bash
npm install --global rom-weaver
```

Use the scoped launcher directly for a one-off run, or as a dev dependency for a repository's scripts:

```bash
npx @rom-weaver/cli probe --input game.iso
npm install --save-dev @rom-weaver/cli
```

### cargo-binstall

Fetches the released binary instead of compiling from source, which `cargo install rom-weaver-cli` would otherwise do.

```bash
cargo binstall rom-weaver-cli
```

`cargo-binstall` installs only the executable, so no manpages, identify database, or cheat shards sit beside it. Install them after:

```bash
rom-weaver man --install
rom-weaver setup
```

`rom-weaver setup` downloads this version's identify packs and cheat shards from its GitHub release into the per-user data directory. Running it again reports what is installed instead of downloading again; `--force` refreshes it. The Homebrew, scoop, npm, install-script, and Docker packages already carry that data, so `setup` only reports on those.

### mise

Manages the CLI per project in `mise.toml` and verifies the release's GitHub artifact attestations on install. [Install mise](https://mise.jdx.dev/installing-mise.html) first. The `minimum_release_age=0s` option lets new releases resolve immediately on release day; omit it if you prefer mise's default release-age delay.

```bash
mise use 'github:rom-weaver/rom-weaver[minimum_release_age=0s]'
```

The generic GitHub backend installs only one release asset. Install the generated manpages and the identify and cheat databases after it finishes:

```bash
rom-weaver man --install
rom-weaver setup
```

## Source install

Install the current source build. This requires Rust 1.95, CMake, Clang, and a native compiler toolchain.

```bash
git clone https://github.com/rom-weaver/rom-weaver.git
cd rom-weaver
cargo install --path crates/rom-weaver-cli --locked
rom-weaver --version
```

Cargo installs the executable only. Install the generated manpages after it finishes:

```bash
rom-weaver man --install
```

Install the identify and cheat databases:

```bash
rom-weaver setup
```

`setup` downloads them from the matching GitHub release, so a source build of an unreleased commit has no data to fetch. Build the data locally in that case with `node scripts/ensure-identify-data.mjs`; see [Identify data](../development/identify-data.md).

### Install the data without a network

On a machine that cannot reach GitHub, download `rom-weaver-identify-data.tar.br` from the [release page](https://github.com/rom-weaver/rom-weaver/releases) on a machine that can, copy it across, and point `setup` at it:

```bash
rom-weaver setup --from rom-weaver-identify-data.tar.br
```

One archive serves as many machines as you like. Use the archive built for the version you installed; `setup` verifies every pack against the index inside it and fails rather than install a mismatched database.

## Run in Docker

A Linux CLI image is published for each release. It carries its own runtime, so nothing but Docker is required:

```bash
docker run --rm \
  --user "$(id -u):$(id -g)" \
  --volume "$PWD:/work" \
  ghcr.io/rom-weaver/rom-weaver-cli:latest \
  probe --input /work/game.iso
```

The image's working directory is `/work`; mount the directory holding your ROMs there and pass paths under `/work`. Arguments after the image name go straight to `rom-weaver`, so `--help` and every subcommand work unchanged. The generated manpages are present under `/usr/local/share/man/man1`; the image has no `man(1)` program, so use the [CLI reference](../reference/cli.md) or copy a page out with `docker cp`.

`--user "$(id -u):$(id -g)"` is what makes the output usable. Bind-mounted files keep their host ownership. Without that flag, the container runs as the base image's `nonroot` user (uid 65532). The container may refuse permission to read your files, and anything it writes ends up owned by a uid that does not exist on the host. rom-weaver reads no home directory or user config, so an arbitrary uid needs no matching account inside the image.

The image is distroless - it contains the `rom-weaver` binary and its C runtime and nothing else, so there is no shell inside and `--entrypoint sh` will not get you a prompt.

Mount read-only sources with `:ro` and give writes their own destination:

```bash
docker run --rm \
  --user "$(id -u):$(id -g)" \
  --volume "$HOME/roms:/work/in:ro" \
  --volume "$PWD/out:/work/out" \
  ghcr.io/rom-weaver/rom-weaver-cli:latest \
  patch apply --input /work/in/game.sfc --patch /work/in/hack.bps --output /work/out/patched.sfc
```

Tags follow the release: `latest`, the exact version (`X.Y.Z`), and the minor series (`X.Y`). Stable releases also receive a major-series tag once the project reaches 1.0. Prereleases publish under `beta` instead of `latest`. The image is built for `linux/amd64` and `linux/arm64`; Docker selects the native variant on Apple Silicon and other arm64 hosts.

## Install shell completions

The Homebrew and script installers already place completion files. npm packages ship them under `docs/completions`. For the other install methods, print the script and save it where your shell looks for one, then start a new shell:

```bash
rom-weaver completions bash > /etc/bash_completion.d/rom-weaver
rom-weaver completions zsh  > ~/.zfunc/_rom-weaver
rom-weaver completions fish > ~/.config/fish/completions/rom-weaver.fish
```

`bash`, `zsh`, `fish`, `powershell`, and `elvish` are supported.

## Development checkout

For a development checkout, follow the [development guide](../development/development.md) and use `cargo run -p rom-weaver-cli --bin rom-weaver --` in place of `rom-weaver`.

Installed? Run your [first apply](../tutorials/cli-first-weave.md#first-apply), then continue with the task guides or the [CLI reference](../reference/cli.md).
