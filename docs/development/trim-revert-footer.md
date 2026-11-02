# Trim revert footer (`RW`)

`rom-weaver trim --revert-marker` (alias `--reversible`) records the removed padding length and one fill byte in a footer. `rom-weaver trim --revert` uses those values to restore the file length and padding. Exact reconstruction requires unchanged ROM data and removed bytes that all match the recorded fill byte. The fill byte is recorded before trimming, including in-place operations. A plain CLI `trim` writes no footer; browser Trim writes one for every NDS, GBA, and 3DS ROM it trims.

The trimmed file is `[trimmed ROM data][footer]`. Readers that ignore bytes beyond the ROM's used data can ignore the footer. The footer format does not guarantee compatibility with every emulator or flashcart.

<!-- START doctoc -->
## Table of contents

- [Layout (12 bytes, appended at end of file)](#layout-12-bytes-appended-at-end-of-file)
- [Legacy layout (14 bytes, `RWT\x01`)](#legacy-layout-14-bytes-rwtx01)
- [CRC-32](#crc-32)
- [Detection and revert](#detection-and-revert)
- [Notes and invariants](#notes-and-invariants)

<!-- END doctoc -->

## Layout (12 bytes, appended at end of file)

All multi-byte integers are **little-endian**. Every footer rom-weaver writes uses this layout.

| Offset | Size | Field        | Description                                                        |
|-------:|-----:|--------------|--------------------------------------------------------------------|
| 0      | 2    | `magic`      | ASCII `R`, `W`.                                                     |
| 2      | 1    | `pad_byte`   | The padding byte to restore. The reader accepts any byte; normal trim detection uses `0x00` or `0xFF`. |
| 3      | 5    | `pad_len`    | Number of padding bytes removed by the trim (40-bit LE, at most 1 TiB minus 1 byte). |
| 8      | 4    | `crc32`      | CRC-32/IEEE over bytes `0..8` (magic + pad_byte + pad_len).         |

`pad_len` stores the **padding length**, not the absolute original size, so the value stays small. The original size is derived on revert as `original_size = data_size + pad_len`, where `data_size = file_size - footer_len`.

## Legacy layout (14 bytes, `RWT\x01`)

Releases since v0.10.0 wrote a 14-byte footer. rom-weaver no longer writes it but still reads it, so files trimmed by those releases keep restoring.

| Offset | Size | Field        | Description                                                        |
|-------:|-----:|--------------|--------------------------------------------------------------------|
| 0      | 4    | `magic`      | ASCII `R`, `W`, `T`, then a version byte, `0x01`.                   |
| 4      | 1    | `pad_byte`   | As in the current layout.                                           |
| 5      | 5    | `pad_len`    | As in the current layout (40-bit LE).                               |
| 10     | 4    | `crc32`      | CRC-32/IEEE over bytes `0..10` (magic + pad_byte + pad_len).        |

## CRC-32

Standard CRC-32/IEEE (polynomial `0xEDB88320`, init `0xFFFFFFFF`, reflected, final XOR `0xFFFFFFFF`), computed over every byte preceding it: the first 8 bytes of a 12-byte footer, the first 10 bytes of a legacy footer.

## Detection and revert

XISO and RVZ conversion reject `--revert-marker` and `--revert`, including inputs with an existing footer. Disc conversion and rebuilding cannot be reversed by appending padding.

For NDS-family, GBA, and 3DS ROMs, on `--revert`, before the format-specific size heuristics, rom-weaver looks for a footer at the end of the file in this order, and treats the first match as a footer only if **both** its magic and its CRC-32 validate:

1. The final 14 bytes as a legacy `RWT\x01` footer.
2. The final 12 bytes as a current `RW` footer.

When a valid footer is present:

1. `data_size = file_size - footer_len`, where `footer_len` is 14 or 12 for the footer that matched.
2. Strip the footer.
3. Pad from `data_size` up to `data_size + pad_len` with `pad_byte`.

The CRC covers the footer, not the ROM data. It cannot detect changes to the retained ROM bytes or prove that the recorded fill matches all removed bytes. A footer whose CRC does not validate is ignored.

When no valid footer is present, revert uses the format's size heuristic. A 3DS cart image (NCSD) grows to the card size its header declares, up to 8 GiB; GBA and NCCH-only `.3ds` images grow to the next power of two. A `.cxi` has no cartridge padding and stays unchanged. NDS/DSi also use the next power of two, with the parsed used-data size as a lower bound. These paths fill with `0xFF`; they do not recover an arbitrary original dump size or padding pattern.

## Notes and invariants

- **Opt-in.** Default `trim` never writes a footer; only `--revert-marker` does.
- **Only emitted when something was trimmed.** If the input was already at its target size, no footer is written (there is nothing to restore).
- **Self-contained.** No sidecar file; the trimmed ROM carries everything needed to revert.
- **Only helps ROMs trimmed by rom-weaver with the flag.** Other tools' trims have no footer and use the fallback path above.
- **Identified by magic length.** Legacy `RWT\x01` footers are read, never written; new files always get the 12-byte `RW` footer. A future layout needs a new magic that neither reader accepts.
- **Re-trimming replaces the footer.** Trimming a ROM that already has a footer removes that footer: an NDS/DSi trim truncates to the used-data size, and a GBA/3DS trim strips exactly the footer instead of scanning for padding. With `--revert-marker`, the new footer reuses the existing footer's original size and fill and is always written in the 12-byte `RW` layout, even if the old one was legacy. Without it, the output has no footer, so revert falls back to the size heuristic.
