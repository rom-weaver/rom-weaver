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

asset="rom-weaver-$platform"
docs_asset="rom-weaver-cli-assets.tar.gz"
if [ "$version" = "latest" ]; then
  release_url="https://github.com/$repo/releases/latest/download"
else
  version="${version#v}"
  release_url="https://github.com/$repo/releases/download/v$version"
fi

tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM

curl --fail --location --proto '=https' --tlsv1.2 \
  --output "$tmp_dir/$asset" "$release_url/$asset"

# Hash what actually arrived. This is the lookup key for the provenance check,
# and it is also why there is no separate checksum step: a truncated, corrupted,
# or substituted download hashes to something no attestation covers, so the
# check below refuses it. A published `.sha256` sidecar would add nothing on top
# of that - it ships from the same place as the binary, so whatever can replace
# one can replace the other.
if command -v sha256sum >/dev/null 2>&1; then
  digest=$(sha256sum "$tmp_dir/$asset" | cut -d ' ' -f 1)
else
  digest=$(shasum --algorithm 256 "$tmp_dir/$asset" | cut -d ' ' -f 1)
fi

# Build provenance says which workflow produced this file, so an asset uploaded
# by a stolen token or from a maintainer's laptop is refused here.
#
# A definite answer is fatal, an absent one is not. Those are different facts and
# conflating them gets the default wrong in one direction or the other: treating
# "cannot reach the API" as failure strands anyone behind a proxy, and treating
# "this binary has no provenance" as a warning buries the finding that matters in
# output nobody reads.
#
#   attestation says another repository built this, or none did  -> refuse
#   the check could not run at all (offline, rate-limited, 5xx)  -> warn
#
# ROM_WEAVER_SKIP_ATTESTATION=1 skips the check; ROM_WEAVER_REQUIRE_ATTESTATION=1
# promotes the warning to a refusal too.
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
  # The endpoint is scoped to this repository *and* to the bytes just downloaded:
  # asking `/repos/$repo/attestations/sha256:$digest` returns only attestations
  # this repository published for exactly that digest. So a non-empty answer is
  # the whole finding - "$repo attested this file" - and nothing has to be read
  # out of the response to establish it.
  #
  # That is why no bundle is decoded here. Checking the signed statement's own
  # `repository` field would look more rigorous, but without verifying the
  # signature that field is exactly as trustworthy as the envelope around it:
  # both arrive in the same response from the same API. Decoding it would buy
  # appearance, not assurance. The trust placed here is GitHub's API over TLS,
  # which is already the trust the download itself rests on.
  #
  # What that does catch, and it is the point of the feature, is an asset no
  # workflow run ever produced - one uploaded by a stolen token or by hand.
  # Verifying the Sigstore signature instead would need `gh` or `cosign`, and
  # neither belongs in a curl-to-shell installer's dependency list; the manual
  # command is in docs/hosting/cli.md for anyone who wants it.
  #
  # This leaves curl and grep as the only tools involved.
  #
  # The status code is read rather than leaning on `--fail`, because 404 and 403
  # have to be told apart: 404 is GitHub answering "nothing attested these bytes"
  # and is fatal, while a 403 is the unauthenticated rate limit and means the
  # question went unanswered. `|| status=000` covers a network-level failure,
  # where curl exits non-zero and no code was ever received.
  # `predicate_type` is load-bearing, not tidiness. Immutable releases make
  # GitHub attest every release automatically, and that attestation lists each
  # asset's digest - so an unfiltered query returns a hit for any file in any
  # release and this check would pass on it. That attestation says only "this
  # was in release X"; an asset uploaded to the draft by a stolen token is in it
  # too. Filtering to SLSA provenance is what makes the answer mean "the release
  # workflow built this", which is the claim being made here.
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
install -m 0755 "$tmp_dir/$asset" "$install_dir/rom-weaver"
echo "Installed rom-weaver to $install_dir/rom-weaver"

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
