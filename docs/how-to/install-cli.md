# Install the CLI

Every way to install the rom-weaver command-line tool: package managers,
verified install scripts, npm, Docker, and building from source. Each method
installs the same `rom-weaver` CLI; pick the one that fits your machine and
move on to your [first apply](../tutorials/cli-first-weave.md#first-apply).

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
- [Run in Docker](#run-in-docker)
- [Install shell completions](#install-shell-completions)
- [Development checkout](#development-checkout)

<!-- END doctoc -->


## Prebuilt install

Every method here installs a binary built for the release: macOS arm64 and
x86-64; Linux x86-64 GNU plus x86-64, arm64, and i686 musl; and Windows
arm64, x86-64, and x86.

Homebrew, the install scripts, and npm also carry the generated CLI manpages
and shell completions. Scoop, cargo-binstall, mise, and `cargo install` install
the executable only; see
[Install shell completions](#install-shell-completions) for those methods, and
[man pages](../reference/cli.md#man-pages) for where the manpages come from.

### Homebrew (macOS arm64/Intel, Linux arm64/x86-64)

```bash
brew install rom-weaver/tap/rom-weaver
```

### Scoop (Windows)

```powershell
scoop bucket add rom-weaver https://github.com/rom-weaver/scoop-bucket
scoop install rom-weaver
```

### Install script (macOS, Linux)

Downloads the latest release to `~/.local/bin` and checks its build provenance,
refusing to install a binary this repository did not publish. Set
`ROM_WEAVER_INSTALL_DIR` to choose another directory, or `ROM_WEAVER_VERSION` to
install a specific release. See [Verify a download](verify-downloads.md) to run
that check yourself or change how strict it is. It also installs manpages under
`~/.local/share/man/man1` and completions under the standard per-user shell
directories.

```bash
curl --proto '=https' --tlsv1.2 -LsSf \
  https://raw.githubusercontent.com/rom-weaver/rom-weaver/main/install.sh | sh
```

### Install script (Windows)

The PowerShell equivalent, installing to `%LOCALAPPDATA%\rom-weaver\bin`. It
honors the same environment variables and runs the same checks. The PowerShell
completion is installed under that directory's `completions` folder.

```powershell
irm https://raw.githubusercontent.com/rom-weaver/rom-weaver/main/install.ps1 | iex
```

### npm

The only channel covering every supported target at once. Needs Node.js 22+.
The unscoped `rom-weaver` package points at the `@rom-weaver/cli` launcher,
whose binary arrives through a platform-specific optional dependency, so only
your platform's binary is downloaded.

```bash
npm install --global rom-weaver
```

Use the scoped launcher directly for a one-off run, or as a dev dependency for
a repository's scripts:

```bash
npx @rom-weaver/cli probe --input game.iso
npm install --save-dev @rom-weaver/cli
```

### cargo-binstall

Fetches the released binary instead of compiling from source, which
`cargo install rom-weaver-cli` would otherwise do.

```bash
cargo binstall rom-weaver-cli
```

### mise

Manages the CLI per project in `mise.toml` and verifies the release's GitHub
artifact attestations on install.
[Install mise](https://mise.jdx.dev/installing-mise.html) first.
The `minimum_release_age=0s` option lets
new releases resolve immediately on release day; omit it if you prefer mise's
default release-age delay.

```bash
mise use 'github:rom-weaver/rom-weaver[minimum_release_age=0s]'
```

## Source install

Install the current source build. This requires Rust 1.95, CMake, Clang, and a
native compiler toolchain.

```bash
git clone https://github.com/rom-weaver/rom-weaver.git
cd rom-weaver
cargo install --path crates/rom-weaver-cli --locked
rom-weaver --version
```

## Run in Docker

A Linux CLI image is published for each release. It carries its own runtime, so
nothing but Docker is required:

```bash
docker run --rm \
  --user "$(id -u):$(id -g)" \
  --volume "$PWD:/work" \
  ghcr.io/rom-weaver/rom-weaver-cli:latest \
  probe --input /work/game.iso
```

The image's working directory is `/work`; mount the directory holding your ROMs
there and pass paths under `/work`. Arguments after the image name go straight to
`rom-weaver`, so `--help` and every subcommand work unchanged.

`--user "$(id -u):$(id -g)"` is what makes the output usable. Bind-mounted files
keep their host ownership. Without that flag, the container runs as the base
image's `nonroot` user (uid 65532). The container may refuse permission to read
your files, and anything it writes ends up owned by a uid that does not exist on
the host. rom-weaver reads no home directory or user config, so an arbitrary uid
needs no matching account inside the image.

The image is distroless - it contains the `rom-weaver` binary and its C runtime
and nothing else, so there is no shell inside and `--entrypoint sh` will not get
you a prompt.

Mount read-only sources with `:ro` and give writes their own destination:

```bash
docker run --rm \
  --user "$(id -u):$(id -g)" \
  --volume "$HOME/roms:/work/in:ro" \
  --volume "$PWD/out:/work/out" \
  ghcr.io/rom-weaver/rom-weaver-cli:latest \
  patch apply --input /work/in/game.sfc --patch /work/in/hack.bps --output /work/out/patched.sfc
```

Tags follow the release: `latest`, the exact version (`X.Y.Z`), and the minor
series (`X.Y`). Stable releases also receive a major-series tag once the
project reaches 1.0. Prereleases publish under `beta` instead of `latest`. The
image is built for `linux/amd64` and `linux/arm64`; Docker selects the native
variant on Apple Silicon and other arm64 hosts.

## Install shell completions

The Homebrew and script installers already place completion files. npm
packages ship them under `docs/completions`. For the other install methods,
print the script and save it where your shell looks for one, then start a new
shell:

```bash
rom-weaver completions bash > /etc/bash_completion.d/rom-weaver
rom-weaver completions zsh  > ~/.zfunc/_rom-weaver
rom-weaver completions fish > ~/.config/fish/completions/rom-weaver.fish
```

`bash`, `zsh`, `fish`, `powershell`, and `elvish` are supported.

## Development checkout

For a development checkout, follow the [development guide](../development/development.md)
and use `cargo run -p rom-weaver-cli --bin rom-weaver --` in place of
`rom-weaver`.

Installed? Run your [first apply](../tutorials/cli-first-weave.md#first-apply), then continue
with the task guides or the [CLI reference](../reference/cli.md).
