# Vendored Dependencies

`rom-weaver` vendors a small set of dependencies for reproducibility and local patching.

See [`docs/vendor-code.md`](../docs/vendor-code.md) for why each one is vendored,
how vendoring interacts with publishing to crates.io, and the steps to move each
back to an upstream release. Not everything vendored lives here - the
`xdvdfs` and `nod` sources are inlined at
`crates/rom-weaver-containers/src/xdvdfs/` and
`crates/rom-weaver-containers/src/nod/`.

## Current vendor contents

- `vendor/libarchive`:
  - Git submodule used by `crates/rom-weaver-libarchive-sys/build.rs`.
  - Initialize or refresh with:
    ```bash
    git submodule update --init --recursive vendor/libarchive
    ```

- `vendor/nod`:
  - Git submodule tracking upstream `main` at `https://github.com/encounter/nod`.
  - The build uses the copied source at `crates/rom-weaver-containers/src/nod/`;
    the submodule is only the refresh/contribution checkout.
  - Initialize or refresh with:
    ```bash
    git submodule update --init --recursive vendor/nod
    ```

## Validate after vendor updates

```bash
cargo check -p rom-weaver-patches
cargo check -p rom-weaver-cli
```
