import { describe, expect, it } from "vitest";
import { minifyDocumentHead } from "../../scripts/vite-config/minify-document-inline-scripts.mjs";
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

  it("minifies uppercase scripts", () => {
    expect(minifyInlineScripts("<SCRIPT>window.a = 1; // note\n</SCRIPT>")).toBe("<script>window.a=1;</script>");
  });

  it("preserves uppercase data and external scripts", () => {
    for (const html of [
      '<SCRIPT TYPE="application/ld+json">{"name": "test"}</SCRIPT>',
      '<SCRIPT SRC="app.js"> fallback </SCRIPT>',
    ]) {
      expect(minifyInlineScripts(html)).toBe(html);
    }
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

describe("document head minification", () => {
  it("preserves uppercase script and style contents", () => {
    const content = '<SCRIPT>window.text = "a>  <b";</SCRIPT><STYLE>p::before { content: "a>  <b"; }</STYLE>';
    expect(minifyDocumentHead(`<head>  ${content}  </head>`)).toBe(`<head>${content}</head>`);
  });

  it("keeps script, style, and body whitespace while removing head spacing", () => {
    const script = '<script>window.text = "a>  <b"; // Keep the newline.\nwindow.ok = true;</script>';
    const style = '<style>body::before { content: "a>  <b"; }</style>';
    const body = "<body><span>a</span> <span>b</span><pre>  text\n</pre></body>";
    const html = `<head><meta charset="UTF-8">\n  ${script}\n  ${style}\n  <title>Title</title></head>${body}`;
    expect(minifyDocumentHead(html)).toBe(
      `<head><meta charset="UTF-8">${script}${style}<title>Title</title></head>${body}`,
    );
  });
});
