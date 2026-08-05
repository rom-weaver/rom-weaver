import assert from "node:assert/strict";
import test from "node:test";
import { checkTouchStyles, collectTouchStyleFacts, findTouchStyleViolations } from "./check-touch-styles.mjs";

test("checkTouchStyles: a bare `:hover` outside @media (hover: hover) is a violation", () => {
  const { failures } = checkTouchStyles([{ file: "a.css", css: ".btn:hover { color: red; }" }], new Map());

  assert.equal(failures.length, 1);
  assert.match(failures[0], /`\.btn:hover` is not inside @media \(hover: hover\)/u);
});

test("checkTouchStyles: `:hover` grouped with `:focus-visible` outside the media query is a violation", () => {
  const { failures } = checkTouchStyles(
    [{ file: "a.css", css: ".btn:hover, .btn:focus-visible { color: red; }" }],
    new Map(),
  );

  assert.equal(failures.length, 2);
  assert.ok(failures.some((failure) => /`\.btn:hover` is not inside @media \(hover: hover\)/u.test(failure)));
  assert.ok(
    failures.some((failure) =>
      /groups :hover with :focus-visible\/:focus-within\/:active - keep those halves in separate selector lists/u.test(
        failure,
      ),
    ),
  );
});

test("checkTouchStyles: `:hover` grouped with `:focus-visible` INSIDE a correctly gated media query is still a violation", () => {
  // Regression case: gating the whole group does not make grouping legal - AGENTS.md requires the
  // hover and focus/active halves to live in separate selector lists regardless of gating.
  const { failures } = checkTouchStyles(
    [
      {
        css: "@media (hover: hover) { .btn:hover, .btn:focus-visible { color: red; } } .btn:active { color: darkred; }",
        file: "a.css",
      },
    ],
    new Map(),
  );

  assert.equal(failures.length, 1);
  assert.match(
    failures[0],
    /`\.btn:hover, \.btn:focus-visible` groups :hover with :focus-visible\/:focus-within\/:active/u,
  );
});

test("checkTouchStyles: `:hover` grouped with `:active` in one selector list is a violation even though :active is the required twin", () => {
  const { failures } = checkTouchStyles(
    [{ css: "@media (hover: hover) { .btn:hover, .btn:active { color: red; } }", file: "a.css" }],
    new Map(),
  );

  assert.equal(failures.length, 1);
  assert.match(failures[0], /groups :hover with :focus-visible\/:focus-within\/:active/u);
});

test("checkTouchStyles: a correctly gated `:hover` paired with its `:active` twin passes", () => {
  const { failures } = checkTouchStyles(
    [
      {
        file: "a.css",
        css: "@media (hover: hover) { .btn:hover { color: red; } } .btn:active { color: darkred; }",
      },
    ],
    new Map(),
  );

  assert.deepEqual(failures, []);
});

test("checkTouchStyles: a gated `:hover` with no `:active` twin anywhere is a violation", () => {
  const { failures } = checkTouchStyles(
    [{ file: "a.css", css: "@media (hover: hover) { .btn:hover { color: red; } }" }],
    new Map(),
  );

  assert.equal(failures.length, 1);
  assert.match(failures[0], /`\.btn:hover` has no `\.btn:active` twin/u);
});

test("checkTouchStyles: the `:active` twin may live in a different source file", () => {
  const { failures } = checkTouchStyles(
    [
      { file: "hover.css", css: "@media (hover: hover) { .btn:hover { color: red; } }" },
      { file: "active.css", css: ".btn:active { color: darkred; }" },
    ],
    new Map(),
  );

  assert.deepEqual(failures, []);
});

test("checkTouchStyles: an EXEMPT entry silences a missing-twin violation", () => {
  const { failures } = checkTouchStyles(
    [{ file: "a.css", css: "@media (hover: hover) { .btn:hover { color: red; } }" }],
    new Map([[".btn:hover", "documented in test"]]),
  );

  assert.deepEqual(failures, []);
});

test("checkTouchStyles: @supports and @container also count as gating scopes other than hover media", () => {
  const { failures } = checkTouchStyles(
    [{ file: "a.css", css: "@supports (display: grid) { .btn:hover { color: red; } }" }],
    new Map(),
  );

  // Not a hover-capability gate, so still flagged as ungated.
  assert.equal(failures.length, 1);
  assert.match(failures[0], /is not inside @media \(hover: hover\)/u);
});

test("collectTouchStyleFacts: reports gatedHover/ungated/active counts consistent with the CLI summary line", () => {
  const facts = collectTouchStyleFacts([
    {
      file: "a.css",
      css: "@media (hover: hover) { .btn:hover { color: red; } } .btn:active { color: darkred; } .x:hover {}",
    },
  ]);

  assert.equal(facts.gatedHover.length, 1);
  assert.equal(facts.ungated.length, 1);
  assert.equal(facts.active.size, 1);
});

test("findTouchStyleViolations: is a pure function over pre-collected facts", () => {
  const facts = collectTouchStyleFacts([{ file: "a.css", css: ".btn:hover { color: red; }" }]);

  const failures = findTouchStyleViolations(facts, new Map());

  assert.equal(failures.length, 1);
});
