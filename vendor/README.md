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

## Validate after vendor updates

```bash
cargo check -p rom-weaver-patches
cargo check -p rom-weaver-cli
```
