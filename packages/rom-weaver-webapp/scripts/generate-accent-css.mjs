import fs from "node:fs";
import path from "node:path";
import { ACCENTS } from "../src/webapp/accent-palette.mjs";

const outputPath = path.resolve(import.meta.dirname, "../src/webapp/design-system/accent-values.css");

const renderAccentCss = () => {
  const blocks = ACCENTS.filter((accent) => accent.value !== "madder").map(
    ({
      highlight,
      label,
      swatch,
      threadInk,
      threadTextDark,
      threadTextLight,
      value,
    }) => `/* ── ${label} (${value}) ── */
:root[data-accent="${value}"] {
  --thread: ${swatch};
  --thread-ink: ${threadInk};
  --thread-hi: ${highlight};
}
:root[data-accent="${value}"][data-theme="dark"] {
  --thread-text: ${threadTextDark};
}
:root[data-accent="${value}"][data-theme="light"] {
  --thread-text: ${threadTextLight};
}
`,
  );
  return `/* Generated from src/webapp/accent-palette.mjs. Do not edit by hand. */
${blocks.join("\n")}`;
};

const checkOnly = process.argv.includes("--check");
const expected = renderAccentCss();
const existing = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : "";

if (checkOnly) {
  if (existing !== expected) {
    throw new Error("Generated accent CSS is out of date; run npm run accents:generate");
  }
  console.log("Accent CSS is up to date.");
} else if (existing !== expected) {
  fs.writeFileSync(outputPath, expected);
  console.log(`Wrote ${path.relative(process.cwd(), outputPath)}`);
}
