#!/bin/sh
set -eu

usage() {
  echo "usage: build.sh --output-dir DIR --build-dir DIR" >&2
  exit 2
}

output_dir=
build_dir=
configure_host=
configure_windres=
retroarch_ldflags=${LDFLAGS:-}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output-dir) [ "$#" -ge 2 ] || usage; output_dir=$2; shift 2 ;;
    --build-dir) [ "$#" -ge 2 ] || usage; build_dir=$2; shift 2 ;;
    *) usage ;;
  esac
done
[ -n "$output_dir" ] && [ -n "$build_dir" ] || usage

case $(uname -s):$(uname -m) in
  Linux:x86_64)
    platform=linux-x64-gnu; cc=cc; cxx=c++; make_command='make'
    tar_command=tar; sha256_command=sha256sum; executable=retroarch
    core_extension=so; fceumm_platform=unix
    ;;
  Darwin:x86_64)
    platform=darwin-x64; cc=clang; cxx=clang++; make_command=gmake
    tar_command=gtar; sha256_command=gsha256sum; executable=retroarch
    core_extension=dylib; fceumm_platform=osx
    ;;
  Darwin:arm64)
    platform=darwin-arm64; cc=clang; cxx=clang++; make_command=gmake
    tar_command=gtar; sha256_command=gsha256sum; executable=retroarch
    core_extension=dylib; fceumm_platform=osx
    ;;
  MINGW*:x86_64|MSYS_NT*:x86_64)
    platform=win32-x64; cc=gcc; cxx=g++; make_command='make'
    tar_command=tar; sha256_command=sha256sum; executable=retroarch.exe
    core_extension=dll; fceumm_platform=win
    configure_host=x86_64-w64-mingw32
    configure_windres=windres
    retroarch_ldflags="$retroarch_ldflags -lole32 -lcomdlg32 -lgdi32"
    ;;
  *) echo "unsupported emulator runtime host: $(uname -s):$(uname -m)" >&2; exit 1 ;;
esac

for command in "$cc" "$cxx" cmake curl gzip "$make_command" nasm node python3 \
  "$sha256_command" "$tar_command"; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "required command is unavailable: $command" >&2
    exit 1
  }
done

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
mkdir -p "$output_dir" "$build_dir"
output_dir=$(CDPATH='' cd -- "$output_dir" && pwd)
build_dir=$(CDPATH='' cd -- "$build_dir" && pwd)
case "$output_dir/" in
  "$build_dir/"*)
    echo "output directory must not overlap build directory: $output_dir" >&2
    exit 1
    ;;
esac
case "$build_dir/" in
  "$output_dir/"*)
    echo "build directory must not overlap output directory: $build_dir" >&2
    exit 1
    ;;
esac
if find "$build_dir" -mindepth 1 -print -quit | grep -q .; then
  echo "build directory must be empty: $build_dir" >&2
  exit 1
fi

export TMPDIR="$build_dir/tmp"
mkdir -p "$TMPDIR" "$build_dir/downloads" "$build_dir/src" \
  "$build_dir/runtime/bin" "$build_dir/runtime/cores" \
  "$build_dir/runtime/licenses" "$build_dir/source-package/archives" \
  "$build_dir/source-package/licenses"

read_source() {
  node -e '
    const source = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const item = process.argv[2] === "retroarch" ? source.retroarch : source.cores.find((core) => core.id === process.argv[2]);
    process.stdout.write(String(item[process.argv[3]]));
  ' "$script_dir/sources.json" "$1" "$2"
}

fetch_source() {
  name=$1
  archive=$(read_source "$name" archive)
  expected=$(read_source "$name" sha256)
  destination="$build_dir/downloads/$archive"
  if [ -f "$script_dir/archives/$archive" ]; then
    cp "$script_dir/archives/$archive" "$destination"
  else
    curl --fail --location --retry 3 --output "$destination" \
      "$(read_source "$name" url)"
  fi
  actual=$(sha256sum "$destination" | cut -d ' ' -f 1)
  [ "$actual" = "$expected" ] || {
    echo "$name source SHA256 mismatch: expected $expected, got $actual" >&2
    exit 1
  }
  cp "$destination" "$build_dir/source-package/archives/$archive"
}

fetch_source retroarch
fetch_source fceumm
retroarch_archive=$(read_source retroarch archive)
fceumm_archive=$(read_source fceumm archive)
mkdir -p "$build_dir/src/retroarch" "$build_dir/src/fceumm"
if [ "$platform" = win32-x64 ]; then
  # The headless build disables Metal, so Windows does not need this Apple
  # framework bundle. Its versioned symlinks cannot be created by MSYS2 tar.
  "$tar_command" -xzf "$build_dir/downloads/$retroarch_archive" \
    --exclude='*/pkg/apple/Frameworks/MoltenVK.xcframework' \
    -C "$build_dir/src/retroarch" --strip-components=1
else
  "$tar_command" -xzf "$build_dir/downloads/$retroarch_archive" \
    -C "$build_dir/src/retroarch" --strip-components=1
fi
tar -xzf "$build_dir/downloads/$fceumm_archive" \
  -C "$build_dir/src/fceumm" --strip-components=1

# Apple provides the MD5 API through CommonCrypto, which lrc_hash.h selects on
# macOS. Skip RetroArch's bundled implementation there: it expects its own
# MD5_CTX layout and cannot compile against CommonCrypto's context type.
node - "$build_dir/src/retroarch/libretro-common/utils/md5.c" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
const source = fs.readFileSync(file, "utf8");
const start = source.indexOf("#define MD5_F(x, y, z)");
const end = source.lastIndexOf("memset(ctx, 0, sizeof(*ctx));\n}");
if (start < 0 || end < start || source.indexOf("#define MD5_F(x, y, z)", start + 1) !== -1) {
  throw new Error("RetroArch MD5 implementation changed");
}
const endOfImplementation = end + "memset(ctx, 0, sizeof(*ctx));\n}".length;
const patchedSource = [
  source.slice(0, start),
  "#ifndef __APPLE__\n",
  source.slice(start, endOfImplementation),
  "\n#endif\n",
  source.slice(endOfImplementation),
].join("");
fs.writeFileSync(file, patchedSource);
NODE

if [ "$platform" = darwin-arm64 ] || [ "$platform" = darwin-x64 ]; then
  node "$script_dir/patch-headless-darwin.mjs" "$build_dir/src/retroarch"

  # New Apple Clang versions define TARGET_OS_MAC as a built-in macro. Old
  # bundled zlib treats that as classic Mac OS and hides the POSIX fdopen API.
  node - "$build_dir/src/retroarch/deps/libz/zutil.h" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
const source = fs.readFileSync(file, "utf8");
const probe = "#if defined(MACOS) || defined(TARGET_OS_MAC)";
const replacement = "#if (defined(MACOS) || defined(TARGET_OS_MAC)) && !defined(__APPLE__)";
if (source.split(probe).length !== 2) {
  throw new Error("RetroArch bundled zlib platform guard changed");
}
fs.writeFileSync(file, source.replace(probe, replacement));
NODE

  # With Cocoa disabled, RetroArch misses OSX in this file's include guard
  # while still compiling its sysctlbyname fallback.
  node - "$build_dir/src/retroarch/frontend/drivers/platform_darwin.m" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
const source = fs.readFileSync(file, "utf8");
const probe = "#include <sys/utsname.h>\n";
const sysctlIncludes = source.match(/^#include <sys\/sysctl\.h>$/gm) ?? [];
if (!source.includes(probe) || sysctlIncludes.length !== 2) {
  throw new Error("RetroArch Darwin sysctl include changed");
}
fs.writeFileSync(file, source.replace(probe, `${probe}#include <sys/sysctl.h>\n`));
NODE

  node - "$build_dir/src/retroarch/menu/menu_displaylist.c" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
const source = fs.readFileSync(file, "utf8");
const probe = "#include <stddef.h>\n";
const include = "#include <CoreFoundation/CFBundle.h>\n";
if (!source.includes(probe) || source.includes(include)) {
  throw new Error("RetroArch CoreFoundation include changed");
}
fs.writeFileSync(file, source.replace(probe, `${probe}\n#ifdef __APPLE__\n${include}#endif\n`));
NODE
fi

# RetroArch has no configure switch for xkbcommon. The runtime MUST retain only
# its null display path, so prevent the optional host library from being found.
node - "$build_dir/src/retroarch/qb/config.libs.sh" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
const source = fs.readFileSync(file, "utf8");
const probe = "check_val '' XKBCOMMON -lxkbcommon '' xkbcommon 0.3.2 '' false";
if (!source.includes(probe)) throw new Error("RetroArch xkbcommon probe changed");
fs.writeFileSync(file, source.replace(probe, "HAVE_XKBCOMMON=no"));
NODE
fceumm_revision=$(read_source fceumm revision)
node - "$build_dir/src/fceumm/Makefile.libretro" "$fceumm_revision" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
const source = fs.readFileSync(file, "utf8");
const probe = `GIT_VERSION := " $(shell git rev-parse --short HEAD || echo unknown)"`;
if (!source.includes(probe)) throw new Error("FCEUmm revision probe changed");
fs.writeFileSync(file, source.replace(probe, `GIT_VERSION := ${process.argv[3]}`));
NODE

cd "$build_dir/src/retroarch"
# Cocoa selects NSApplicationMain even with null video. These probes have no
# configure switches; their environment values keep the command-line entry point.
HAVE_COCOA=no HAVE_COCOA_METAL=no HAVE_CORELOCATION=no CC="$cc" CXX="$cxx" \
  WINDRES="$configure_windres" \
  LDFLAGS="$retroarch_ldflags" sh ./configure \
  ${configure_host:+"--host=$configure_host"} \
  --disable-bluetooth --enable-rgui --disable-materialui \
  --disable-xmb --disable-ozone \
  --disable-video_filter --disable-dsp_filter --disable-overlay \
  --disable-sdl --disable-sdl2 --disable-x11 --disable-wayland \
  --disable-kms --disable-egl --disable-opengl --disable-vulkan \
  --disable-metal --disable-d3d8 --disable-d3d9 --disable-d3d10 \
  --disable-d3d11 --disable-d3d12 --disable-d3dx --disable-dinput \
  --disable-dsound --disable-wasapi --disable-winmm --disable-xaudio \
  --disable-coreaudio --disable-coreaudio3 \
  --disable-alsa --disable-tinyalsa --disable-oss --disable-rsound \
  --disable-roar --disable-jack --disable-pipewire --disable-pulse \
  --disable-libusb --disable-dbus --disable-systemd --disable-udev \
  --disable-networking --disable-ssl --disable-ffmpeg \
  --disable-libretrodb --disable-7zip --disable-zstd --disable-chd \
  --disable-flac --disable-online_updater --disable-update_cores \
  --disable-update_core_info --disable-update_assets \
  --disable-freetype --disable-qt --disable-cheevos \
  --disable-discord --disable-accessibility --disable-translate \
  --disable-audiomixer --disable-microphone --disable-cdrom \
  --disable-glsl --disable-slang --disable-shaderpipeline \
  --disable-builtinglslang --disable-crtswitchres --disable-parport \
  --disable-test_drivers --disable-imageviewer --disable-bsv_movie \
  --disable-runahead --disable-rewind --disable-cheats --disable-patch \
  --enable-builtinzlib
"$make_command" -j"${JOBS:-2}"

cd "$build_dir/src/fceumm"
"$make_command" -f Makefile.libretro -j"${JOBS:-2}" \
  "platform=$fceumm_platform" \
  "CC=$cc" "CXX=$cxx"

install -m 0755 "$build_dir/src/retroarch/$executable" \
  "$build_dir/runtime/bin/$executable"
install -m 0755 "$build_dir/src/fceumm/fceumm_libretro.$core_extension" \
  "$build_dir/runtime/cores/fceumm_libretro.$core_extension"
install -m 0644 "$build_dir/src/retroarch/COPYING" \
  "$build_dir/runtime/licenses/RetroArch-COPYING"
install -m 0644 "$build_dir/src/fceumm/Copying" \
  "$build_dir/runtime/licenses/FCEUmm-Copying"

EMULATOR_RUNTIME_PLATFORM="$platform" CC="$cc" CXX="$cxx" \
  MAKE="$make_command" node "$script_dir/build-cores.mjs" "$build_dir"

node "$script_dir/verify-runtime.mjs" "$build_dir/runtime"
node "$script_dir/verify-dependencies.mjs" "$build_dir/runtime"

runtime_archive="$output_dir/rom-weaver-emulator-$platform.tar.gz"
"$tar_command" --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner \
  -C "$build_dir/runtime" -cf - . | gzip -n >"$runtime_archive"
runtime_digest=$("$sha256_command" "$runtime_archive" | cut -d ' ' -f 1)
printf '%s  %s\n' "$runtime_digest" "$(basename "$runtime_archive")" \
  >"$runtime_archive.sha256"

cp "$script_dir/build.sh" "$script_dir/build-cores.mjs" \
  "$script_dir/patch-headless-darwin.mjs" "$script_dir/tar-path.mjs" \
  "$script_dir/inspect-core.py" "$script_dir/smoke.sh" \
  "$script_dir/verify-runtime.mjs" "$script_dir/sources.json" \
  "$script_dir/verify-dependencies.mjs" "$script_dir/platform.mjs" \
  "$build_dir/source-package/"
cp "$build_dir/runtime/licenses/RetroArch-COPYING" \
  "$build_dir/runtime/licenses/FCEUmm-Copying" \
  "$build_dir/source-package/licenses/"
source_archive="$output_dir/rom-weaver-emulator-sources-$platform.tar.gz"
"$tar_command" --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner \
  -C "$build_dir/source-package" -cf - . | gzip -n >"$source_archive"

echo "runtime archive: $runtime_archive"
echo "runtime SHA256: $runtime_archive.sha256"
echo "source archive: $source_archive"
