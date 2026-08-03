import assert from "node:assert/strict";
import test from "node:test";
import { buildLayerRules, checkCssLayers, findLayerViolations } from "./check-css-layers.mjs";

test("checkCssLayers: flags a higher-specificity earlier-layer rule that loses across the boundary", () => {
  const layeredSources = [
    { layer: "base", layerIndex: 0, file: "base.css", css: ".btn.is-disabled { color: red; }" },
    { layer: "override", layerIndex: 1, file: "override.css", css: ".btn { color: blue; }" },
  ];

  const { failures } = checkCssLayers(layeredSources, new Map());

  assert.equal(failures.length, 1);
  assert.match(failures[0], /base\.css \(layer base\) loses to override\.css \(layer override\)/u);
  assert.match(failures[0], /property\/-ies:\s+color/u);
});

test("checkCssLayers: a rule inside the correct (later, equal-or-lower-specificity) layer passes", () => {
  const layeredSources = [
    { layer: "base", layerIndex: 0, file: "base.css", css: ".btn { color: red; }" },
    { layer: "override", layerIndex: 1, file: "override.css", css: ".btn.is-disabled { color: blue; }" },
  ];

  const { failures } = checkCssLayers(layeredSources, new Map());

  assert.deepEqual(failures, []);
});

test("checkCssLayers: no violation when the two rules share no property", () => {
  const layeredSources = [
    { layer: "base", layerIndex: 0, file: "base.css", css: ".btn.is-disabled { color: red; }" },
    { layer: "override", layerIndex: 1, file: "override.css", css: ".btn { background: blue; }" },
  ];

  const { failures } = checkCssLayers(layeredSources, new Map());

  assert.deepEqual(failures, []);
});

test("checkCssLayers: same-layer rules are never flagged regardless of specificity", () => {
  const layeredSources = [
    { layer: "base", layerIndex: 0, file: "a.css", css: ".btn.is-disabled { color: red; }" },
    { layer: "base", layerIndex: 0, file: "b.css", css: ".btn { color: blue; }" },
  ];

  const { failures } = checkCssLayers(layeredSources, new Map());

  assert.deepEqual(failures, []);
});

test("checkCssLayers: a documented EXEMPT entry silences a genuine crossing", () => {
  const layeredSources = [
    { layer: "base", layerIndex: 0, file: "base.css", css: ".btn.is-disabled { color: red; }" },
    { layer: "override", layerIndex: 1, file: "override.css", css: ".btn { color: blue; }" },
  ];
  const exempt = new Map([[".btn.is-disabled >>> .btn", "intentional override, documented in test"]]);

  const { failures } = checkCssLayers(layeredSources, exempt);

  assert.deepEqual(failures, []);
});

test("checkCssLayers: an EXEMPT entry that matches nothing is reported as stale", () => {
  const layeredSources = [{ layer: "base", layerIndex: 0, file: "base.css", css: ".btn { color: red; }" }];
  const exempt = new Map([[".never .matches >>> .anything", "no longer applies"]]);

  const { failures } = checkCssLayers(layeredSources, exempt);

  assert.equal(failures.length, 1);
  assert.match(failures[0], /stale EXEMPT entry `\.never \.matches >>> \.anything` matches no rule pair/u);
});

test("checkCssLayers: reports ruleCount alongside failures", () => {
  const layeredSources = [
    { layer: "base", layerIndex: 0, file: "base.css", css: ".a { color: red; } .b { color: blue; }" },
  ];

  const { failures, ruleCount } = checkCssLayers(layeredSources, new Map());

  assert.deepEqual(failures, []);
  assert.equal(ruleCount, 2);
});

test("buildLayerRules: skips @keyframes bodies and rules with no declared properties", () => {
  const rules = buildLayerRules([
    {
      layer: "base",
      layerIndex: 0,
      file: "anim.css",
      css: "@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } } .empty {}",
    },
  ]);

  assert.deepEqual(rules, []);
});

test("buildLayerRules: strips comments before parsing selectors", () => {
  const rules = buildLayerRules([
    { layer: "base", layerIndex: 0, file: "commented.css", css: "/* note */ .btn { color: red; /* inline */ }" },
  ]);

  assert.equal(rules.length, 1);
  assert.equal(rules[0].selector, ".btn");
});

test("findLayerViolations: is a pure function over a pre-built rule list", () => {
  const rules = buildLayerRules([
    { layer: "base", layerIndex: 0, file: "base.css", css: ".btn.is-disabled { color: red; }" },
    { layer: "override", layerIndex: 1, file: "override.css", css: ".btn { color: blue; }" },
  ]);

  const { failures, usedExemptions } = findLayerViolations(rules, new Map());

  assert.equal(failures.length, 1);
  assert.equal(usedExemptions.size, 0);
});
