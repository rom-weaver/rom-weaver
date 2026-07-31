# Browser usage

rom-weaver applies and creates ROM patches without uploading your files.
Nothing needs to be installed for this guide.

<!-- START doctoc -->
## Table of contents

- [What is a patch?](#what-is-a-patch)
- [Try a harmless sample](#try-a-harmless-sample)
- [Apply your first real patch](#apply-your-first-real-patch)
- [Should I use the browser or CLI?](#should-i-use-the-browser-or-cli)
- [Terms used in rom-weaver](#terms-used-in-rom-weaver)
- [Before you use a real game](#before-you-use-a-real-game)
- [Where to go next](#where-to-go-next)

<!-- END doctoc -->

## What is a patch?

A ROM is a copy of a game stored in one or more files. A patch is a much
smaller file that describes changes to one exact version of that game. The
change might be a translation, a bug fix, restored content, or a new set of
levels.

A patch is not the game. Think of it as a list that says, "replace these bytes
with those bytes." You provide your own clean game file and the patch.
rom-weaver combines them and gives you a new file. It leaves the clean file
alone.

The exact starting file matters. A USA release and a Japanese release may look
like the same game, but their bytes differ. The same is true for revisions and
some cartridge headers. A patch made for one will usually reject the others.

## Try a harmless sample

Open [guided Apply](https://rom-weaver.com/apply?guide=apply). rom-weaver loads
a tiny homebrew NES ROM and two patches made for this project. No commercial
game data is involved.

The guide points to four parts of the real Weave page:

1. The **ROM** card shows the starting file and its checksums.
2. The **Patches** cards show the order. Patch 1 changes `HELLO` to
   `MODIFIED`. Patch 2 changes `WORLD` to `ROM`.
3. **Add files** stays available if you need another ROM, patch, archive, or
   bundle.
4. **Weave** controls the output. Choose **WEAVE & DOWNLOAD** to make the new
   ROM.

The finished sample displays `MODIFIED ROM`. Its SHA-256 is
`e0db7cbd02cccd5e83931e7974db94aaafe40327b2a33fdd4c83235c9880a90e`, so you
can check that your download is byte-for-byte identical. If you want to inspect
the files yourself, choose **Download a test bundle** from the **New here?**
beacon on the empty Weave page or
[download `first-weave.zip`](https://rom-weaver.com/first-weave.zip).

The sample is also useful later. [Guided Create](https://rom-weaver.com/create?guide=create)
uses two homebrew ROMs to make a patch.
[Guided Bundle](https://rom-weaver.com/apply?guide=bundle) turns the Apply
sample into a safe, patch-only release archive.

## Apply your first real patch

Once the sample makes sense, you need two things:

- the patch you downloaded;
- your own clean copy of the exact game version named by the patch author.

Then:

1. Open [Apply](https://rom-weaver.com/apply).
2. Add the ROM and patch together. You may drag them onto **0x01 Add files** or
   tap the picker.
3. Wait for the ROM and patch cards to finish reading and checking.
4. Read every warning. A different filename is only a clue. A checksum or size
   mismatch means the bytes differ and needs attention.
5. If there is more than one patch, drag the numbered handles into the order
   the author gave you.
6. In **0x04 Weave**, give the result a new name.
7. Choose **WEAVE & DOWNLOAD**.
8. Open the new file in the emulator or hardware you normally use.

The original ROM is not overwritten. Keep it somewhere safe because an update
or a different patch may need the clean file again.

For screenshots and explanations of every control, continue with
[Apply a ROM patch in the browser](apply-rom-patches.md).

## Should I use the browser or CLI?

Use the browser when you are learning, patching a few files, or want the cards
and warnings to explain what rom-weaver found. It works on desktop and mobile,
supports drag and drop or file pickers, and can be installed as an offline
app. Your ROMs, patches, and results stay on your device.

Use the command-line tool when you want repeatable scripts, batch jobs, CI, or
exact flags you can paste into release instructions. The commands do the same
core work, but the interface is intentionally different. The
[CLI guides](../cli/get-started.md) own installation, terminal examples, and
the full [command reference](../cli/reference.md). Browser guides do not mix terminal steps into the
middle of a visual workflow.

If you are unsure, start in the browser. You can move to the CLI later without
changing your patch files or bundles.

## Terms used in rom-weaver

- **ROM**: the game file you already have.
- **Patch**: the smaller file that describes changes to one ROM.
- **Original**: the clean, unchanged ROM used to create a patch.
- **Modified**: the finished ROM from which a new patch is created.
- **Checksum**: a fingerprint calculated from every byte in a file. A matching
  checksum proves that the bytes match. Renaming a file does not change it.
- **Region**: the market a release was made for, such as USA, Japan, or Europe.
- **Revision**: a later printing of the same game.
- **Header**: extra bytes added to the front of some cartridge dumps.
- **Patch order**: the sequence used when several patches build on one another.
- **Bundle**: a recipe that records a ROM's checks, patch files, order, choices,
  and output settings.

You do not need to memorize this list. The cards show these details where they
matter, and the [FAQ](faq.md) answers the common follow-up questions.

## Before you use a real game

Read the patch author's notes first. Find the expected region, revision,
header state, patch order, and checksum. Keep the notes open while you work.

Do not trust filenames alone. Two files can have the same name and different
bytes. The reverse is also true: a correctly matching ROM may have a different
filename. rom-weaver treats an expected name as a helpful warning, while size
and checksums are the real checks.

Keep a clean original. Save patched results under new names. Only use and
share files you are allowed to have. Public patch releases normally contain a
patch or patch-only bundle, not the copyrighted original ROM.

## Where to go next

- [Apply a ROM patch](apply-rom-patches.md) for the complete Weave webapp
  workflow.
- [Create a ROM patch](create-rom-patches.md) when you have clean and modified
  files.
- [Create and share a bundle](create-bundles.md) for several patches or a
  repeatable release.
- [Fix a checksum error](fix-checksum-errors.md) when a file does not match.
- [Pick a patch format](patch-formats.md) when you are publishing.
- [Use the CLI](../cli/get-started.md) for installation and terminal commands.

For privacy details, read [Privacy](../legal/privacy.md). For licensing and
third-party components, read [Notices](https://rom-weaver.com/docs/notices).
