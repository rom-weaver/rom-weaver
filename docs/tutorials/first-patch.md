# Your first patch in the browser

In about ten minutes you will patch a ROM in your browser and prove the result
is correct, byte for byte. You need nothing but a browser: no install, no
account, and no files of your own.

Everything here uses tiny homebrew ROMs made for this project, so there is
nothing to obtain and nothing to break.

<!-- START doctoc -->
## Table of contents

- [What you are about to do](#what-you-are-about-to-do)
- [Step 1: open the guided sample](#step-1-open-the-guided-sample)
- [Step 2: look at what loaded](#step-2-look-at-what-loaded)
- [Step 3: apply the patches](#step-3-apply-the-patches)
- [Step 4: check that you got the right bytes](#step-4-check-that-you-got-the-right-bytes)
- [Step 5: try the other two samples](#step-5-try-the-other-two-samples)
- [If something looked different](#if-something-looked-different)
- [What you learned](#what-you-learned)
- [Next](#next)

<!-- END doctoc -->

## What you are about to do

A patch is a small file that describes changes to one exact version of a game.
rom-weaver combines your game file and the patch into a new file, and leaves
your original alone.

That is all you need to know to start.
[How patching works](../explanation/how-patching-works.md) explains the rest
once you have seen it happen.

## Step 1: open the guided sample

Open [guided Apply](https://rom-weaver.com/apply?guide=apply).

rom-weaver loads a tiny homebrew NES ROM and two patches written for this
guide. Nothing is uploaded, and no commercial game data is involved.

## Step 2: look at what loaded

The guide points at four parts of the Apply page. Look at each one before you
touch anything.

1. The **ROM** card shows the starting file and its checksums.
2. The **Patches** cards show the order. Patch 1 changes `HELLO` to
   `MODIFIED`. Patch 2 changes `WORLD` to `ROM`.
3. **Add files** is where more ROMs, patches, archives, or bundles would go.
   You do not need it here.
4. **Apply** controls the output.

## Step 3: apply the patches

In the **Apply** section, choose **APPLY & DOWNLOAD**.

Your browser downloads a new ROM. The sample ROM you started from is
untouched.

<figure class="docs-screenshot-pair" aria-label="The practice ROM before and after both patches">
  <figure class="docs-screenshot">
    <img src="/docs/screenshots/first-sample-hello-world.webp" width="1024" height="768" alt="The original homebrew sample ROM displaying HELLO WORLD in an NES emulator" loading="lazy" decoding="async">
    <figcaption>Before: the clean practice ROM.</figcaption>
  </figure>
  <figure class="docs-screenshot">
    <img src="/docs/screenshots/first-sample-modified-rom.webp" width="1024" height="768" alt="The homebrew sample ROM displaying MODIFIED ROM after both patches" loading="lazy" decoding="async">
    <figcaption>After: both patches applied in order.</figcaption>
  </figure>
</figure>

## Step 4: check that you got the right bytes

The finished sample displays `MODIFIED ROM`. Its SHA-256 is:

```text
e0db7cbd02cccd5e83931e7974db94aaafe40327b2a33fdd4c83235c9880a90e
```

If your download has that checksum, it is byte-for-byte identical to the file
this guide expects. That is the strongest confirmation a patch tool can give
you, and it is the same check you will use on real patches.

To see the sample files for yourself, choose **Download a test bundle** from
the **New here?** beacon on the empty Apply page, or
[download `first-weave.zip`](https://rom-weaver.com/first-weave.zip).

## Step 5: try the other two samples

The same practice files drive two more guided runs:

- [Guided Create](https://rom-weaver.com/create?guide=create) makes a patch
  from two homebrew ROMs.
- [Guided Bundle](https://rom-weaver.com/apply?guide=bundle) turns the Apply
  sample into a patch-only release archive.

Run them now, while the sample is still fresh.

## If something looked different

This tutorial is written against the guided sample, so the usual surprises have
simple causes:

- **The page was empty when it opened.** The guide runs from the `?guide=apply`
  part of the link. Open
  [guided Apply](https://rom-weaver.com/apply?guide=apply) again rather than
  the plain Apply page.
- **The button was greyed out.** Every file has to finish reading and
  checksumming first. The notice nearest the disabled button always says what
  it is still waiting for.
- **The patches were in the other order.** Drag the numbered handle on a patch
  card to move it. Patch 1 has to run first, because patch 2 was written
  against patch 1's result.
- **Your checksum did not match.** Confirm you applied both patches, in order,
  and that you are hashing the downloaded file rather than the sample you
  started from.

None of these can damage anything here. The files are homebrew, and your input
files are never modified - rom-weaver always writes a new one.

## What you learned

You applied an ordered pair of patches, downloaded the result, and verified it
with a checksum. That is the whole shape of the Apply workflow. A real patch
differs only in that you supply the game file.

## Next

- [Apply a ROM patch](../how-to/apply-rom-patches.md) when someone hands you a
  real patch.
- [How patching works](../explanation/how-patching-works.md) for what a
  checksum proves and why the exact starting file matters.
- [Your first weave in the terminal](cli-first-weave.md) to do the same thing
  from a command line.
