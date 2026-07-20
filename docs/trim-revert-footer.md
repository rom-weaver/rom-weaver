# Trim revert footer (`RWT\x01`)

`rom-weaver trim --revert-marker` (alias `--reversible`) appends a small, self-describing
footer to the trimmed ROM so that a later `rom-weaver trim --revert` can reconstruct the
original file **byte-for-byte**, regardless of whether the original padding was `0x00` or
`0xFF`. The footer is **opt-in**: a plain `trim` produces a clean truncation with no footer.

The trimmed file is `[trimmed ROM data][footer]`. The footer sits where padding used to be -
past the ROM header's used-size - so emulators and flashcarts that read up to the used-size
ignore it, and playability is unaffected.

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
| 4      | 1    | `pad_byte`   | The padding byte to restore (`0x00` or `0xFF`).                     |
| 5      | 5    | `pad_len`    | Number of padding bytes removed by the trim (40-bit LE, ≤ 1 TiB).  |
| 10     | 4    | `crc32`      | CRC-32/IEEE over bytes `0..10` (magic + pad_byte + pad_len).        |

`pad_len` stores the **padding length**, not the absolute original size, so the value stays
small. The original size is derived on revert as `original_size = data_size + pad_len`, where
`data_size = file_size - 14`.

## CRC-32

Standard CRC-32/IEEE (polynomial `0xEDB88320`, init `0xFFFFFFFF`, reflected, final XOR
`0xFFFFFFFF`), computed over the 10 bytes preceding it (`magic` through `pad_len`).

## Detection and revert

On `--revert`, before any format-specific logic, rom-weaver reads the final 14 bytes and treats
them as a footer only if **both** the magic matches `RWT\x01` **and** the CRC-32 validates.
When a valid footer is present:

1. `data_size = file_size - 14`.
2. Strip the footer.
3. Pad from `data_size` up to `data_size + pad_len` with `pad_byte`.

The result is byte-identical to the pre-trim original.

When no valid footer is present (a clean trim, or a file trimmed by another tool), revert falls
back to the per-format heuristic: NDS/3DS restore to the cartridge size implied by the header
and GBA to the next power of two, filling with `0xFF`.

## Notes and invariants

- **Opt-in.** Default `trim` never writes a footer; only `--revert-marker` does.
- **Only emitted when something was trimmed.** If the input was already at its target size, no
  footer is written (there is nothing to restore).
- **Self-contained.** No sidecar file; the trimmed ROM carries everything needed to revert.
- **Only helps ROMs trimmed by rom-weaver with the flag.** Other tools' trims have no footer and
  use the fallback path above.
- **Versioned.** The 4th magic byte is a format version; readers must reject unknown versions
  (a future version may change the field layout).
- **Re-trimming drops the footer.** Trimming a footered file again truncates the 14 footer bytes
  along with any re-detected padding, discarding the revert metadata.
