# Get started with rom-weaver

rom-weaver applies and creates ROM patches. It runs in your browser or in a
terminal, and your files never leave your device.

<!-- START doctoc -->
## Table of contents

- [What a patch is](#what-a-patch-is)
- [Pick your guide](#pick-your-guide)
- [Try it in the browser](#try-it-in-the-browser)
- [Try it in a terminal](#try-it-in-a-terminal)
- [Before you use a real patch](#before-you-use-a-real-patch)
- [Words you will keep seeing](#words-you-will-keep-seeing)
- [Where to go next](#where-to-go-next)
- [Legal and privacy](#legal-and-privacy)

<!-- END doctoc -->

## What a patch is

A ROM is a copy of a game kept in one file. A patch is a much smaller file
that lists changes somebody made to that game: a fan translation, a bug fix, a
new set of levels.

A patch is not the game. It only holds the differences. To play the change you
need two files: the patch, and your own copy of the exact game it was built
from. rom-weaver combines them and writes a new file. Your original is left
alone.

This is why patches get shared and games do not. rom-weaver never supplies
game data, and no patch works without the right starting file.

## Pick your guide

- [Apply a patch](apply-rom-patches.md) if somebody handed you a patch and you
  want to play it.
- [Create a patch](create-rom-patches.md) if you changed a game and want to
  share that change.
- [Fix a checksum error](fix-checksum-errors.md) if rom-weaver says your file
  is not the one the patch expects.
- [Pick a patch format](patch-formats.md) if you are publishing and cannot
  decide between BPS, IPS, xdelta, and the rest.

Reading in order also works. Each guide points at the next one.

## Try it in the browser

Nothing to install, no account to make.
[Weave](https://rom-weaver.com/weave) applies patches.
[Create](https://rom-weaver.com/create) makes them.

Want to watch it work before you touch your own files? Open
[Weave](https://rom-weaver.com/weave) and choose **Start guided Apply**. It
loads a tiny practice ROM and two patches, then walks through the important
controls with nothing of yours at stake. Create has its own guided practice
run too. Both pages also let you download their sample files without starting
the guide.

You can also install the site as an app from your browser menu. Once it has
saved its own files, it keeps working with no connection.

## Try it in a terminal

The command-line tool does the same jobs. Reach for it when you want to repeat
a task or script it. Install it with Homebrew, Scoop, the install script, npm,
Cargo, or Docker. The [CLI guide](../cli.md) covers every install route,
command, and option.

Check that it is there:

```bash
rom-weaver --help
```

Then run the same practice files:

```bash
curl --fail --location --output first-weave.zip \
  https://rom-weaver.com/first-weave.zip
rom-weaver weave --input first-weave.zip --output modified-rom.nes --no-compress
rom-weaver checksum --input modified-rom.nes --algo sha256
```

The last command should print
`e0db7cbd02cccd5e83931e7974db94aaafe40327b2a33fdd4c83235c9880a90e`. If it
does, your install works.

## Before you use a real patch

Read whatever the patch author wrote, even when it is short. Write down which
version of the game they used: the region (USA, Japan, Europe), the revision
number, and anything they say about headers or disc layout. If they published
a checksum, keep it.

Do not trust the filename. Two files can share a name and hold different
bytes, and the patch cares about the bytes.

Keep one clean copy of the original game and never overwrite it. Save patched
results under new names. Only use files you are allowed to have.

## Words you will keep seeing

- **ROM**: one file holding a copy of a game.
- **Patch**: a small file listing changes to a specific ROM.
- **Checksum**: a short code worked out from a file's bytes, used to prove two
  files are identical. Renaming a file does not change it.
- **Region**: which part of the world a release was sold in. Regions differ
  inside the file, not just on the title screen.
- **Revision**: a later printing of the same game, often with bugs fixed.
- **Header**: a small block of extra bytes sitting in front of some ROMs. A
  patch may expect it to be there or expect it gone.

## Where to go next

These guides cover the usual path: a clean file in, a checked file out. For
scripting, archives, compression, bundles, JSON output, and the full command
reference, read the [CLI guide](../cli.md). To build or deploy rom-weaver
itself, start at the [documentation index](../README.md).

## Legal and privacy

- [Notices](notices.md) covers the project license and the open-source
  components in each build.
- [Privacy](privacy.md) covers what stays on your device, what your browser
  keeps, and what leaves.
