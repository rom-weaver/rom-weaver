#!/usr/bin/env node
// Touch-device style audit.
//
// 1. Every `:hover` rule must sit inside `@media (hover: hover)`. Touch browsers
//    latch :hover onto the last-tapped element until another tap lands
//    elsewhere, so an ungated hover rule leaves tapped controls stuck in the
//    hover look.
// 2. Every gated hover selector needs an `:active` twin, because gating the
//    hover removes the only press feedback a touch user would otherwise get.
//    Selectors that legitimately have no twin go in EXEMPT with a reason.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

// Selector -> why it needs no `:active` twin of its own.
const EXEMPT = new Map([
  [".rw-app .btn.primary:hover", "variant of .btn; .btn:active supplies the press transform"],
  [".rw-app .btn.danger:hover", "variant of .btn; .btn:active supplies the press transform"],
  [".rw-app .btn.bundle-dl:hover", "variant of .btn; .btn:active supplies the press transform"],
  [".rw-app .handle:hover:not(:disabled)", "paired with .handle:active:not(:disabled)"],
  [".rw-app .pick-row.off:hover", "variant of .pick-row; .pick-row:active covers the press"],
  [
    ".rw-app .drawer-action .expected-mismatch-info .info-btn:hover",
    "variant of .drawer-action .info-btn; its :active scale covers the press",
  ],
  [".rw-app .drawer-action .info-btn:hover::before", "decorative underline on the same button"],
  [".rw-app .cks > .cks-head:hover .chev", "chevron affordance; the head's own :active tints the row"],
  [".rw-app .ck:hover .copy", "reveals a button that has its own :active scale"],
  [".rw-app .swap-btn:hover svg", "carries .btn; .btn:active supplies the press transform"],
  [".rw-app .masthead-tools .masthead-donate:hover", "carries .tool; .tool:active supplies the press tint"],
  [
    ".rw-app .patch-checks-body .verification-row .popt-input:hover",
    "text input - :focus, not :active, is the meaningful press state",
  ],
  ["input[type=checkbox].styled:hover:not(:disabled)", "toggle - the :checked flip is the feedback"],
  ["input[type=checkbox].styled:hover:checked:not(:disabled)", "toggle - the :checked flip is the feedback"],
  ['.rw-app input[type="checkbox"]:hover', "toggle - the :checked flip is the feedback"],
  [
    ".rw-app .tool:hover .tip",
    "pointer-only tooltip; touch gets the label from the button's own aria-label, and a press twin would flash a tip under the finger",
  ],
]);

const cssFiles = (dir) =>
  readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return cssFiles(full);
    return full.endsWith(".css") ? [full] : [];
  });

// Preludes carry any comment that precedes the rule; drop it before matching.
const normalize = (selector) =>
  selector
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .trim()
    .replace(/\s+/g, " ");

// Walk top-level blocks, tracking whether we are inside `@media (hover: hover)`.
const collect = (src, file, out, gated = false, lineOffset = 0) => {
  let index = 0;
  let preludeStart = 0;
  let blockStart = -1;
  let depth = 0;
  while (index < src.length) {
    const char = src[index];
    if (char === "/" && src[index + 1] === "*") {
      const end = src.indexOf("*/", index + 2);
      index = end === -1 ? src.length : end + 2;
      continue;
    }
    if (char === '"' || char === "'") {
      let cursor = index + 1;
      while (cursor < src.length && src[cursor] !== char) cursor += src[cursor] === "\\" ? 2 : 1;
      index = cursor + 1;
      continue;
    }
    if (char === "{") {
      if (depth === 0) blockStart = index;
      depth += 1;
      index += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        const prelude = src.slice(preludeStart, blockStart);
        const body = src.slice(blockStart + 1, index);
        // Report the first selector line, not the `{`, so multi-line lists point at themselves.
        const leading = prelude.match(/^(?:\s|\/\*[\s\S]*?\*\/)*/)[0];
        const line = lineOffset + src.slice(0, preludeStart + leading.length).split("\n").length;
        const trimmed = normalize(prelude);
        if (trimmed.startsWith("@")) {
          const isHoverQuery = /^@media\s*\(\s*hover\s*:\s*hover\s*\)/.test(trimmed);
          if (/^@(media|supports|container|layer)\b/.test(trimmed)) {
            collect(body, file, out, gated || isHoverQuery, line - 1);
          }
        } else {
          const selectorGroup = trimmed.split(",").map(normalize);
          const hasHover = selectorGroup.some((selector) => selector.includes(":hover"));
          const hasGroupedNonHoverState = selectorGroup.some(
            (selector) =>
              !selector.includes(":hover") &&
              (selector.includes(":focus-visible") ||
                selector.includes(":focus-within") ||
                selector.includes(":active")),
          );
          if (selectorGroup.length > 1 && hasHover && hasGroupedNonHoverState) {
            out.groupedWithHover.push({ file, line, selectorGroup: trimmed });
          }
          for (const selector of selectorGroup) {
            if (selector.includes(":hover")) {
              if (gated) out.gatedHover.push({ file, line, selector });
              else out.ungated.push({ file, line, selector });
            }
            if (selector.includes(":active")) out.active.add(selector);
          }
        }
        preludeStart = index + 1;
      }
      index += 1;
      continue;
    }
    index += 1;
  }
};

/**
 * Walk `{ file, css }` sources and collect every `:hover` selector (split by
 * gated vs. ungated) plus every `:active` selector seen anywhere. Pure - no
 * filesystem access - so tests can hand it inline CSS instead of real files.
 */
export const collectTouchStyleFacts = (cssSources) => {
  const out = { active: new Set(), gatedHover: [], groupedWithHover: [], ungated: [] };
  for (const { file, css } of cssSources) collect(css, file, out);
  return out;
};

/** Ungated `:hover` rules, `:hover` grouped with `:focus-visible`/`:focus-within`/`:active` in one
 * selector list, and gated `:hover` rules missing their `:active` twin. */
export const findTouchStyleViolations = (facts, exempt) => {
  const failures = [];
  for (const { file, line, selector } of facts.ungated) {
    failures.push(`${file}:${line}: \`${selector}\` is not inside @media (hover: hover)`);
  }
  for (const { file, line, selectorGroup } of facts.groupedWithHover) {
    failures.push(
      `${file}:${line}: \`${selectorGroup}\` groups :hover with :focus-visible/:focus-within/:active - keep those halves in separate selector lists`,
    );
  }
  for (const { file, line, selector } of facts.gatedHover) {
    if (exempt.has(selector)) continue;
    const twin = selector.replaceAll(":hover", ":active");
    if (facts.active.has(twin)) continue;
    failures.push(
      `${file}:${line}: \`${selector}\` has no \`${twin}\` twin (add one, or an EXEMPT entry with a reason)`,
    );
  }
  return failures;
};

/** Full touch-style audit over `{ file, css }` sources - the pure entry point tests exercise. */
export const checkTouchStyles = (cssSources, exempt = EXEMPT) => {
  const facts = collectTouchStyleFacts(cssSources);
  return { facts, failures: findTouchStyleViolations(facts, exempt) };
};

export const main = () => {
  const cssSources = cssFiles(SRC_DIR).map((file) => ({
    file: path.relative(SRC_DIR, file),
    css: readFileSync(file, "utf8"),
  }));
  const { facts, failures } = checkTouchStyles(cssSources, EXEMPT);

  if (failures.length) {
    console.error("Touch style audit failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log(
    `Touch style audit passed: ${facts.gatedHover.length} gated hover rule(s), ${facts.active.size} :active selector(s), ${EXEMPT.size} documented exemption(s).`,
  );
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
