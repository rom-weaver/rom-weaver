# Install the CLI

Every way to install the rom-weaver command-line tool: package managers,
verified install scripts, npm, Docker, and building from source. Each method
installs the same binary; pick the one that fits your machine and move on to
your [first weave](get-started.md#first-weave).

<!-- START doctoc -->
## Table of contents

- [Prebuilt install](#prebuilt-install)
  - [Homebrew (macOS arm64/Intel, Linux arm64/x86-64)](#homebrew-macos-arm64intel-linux-arm64x86-64)
  - [Scoop (Windows)](#scoop-windows)
  - [Install script (macOS, Linux)](#install-script-macos-linux)
  - [Install script (Windows)](#install-script-windows)
  - [Verifying a download](#verifying-a-download)
    - [Verifying a file you downloaded by hand](#verifying-a-file-you-downloaded-by-hand)
    - [Checking the signature](#checking-the-signature)
    - [What the install scripts do](#what-the-install-scripts-do)
  - [npm](#npm)
  - [cargo-binstall](#cargo-binstall)
  - [mise](#mise)
- [Source install](#source-install)
- [Run in Docker](#run-in-docker)
- [Development checkout](#development-checkout)

<!-- END doctoc -->


## Prebuilt install

Every method here installs a binary built for the release: macOS arm64 and
x86-64; Linux x86-64 GNU plus x86-64, arm64, and i686 musl; and Windows
arm64, x86-64, and x86.

Homebrew, the install scripts, and npm also carry the generated CLI manpages
and shell completions. Scoop, cargo-binstall, mise, and `cargo install` install
the executable only; use the
[completion](reference.md#shell-completions) and
[man page](reference.md#man-pages) commands for those methods.

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
install a specific release. See [Verifying a download](#verifying-a-download)
for what that check does and does not prove. It also installs manpages under
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

### Verifying a download

Every published artifact carries signed [build provenance][slsa]: the platform
binaries and the webapp tarball on each release, the npm packages, and the
container images. It records which workflow, run, and commit produced the file,
so an asset uploaded by anything other than the release workflow - a stolen
token, a maintainer's laptop - has none.

#### Verifying a file you downloaded by hand

Hash the file and ask GitHub whether this repository's release workflow built
exactly those bytes. Nothing needs installing - this is the same check both
install scripts run:

```bash
file=rom-weaver-linux-x64-gnu

# sha256sum on Linux; macOS ships shasum instead. Probed rather than tried and
# fallen back from: `$(missing | cut)` exits 0, so a fallback keyed on the exit
# status never runs and the digest silently comes out empty.
if command -v sha256sum >/dev/null 2>&1; then
  digest=$(sha256sum "$file" | cut -d ' ' -f 1)
else
  digest=$(shasum -a 256 "$file" | cut -d ' ' -f 1)
fi

if curl -fsS "https://api.github.com/repos/rom-weaver/rom-weaver/attestations/sha256:$digest?predicate_type=https://slsa.dev/provenance/v1" \
  | grep -q '"repository_id"'
then
  echo "VERIFIED: built by the rom-weaver release workflow"
else
  echo "NOT VERIFIED: no build provenance covers this file" >&2
fi
```

The PowerShell equivalent:

```powershell
$file = 'rom-weaver-win32-x64-msvc.exe'
$digest = (Get-FileHash -Path $file -Algorithm SHA256).Hash.ToLower()
$uri = "https://api.github.com/repos/rom-weaver/rom-weaver/attestations/sha256:${digest}" +
  '?predicate_type=https://slsa.dev/provenance/v1'
# A repository with no attestations at all answers 404, which Invoke-RestMethod
# raises rather than returns - uncaught, it ends the script before the
# not-verified message it was written for. Unlike the install scripts, this does
# not tell that apart from an unreachable API; both report NOT VERIFIED here.
# The property is checked before it is read because `@($null).Count` is 1, so
# reading a missing one blind would count an unrelated 200 as verified.
$count = 0
try {
  $response = Invoke-RestMethod -Uri $uri
  if ($response.PSObject.Properties['attestations']) {
    $count = @($response.attestations).Count
  }
} catch { }
if ($count -gt 0) {
  Write-Host 'VERIFIED: built by the rom-weaver release workflow'
} else {
  Write-Error 'NOT VERIFIED: no build provenance covers this file'
}
```

**`predicate_type` is not optional.** Immutable releases make GitHub attest
every release automatically, and that attestation lists the digest of every
asset in it - so an unfiltered query returns a hit for any file in any release,
and the check passes on files nothing built. That automatic attestation only
says "this was in release X", which is also true of an asset a stolen token
uploaded to the draft. Filtering to SLSA provenance is what makes a hit mean
"the release workflow produced this".

Because it is the release workflow's own attestation, it only exists for
releases cut after this was added. Verifying an asset from an earlier release
correctly reports NOT VERIFIED - there is no build provenance to find.

#### Checking the signature

The queries above trust GitHub's API response over TLS, which is the same trust
the download itself already places in GitHub. They do not check the Sigstore
signature. For that - signature, certificate chain, and transparency-log
inclusion - use `gh`, which must be signed in even for a public repository:

```bash
gh attestation verify rom-weaver-linux-x64-gnu --repo rom-weaver/rom-weaver
gh attestation verify oci://ghcr.io/rom-weaver/rom-weaver-cli:latest \
  --repo rom-weaver/rom-weaver
```

npm packages carry their own provenance, verified with:

```bash
npm audit signatures
```

The install scripts deliberately do not reach for `gh` or `cosign`. Requiring a
tool most machines lack, in order to install a tool, is not a trade worth making
in a `curl | sh` - and `gh` refuses to run unauthenticated, so a fresh machine
could not use it anyway.

#### What the install scripts do

They run the query above against the file they just downloaded, which is also
why no `.sha256` sidecar is published any more: altered bytes hash to something
no attestation covers, so the check refuses them. A sidecar could not have added
anything, having shipped from the same place as the binary.

A definite negative stops the install; an unanswered question does not:

| Outcome | Behavior |
| --- | --- |
| This repository attested these bytes | installs |
| Nothing attested them - empty response or HTTP 404 | **refuses** |
| The check could not run - offline, rate-limited, 5xx | warns, installs |

The unauthenticated API allows 60 requests an hour per address, so the last row
is reachable by ordinary use rather than only by attack, which is why it does not
block. Every refusal prints the way past it:

```bash
curl --proto '=https' --tlsv1.2 -LsSf \
  https://raw.githubusercontent.com/rom-weaver/rom-weaver/main/install.sh |
  ROM_WEAVER_SKIP_ATTESTATION=1 sh
```

The assignment belongs on `sh`, not on `curl`: putting it at the front of the
pipeline sets it for the download and not for the script that reads the
variable, so the install refuses again.

Going the other way, `ROM_WEAVER_REQUIRE_ATTESTATION=1` promotes that warning to
a refusal too, so an install that could not be verified fails rather than
proceeding.

[slsa]: https://slsa.dev/spec/v1.0/provenance

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

Fetches the released binary instead of compiling the workspace, which
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
keep their host ownership, and without it the container runs as the base image's
`nonroot` user (uid 65532): reading your files may be refused, and anything it
does write ends up owned by a uid that does not exist on the host. rom-weaver
reads no home directory or user config, so an arbitrary uid needs no matching
account inside the image.

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
  weave --input /work/in/game.sfc --patch /work/in/hack.bps --output /work/out/patched.sfc
```

Tags follow the release: `latest`, the exact version (`X.Y.Z`), and the minor
series (`X.Y`). Stable releases also receive a major-series tag once the
project reaches 1.0. Prereleases publish under `beta` instead of `latest`. The
image is built for `linux/amd64` and `linux/arm64`; Docker selects the native
variant on Apple Silicon and other arm64 hosts.

## Development checkout

For a development checkout, follow the [development guide](../development/development.md)
and use `cargo run -p rom-weaver-cli --bin rom-weaver --` in place of
`rom-weaver`.

Installed? Run your [first weave](get-started.md#first-weave), then continue
with the task guides or the [CLI reference](reference.md).
