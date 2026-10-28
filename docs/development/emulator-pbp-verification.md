# PBP emulator verification

PBP extraction, loader routing, and successful emulation are separate claims. Synthetic sector fixtures cover extraction and routing; they do not establish that a PS1 or PSP program boots. A core's start callback also does not establish that the supplied program rendered: RetroArch can display its own menu after a content failure.

<!-- START doctoc -->
## Table of contents

- [Legal inputs](#legal-inputs)
- [Run the application check](#run-the-application-check)
- [Evidence requirements](#evidence-requirements)
- [Recorded browser run](#recorded-browser-run)
  - [Raw-disc bundle control](#raw-disc-bundle-control)

<!-- END doctoc -->

## Legal inputs

The following upstream inputs require no commercial game, Sony BIOS, or proprietary firmware. Keep downloaded binaries and SDK files in ignored task scratch rather than committing them.

| Input | Source revision | License | SHA-256 |
| --- | --- | --- | --- |
| Cornell-Box PSP `v1.0-C` release `EBOOT.PBP`, 161,444 bytes | [Saymond/PSP-apps, `55553eb`](https://github.com/Saymond/PSP-apps/tree/55553eb52f4c0e1a87de65368df7d299ad2762e1) | [MIT](https://github.com/Saymond/PSP-apps/blob/55553eb52f4c0e1a87de65368df7d299ad2762e1/LICENSE) | `8b4f679ed2494a7b23df5e96e60e2f66eaf1c943a2991089e3c5989d4585f96b` |
| `PSn00bSDK-0.24-Linux.zip` | [PSn00bSDK `v0.24`, `06e65be`](https://github.com/Lameguy64/PSn00bSDK/tree/06e65bea3a778b2dae5af77a7935ae3868ddd4d3) | [Component licenses](https://github.com/Lameguy64/PSn00bSDK/blob/06e65bea3a778b2dae5af77a7935ae3868ddd4d3/LICENSE.md): examples MPL-2.0, SDK MPL-2.0, GCC GPL-3.0, mkpsxiso GPL-2.0-or-later | `5ada7c9478d795b22bde96ee23d6869290c14a740bcde3d57c01c342a26ded35` |

The PSP release is available from its [upstream release](https://github.com/Saymond/PSP-apps/releases/tag/v1.0-C). Its DATA.PSAR offset is 161,444, equal to the file length; DATA.PSP begins at 360. The empty PSAR is intentional. A successful test must render the demo's colored cube rather than only report that PPSSPP started.

The [PSn00bSDK release](https://github.com/Lameguy64/PSn00bSDK/releases/tag/v0.24) contains a complete local toolchain and examples. The `io/pads` example displays controller bytes and a counter, providing an observable input response. Build that example with the release's `lib/libpsn00b/cmake/sdk.cmake` toolchain file and `PSN00BSDK_TC` pointing to the release's `bin` directory. Package `pads.exe` and a `SYSTEM.CNF` containing `BOOT = cdrom:\PADS.EXE;1` with the release's `mkpsxiso`. Do not include its optional proprietary license sector.

`tests/fixtures/psn00bsdk-pbp.mjs` exports `packHomebrewPbp(images)` for wrapping these actual raw Mode 2 CD sectors in raw DEFLATE PBP blocks. Pass one image for a single-disc fixture or two images for a multi-disc fixture. Duplicating the controller demo proves disk selection and continued execution, not a game's cross-disc save or progression behavior. The builder rejects a missing ISO9660 volume descriptor; that check is not itself proof that a disc boots.

The pinned EmulatorJS 4.2.3 PCSX-ReARMed threaded asset (`017cd5727be628983e26fab99c9a7f859cf7d180d7a74798a43f76cd601f2266`) rejects the same demo packaged as stored blocks: its native log reports `uncompress failed with -3 for block 0, sector 4`, followed by content-load failure. The parser's support for stored PBP blocks therefore does not establish boot support in this core. The boot fixtures use raw DEFLATE blocks.

## Run the application check

The opt-in `packages/rom-weaver-webapp/tests/e2e/pbp-boot.test.mjs` test requires three environment variables: `ROM_WEAVER_PBP_BOOT_URL` is the fresh production preview origin, `ROM_WEAVER_PBP_BOOT_FIXTURES` is the directory containing `pads.bin`, `ps1-pads-single.pbp`, `ps1-pads-multi.pbp`, and `psp-v1.0-C.pbp`, and `ROM_WEAVER_PBP_BOOT_ARTIFACTS` is an ignored output directory. Run it with `node --test packages/rom-weaver-webapp/tests/e2e/pbp-boot.test.mjs` from the repository root. Missing inputs fail explicitly rather than silently skipping. The test launches muted headless Chromium, uses the actual Test picker, blocks external network requests, and saves canvas captures and a JSON report.

The cube's saturated pixels and the PS1 demo's brown framebuffer distinguish the programs from a black canvas or RetroArch's gray menu. The PS1 controller byte region must change while Up is held. On PSP, Start must switch the cube to the purple-background raycast scene. These visual oracles are specific to the pinned homebrew inputs; they are not general game-compatibility tests.

## Evidence requirements

Record the application revision, WASM source and artifact hashes, browser version, EmulatorJS lock hashes, fixture hashes, and viewport with each run. Use the fresh application Test file picker, not a mocked loader. Block external requests so a missing pinned core cannot silently fall back to the CDN.

For PS1, record rendered controller-demo text and a changed controller-byte region while a button is held. For PSP, record the colored cube and a visible response to the demo's controls. Capture multiple rendered frames; a black canvas, nonzero canvas dimensions, or a start callback is insufficient.

For multiple discs, require native `getDiskCount()` to return two, switch using the emulator's disk menu, and check `getCurrentDisk()` changes from zero to one and back. Capture continued demo rendering after the switch. A JavaScript disc array or mocked disk callback does not establish native core support. A return value of `-1` indicates unavailable disk control in the RetroArch adapter, not a successful switch.

## Recorded browser run

On 2026-10-28, headless Chromium 156.0.8078.4 at 1280 × 900 exercised the production Test picker at base revision `a9dec628` plus the issue 1505 loader changes. The WASM SHA-256 was `e53ffa2a0f0789572ac8b09e57c23cd89fb7bfabe151a39f9c71614252373f3c`; its source fingerprint was `132c8bd87e16b64ac22144cc113eebab2404ec3ae96057d348dd472f8deba2ce`.

The empty-PSAR PSP release passed: the canvas contained 106,260 saturated cube pixels before Start and 272,697 purple scene pixels after Start switched to the raycast scene. No external requests or page errors occurred.

The PS1 application runs were blocked before player creation by `malformed ISO index entry`: the parser rejected the zero-size, nonzero-offset end sentinel used by the native PCSX reader to terminate its final compressed block. Standalone pinned-core verification established rendered controller-demo frames and disk-menu switching, but that does not establish the application journey. The PS1 Test-picker cases require a parser fix and a fresh WASM rerun.

### Raw-disc bundle control

A separate pinned-core control used the existing CLI `playlist` command to create a ZIP containing an M3U, two CUE sheets, and two complete raw BIN files. Each BIN contained the SDK demo's 1,060 data sectors plus 75 sectors of locally generated stereo 440 Hz PCM audio. Both CUE sheets declared MODE2/2352 data and an AUDIO track. No commercial audio was used.

EmulatorJS selected the M3U and exposed two native images. The real disk menu switched 0 → 1 → 0; the controller demo continued rendering and responded to input. Native logs retained the AUDIO track at 00:16:10 with length 00:01:00 on both discs. Each BIN read back from the core's file system was 2,669,520 bytes with SHA-256 `430725bde7a9d3b768a915c2c53f9a85a3ad93ddafa4f232778b400176f09f35`, matching its full input bytes. This proves track and byte retention in the bundle path, not audible playback or application fallback wiring.
