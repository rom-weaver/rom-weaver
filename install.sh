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
curl --fail --location --proto '=https' --tlsv1.2 \
  --output "$tmp_dir/$asset.sha256" "$release_url/$asset.sha256"

if command -v sha256sum >/dev/null 2>&1; then
  (cd "$tmp_dir" && sha256sum --check "$asset.sha256")
  digest=$(sha256sum "$tmp_dir/$asset" | cut -d ' ' -f 1)
else
  (cd "$tmp_dir" && shasum --algorithm 256 --check "$asset.sha256")
  digest=$(shasum --algorithm 256 "$tmp_dir/$asset" | cut -d ' ' -f 1)
fi

# The checksum above only proves the download is intact: the sidecar ships from
# the same place as the binary, so anything that can replace one can replace the
# other. Build provenance is the part that says which workflow produced this
# file, so an asset uploaded by a stolen token or a maintainer's laptop fails
# here even though its checksum matches.
#
# Advisory by default - a verification the installer cannot perform must not
# strand someone on a minimal box. Set ROM_WEAVER_REQUIRE_ATTESTATION=1 to make
# every branch below fatal instead.
require_attestation="${ROM_WEAVER_REQUIRE_ATTESTATION:-0}"
attestation_failed() {
  if [ "$require_attestation" = 1 ]; then
    echo "rom-weaver: $1" >&2
    exit 1
  fi
  echo "rom-weaver: $1" >&2
}

if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  # The only branch that checks the Sigstore signature, certificate chain, and
  # transparency-log inclusion rather than trusting the API response.
  if gh attestation verify "$tmp_dir/$asset" --repo "$repo" >/dev/null 2>&1; then
    echo "Verified build provenance for $asset"
  else
    attestation_failed "build provenance verification FAILED for $asset"
  fi
else
  # No gh, so this reads the attestation over TLS from api.github.com instead of
  # verifying the bundle itself. That is strictly weaker - it trusts GitHub's
  # API rather than the signature - but it is the same trust already placed in
  # the TLS download above, and it still catches an asset that no workflow run
  # ever produced.
  #
  # No JSON parser is involved. Beyond curl, which got us here, this uses only
  # tr, sed, head, printf and grep -q - all POSIX, no GNU-only flags - plus a
  # base64 decoder, the one piece POSIX does not specify and the only reason
  # there are three branches for it below.
  #
  # The signed statement is a base64 DSSE payload, and the value being looked for
  # is an exact literal in it: `"repository":"..."` occurs exactly once, because
  # the neighboring `repository_id` and `repository_owner_id` keys do not end at
  # the same quote. Matching a fixed string beats parsing here - there is no
  # shape to get wrong, only bytes that are present or absent.
  if curl --fail --silent --location --proto '=https' --tlsv1.2 \
    --output "$tmp_dir/attestations.json" \
    "https://api.github.com/repos/$repo/attestations/sha256:$digest"; then
    # -d is GNU and current macOS, -D is older macOS, and openssl covers the
    # rest. The probe is on empty input so it costs nothing and cannot decode.
    if base64 -d </dev/null >/dev/null 2>&1; then
      decode_base64() { base64 -d; }
    elif base64 -D </dev/null >/dev/null 2>&1; then
      decode_base64() { base64 -D; }
    else
      decode_base64() { openssl base64 -d -A; }
    fi

    # Flatten the pretty-printed response, then break it on JSON's structural
    # characters to put one field per line - `tr` pads the shorter replacement
    # set, so every one of them becomes a newline. None occurs in base64
    # (A-Za-z0-9+/=), so a payload never splits. Splitting on commas alone is not
    # enough: `payload` follows `"dsseEnvelope": {` directly, so it would not
    # start its line.
    #
    # The anchor is what makes this safe. Unanchored, the expression matches
    # greedily and silently picks the *last* attestation, and `grep -o` - the
    # obvious alternative - is a GNU extension rather than POSIX. `head` because
    # an asset attested more than once returns several, and one of them proving
    # this repository built it is enough.
    payload=$(tr -d '\n\r' < "$tmp_dir/attestations.json" \
      | tr ',{}[]' '\n' \
      | sed -n 's/^[[:space:]]*"payload"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
      | head -n 1)

    if [ -n "$payload" ] && printf '%s' "$payload" | decode_base64 2>/dev/null \
      | grep -q "\"repository\":\"https://github.com/$repo\""; then
      echo "Found build provenance for $asset (install gh to verify its signature)"
    else
      attestation_failed "no build provenance from $repo for $asset"
    fi
  else
    attestation_failed "no build provenance published for $asset"
  fi
fi

mkdir -p "$install_dir"
install -m 0755 "$tmp_dir/$asset" "$install_dir/rom-weaver"
echo "Installed rom-weaver to $install_dir/rom-weaver"

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
