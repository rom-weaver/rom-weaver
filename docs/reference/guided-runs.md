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
| [Apply](https://rom-weaver.com/apply-patches?guide=apply) | 4 | Waits for you to add files; the card offers the practice files |
| [Apply cheats](https://rom-weaver.com/apply-patches?guide=apply-cheats) | 4 | Loads `hello-world.nes` |
| [Bundle](https://rom-weaver.com/bundle-patches?guide=bundle) | 4 | Loads `first-weave.zip` |
| [Create](https://rom-weaver.com/create-patch?guide=create) | 6 | Loads `hello-world.nes` and `modified-world.nes` |
| [Create cheats](https://rom-weaver.com/create-patch?guide=create-cheats) | 4 | Loads `hello-world.nes` |
| [Test](https://rom-weaver.com/test-rom?guide=test) | 2 | Loads `hello-world.nes` |

Guided Apply's steps are add your files, check your starting ROM (with the Simple and Detailed views), patches and cheats, and apply. Its **Continue** stays unavailable until a ROM and a patch are in. [Your first patch in the browser](../tutorials/first-patch.md) follows it to a verified checksum.

A step that needs a control the page does not show, such as the **Detailed** switch, is left out. **✕** or Esc ends a run; files already added stay.

## Where a run starts

- A link with `?guide=`, as in the table above. It works even when **New here?** is hidden.
- **New here?** below an empty drop zone: Apply offers Apply and Apply cheats, Create offers Create and Create cheats, and Bundle and Test offer their own run.

**Hide this button** in that menu removes **New here?**; the **Show the "New here?" quick-start tips** [setting](../how-to/browser-settings.md) brings it back.

## Ways files get into Apply

All of these feed **0x01 Inputs**, which puts each file on its card.

| Route | Accepts |
| --- | --- |
| Drop files | ROMs, patches, archives, and bundles, several at once |
| Drop a folder | Every file inside, including subfolders; hidden files are skipped |
| **Add files** | The file picker; touch screens show **Tap to choose files** |
| Archives | ZIP, 7z, RAR, tar, and nested archives; see [container formats](formats.md#container-and-compression-formats) |
| **Use the practice files** | Guided Apply only: loads `first-weave.zip` onto the bench |
| **Download first-weave.zip** | Guided Apply only: saves it to add by any route above |

## Practice files

| File | Contents | **New here?** download |
| --- | --- | --- |
| `first-weave.zip` | `hello-world.nes`, two IPS patches, and a bundle manifest | **Download a test bundle** (Apply, Bundle) |
| `first-create.zip` | `hello-world.nes` and `modified-world.nes` | **Download samples** (Create) |
| `hello-world.nes` | Homebrew NES ROM that shows `HELLO WORLD` | **Download the sample ROM** (Test) |

The practice cheat catalog unlocks only for `hello-world.nes`, matched by checksum.
