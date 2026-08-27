# Save Editor development

The Save Editor uses one Rust handler model for the native CLI and the browser WASM workflow. The first version supports only English retail Pokémon Ruby, Sapphire, Emerald, FireRed, and LeafGreen saves.

Read [Edit a Generation III save](../how-to/edit-gen3-saves.md) for user tasks, recognition outcomes, editable fields, and safety limits. This page owns the implementation design and contributor flow.

<!-- START doctoc -->
## Table of contents

- [Support boundary](#support-boundary)
- [Handler architecture](#handler-architecture)
- [Save integrity boundary](#save-integrity-boundary)
- [Eight-step contributor flow](#eight-step-contributor-flow)
- [Checks before handoff](#checks-before-handoff)
- [Related](#related)

<!-- END doctoc -->

## Support boundary

Keep the first handler set narrow:

- Ruby and Sapphire use the English retail Ruby/Sapphire layout.
- Emerald uses the English retail Emerald layout.
- FireRed and LeafGreen use the English retail FireRed/LeafGreen layout.
- Regional layouts are unsupported until each layout has its own checked definition and fixtures.
- Emerald can identify itself from its save checksum layout.
- Ruby/Sapphire and FireRed/LeafGreen need a manual game choice without ROM identity.

Do not treat a matching 128 KiB size as game recognition. A save state is not a game save. The handler accepts game SRAM saves only.

The first editable set is trainer name, trainer gender, money, and badge flags. Trainer IDs, play time, and the security key remain read-only. Inventory and Pokémon editing are out of scope for this version.

The handler treats one valid slot plus one empty slot as valid with a warning. It preserves the empty slot. It blocks edits when the second slot has damaged save data.

## Handler architecture

Keep format facts in the core save module. The handler should own the byte layout, section map, field offsets, encryption rules, recognition rules, and checksum updates. It should not know about Clap, React, OPFS, or terminal output.

Use these boundaries:

- `crates/rom-weaver-core/src/save/mod.rs` defines the save document, game definitions, field schema, recognition outcomes, integrity state, and edits.
- `crates/rom-weaver-core/src/save/formats/` defines physical save formats.
- `crates/rom-weaver-core/src/save/container.rs` unwraps save wrappers (GameShark SP `.sps`, `.xps`, `.gsv`) before recognition and re-wraps edited bytes, so handlers always see raw save data.
- `crates/rom-weaver-core/src/save/pokemon_gen3.rs` owns the Generation III game structure.
- `SaveGameRegistry` maps a game choice to one game definition and exposes the shared handler operations.
- `SaveGameHandler` parses the 32-sector image, validates both 14-section save slots, selects the active slot, reads fields, and applies validated edits.
- `crates/rom-weaver-cli/src/save_command.rs` maps `save identify`, `save inspect`, `save get`, `save set`, and `save export-schema` to core operations. It owns paths, output files, dry-run behavior, force checks, and CLI reports.
- `crates/rom-weaver-cli/src/command_args.rs` and `src/lib.rs` own the public command and JSON request shapes. Keep those shapes shared by native and WASM builds.
- The browser workflow should call the same WASM command path through the dedicated worker. Keep file reads and writes in the existing OPFS worker boundary. Do not add main-thread OPFS access.

Return structured recognition, integrity, field, and change data. Do not make the browser or CLI parse human-readable strings to learn whether a save is safe to edit.

## Save integrity boundary

The handler must preserve the source file and write an edited copy. It must:

1. Check the exact input size and supported game definition.
2. Parse both physical save slots.
3. Check all 14 section IDs, signatures, and checksums in each candidate slot.
4. Select the newest complete valid slot by the game counter rule.
5. Refuse writes when no complete active slot is proven.
6. Apply only fields in the editable schema.
7. Recompute each changed section checksum and write a complete edited copy.
8. Report the original and edited integrity state without changing the input.

Keep the slot counter and rotation rules in the handler. A caller must not choose a physical sector by assuming that section IDs are in order.

## Eight-step contributor flow

1. **Set the boundary.** Confirm the game, region, save size, editable fields, and recognition outcome before you add a definition.
2. **Read the architecture.** Check `docs/development/ARCHITECTURE.md`, the core registry traits, the WASM worker path, and the one-error-type rule.
3. **Add the game definition.** Put section sizes, field offsets, encryption, and game-choice rules in the core save module. Preserve unknown bytes.
4. **Add recognition fixtures.** Test valid two-slot saves, one valid slot, empty slots, bad checksums, wrong section IDs, counter wrap, and unsupported layouts.
5. **Add field tests.** Test each editable field, read-only field, boundary value, invalid value, checksum update, and byte preservation case.
6. **Wire both front ends.** Add CLI dispatch and structured reports, then add the browser workflow through the existing WASM worker. Keep command names and field names identical.
7. **Regenerate shared types.** Run `mise run typegen` after Rust command, field, or metadata changes. Commit the generated TypeScript files when the command requires them.
8. **Run the checks.** Run focused Rust tests, CLI smoke tests, browser tests, formatting, lint, and the docs checks. Review every changed file before handoff.

## Checks before handoff

Run the focused Rust suite and the CLI smoke tests:

```bash
cargo test -p rom-weaver-core save
cargo test -p rom-weaver-cli --test cli_smoke
```

Run type generation when Rust command or metadata types changed:

```bash
mise run typegen
```

Run the webapp lint and browser save tests when the browser workflow changed:

```bash
npm --prefix packages/rom-weaver-webapp run lint
npm --prefix packages/rom-weaver-webapp run test:browser:wasm
```

Run the documentation checks for Markdown and route coverage. Regenerate the tables of contents for every changed Markdown file.

## Related

- [Edit a Generation III save](../how-to/edit-gen3-saves.md): browser and CLI tasks, support limits, and user-visible safety behavior.
- [Architecture](ARCHITECTURE.md): crate graph, registry traits, WASM workers, OPFS, and the Rust-TypeScript boundary.
- [Development guide](development.md): setup, worktrees, tests, and full local checks.
