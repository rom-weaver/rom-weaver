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
  - Git submodule currently tracks branch `local-changes` at `https://github.com/brandonocasey/nod`.
  - Current pinned commit in this repo: `5159244` (based on `v2.0.0-alpha.10`).
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

- `vendor/xdvdfs-0.8.3`:
  - Local patched copy of the `xdvdfs` crate.
  - Wired through root `Cargo.toml` `[patch.crates-io]`.

## Validate after vendor updates

```bash
cargo check -p rom-weaver-patches
cargo check -p rom-weaver-cli
```
