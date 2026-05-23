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

## Validate after vendor updates

```bash
cargo check -p rom-weaver-patches
cargo check -p rom-weaver-cli
```
