# Vendored Dependencies

`rom-weaver` vendors a small set of dependencies for reproducibility and local patching.

## Current vendor contents

- `vendor/libarchive`:
  - Git submodule used by `crates/rom-weaver-libarchive-sys/build.rs`.
  - Initialize or refresh with:
    ```bash
    git submodule update --init --recursive vendor/libarchive
    ```

- `vendor/nod`:
  - Git submodule currently tracks `brandonocasey/nod` branch `fix/rvz-zstd-groups-compress-bound`.
  - Current pinned commit in this repo: `b9fe61a` (based on `v2.0.0-alpha.8`).
  - Workspace dependency is wired via root `Cargo.toml` (`[workspace.dependencies].nod` path).
  - Initialize or refresh with:
    ```bash
    git submodule update --init --recursive vendor/nod
    ```

- `vendor/akv-0.1.0`:
  - Local patched copy of the `akv` crate.
  - Wired through root `Cargo.toml` `[patch.crates-io]`.

- `vendor/chd-0.3.4`:
  - Local patched copy of the `chd` crate.
  - Manifest patch routes `flate2` through `libz-sys` instead of adding `zlib-rs`.
  - Wired through root `Cargo.toml` `[patch.crates-io]`.

- `vendor/qbsdiff-1.4.4`:
  - Local patched copy of the `qbsdiff` crate.
  - Manifest patch routes `bzip2` through `bzip2-sys` instead of adding `libbz2-rs-sys`.
  - Wired through root `Cargo.toml` `[patch.crates-io]`.

## Validate after vendor updates

```bash
cargo check -p rom-weaver-patches
cargo check -p rom-weaver-cli
```
