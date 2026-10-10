# Add an Apply button to a patch release

Give readers one link that loads your patch recipe, then asks them to supply their own matching ROM. Use a patch-only weave to preserve source checks, patch order, and optional add-ons.

<!-- START doctoc -->
## Table of contents

- [Prepare the release recipe](#prepare-the-release-recipe)
- [Copy a release-page link](#copy-a-release-page-link)
- [Use a patch-only link for a simple release](#use-a-patch-only-link-for-a-simple-release)
- [Check hosting and the reader's path](#check-hosting-and-the-readers-path)

<!-- END doctoc -->

## Prepare the release recipe

1. Follow [Create and share a patch weave](create-bundles.md) to build your recipe from the clean source and patches.
2. Leave **Include ROM in weave** clear. Record the expected source checksum and size, and keep a copy of those values in your release notes.
3. Put required patches in execution order. Mark only genuine add-ons optional; they start disabled. Test every optional combination you advertise, including any dependency on an earlier patch's result.
4. Reopen the exported archive with a fresh matching source. Apply it and compare the result with the checksum of your intended modified file.
5. Host the patch-only archive at a stable public HTTPS URL you control. Use a versioned filename so an old release link does not silently load a newer recipe.

The [first-patch tutorial](../tutorials/first-patch.md) supplies a homebrew practice run. The existing [two-patch demo video](https://github.com/user-attachments/assets/558b4f4d-640c-410e-a866-cd9ff97ac84c) shows applying the sample patches and downloading a 7z result. Link to it when readers need a preview; no commercial ROM is required.

## Copy a release-page link

Replace the example archive URL with your own. This HTML link can be styled as a button by your release site:

```html
<a href="https://rom-weaver.com/weave-patches?weave=https%3A%2F%2Fexample.com%2Freleases%2Fv1%2Frelease.zip">Apply this recipe</a>
```

For a Markdown release page:

```markdown
[Apply this recipe](https://rom-weaver.com/weave-patches?weave=https%3A%2F%2Fexample.com%2Freleases%2Fv1%2Frelease.zip)
```

Encode the entire archive URL as the `weave` parameter value, especially if it contains `&`, `?`, `#`, or spaces. The [integration reference](../hosting/webapp-integration.md#url-sessions) shows a URL builder and the parameter rules.

Put this information beside the button, replacing the brackets with your release's verified values:

```text
Bring your own [game, region, revision, header state] ROM.
Expected source: [algorithm and checksum], [size in bytes].
This link loads our patch-only recipe. Your ROM is processed on your device.
Required patches: [names in order]. Optional add-ons: [tested choices].
Expected result: [filename and checksum for each supported choice].
Download the recipe directly: [archive URL and archive checksum].
```

The archive checksum verifies the download; the source and result checksums describe the files being patched. Do not substitute one for another. Do not put ROM bytes, private download tokens, or personal information in a shareable link.

## Use a patch-only link for a simple release

For a release that needs no saved recipe metadata, preload one or more patch URLs and leave out `rom`:

```text
https://rom-weaver.com/apply-patches?patch=https%3A%2F%2Fexample.com%2Fchange.bps
```

Repeat `patch` to preload multiple files. A direct link does not record your expected ROM checks, optional defaults, or execution-input choices. Use a weave for a dependent chain rather than relying on a reader to reconstruct it.

Do not combine `weave` with `rom` or `patch`: the weave takes precedence. Neither link automatically applies patches; the user reviews the inputs and starts the operation.

## Check hosting and the reader's path

1. Configure the archive host and every remote patch host to allow downloads from `https://rom-weaver.com` using CORS. Follow the [hosting checklist](../hosting/webapp-integration.md#host-remote-inputs).
2. Open the exact published link in a fresh browser page without being signed into the file host. Confirm it loads the recipe rather than a login page or HTML preview.
3. Confirm the displayed source checks, patch order, names, and optional switches match the release notes. Add the clean source locally and apply the recipe.
4. Download and checksum the result, then test the emulator or hardware you claim to support. Repeat for supported optional combinations.
5. Try a harmless wrong sample source and confirm that the mismatch is visible. Do not instruct readers to bypass it.
6. Test on every device/browser you name in the release notes. A successful small sample does not establish that a multi-gigabyte disc will fit another device's memory or browser storage.

If the host refuses cross-origin downloads, offer the direct archive download and tell readers to add that downloaded archive in [Weave](https://rom-weaver.com/weave-patches), followed by their own source ROM. Do not ask them to disable browser security. For source mismatches, link to [Fix checksum errors](fix-checksum-errors.md).
