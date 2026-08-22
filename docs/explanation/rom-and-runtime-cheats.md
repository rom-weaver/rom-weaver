# ROM cheats and runtime cheats

A cheat code names an address and a value. That address can refer to cartridge ROM or runtime memory.

A ROM address maps to bytes in the game file. ROMWeaver can bake those writes into the output ROM.

A runtime address maps to memory that exists while an emulator runs. The game file does not contain that changing memory.

ROMWeaver therefore exports runtime cheats to a RetroArch `.cht` file. A compatible core interprets the preserved entry during play.

Some named cheats contain several linked subcodes. The subcodes can depend on one another.

ROMWeaver keeps a mixed ROM and runtime group intact. It exports the complete original entry instead of splitting the group.

Parameterized codes contain placeholders such as `??` or `XXXX`. Replacing these placeholders with zero would change their meaning.

ROMWeaver keeps parameterized entries disabled until a later version can ask for a value.

Checksum matching identifies a known ROM revision. It does not prove that every community cheat is correct.

An earlier patch can also change a byte that a ROM cheat expects. ROMWeaver resolves each ROM cheat at its ordered pipeline position.

The browser performs identification, classification, and output work on the device. It does not upload ROM bytes or ROM checksums.

For the browser task, see [Use cheats in the browser](../how-to/use-browser-cheats.md).

For database fields and licensing, see [Cheat database reference](../reference/cheat-database.md).
