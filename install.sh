#!/bin/sh

set -eu

repo="rom-weaver/rom-weaver"
version="${ROM_WEAVER_VERSION:-latest}"
install_dir="${ROM_WEAVER_INSTALL_DIR:-$HOME/.local/bin}"

system=$(uname -s)
machine=$(uname -m)
case "$system:$machine" in
  Darwin:arm64) platform="darwin-arm64" ;;
  Darwin:x86_64) platform="darwin-x64" ;;
  Linux:x86_64)
    libc=musl
    if command -v getconf >/dev/null 2>&1 && getconf GNU_LIBC_VERSION >/dev/null 2>&1; then
      libc=gnu
    elif command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -Eqi 'glibc|gnu libc'; then
      libc=gnu
    fi
    platform="linux-x64-$libc"
    ;;
  Linux:aarch64 | Linux:arm64) platform="linux-arm64-musl" ;;
  Linux:i386 | Linux:i486 | Linux:i586 | Linux:i686) platform="linux-ia32-musl" ;;
  *)
    echo "rom-weaver does not support $system/$machine" >&2
    exit 1
    ;;
esac

asset="rom-weaver-$platform.tar.gz"
legacy_asset="rom-weaver-$platform"
docs_asset="rom-weaver-cli-assets.tar.gz"
identify_asset="rom-weaver-identify-data.tar.br"
if [ "$version" = "latest" ]; then
  release_url="https://github.com/$repo/releases/latest/download"
else
  version="${version#v}"
  release_url="https://github.com/$repo/releases/download/v$version"
fi

tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM

# Releases up to v0.10.2 shipped the executable as a loose file instead of a
# tar.gz. Fall back only on a definite 404 - the pinned version predates the
# archive - so a transient failure surfaces as itself instead of as the legacy
# asset's error. `|| status=000` covers a network-level failure, where curl
# exits non-zero and no code was ever received.
download_status=$(curl --silent --location --proto '=https' --tlsv1.2 \
  --output "$tmp_dir/$asset" \
  --write-out '%{http_code}' \
  "$release_url/$asset") || download_status=000
if [ "$download_status" = 404 ]; then
  asset="$legacy_asset"
  curl --fail --location --proto '=https' --tlsv1.2 \
    --output "$tmp_dir/$asset" "$release_url/$asset"
elif [ "$download_status" != 200 ]; then
  echo "rom-weaver: failed to download $release_url/$asset (HTTP $download_status)" >&2
  exit 1
fi

# The downloaded file's SHA-256 is the key for the repository attestation lookup.
if command -v sha256sum >/dev/null 2>&1; then
  digest=$(sha256sum "$tmp_dir/$asset" | cut -d ' ' -f 1)
else
  digest=$(shasum --algorithm 256 "$tmp_dir/$asset" | cut -d ' ' -f 1)
fi

# A missing attestation MUST stop installation; an unavailable API warns unless
# ROM_WEAVER_REQUIRE_ATTESTATION=1. ROM_WEAVER_SKIP_ATTESTATION=1 bypasses this check.
skip_attestation="${ROM_WEAVER_SKIP_ATTESTATION:-0}"
require_attestation="${ROM_WEAVER_REQUIRE_ATTESTATION:-0}"

# Every refusal has to say how to get past it, or the only way out is reading
# this script.
attestation_refuse() {
  echo "rom-weaver: $1" >&2
  echo "rom-weaver: refusing to install $asset." >&2
  echo "rom-weaver: to install it anyway, re-run with ROM_WEAVER_SKIP_ATTESTATION=1" >&2
  exit 1
}

attestation_unknown() {
  if [ "$require_attestation" = 1 ]; then
    attestation_refuse "$1"
  fi
  echo "rom-weaver: $1" >&2
  echo "rom-weaver: continuing - this download is unverified" >&2
}

if [ "$skip_attestation" = 1 ]; then
  echo "rom-weaver: skipping the build provenance check (ROM_WEAVER_SKIP_ATTESTATION=1)" >&2
else
  # Trust GitHub's API over TLS to find SLSA provenance for this repository and digest.
  # This lookup does not verify signatures or require a particular build workflow.
  #
  # The predicate filter MUST exclude release-membership attestations, which do not
  # prove that a workflow built the asset. See docs/how-to/verify-downloads.md.
  #
  # Read the status explicitly: 404 means no match; transport errors and other
  # HTTP failures leave the check unresolved.
  status=$(curl --silent --location --proto '=https' --tlsv1.2 \
    --output "$tmp_dir/attestations.json" \
    --write-out '%{http_code}' \
    "https://api.github.com/repos/$repo/attestations/sha256:$digest?predicate_type=https://slsa.dev/provenance/v1") || status=000

  # A repository with no attestations at all answers 404; one that has some, but
  # none for these bytes, answers 200 with `{"attestations": []}`. Both mean the
  # same thing. `repository_id` is the first field of an entry and appears only
  # when there is one, so its presence is what separates the two.
  if [ "$status" = 200 ] && grep -q '"repository_id"' "$tmp_dir/attestations.json"; then
    echo "Verified build provenance for $asset"
  elif [ "$status" = 200 ] || [ "$status" = 404 ]; then
    attestation_refuse "no build provenance from $repo for $asset"
  else
    attestation_unknown "could not reach the attestations API for $asset (HTTP $status)"
  fi
fi

mkdir -p "$install_dir"
case "$asset" in
  *.tar.gz)
    tar --extract --gzip --file "$tmp_dir/$asset" --directory "$tmp_dir" rom-weaver
    install -m 0755 "$tmp_dir/rom-weaver" "$install_dir/rom-weaver"
    ;;
  *)
    install -m 0755 "$tmp_dir/$asset" "$install_dir/rom-weaver"
    ;;
esac
echo "Installed rom-weaver to $install_dir/rom-weaver"

if curl --fail --location --proto '=https' --tlsv1.2 \
  --output "$tmp_dir/$identify_asset" "$release_url/$identify_asset"; then
  if command -v sha256sum >/dev/null 2>&1; then
    identify_digest=$(sha256sum "$tmp_dir/$identify_asset" | cut -d ' ' -f 1)
  else
    identify_digest=$(shasum --algorithm 256 "$tmp_dir/$identify_asset" | cut -d ' ' -f 1)
  fi
  identify_verified=1
  if [ "$skip_attestation" != 1 ]; then
    status=$(curl --silent --location --proto '=https' --tlsv1.2 \
      --output "$tmp_dir/identify-attestations.json" \
      --write-out '%{http_code}' \
      "https://api.github.com/repos/$repo/attestations/sha256:$identify_digest?predicate_type=https://slsa.dev/provenance/v1") || status=000
    if [ "$status" = 200 ] && grep -q '"repository_id"' "$tmp_dir/identify-attestations.json"; then
      echo "Verified build provenance for $identify_asset"
    elif [ "$status" = 200 ] || [ "$status" = 404 ]; then
      identify_verified=0
      echo "rom-weaver: no build provenance from $repo for $identify_asset; installed the binary only" >&2
      echo "rom-weaver: run \`rom-weaver setup\` to install the identify database" >&2
    elif [ "$require_attestation" = 1 ]; then
      identify_verified=0
      echo "rom-weaver: could not check build provenance for $identify_asset; installed the binary only" >&2
      echo "rom-weaver: run \`rom-weaver setup\` to install the identify database" >&2
    else
      echo "rom-weaver: could not check build provenance for $identify_asset; continuing unverified" >&2
    fi
  fi
  if [ "$identify_verified" = 1 ]; then
    if ! command -v brotli >/dev/null 2>&1; then
      echo "rom-weaver: Brotli decoder unavailable; installed the binary only" >&2
      echo "rom-weaver: run \`rom-weaver setup\` to install the identify database" >&2
    elif brotli --decompress --force \
      --output="$tmp_dir/rom-weaver-identify-data.tar" \
      "$tmp_dir/$identify_asset" &&
      tar --extract --file "$tmp_dir/rom-weaver-identify-data.tar" \
        --directory "$install_dir"; then
      echo "Installed ROM identify data to $install_dir/share/rom-weaver/identify/v1"
    else
      echo "rom-weaver: failed to extract Brotli identify data; installed the binary only" >&2
      echo "rom-weaver: run \`rom-weaver setup\` to install the identify database" >&2
    fi
  fi
else
  echo "rom-weaver: ROM identify data unavailable; installed the binary only" >&2
  echo "rom-weaver: run \`rom-weaver setup\` to install the identify database" >&2
fi

# Documentation is a separate, platform-independent release asset so the
# executable remains usable by cargo-binstall, mise, and package managers that
# only understand one binary. Older releases may not have it yet; keep the
# binary install successful in that case.
if curl --fail --location --proto '=https' --tlsv1.2 \
  --output "$tmp_dir/$docs_asset" "$release_url/$docs_asset"; then
  tar --extract --gzip --file "$tmp_dir/$docs_asset" --directory "$tmp_dir"
  man_dir="${ROM_WEAVER_MAN_DIR:-$HOME/.local/share/man/man1}"
  bash_completion_dir="${ROM_WEAVER_BASH_COMPLETION_DIR:-$HOME/.local/share/bash-completion/completions}"
  zsh_completion_dir="${ROM_WEAVER_ZSH_COMPLETION_DIR:-$HOME/.zfunc}"
  fish_completion_dir="${ROM_WEAVER_FISH_COMPLETION_DIR:-$HOME/.config/fish/completions}"
  elvish_completion_dir="${ROM_WEAVER_ELVISH_COMPLETION_DIR:-$HOME/.config/elvish/lib}"
  mkdir -p "$man_dir" "$bash_completion_dir" "$zsh_completion_dir" "$fish_completion_dir" "$elvish_completion_dir"
  for page in "$tmp_dir"/man/*.1; do
    install -m 0644 "$page" "$man_dir/"
  done
  install -m 0644 "$tmp_dir/completions/rom-weaver.bash" "$bash_completion_dir/rom-weaver"
  install -m 0644 "$tmp_dir/completions/_rom-weaver" "$zsh_completion_dir/_rom-weaver"
  install -m 0644 "$tmp_dir/completions/rom-weaver.fish" "$fish_completion_dir/rom-weaver.fish"
  install -m 0644 "$tmp_dir/completions/rom-weaver.elv" "$elvish_completion_dir/rom-weaver.elv"
  echo "Installed man pages and shell completions"
else
  echo "rom-weaver: CLI documentation asset unavailable; installed the binary only" >&2
fi

case ":$PATH:" in
  *":$install_dir:"*) echo "Run: rom-weaver --help" ;;
  *)
    shell_name="${SHELL:-}"
    shell_name="${shell_name##*/}"
    echo "Add rom-weaver to PATH:"
    case "$shell_name" in
      fish)
        echo "  fish_add_path \"$install_dir\""
        ;;
      zsh)
        profile="${ZDOTDIR:-$HOME}/.zshrc"
        echo "  echo 'export PATH=\"$install_dir:\$PATH\"' >> \"$profile\""
        echo "  source \"$profile\""
        ;;
      bash)
        if [ "$(uname -s)" = "Darwin" ]; then
          profile="$HOME/.bash_profile"
        else
          profile="$HOME/.bashrc"
        fi
        echo "  echo 'export PATH=\"$install_dir:\$PATH\"' >> \"$profile\""
        echo "  source \"$profile\""
        ;;
      *)
        profile="$HOME/.profile"
        echo "  echo 'export PATH=\"$install_dir:\$PATH\"' >> \"$profile\""
        echo "  . \"$profile\""
        ;;
    esac
    echo "Then run: rom-weaver --help"
esac
