# RomWeaver documentation

Choose the guide that matches what you are trying to do.

## Use RomWeaver

- [CLI guide](cli.md): installation, common commands, patching behavior,
  supported formats, compression, checksums, trimming, and JSON output.
- [Generated man pages](man/): `rom-weaver(1)` and one page per visible CLI
  command, generated directly from Clap.
- [Self-hosting](self-hosting.md): Docker, static deployment, reverse proxies,
  subpaths, HTTPS, COOP/COEP, and host-provided OPFS inputs.
- [`rom-weaver-bundle.json` schema](rom-weaver-bundle.schema.json): machine-readable
  schema for distributable patch workflows.
- [Runtime configuration](env-vars.md): native, WASM, webapp, test, and build
  configuration knobs.

Format specifications and upstream reference implementations are cataloged in
[`references.md`](references.md).

## Develop and contribute

- [Contribution guide](../.github/CONTRIBUTING.md): reporting bugs, proposing changes,
  validation, and contribution licensing.
- [Code of conduct](../.github/CODE_OF_CONDUCT.md): expectations for respectful project
  participation and reporting conduct concerns.
- [Security policy](../.github/SECURITY.md): supported versions and private
  vulnerability reporting.
- [Development guide](development.md): prerequisites, setup, native and WASM
  builds, the dev server, tests, generated files, and linked worktrees.
- [Architecture](ARCHITECTURE.md): workspace layout, crate graph, command core,
  browser boundary, OPFS, workers, and test organization.
- [Browser concurrency](browser-concurrency.md): shared memory, worker protocols,
  synchronization, cancellation, and file ownership.
- [Mobile Safari verification](mobile-safari-verification.md): automated and
  real-device checks for WebKit, OPFS, memory pressure, and PWA behavior.

## Design and migration notes

- [CHD native Rust migration](chd-native-rust-migration.md)
- [Reversible trim footer](trim-revert-footer.md)

These notes document implementation constraints and durable file formats. They
are useful when changing the corresponding subsystem, but are not required for
normal CLI or webapp use.
