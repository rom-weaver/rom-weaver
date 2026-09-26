#!/bin/sh
set -eu

usage() {
  echo "usage: build.sh --output-dir DIR --build-dir DIR" >&2
  exit 2
}

output_dir=
build_dir=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output-dir) [ "$#" -ge 2 ] || usage; output_dir=$2; shift 2 ;;
    --build-dir) [ "$#" -ge 2 ] || usage; build_dir=$2; shift 2 ;;
    *) usage ;;
  esac
done
[ -n "$output_dir" ] && [ -n "$build_dir" ] || usage

for command in cc c++ curl gzip make node sha256sum tar; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "required command is unavailable: $command" >&2
    exit 1
  }
done

case $(uname -s):$(uname -m) in
  Linux:x86_64) ;;
  *) echo "this source lock supports only Linux x86_64" >&2; exit 1 ;;
esac

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
    const item = process.argv[2] === "retroarch" ? source.retroarch : source.cores[0];
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
tar -xzf "$build_dir/downloads/$retroarch_archive" \
  -C "$build_dir/src/retroarch" --strip-components=1
tar -xzf "$build_dir/downloads/$fceumm_archive" \
  -C "$build_dir/src/fceumm" --strip-components=1

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
CC=cc CXX=c++ ./configure \
  --disable-bluetooth --enable-rgui --disable-materialui \
  --disable-xmb --disable-ozone \
  --disable-video_filter --disable-dsp_filter --disable-overlay \
  --disable-sdl --disable-sdl2 --disable-x11 --disable-wayland \
  --disable-kms --disable-egl --disable-opengl --disable-vulkan \
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
make -j"${JOBS:-2}"

cd "$build_dir/src/fceumm"
make -f Makefile.libretro -j"${JOBS:-2}" CC=cc

install -m 0755 "$build_dir/src/retroarch/retroarch" \
  "$build_dir/runtime/bin/retroarch"
install -m 0755 "$build_dir/src/fceumm/fceumm_libretro.so" \
  "$build_dir/runtime/cores/fceumm_libretro.so"
install -m 0644 "$build_dir/src/retroarch/COPYING" \
  "$build_dir/runtime/licenses/RetroArch-COPYING"
install -m 0644 "$build_dir/src/fceumm/Copying" \
  "$build_dir/runtime/licenses/FCEUmm-Copying"

retroarch_revision=$(read_source retroarch revision)
retroarch_sha=$(sha256sum "$build_dir/runtime/bin/retroarch" | cut -d ' ' -f 1)
fceumm_sha=$(sha256sum "$build_dir/runtime/cores/fceumm_libretro.so" | cut -d ' ' -f 1)
cat >"$build_dir/runtime/manifest.json" <<EOF
{
  "schemaVersion": 1,
  "platform": "linux-x64-gnu",
  "retroarch": {
    "path": "bin/retroarch",
    "revision": "$retroarch_revision",
    "sha256": "$retroarch_sha"
  },
  "cores": [
    {
      "id": "fceumm",
      "platform": "nes",
      "path": "cores/fceumm_libretro.so",
      "revision": "$fceumm_revision",
      "sha256": "$fceumm_sha"
    }
  ]
}
EOF

node "$script_dir/verify-runtime.mjs" "$build_dir/runtime"

runtime_archive="$output_dir/rom-weaver-emulator-linux-x64-gnu.tar.gz"
tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner \
  -C "$build_dir/runtime" -cf - . | gzip -n >"$runtime_archive"
runtime_digest=$(sha256sum "$runtime_archive" | cut -d ' ' -f 1)
printf '%s  %s\n' "$runtime_digest" "$(basename "$runtime_archive")" \
  >"$runtime_archive.sha256"

cp "$script_dir/build.sh" "$script_dir/smoke.sh" \
  "$script_dir/verify-runtime.mjs" "$script_dir/sources.json" \
  "$build_dir/source-package/"
cp "$build_dir/runtime/licenses/RetroArch-COPYING" \
  "$build_dir/runtime/licenses/FCEUmm-Copying" \
  "$build_dir/source-package/licenses/"
source_archive="$output_dir/rom-weaver-emulator-sources.tar.gz"
tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner \
  -C "$build_dir/source-package" -cf - . | gzip -n >"$source_archive"

echo "runtime archive: $runtime_archive"
echo "runtime SHA256: $runtime_archive.sha256"
echo "source archive: $source_archive"
