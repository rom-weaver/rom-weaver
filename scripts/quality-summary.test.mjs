import assert from "node:assert/strict";
import test from "node:test";
import { renderSignals } from "./quality-summary.mjs";
test("summary keeps independent failures and non-execution explicit", () => {
  const summary = renderSignals(
    { fuzz: "failure", Miri: "not-run", architecture: "success", mutation: "cancelled" },
    {
      guardrails: {
        findings: [{ severity: "review", path: "oracle.bin", line: 0, kind: "oracle-change" }],
      },
    },
  );
  assert.match(summary, /fuzz \| failed/);
  assert.match(summary, /Miri \| not measured/);
  assert.match(summary, /mutation \| incomplete/);
  assert.match(summary, /1 require review/);
  assert.match(summary, /oracle.bin:0/);
  assert.throws(() => renderSignals({ fuzz: "caught" }), /Unknown outcome/);
});
