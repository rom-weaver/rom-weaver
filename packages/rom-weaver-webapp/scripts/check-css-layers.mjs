#!/usr/bin/env node
// Cascade-layer audit.
//
// Layer order beats specificity outright: across a layer boundary a bare `.card`
// in a later layer wins over a `.card.is-disabled .rb` in an earlier one, with no
// warning from anything. Every rule in design-system/ was written expecting the
// opposite - specificity first, import order only to break ties - so any pair that
// crosses a boundary the wrong way is a silent behaviour change.
//
// This finds them: rule pairs where an earlier layer holds the HIGHER-specificity
// rule, the selectors can match the same element, and both set the same property.
// Genuine cases (the override is meant to lose) go in EXEMPT with a reason.
//
// The fix is almost never a specificity bump - it cannot work across layers. Move
// the override into the file that owns the component it modifies, so the pair
// shares a layer and specificity decides again.
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "webapp", "design-system");
const MANIFESTS = ["index.css", "deferred.css", "docs-route.css"];

// The 16px floor in webapp-modals.css (inside @supports -webkit-touch-callout) exists
// precisely to beat the smaller per-field sizes: iOS zooms the page in when a focused
// field's text is under 16px. Losing to it is the intent, which is why the file also
// re-asserts it by hand for the fields whose specificity used to defeat it.
const IOS_FONT_FLOOR =
  "iOS 16px font-size floor - it is meant to beat the smaller per-field size, or iOS zooms on focus";

// `<earlier selector> >>> <later selector>` -> why the later rule is meant to win.
//
// These are the fields the floor is still meant to reach. The self-sizing dropdown
// families (`.meta-target-select`, `.ck-add-select`) need no entry: the floor's bare
// `select` selector skips them by class, and its `.select` selector never matched them.
const EXEMPT = new Map([
  [".rw-app .ofld .input >>> .rw-app .input", IOS_FONT_FLOOR],
  [".rw-app .ofld .select >>> .rw-app .select", IOS_FONT_FLOOR],
  [".rw-app .setrow .input >>> .rw-app .input", IOS_FONT_FLOOR],
  [".rw-app .setrow .select >>> .rw-app .select", IOS_FONT_FLOOR],
  [".rw-app .log-filter-bar .loglevel .select >>> .rw-app .select", IOS_FONT_FLOOR],
]);

const scrub = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** Layer order as declared, then which files fill each layer, in import order. */
const readManifests = () => {
  const index = readFileSync(path.join(DS_DIR, "index.css"), "utf8");
  const declared = index.match(/@layer\s+([^;{]+);/);
  if (!declared) throw new Error("design-system/index.css declares no @layer order");
  const order = declared[1]
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);

  const files = new Map();
  for (const manifest of MANIFESTS) {
    let text;
    try {
      text = readFileSync(path.join(DS_DIR, manifest), "utf8");
    } catch {
      continue;
    }
    for (const [, file, layer] of text.matchAll(/@import\s+"([^"]+)"\s+layer\(([^)]+)\)/g)) {
      const name = layer.trim();
      if (!order.includes(name)) {
        throw new Error(`${manifest} imports into layer "${name}", which index.css never declares`);
      }
      if (!files.has(name)) files.set(name, []);
      files.get(name).push(file.trim());
    }
  }
  return { order, files };
};

/** Flatten a stylesheet to rules, carrying the enclosing at-rules. */
const parseRules = (css) => {
  const rules = [];
  const stack = [];
  let buf = "";
  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i];
    if (ch === "{") {
      const prelude = buf.trim();
      buf = "";
      if (prelude.startsWith("@")) {
        stack.push(prelude);
        continue;
      }
      let depth = 1;
      let body = "";
      i += 1;
      for (; i < css.length && depth > 0; i += 1) {
        if (css[i] === "{") depth += 1;
        else if (css[i] === "}") {
          depth -= 1;
          if (depth === 0) break;
        }
        body += css[i];
      }
      rules.push({ atRules: [...stack], prelude, body });
      continue;
    }
    if (ch === "}") {
      stack.pop();
      buf = "";
      continue;
    }
    buf += ch;
  }
  return rules;
};

const declaredProperties = (body) =>
  new Set(
    body
      .split(";")
      .map((decl) => decl.split(":")[0]?.trim().toLowerCase())
      .filter((name) => name && !name.startsWith("--") && !name.includes("{")),
  );

/** (id, class, type) specificity for one complex selector. */
const specificity = (selector) => {
  let rest = selector.replace(/::[\w-]+/g, " ");
  const ids = (rest.match(/#[\w-]+/g) || []).length;
  const classes = (rest.match(/\.[\w-]+/g) || []).length;
  const attributes = (rest.match(/\[[^\]]+\]/g) || []).length;
  const pseudoClasses = (rest.match(/:(?!:)[\w-]+/g) || []).length;
  rest = rest
    .replace(/[#.][\w-]+/g, " ")
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/:[\w-]+(\([^)]*\))?/g, " ");
  const types = (rest.match(/\b[a-z][\w-]*\b/gi) || []).length;
  return [ids, classes + attributes + pseudoClasses, types];
};

const outranks = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/**
 * Classes the selector requires of its own subject. Those inside :not() are
 * negations; those inside :has() describe a descendant, not the matched element.
 */
const subjectClasses = (selector) => {
  const positive = selector.replace(/:not\([^)]*\)/g, " ").replace(/:has\([^)]*\)/g, " ");
  return new Set((positive.match(/\.[\w-]+/g) || []).map((cls) => cls.slice(1)));
};
const negatedClasses = (selector) =>
  new Set(
    [...selector.matchAll(/:not\(([^)]*)\)/g)].flatMap((match) =>
      (match[1].match(/\.[\w-]+/g) || []).map((cls) => cls.slice(1)),
    ),
  );
const keyCompound = (selector) =>
  selector
    .trim()
    .split(/\s|>|\+|~/)
    .filter(Boolean)
    .pop() || "";
const pseudoElement = (selector) => (selector.match(/::[\w-]+/g) || []).join("");

/** Can the weaker, more general selector match everything the stronger one does? */
const generalizes = (strong, weak) => {
  if (pseudoElement(strong) !== pseudoElement(weak)) return false;
  const weakKey = subjectClasses(keyCompound(weak));
  const strongKey = subjectClasses(keyCompound(strong));
  if (weakKey.size === 0) return false;
  for (const cls of weakKey) if (!strongKey.has(cls)) return false;
  const strongAll = subjectClasses(strong);
  for (const cls of subjectClasses(weak)) if (!strongAll.has(cls)) return false;
  const strongNegated = negatedClasses(strong);
  for (const cls of subjectClasses(weak)) if (strongNegated.has(cls)) return false;
  const weakNegated = negatedClasses(weak);
  for (const cls of subjectClasses(strong)) if (weakNegated.has(cls)) return false;
  return true;
};

const { order, files } = readManifests();

const rules = [];
for (const [layerIndex, layer] of order.entries()) {
  for (const file of files.get(layer) || []) {
    const relative = file.replace(/^\.\//, "");
    let css;
    try {
      css = scrub(readFileSync(path.join(DS_DIR, relative), "utf8"));
    } catch {
      continue;
    }
    for (const rule of parseRules(css)) {
      if (rule.atRules.some((at) => at.startsWith("@keyframes"))) continue;
      const properties = declaredProperties(rule.body);
      if (properties.size === 0) continue;
      const media = rule.atRules.filter((at) => at.startsWith("@media")).join(" and ") || "(all)";
      for (const part of rule.prelude.split(",")) {
        const selector = part.trim();
        if (selector) {
          rules.push({ layer, layerIndex, file: relative, selector, spec: specificity(selector), properties, media });
        }
      }
    }
  }
}

const failures = [];
const usedExemptions = new Set();
const seen = new Set();
for (const strong of rules) {
  for (const weak of rules) {
    // Same layer: ordinary CSS applies, so specificity already protects the override.
    if (weak.layerIndex <= strong.layerIndex) continue;
    if (outranks(strong.spec, weak.spec) <= 0) continue;
    if (!generalizes(strong.selector, weak.selector)) continue;
    const shared = [...strong.properties].filter((property) => weak.properties.has(property));
    if (shared.length === 0) continue;

    const key = `${strong.selector} >>> ${weak.selector}`;
    if (EXEMPT.has(key)) {
      usedExemptions.add(key);
      continue;
    }
    if (seen.has(`${key}::${shared.join(",")}`)) continue;
    seen.add(`${key}::${shared.join(",")}`);
    failures.push(
      `${strong.file} (layer ${strong.layer}) loses to ${weak.file} (layer ${weak.layer})\n` +
        `    outranks but loses: \`${strong.selector}\` [${strong.spec.join(",")}] ${strong.media}\n` +
        `    now wins on order:  \`${weak.selector}\` [${weak.spec.join(",")}] ${weak.media}\n` +
        `    property/-ies:      ${shared.join(", ")}`,
    );
  }
}

for (const key of EXEMPT.keys()) {
  if (!usedExemptions.has(key)) {
    failures.push(`stale EXEMPT entry \`${key}\` matches no rule pair - delete it`);
  }
}

if (failures.length) {
  console.error("Cascade layer audit failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  console.error(
    "\nA later layer beats an earlier one no matter how specific the earlier rule is.\n" +
      "Move the override into the file that owns the component it modifies so the pair\n" +
      "shares a layer, or add an EXEMPT entry in scripts/check-css-layers.mjs with a reason.",
  );
  process.exit(1);
}

console.log(
  `Cascade layer audit passed: ${order.length} layer(s), ${rules.length} rule(s), ` +
    `${EXEMPT.size} documented exemption(s).`,
);
