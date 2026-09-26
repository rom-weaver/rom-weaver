# Test a ROM from the CLI

Use the native CLI to start a ROM for a fixed frame count and capture the final frame. This is a smoke test. It proves that the ROM starts in the packaged emulator core. It does not test controller input, later gameplay, or game completion.

Native testing supports the systems in the installed runtime on Linux x86-64 with GNU libc 2.39 or later. The packaged runtime uses headless RetroArch and libretro cores. The RetroArch frontend is built without networking. Native macOS and Windows runtimes are not available.

<!-- START doctoc -->
## Table of contents

- [Install the runtime](#install-the-runtime)
- [Run a smoke test](#run-a-smoke-test)

<!-- END doctoc -->

## Install the runtime

Install the CLI version that you want to use. The N64 and PSP cores need the system OpenGL loader library, even with software rendering. mGBA needs the system zlib library. On Debian or Ubuntu, install these libraries:

```sh
sudo apt-get install libgl1 zlib1g
```

No display server or GPU is required. Then install the matching runtime:

```sh
rom-weaver emulator install
```

The command downloads `rom-weaver-emulator-linux-x64-gnu.tar.gz` and its SHA-256 file from the matching GitHub release. A newly built version cannot download its runtime until that release is published.

For an offline install, download the runtime archive and obtain its SHA-256 value. Then run:

```sh
archive=rom-weaver-emulator-linux-x64-gnu.tar.gz
```

```sh
sha256=SHA256
```

```sh
rom-weaver emulator install --archive "$archive" --sha256 "$sha256"
```

The offline form works before publication when you have a locally built runtime archive. Both forms verify the archive, manifest, RetroArch binary, cores, and packaged system assets before installation.

Check the installed runtime:

```sh
rom-weaver emulator info
```

## Run a smoke test

Run 600 frames and save the final frame:

```sh
rom-weaver test game.nes --frames 600 --screenshot frame.png
```

The CLI chooses a core when exactly one installed core accepts the input extension. Select a core when extensions overlap:

```sh
rom-weaver test game.bin --core genesis_plus_gx --screenshot frame.png
```

Run `rom-weaver emulator info` to list installed core IDs, platforms, extensions, and required firmware.

The command refuses to replace an existing screenshot. It also captures and hashes a frame when you omit `--screenshot`; the temporary image is removed after the test.

The RetroArch frontend has no networking support. A custom `--runtime-dir` can name a different executable. rom-weaver does not place that executable in an operating-system network sandbox.

Use `--timeout` to change the 30-second wall-clock limit:

```sh
rom-weaver test game.nes --frames 1200 --timeout 60 --screenshot frame.png
```

The input can be an archive. The CLI extracts the complete archive, then selects the input. Use `--select` when the archive contains more than one candidate:

```sh
rom-weaver test games.zip --select 'Games/Mario.nes' --screenshot mario.png
```

For CUE, GDI, and M3U inputs, keep relative track and playlist files beside the selected file. The CLI copies those companions into its private workspace. References must stay inside the source directory.

Some games need firmware. The installed manifest lists unconditional requirements; individual disc formats can require additional files. Supply your firmware directory:

```sh
rom-weaver test game.nds --core melonds --system-dir firmware
```

The CLI copies regular files from this directory into the private workspace. It rejects links, more than 4,096 entries, more than 512 MiB, and paths deeper than 16 directories.

For automation, add `--json`. A successful result reports `status: "smoke-tested"`, the requested frame count, elapsed time, the runtime revisions, and the screenshot SHA-256. It does not report an observed frame count.

```sh
rom-weaver --json test game.nes --frames 600 --screenshot frame.png
```

Use `--dry-run` to show the input, requested runtime directory, and planned screenshot without reading, downloading, writing, or starting the emulator.

See the [`test` and `emulator` reference](../reference/cli.md#native-rom-testing) for every option and result field.
