import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RuntimeGlyph } from "../../src/webapp/components/runtime-status.tsx";

// The parser-time resolver in index.html draws the status glyph before React
// loads; any drift from RuntimeGlyph makes hydration discard the prerendered page.
const resolver = readFileSync(fileURLToPath(new URL("../../index.html", import.meta.url)), "utf8");

describe("parser-time runtime glyphs", () => {
  it.each(["active", "ready", "update", "online", "disabled", "installing"] as const)(
    "draws the %s glyph exactly as RuntimeGlyph renders it",
    (state) => {
      const glyph = renderToStaticMarkup(<RuntimeGlyph state={state} />);
      const paths = resolver.match(new RegExp(`\\b${state}:\\s*'([^']+)'`))?.[1];
      const iconClass = resolver.match(new RegExp(`\\b${state}: "(lucide-[a-z0-9-]+)"`))?.[1];
      expect(paths).toBeTruthy();
      expect(glyph.match(/<svg[^>]*>(.*)<\/svg>/)?.[1]).toBe(paths);
      expect(glyph).toContain(`lucide ${iconClass}`);
    },
  );
});
