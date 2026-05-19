# Vendored Dependencies

`rom-weaver` vendors a small set of dependencies for reproducibility and local patching.

## Crates vendored from crates.io

These are refreshed by `cargo vendor` and then trimmed:

- `vendor/libflac-sys-0.3.4`
- `vendor/sevenz-rust2-0.20.2`
- `vendor/zstd-seekable-0.1.23`

Refresh command:

```bash
scripts/vendor/sync-vendor.sh
```

That script:

1. Runs `cargo vendor --versioned-dirs` into a temp directory.
2. Replaces the three crate directories above.
3. Runs `scripts/vendor/prune-vendor.sh` to remove non-build files.

## xdelta source snapshot

`vendor/xdelta3-src` is a curated C source snapshot used by
`crates/rom-weaver-patches/build.rs`.

It intentionally keeps only the files needed to compile `xdelta3.c` plus
license/readme metadata. `scripts/vendor/prune-vendor.sh` enforces this shape.

If `xdelta3` sources are refreshed, run:

```bash
scripts/vendor/prune-vendor.sh
```

## Validate after vendor updates

```bash
cargo check -p rom-weaver-patches
cargo check -p rom-weaver-cli
```
