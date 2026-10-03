import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RuntimeGlyph } from "../../src/webapp/components/runtime-status.tsx";

// The parser-time resolver in index.html draws the status glyph before React
// loads; any drift from RuntimeGlyph makes hydration discard the prerendered page.
const resolver = readFileSync(fileURLToPath(new URL("../../index.html", import.meta.url)), "utf8");
// The table builds its glyphs from shared parts, so run its source rather than match one literal per state.
const glyphSource = resolver.match(/const monitor\s*=[\s\S]*?const glyphs = \{[\s\S]*?\n\s*\};/)?.[0] ?? "";
const glyphs = runInNewContext(`${glyphSource} glyphs;`) as Record<string, string>;

describe("parser-time runtime glyphs", () => {
  it.each(["active", "ready", "update", "online", "disabled", "installing"] as const)(
    "draws the %s glyph exactly as RuntimeGlyph renders it",
    (state) => {
      const glyph = renderToStaticMarkup(<RuntimeGlyph state={state} />);
      const paths = glyphs[state];
      const iconClass = resolver.match(new RegExp(`\\b${state}: "(lucide-[a-z0-9-]+)"`))?.[1];
      expect(paths).toBeTruthy();
      expect(glyph.match(/<svg[^>]*>(.*)<\/svg>/)?.[1]).toBe(paths);
      expect(glyph).toContain(`lucide ${iconClass}`);
    },
  );
});
