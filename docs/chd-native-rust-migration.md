# CHD Native Rust Migration Plan (Experiment Branch)

This branch now runs CHD through the Rust path directly with no runtime backend toggle.

## Status today

- `probe`, `extract`, and `create` run through the Rust CHD path in `rom-weaver-containers`.
- The `ROM_WEAVER_CHD_BACKEND` mode switch has been removed from this branch.
- Legacy native CHD create/read helper paths were deleted from the active CHD container flow.

## Current supported create codecs

- Raw/DVD/HD media: `store`, `zstd`, `zlib`, `lzma`, `huff` (`huffman` alias), `flac`
- AV media (`chav` frames): `store`, `avhuff` (`avhu` alias)
- CD/GD media: `store`, `cdzs`, `cdzl`, `cdlz`, `cdfl` (with `zstd`/`zlib`/`lzma`/`flac` aliases normalized for disc media)

## Default create codec plans

- CD/GD: `cdzs,cdzl,cdfl`
- DVD: `zstd,zlib,huff,flac`
- Raw/HD: `zstd,zlib,huff,flac`

## Remaining parity gap

- Additional size-ratio parity validation against `chdman` for representative fixtures.
- Additional metadata and behavior parity validation against historical native outputs where needed.

## Validation commands

```bash
# CHD container tests
cargo test -p rom-weaver-containers chd_ -- --nocapture

# CHD CLI smoke subset
cargo test -p rom-weaver-cli chd_ -- --nocapture

# WASM build and package sync
mise run build-wasm
```
