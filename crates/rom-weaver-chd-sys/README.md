# rom-weaver-chd-sys

`rom-weaver-chd-sys` is the native bridge boundary for CHD support in
`rom-weaver`, using a reduced embedded subset of MAME's BSD-licensed CHD code.

The crate intentionally wraps `chd_file` instead of `chdman.cpp`.
`chdman.cpp` is a CLI frontend with broad MAME dependencies. `chd_file`
and `chd_file_compressor` expose the lower-level operations `rom-weaver`
needs:

- `open(...)`
- `create(...)`
- `read_hunk(...)`
- `write_hunk(...)`
- `write_metadata(...)`
- `compress_begin(...)`
- `compress_continue(...)`

## Current backend

The current embedded backend is intentionally reduced:

- supported container codecs: `none`, `zlib`, `zstd`, `lzma`, `huffman`
- supported create path: raw path-backed compression through
  `chd_file_compressor`
- supported read path: any CHD that only uses the embedded codec set above
- zstd wiring is provided by `zstd-sys`, so the default path can vendor zstd
  instead of requiring a host `pkg-config` setup

Not supported yet:

- FLAC/CD codecs
- AV codecs

## Suggested next work

1. Add CD frontends like `cdzl`, `cdzs`, and `cdlz` on top of the general codecs.
2. Add FLAC/CD codecs and A/V codecs if `rom-weaver` needs disc/media parity with `chdman`.
3. Integrate this bridge into `rom-weaver-containers` for CHD extract/create flows.
