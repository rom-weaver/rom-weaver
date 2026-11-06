import { describe, expect, it } from "vitest";
import { resolveAssetUrl } from "../../src/public/react/asset-url.ts";
import { AUTHORED_SAMPLE_BASE, rebaseRootUrls, retargetSampleUrls } from "../../src/webapp/docs-sample-origin.ts";

const PRODUCTION = "https://rom-weaver.com";
const PREVIEW = "https://pr-225.rom-weaver-preview.pages.dev/";

const GUIDE = `<pre tabindex="0"><code class="language-bash">curl --fail --location --output first-weave.zip \\
  ${PRODUCTION}/first-weave.zip
rom-weaver weave --input first-weave.zip --output woven.bin --no-compress
</code></pre>
<p>Open the <a href="/weave?weave=first-weave.zip">practice run</a> on ${PRODUCTION}.</p>
<pre tabindex="0"><code class="language-bash">rom-weaver --help
</code></pre>`;

describe("retargetSampleUrls", () => {
  it("points shell samples at the deployment serving the page", () => {
    expect(retargetSampleUrls(GUIDE, PREVIEW)).toContain(`${PREVIEW}first-weave.zip`);
  });

  // Why this resolves against the base rather than the origin: samples sit
  // beside the app, which is not necessarily the domain root.
  it("keeps samples beside the app on a sub-path deployment", () => {
    expect(retargetSampleUrls(GUIDE, "https://example.test/rom-weaver/")).toContain(
      "https://example.test/rom-weaver/first-weave.zip",
    );
  });

  // Same resolution the sample button uses, so a guide and the app never
  // disagree about where a sample lives.
  it("resolves a name the way resolveAssetUrl does", () => {
    expect(retargetSampleUrls(GUIDE, "https://example.test/rom-weaver/")).toContain(
      resolveAssetUrl("https://example.test/rom-weaver/", "first-weave.zip"),
    );
  });

  it("leaves prose and links on the production site", () => {
    expect(retargetSampleUrls(GUIDE, PREVIEW)).toContain(
      `<a href="/weave?weave=first-weave.zip">practice run</a> on ${PRODUCTION}.`,
    );
  });

  it("returns the guide untouched on production, so hydration has nothing to reconcile", () => {
    expect(retargetSampleUrls(GUIDE, AUTHORED_SAMPLE_BASE)).toBe(GUIDE);
  });

  it("keeps the published host when there is no usable base", () => {
    expect(retargetSampleUrls(GUIDE, undefined)).toBe(GUIDE);
    expect(retargetSampleUrls(GUIDE, "   ")).toBe(GUIDE);
    expect(retargetSampleUrls(GUIDE, "not a url")).toBe(GUIDE);
  });

  it("leaves a guide that ships no samples alone", () => {
    const noSamples = `<p>Read the <a href="/docs/privacy">privacy guide</a>.</p>`;

    expect(retargetSampleUrls(noSamples, PREVIEW)).toBe(noSamples);
  });

  describe("links", () => {
    const LINKS = `<p><a href="${PRODUCTION}/apply-cheats?guide=apply-cheats&amp;x=1#top">cheats</a>
<a href="${PRODUCTION}/">home</a>
<a href="${PRODUCTION}.example/compress">lookalike suffix</a>
<a href="https://rom-weaver.com.example/compress">lookalike host</a>
<a href="https://rom-weaver.com@example.test/compress">userinfo lookalike</a>
<a href="http://rom-weaver.com/compress-files">other scheme</a>
<a href="/docs/faq">relative</a>
<a href="https://example.test/docs">elsewhere</a></p>`;

    it("retargets a production-origin link to the deployment, keeping query and fragment", () => {
      const html = retargetSampleUrls(LINKS, PREVIEW);

      expect(html).toContain(`<a href="${PREVIEW}apply-cheats?guide=apply-cheats&amp;x=1#top">cheats</a>`);
      expect(html).toContain(`<a href="${PREVIEW}">home</a>`);
    });

    it("resolves a link against the app base path on a sub-path deployment", () => {
      expect(retargetSampleUrls(LINKS, "https://example.test/rom-weaver/")).toContain(
        '<a href="https://example.test/rom-weaver/apply-cheats?guide=apply-cheats&amp;x=1#top">',
      );
    });

    it("leaves lookalike hosts, other schemes, relative and foreign links alone", () => {
      const html = retargetSampleUrls(LINKS, PREVIEW);

      for (const untouched of [
        `${PRODUCTION}.example/compress`,
        "https://rom-weaver.com.example/compress",
        "https://rom-weaver.com@example.test/compress",
        "http://rom-weaver.com/compress-files",
        'href="/docs/faq"',
        "https://example.test/docs",
      ]) {
        expect(html).toContain(untouched);
      }
    });

    it("returns links untouched on the production origin", () => {
      expect(retargetSampleUrls(LINKS, AUTHORED_SAMPLE_BASE)).toBe(LINKS);
    });
  });
});

describe("rebaseRootUrls", () => {
  const LINKS =
    '<a href="/docs/faq#files">faq</a> <a href="/apply-rom-patches?mode=rom&amp;x=1">apply</a> ' +
    '<a href="//cdn.example/x">cdn</a> <a href="#top">top</a> <a href="https://example.com/a">out</a> ' +
    '<a class="x" href="docs/faq">bare</a> <code>/docs/faq</code>';

  const IMAGES =
    '<picture><source srcset="/docs/screenshots/a.avif 1x, /docs/screenshots/a@2x.avif 2x" type="image/avif">' +
    '<img src="/docs/screenshots/a.webp" alt="/docs/x"></picture> <img src="//cdn.example/b.png"> ' +
    '<img src="https://example.com/c.png"> <img src="docs/screenshots/d.png">';

  it("leaves a root deployment byte-identical", () => {
    expect(rebaseRootUrls(LINKS + IMAGES, "/")).toBe(LINKS + IMAGES);
    expect(rebaseRootUrls(LINKS + IMAGES, "http://localhost:4173/")).toBe(LINKS + IMAGES);
  });

  it("moves root-absolute screenshots under the sub-path", () => {
    expect(rebaseRootUrls(IMAGES, "https://host.test/rom-weaver/")).toBe(
      '<picture><source srcset="/rom-weaver/docs/screenshots/a.avif 1x, /rom-weaver/docs/screenshots/a@2x.avif 2x" type="image/avif">' +
        '<img src="/rom-weaver/docs/screenshots/a.webp" alt="/docs/x"></picture> <img src="//cdn.example/b.png"> ' +
        '<img src="https://example.com/c.png"> <img src="docs/screenshots/d.png">',
    );
  });

  it("moves root-absolute anchors under the sub-path and leaves every other href alone", () => {
    expect(rebaseRootUrls(LINKS, "https://host.test/rom-weaver/")).toBe(
      '<a href="/rom-weaver/docs/faq#files">faq</a> <a href="/rom-weaver/apply-rom-patches?mode=rom&amp;x=1">apply</a> ' +
        '<a href="//cdn.example/x">cdn</a> <a href="#top">top</a> <a href="https://example.com/a">out</a> ' +
        '<a class="x" href="docs/faq">bare</a> <code>/docs/faq</code>',
    );
  });
});
