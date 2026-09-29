# Save Editor development

The Save Editor uses one Rust handler model for the native CLI and the browser WASM workflow. The registry supports several game families.

Typed Rust definitions under the schema catalog extend that registry. A new layout requires an application rebuild.

Read [Save Editor support](../reference/save-editor.md) for the current games, fields, and safety limits. This page owns the implementation design and contributor flow.

<!-- START doctoc -->
## Table of contents

- [Support boundary](#support-boundary)
- [Handler architecture](#handler-architecture)
- [Typed schema design](#typed-schema-design)
- [Save integrity boundary](#save-integrity-boundary)
- [Eight-step contributor flow](#eight-step-contributor-flow)
- [Checks before handoff](#checks-before-handoff)
- [Related](#related)

<!-- END doctoc -->

## Support boundary

Keep each handler boundary narrow:

- Red, Blue, and Yellow use checked English 32 KiB SRAM layouts.
- Gold, Silver, and Crystal use checked English 32 KiB SRAM layouts.
- Ruby and Sapphire use the English retail Ruby/Sapphire layout.
- Emerald uses the English retail Emerald layout.
- FireRed and LeafGreen use the English retail FireRed/LeafGreen layout.
- Regional layouts are unsupported until each layout has its own checked definition and fixtures.
- Emerald can identify itself from its save checksum layout.
- Ruby/Sapphire and FireRed/LeafGreen need a manual game choice without ROM identity.
- Diamond, Pearl, Platinum, HeartGold, and SoulSilver use their checked 512 KiB layouts and stored game version.
- A Link to the Past uses checked 8 KiB SNES SRAM files and duplicate copies.
- Super Mario World uses 2 KiB SNES SRAM, three files, additive checksums, and duplicate copies.
- Black, White, Black 2, and White 2 use 512 KiB saves, version markers, and per-block CRC checks.

Do not treat a matching size as game recognition. A save state is not a game save. Handlers accept raw persistent game saves only.

Each handler exposes only fields with a checked write path. Generation III supports item IDs and quantities in every bag and PC slot. Generation V exposes scalar inventory fields for the shared CLI and browser controls. Party and boxed Pokémon remain unsupported.

The Generation III handler treats one valid slot plus one empty slot as valid with a warning. It preserves the empty slot.

## Handler architecture

- `crates/rom-weaver-core/src/save/container.rs` removes supported wrappers before recognition and restores them after editing.
- `crates/rom-weaver-core/src/save/formats/` describes physical save formats. A format entry does not recognize a game.
- `crates/rom-weaver-core/src/save/schema/catalog/` contains the built-in game catalog. Each module defines one title or related game family with typed Rust values.
- `SaveGameRegistry` maps a stable game ID to one definition and exposes the shared handler operations.
- The schema engine owns common field storage, physical-to-logical layouts, copy recovery, checksums, text codecs, and edit transactions.
- Native Rust callbacks implement game rules that need conditional fields, arithmetic, validation, or linked writes.
- `SchemaSaveHandler` handles every game definition. It supports fresh generation only when the definition has a checked initializer.
- `crates/rom-weaver-cli/src/save_command.rs` owns CLI paths, output files, dry runs, force checks, and reports.
- The browser calls the same command path through the WASM worker. Keep file access in the existing OPFS worker boundary.

Return structured recognition, integrity, field, and change data. Do not make a front end parse display text to decide whether a save is safe to edit.

## Typed schema design

Define games with the typed Rust schema API. Use the shared engine for storage, layout selection, recovery, checksums, text, and transactional editing. Use a native callback when a rule needs game-specific control flow or arithmetic. Do not duplicate a shared engine feature in a callback.

`schema::GameDefinition` and `schema::FieldDefinition` hold the typed definitions. `SchemaSaveHandler::new` checks their storage, text codecs, and generation defaults before registration.

Put related definitions in one catalog module. Use shared constructors and Rust loops for repeated fields, choices, slots, and profiles. Use `FieldScope` to inherit groups and array guards. Use field and presentation constructors to set metadata without repeating default values. Keep every published game and field ID stable. Profiles for fixed slots, players, regions, or storage variants remain separate registry entries when users must select them independently.

Keep the normalized raw payload size separate from a wrapper. The container layer removes the wrapper before the game definition sees the bytes. Preserve unknown bytes and unrelated records in every edit.

Use the shared text codec types for game character tables and termination rules. Use the shared checksum and layout types when they represent the format exactly. Do not approximate an integrity algorithm or omit one from an editable definition.

Validate every assignment before copying the input. Apply linked writes and game-specific callbacks within the transaction. Repair integrity data, reparse the result, and require requested values to round-trip. A no-op must preserve every byte.

Separate structural integrity from playable game state. Bounds, signatures, encodings, checksums, and mirrors establish structural integrity. They do not prove that every representable value or combination is playable.

Add fresh generation only when a source and fixture prove the initialized image is playable. A test fixture builder does not prove playable generation. Pokémon definitions remain template-only. The Super Mario World and A Link to the Past built-in definitions retain fresh generation. In the additional catalog profiles, only each title's File 1 profile has a fresh initializer.

The JSON returned by `save export-schema` is a UI and automation wire format. It does not contain the byte layout or executable rules and cannot be loaded as a game definition. Adding game support requires a new application build.

Check a definition against pinned sources, representative valid fixtures, invalid integrity cases, one-field edits, checksum bytes, and preservation of unrelated bytes.

## Save integrity boundary

The handler must preserve the source file and write an edited copy. It must:

1. Check the exact input size and supported game definition.
2. Parse each physical save slot or duplicate copy.
3. Check all markers, section IDs, signatures, and checksums for that handler.
4. Select the active data with the game's counter or recovery rule.
5. Refuse writes when no complete active slot is proven.
6. Apply only fields in the editable schema.
7. Recompute each changed section checksum and write a complete edited copy.
8. Report the original and edited integrity state without changing the input.

Keep the slot counter and rotation rules in the handler. A caller must not choose a physical sector by assuming that section IDs are in order.

## Eight-step contributor flow

1. **Set the boundary.** Confirm the game, region, save size, editable fields, and recognition outcome before you add a definition.
2. **Read the architecture.** Check `docs/development/ARCHITECTURE.md`, the core registry traits, the WASM worker path, and the one-error-type rule.
3. **Add the game definition.** Add a typed Rust definition under `save/schema/catalog` and register its constructor in `catalog::all`. Reuse shared constructors and preserve unknown bytes.
4. **Add recognition fixtures.** Test valid two-slot saves, one valid slot, empty slots, bad checksums, wrong section IDs, counter wrap, and unsupported layouts.
5. **Add field tests.** Test each editable field, read-only field, boundary value, invalid value, checksum update, and byte preservation case.
6. **Exercise both front ends.** The registry supplies the CLI and browser through the shared WASM command path. Test the new definition in both workflows.
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

- [Edit a game save in the browser](../how-to/edit-gen3-saves.md): browser steps, previews, downloads, and testing.
- [Save Editor support](../reference/save-editor.md): supported games, fields, recognition, and integrity rules.
- [Architecture](ARCHITECTURE.md): crate graph, registry traits, WASM workers, OPFS, and the Rust-TypeScript boundary.
- [Development guide](development.md): setup, worktrees, tests, and full local checks.
