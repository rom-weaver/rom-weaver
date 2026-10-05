import assert from "node:assert/strict";
import test from "node:test";
import { guardrailSource } from "./quality-trusted-guardrails.mjs";
test("guardrail source comes from the merge base rather than the candidate", () => {
  const calls = [];
  const result = guardrailSource("main", (args) => {
    calls.push(args);
    if (args[0] === "merge-base") return "abc\n";
    if (args[0] === "ls-tree") return "scripts/quality-guardrails.mjs\n";
    return "trusted source";
  });
  assert.equal(result.source, "trusted source");
  assert.deepEqual(calls.at(-1), ["show", "abc:scripts/quality-guardrails.mjs"]);
});
test("only absent baseline checker allows explicit bootstrap", () => {
  assert.equal(
    guardrailSource("main", (args) => (args[0] === "merge-base" ? "abc" : "")).source,
    null,
  );
  assert.throws(
    () =>
      guardrailSource("main", () => {
        throw new Error("git failed");
      }),
    /git failed/,
  );
});
