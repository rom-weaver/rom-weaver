# Trim revert footer (`RWT\x01`)

`rom-weaver trim --revert-marker` (alias `--reversible`) records the removed padding length and one fill byte in a footer. `rom-weaver trim --revert` uses those values to restore the file length and padding. Exact reconstruction requires unchanged ROM data and removed bytes that all match the recorded fill byte. Use a separate output file when exact restoration matters: the current in-place path reads the fill byte after truncating the source, so it can record a different byte. A plain `trim` writes no footer.

The trimmed file is `[trimmed ROM data][footer]`. Readers that ignore bytes beyond the ROM's used data can ignore the footer. The footer format does not guarantee compatibility with every emulator or flashcart.

<!-- START doctoc -->
## Table of contents

- [Layout (14 bytes, appended at end of file)](#layout-14-bytes-appended-at-end-of-file)
- [CRC-32](#crc-32)
- [Detection and revert](#detection-and-revert)
- [Notes and invariants](#notes-and-invariants)

<!-- END doctoc -->

## Layout (14 bytes, appended at end of file)

All multi-byte integers are **little-endian**.

| Offset | Size | Field        | Description                                                        |
|-------:|-----:|--------------|--------------------------------------------------------------------|
| 0      | 4    | `magic`      | ASCII `R`, `W`, `T`, then a version byte. Current version = `0x01`. |
| 4      | 1    | `pad_byte`   | The padding byte to restore. The reader accepts any byte; normal trim detection uses `0x00` or `0xFF`. |
| 5      | 5    | `pad_len`    | Number of padding bytes removed by the trim (40-bit LE, at most 1 TiB minus 1 byte). |
| 10     | 4    | `crc32`      | CRC-32/IEEE over bytes `0..10` (magic + pad_byte + pad_len).        |

`pad_len` stores the **padding length**, not the absolute original size, so the value stays small. The original size is derived on revert as `original_size = data_size + pad_len`, where `data_size = file_size - 14`.

## CRC-32

Standard CRC-32/IEEE (polynomial `0xEDB88320`, init `0xFFFFFFFF`, reflected, final XOR `0xFFFFFFFF`), computed over the 10 bytes preceding it (`magic` through `pad_len`).

## Detection and revert

On `--revert`, before any format-specific logic, rom-weaver reads the final 14 bytes and treats them as a footer only if **both** the magic matches `RWT\x01` **and** the CRC-32 validates. When a valid footer is present:

1. `data_size = file_size - 14`.
2. Strip the footer.
3. Pad from `data_size` up to `data_size + pad_len` with `pad_byte`.

The CRC covers the footer, not the ROM data. It cannot detect changes to the retained ROM bytes or prove that the recorded fill matches all removed bytes.

When no valid footer is present, revert uses the format's size heuristic. GBA and 3DS grow to the next power of two. NDS/DSi also use the next power of two, with the parsed used-data size as a lower bound. These paths fill with `0xFF`; they do not recover an arbitrary original dump size or padding pattern.

## Notes and invariants

- **Opt-in.** Default `trim` never writes a footer; only `--revert-marker` does.
- **Only emitted when something was trimmed.** If the input was already at its target size, no footer is written (there is nothing to restore).
- **Self-contained.** No sidecar file; the trimmed ROM carries everything needed to revert.
- **Only helps ROMs trimmed by rom-weaver with the flag.** Other tools' trims have no footer and use the fallback path above.
- **Versioned.** The 4th magic byte is a format version; readers must reject unknown versions (a future version may change the field layout).
- **Re-trimming is format-dependent.** The trim path does not remove or preserve existing footer metadata explicitly. An NDS/DSi trim can truncate it; a GBA/3DS padding scan can leave it in place. Revert before trimming again to recover the recorded size and fill.
