#!/bin/sh
set -eu

usage() {
  echo "usage: smoke.sh --runtime-dir DIR --scratch-dir DIR [--repo-root DIR]" >&2
  exit 2
}

runtime_dir=
scratch_dir=
repo_root=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --runtime-dir) [ "$#" -ge 2 ] || usage; runtime_dir=$2; shift 2 ;;
    --scratch-dir) [ "$#" -ge 2 ] || usage; scratch_dir=$2; shift 2 ;;
    --repo-root) [ "$#" -ge 2 ] || usage; repo_root=$2; shift 2 ;;
    *) usage ;;
  esac
done
[ -n "$runtime_dir" ] && [ -n "$scratch_dir" ] || usage

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
[ -n "$repo_root" ] || repo_root=$(CDPATH='' cd -- "$script_dir/../.." && pwd)
runtime_dir=$(CDPATH='' cd -- "$runtime_dir" && pwd)
mkdir -p "$scratch_dir"
scratch_dir=$(CDPATH='' cd -- "$scratch_dir" && pwd)

node "$script_dir/verify-runtime.mjs" "$runtime_dir"
node "$repo_root/packages/rom-weaver-webapp/scripts/first-sample-assets.mjs" "$scratch_dir/assets"

config="$scratch_dir/retroarch.cfg"
mkdir -p "$scratch_dir/home" "$scratch_dir/config" "$scratch_dir/data" \
  "$scratch_dir/cache" "$scratch_dir/system" "$scratch_dir/saves" \
  "$scratch_dir/states" "$scratch_dir/playlists"
cat >"$config" <<EOF
video_driver = "null"
audio_driver = "null"
input_driver = "null"
menu_driver = "rgui"
config_save_on_exit = "false"
video_vsync = "false"
audio_enable = "false"
history_list_enable = "false"
system_directory = "$scratch_dir/system"
savefile_directory = "$scratch_dir/saves"
savestate_directory = "$scratch_dir/states"
playlist_directory = "$scratch_dir/playlists"
content_history_path = "$scratch_dir/playlists/content_history.lpl"
content_favorites_path = "$scratch_dir/playlists/content_favorites.lpl"
core_options_path = "$scratch_dir/config/fceumm.opt"
EOF

screenshot="$scratch_dir/hello-world.png"
env -u DISPLAY -u WAYLAND_DISPLAY -u PULSE_SERVER -u XDG_RUNTIME_DIR \
  HOME="$scratch_dir/home" \
  XDG_CONFIG_HOME="$scratch_dir/config" \
  XDG_DATA_HOME="$scratch_dir/data" \
  XDG_CACHE_HOME="$scratch_dir/cache" \
  "$runtime_dir/bin/retroarch" \
  --config="$config" \
  --libretro="$runtime_dir/cores/fceumm_libretro.so" \
  --max-frames=120 \
  --max-frames-ss \
  --max-frames-ss-path="$screenshot" \
  --verbose \
  "$scratch_dir/assets/hello-world.nes"

[ -s "$screenshot" ] || {
  echo "RetroArch did not create the smoke-test screenshot: $screenshot" >&2
  exit 1
}
case $(od -An -tx1 -N8 "$screenshot" | tr -d ' \n') in
  89504e470d0a1a0a) ;;
  *) echo "RetroArch wrote an invalid PNG: $screenshot" >&2; exit 1 ;;
esac
echo "emulator smoke passed: $screenshot"
