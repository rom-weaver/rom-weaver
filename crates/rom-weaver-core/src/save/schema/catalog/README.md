# Save schema sources

The `builtin_*` modules define the full game profiles. The catalog includes layouts adapted from [Game Tools Collection](https://github.com/RyudoSynbios/game-tools-collection/tree/fd8ca0beba05723fcfdb5af83c453ba9bea1221a), revision `fd8ca0beba05723fcfdb5af83c453ba9bea1221a`.

Game Tools Collection is copyright 2024 RyudoSynbios and uses the [MIT License](LICENSE-GAME-TOOLS-COLLECTION). The build includes this attribution in the CLI and browser notices.

F-Zero, Game & Watch Gallery 3, and Kirby's Adventure use revision `75ce8f848b628f202c50daa75d95dda58eb1f3a5` of the same source. Their module comments link the layouts and write rules.

ActRaiser, the two Capcom GBA EEPROM games, Chrono Trigger, Donkey Kong Land, the newer F-Zero games, Final Fantasy VI, Lylat Wars, Mario Kart 64, Mission: Impossible, Mystic Quest Legend, Pokémon Trading Card Game, Super Punch-Out!!, Wario Land 3, and the two Zelda Oracle games use revision [`8fb075e7c130da9e72c3c46ec8efa447a252ad88`](https://github.com/RyudoSynbios/game-tools-collection/tree/8fb075e7c130da9e72c3c46ec8efa447a252ad88). Diddy Kong Racing uses editor offsets from that revision and checksum rules from [DavidSM64/Diddy-Kong-Racing](https://github.com/DavidSM64/Diddy-Kong-Racing/blob/1339ad6304118207b342fe8669c500efb91969df/src/save_data.c). Their module comments link the exact source directories.

Sonic 3, Shining Force, and Soleil also use Game Tools Collection revision [`8fb075e7c130da9e72c3c46ec8efa447a252ad88`](https://github.com/RyudoSynbios/game-tools-collection/tree/8fb075e7c130da9e72c3c46ec8efa447a252ad88). Sonic 3 checksum and block rules follow [jcfields/sonic3-save-editor](https://gitlab.com/jcfields/sonic3-save-editor/-/blob/8b740b670ff8e46f7c35ff8fac98169efccfe3b9/save%20format.md).

All profiles in these modules require explicit selection and a game-made template. Their definitions expose only the fields whose write and integrity rules are implemented. Omitted game data is not editable.
