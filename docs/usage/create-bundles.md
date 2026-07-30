# Create and share a patch bundle

A rom-weaver bundle turns a ROM, an ordered patch chain, its choices, and its
checksums into one repeatable recipe. Create one in the Weave webapp or with
the CLI, then test the bundle itself before publishing it.

<!-- START doctoc -->
## Table of contents

- [Decide what the bundle should contain](#decide-what-the-bundle-should-contain)
- [Create a bundle in the Weave webapp](#create-a-bundle-in-the-weave-webapp)
- [Create a bundle with the CLI](#create-a-bundle-with-the-cli)
- [Test the finished bundle](#test-the-finished-bundle)
- [Publish and link the bundle](#publish-and-link-the-bundle)

<!-- END doctoc -->

## Decide what the bundle should contain

<details class="docs-disclosure" open>
<summary>Choose a patch-only or ROM bundle</summary>

A bundle always contains `rom-weaver-bundle.json`. That small text file records
the patch order, optional patches, expected input and output checksums, and the
output name. A shareable archive can also carry the patch files and, when
appropriate, the original ROM.

- **Bundle + patches** is the normal public release. It includes the recipe and
  patches, but only checksums for the original. Each user supplies their own
  matching ROM.
- **Bundle + ROM + patches** is useful for your own backups, homebrew, or files
  you are allowed to redistribute. Do not put copyrighted game data in a public
  release.
- **Plain `rom-weaver-bundle.json`** is useful when every source already has a
  stable URL or sits beside the recipe.

Give every patch a stable ID. Add a readable name, author, and release version.
Mark genuinely optional patches as optional, and keep required patches
required. The order is executable data: patch 2 receives patch 1's output.

</details>

## Create a bundle in the Weave webapp

<details class="docs-disclosure">
<summary>Show the browser workflow</summary>

1. Open [Apply](https://rom-weaver.com/apply). For harmless practice first,
   open [guided Apply](https://rom-weaver.com/apply?guide=apply); its sample
   already contains one ROM and two ordered patches.
2. Add the clean original ROM and every patch. Drag the patch cards into the
   order users should run them.
3. Open each patch card's options. Add its stable ID and human-facing metadata,
   mark optional patches, and check the input basis. Use **base ROM** only when
   that patch was authored against the clean original; otherwise use
   **previous output**.
4. In **Weave**, set the output filename and format. Open **Options**, find
   **Bundle**, then choose one of:
   - **Bundle + patches (.zip)**
   - **Bundle + ROM + patches (.zip)**
   - **Bundle + patches (.7z)**
   - **Bundle + ROM + patches (.7z)**
5. Choose **Create ZIP Bundle** or **Create 7z Bundle**. Creation calculates
   checksums from the actual files. When it finishes, the same button changes
   to **Download**; save that archive.

The browser reads and writes locally. Your ROM and patches do not upload to
rom-weaver. A patch-only bundle records the original's checksums without
putting the original in the download.

</details>

## Create a bundle with the CLI

<details class="docs-disclosure">
<summary>Show the terminal workflow</summary>

Install the command first if needed: [Install the CLI](../hosting/cli.md#install).
Then create a patch-only ZIP from local files:

```bash
rom-weaver bundle create \
  --input original.sfc \
  --patch translation.bps \
  --patch-id translation \
  --patch-name "English translation" \
  --patch-version 1.0.0 \
  --patch fixes.ips \
  --patch-id fixes \
  --patch-name "Optional fixes" \
  --patch-optional true \
  --output rom-weaver-bundle.json \
  --bundle release.zip \
  --no-bundle-rom
```

Each `--patch-*` option describes the `--patch` immediately before it. Repeat
`--patch` in execution order. Remove `--no-bundle-rom` only when the ROM may
legally ship inside the archive.

For a long release, it can be easier to write a small JSON spec with local
paths and metadata, then let rom-weaver calculate and insert the checks:

```bash
rom-weaver bundle schema > rom-weaver-bundle-v1.schema.json
rom-weaver bundle create \
  --from bundle-spec.json \
  --output rom-weaver-bundle.json \
  --bundle release.zip \
  --no-bundle-rom
```

The [CLI bundle reference](../hosting/cli.md#bundles) documents URLs, per-patch
checksums, output checks, compression, and every metadata flag. `bundle create
--help` is the exact reference for the installed version.

</details>

## Test the finished bundle

<details class="docs-disclosure">
<summary>Prove the download works from a clean start</summary>

Do not test only the loose files used to build the bundle. Move the finished
archive to a clean directory or another machine and test what people will
actually download.

In the browser, open [Apply](https://rom-weaver.com/apply), add the bundle
archive, and supply the matching original when the bundle does not include it.
Check each optional-patch combination you promise to support, weave the output,
and launch it in an emulator or on supported hardware.

The CLI performs the same test:

```bash
rom-weaver weave \
  --bundle release.zip \
  --input original.sfc \
  --output rebuilt.sfc \
  --no-compress
rom-weaver checksum --input rebuilt.sfc --algo sha256
```

Compare that checksum with the finished file from which the release was made.
A checksum match proves byte-for-byte reconstruction. Launching the rebuilt
file proves that the release itself works. These are separate checks, and a
good release does both.

</details>

## Publish and link the bundle

<details class="docs-disclosure">
<summary>Give users one download and one clear entry point</summary>

Publish the tested archive with its version, changelog, expected original ROM
checksum, and the checksum of the archive itself. Say which patches are
optional and what each one changes, even though the bundle records those
choices for rom-weaver.

You can link directly into the hosted webapp:

```text
https://rom-weaver.com/apply?bundle=https://example.com/release.zip
```

The file host must allow cross-origin downloads (CORS). Relative file URLs
inside a remote bundle resolve against the bundle URL. See
[Webapp integration](../hosting/webapp-integration.md) for multiple URLs, local OPFS
files, and hosting requirements.

For an update, rebuild from the same documented clean original and the new
finished files. Keep stable patch IDs, bump patch versions, test the new
download from a clean directory, and publish it as a new immutable release
asset. Do not build version 2 by treating version 1's patched output as the new
original unless you intentionally want an incremental update.

</details>

Need to help someone use the finished archive? Send them to
[Apply ROM patches](apply-rom-patches.md#open-a-bundle).
