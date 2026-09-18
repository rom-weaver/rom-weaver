import fs from "node:fs";
import path from "node:path";
import { ACCENTS } from "../src/webapp/accent-palette.mjs";
import { BRAND_MARK_THEMES, BRAND_MARK_TIGHT_VIEWBOX, renderBrandMark } from "../src/webapp/brand-mark-assets.mjs";

const masterRoot = path.resolve(import.meta.dirname, "../design/icon-masters");
const masterPath = path.join(masterRoot, "brand-mark.svg");
const renderRoot = path.join(masterRoot, "renders");

const expectedRenders = () => {
  const master = fs.readFileSync(masterPath, "utf8");
  const renders = new Map();
  for (const accent of ACCENTS) {
    renders.set(
      path.join(renderRoot, `${accent.value}.svg`),
      renderBrandMark(master, { accent, viewBox: BRAND_MARK_TIGHT_VIEWBOX }),
    );
    for (const theme of BRAND_MARK_THEMES) {
      renders.set(
        path.join(renderRoot, theme, `${accent.value}.svg`),
        renderBrandMark(master, { accent, theme, viewBox: BRAND_MARK_TIGHT_VIEWBOX }),
      );
    }
  }
  return renders;
};

const checkOnly = process.argv.includes("--check");
const mismatches = [];
for (const [target, expected] of expectedRenders()) {
  const existing = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
  if (existing === expected) continue;
  mismatches.push(path.relative(process.cwd(), target));
  if (!checkOnly) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, expected);
  }
}

if (checkOnly && mismatches.length) {
  throw new Error(
    `Brand mark renders are out of date:\n${mismatches.map((target) => `- ${target}`).join("\n")}\nRun npm run brand:render`,
  );
}
if (mismatches.length) console.log(`${checkOnly ? "" : "Updated "}${mismatches.length} brand mark render(s).`);
else console.log("Brand mark renders are up to date.");
