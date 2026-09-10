# ROM cheats

A cheat code names an address and a value. That address can refer to cartridge ROM or runtime memory (RAM, or an emulator's own state).

A ROM address maps to bytes in the game file. ROMWeaver bakes that write into the output ROM.

A runtime address maps to memory that exists only while an emulator runs. The game file does not contain that memory, so ROMWeaver cannot bake a write to it. ROMWeaver marks such a cheat **Unsupported** and gives a reason: the code targets runtime memory, some of its linked subcodes do, it needs a parameter value, or it is a structured RetroArch entry rather than a native code.

Some named cheats contain several linked subcodes. ROMWeaver classifies the whole entry as unsupported unless every subcode resolves to a ROM address.

Checksum matching identifies a known ROM revision. It does not prove that a community-submitted cheat is correct for that revision - the database carries the code as published, not as verified against every game state.

An earlier patch step can change a byte that a ROM cheat expects to find. ROMWeaver resolves each ROM cheat at its position in the ordered pipeline, after earlier patch steps, so a cheat's address math sees the bytes those steps already produced.

The browser performs identification, decoding, and baking on the device. It does not upload ROM bytes or ROM checksums.

For the browser task, see [Use cheats in the browser](../how-to/use-browser-cheats.md).

For database fields and licensing, see [Cheat database reference](../reference/cheat-database.md).
