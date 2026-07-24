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
else
  (cd "$tmp_dir" && shasum --algorithm 256 --check "$asset.sha256")
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
