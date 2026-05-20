# CHD Native Rust Migration Plan (Experiment Branch)

This branch now runs CHD through the Rust path directly with no runtime backend toggle.

## Status today

- `inspect`, `extract`, and `create` run through the Rust CHD path in `rom-weaver-containers`.
- The `ROM_WEAVER_CHD_BACKEND` mode switch has been removed from this branch.
- Legacy native CHD create/read helper paths were deleted from the active CHD container flow.

## Current supported create codecs

- Raw/DVD/HD/AV media: `store`, `zstd`, `zlib`, `lzma`
- CD/GD media: `store`, `cdzs`, `cdzl`, `cdlz` (with `zstd`/`zlib`/`lzma` aliases normalized for disc media)

## Current unsupported create codecs in Rust path

- `huffman`, `flac`, `cdfl`, and `avhu` are currently rejected for CHD create.
- Mixed codec plans that include unsupported codecs are rejected.

## Remaining parity gap

- True Rust encoder parity for `huffman`, `flac`, `cdfl`, and `avhu`.
- Additional metadata and behavior parity validation against historical native outputs where needed.

## Validation commands

```bash
# CHD container tests
cargo test -p rom-weaver-containers chd_ -- --nocapture

# CHD CLI smoke subset
cargo test -p rom-weaver-cli chd_ -- --nocapture

# WASM build and package sync
./scripts/build-wasm-cli.sh
```
