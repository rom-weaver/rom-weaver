import { describe, expect, it } from "vitest";
import { minifyInlineScripts } from "../../scripts/minify-inline-scripts.mjs";

describe("inline script minification", () => {
  it("strips comments and dead whitespace from a classic inline script", () => {
    const html = minifyInlineScripts(`<script>
      // Explains the code to a reader of the repository, not to a browser.
      const theme = "dark";
      document.documentElement.dataset.theme = theme;
    </script>`);
    expect(html).not.toContain("Explains the code");
    expect(html).toContain("document.documentElement.dataset.theme=");
    expect(html).not.toContain("\n");
  });

  it("keeps top-level names another inline script calls", () => {
    const html = minifyInlineScripts(
      "<script>function resolveShellIdentity(){window.ok=true}</script><script>resolveShellIdentity()</script>",
    );
    expect(html).toContain("function resolveShellIdentity(");
    expect(html).toContain("resolveShellIdentity()");
  });

  it("leaves scripts it must not rewrite alone", () => {
    const jsonLd = '<script type="application/ld+json">{"@type": "TechArticle"}</script>';
    const external = '<script type="module" crossorigin src="./assets/index.js"></script>';
    expect(minifyInlineScripts(jsonLd)).toBe(jsonLd);
    expect(minifyInlineScripts(external)).toBe(external);
  });

  it("minifies inline module scripts", () => {
    const html = minifyInlineScripts('<script type="module">window.a = 1; // note\n</script>');
    expect(html).toBe('<script type="module">window.a=1;</script>');
  });

  it("reports the document when a script does not parse", () => {
    expect(() => minifyInlineScripts("<script>const = ;</script>", "docs/faq.html")).toThrow(/docs\/faq\.html/);
  });
});
