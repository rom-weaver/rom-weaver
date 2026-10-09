# Guided practice runs

A guided run is a card that walks one browser workflow step by step on homebrew practice files. No commercial game data is involved, and nothing is uploaded.

<!-- START doctoc -->
## Table of contents

- [Runs](#runs)
- [Where a run starts](#where-a-run-starts)
- [Ways files get into Apply](#ways-files-get-into-apply)
- [Practice files](#practice-files)

<!-- END doctoc -->

## Runs

| Run | Steps | Files |
| --- | --- | --- |
| [Apply](https://rom-weaver.com/apply-patches?guide=apply) | 5 | Waits for you to add files; **Continue** loads `first-weave.zip` |
| [Apply cheats](https://rom-weaver.com/apply-patches?guide=apply-cheats) | 4 | Loads `hello-world.nes` |
| [Weave](https://rom-weaver.com/weave-patches?guide=weave) | 5 | Loads `first-weave.zip` |
| [Create](https://rom-weaver.com/create-patch?guide=create) | 6 | Loads `hello-world.nes` and `modified-world.nes` |
| [Create cheats](https://rom-weaver.com/create-patch?guide=create-cheats) | 4 | Loads `hello-world.nes` |
| [Test](https://rom-weaver.com/test-rom?guide=test) | 2 | Loads `hello-world.nes` |

Guided Apply's steps are add your files, check your starting ROM (with the Simple and Detailed views), identify the starting ROM, patches and cheats, and apply. On its first step, **Continue** with no files in loads `first-weave.zip`; with files in, it moves on. [Your first patch in the browser](../tutorials/first-patch.md) follows it to a verified checksum.

Apply, Create, and Weave include a Simple/Detailed comparison. Its buttons change the live view without advancing the guide. Apply and Weave explain the Identify search and the Detailed view’s Identify drawer.

Guide cards fit their content without an internal scrollbar. The first step includes a click/drop demonstration; reduced-motion preferences disable its movement.

A step that needs a control the page does not show, such as the **Detailed** switch, is left out. **✕** or Esc ends a run; files already added stay. Drawers opened by the guide close again when it ends, including after its final action.

## Where a run starts

- A link with `?guide=`, as in the table above. It works even when the sample link is hidden.
- The sample link below an empty drop zone, named for its page: **Patch a sample** offers Apply and Apply cheats, **Create a sample** offers Create and Create cheats, and **Weave a sample** and **Play a sample** offer their own run.

**Hide this button** in that menu removes the sample link; the **Show the sample quick-start links** [setting](../how-to/browser-settings.md) brings it back.

## Ways files get into Apply

All of these feed **0x01 Inputs**, which puts each file on its card.

| Route | Accepts |
| --- | --- |
| Drop files | ROMs, patches, archives, and weaves, several at once |
| Drop a folder | Every file inside, including subfolders; hidden files are skipped |
| **Add files** | The file picker; touch screens show **Tap to choose files** |
| Archives | ZIP, 7z, RAR, tar, and nested archives; see [container formats](formats.md#container-and-compression-formats) |
| **Continue** with no files in | Guided Apply only: loads `first-weave.zip` onto the bench |
| **Download first-weave.zip** | The guide card's first step: saves it to add by any route above |

## Practice files

| File | Contents | Sample link download |
| --- | --- | --- |
| `first-weave.zip` | `hello-world.nes`, two IPS patches, and a weave manifest | **Download a test weave** (Apply, Weave) |
| `first-create.zip` | `hello-world.nes` and `modified-world.nes` | **Download samples** (Create) |
| `hello-world.nes` | Homebrew NES ROM that shows `HELLO WORLD` | **Download the sample ROM** (Test) |

The first step of every run offers its practice files as one download on the guide card: `first-weave.zip` for Apply and Weave, `first-create.zip` for Create, and `hello-world.nes` for Test and both cheat runs.

The practice cheat catalog unlocks only for `hello-world.nes`, matched by checksum.
