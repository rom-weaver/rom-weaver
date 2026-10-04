import assert from "node:assert/strict";
import test from "node:test";

import { CACHE_RULE_DESCRIPTION, CACHE_RULE_EXPRESSION, cacheRule, ensureCacheRule } from "./ensure-cloudflare-assets-cache-rule.mjs";

test("does not cache asset errors and replaces the old rule", async () => {
  const oldRule = { description: CACHE_RULE_DESCRIPTION, expression: CACHE_RULE_EXPRESSION, action: "set_cache_settings", action_parameters: { cache: true, edge_ttl: { mode: "respect_origin" } }, enabled: true };
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    return { status: 200, json: async () => options.method === "PUT" ? ({ success: true }) : ({ success: true, result: { rules: [oldRule] } }) };
  };

  assert.equal(await ensureCacheRule({ zoneId: "zone", token: "token", fetchImpl }), "installed");
  assert.equal(requests[1].options.method, "PUT");
  assert.deepEqual(JSON.parse(requests[1].options.body).rules, [cacheRule()]);
  assert.deepEqual(cacheRule().action_parameters.edge_ttl.status_code_ttl, [
    { status_code_range: { from: 300, to: 599 }, value: -1 },
  ]);
});

test("retries a transient HTML server error before reading the rules", async () => {
  const waits = [];
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return new Response("upstream unavailable", { status: 500 });
    return Response.json({ success: true, result: { rules: [cacheRule()] } });
  };
  assert.equal(
    await ensureCacheRule({
      zoneId: "zone",
      token: "token",
      fetchImpl,
      sleep: async (ms) => waits.push(ms),
    }),
    "exists",
  );
  assert.equal(calls, 2);
  assert.deepEqual(waits, [1000]);
});

test("limits retries and retains the final server error", async () => {
  const waits = [];
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return Response.json(
      { success: false, errors: [{ message: "internal server error" }] },
      { status: 500 },
    );
  };
  await assert.rejects(
    ensureCacheRule({
      zoneId: "zone",
      token: "token",
      fetchImpl,
      sleep: async (ms) => waits.push(ms),
    }),
    /HTTP 500[\s\S]*internal server error/,
  );
  assert.equal(calls, 3);
  assert.deepEqual(waits, [1000, 2000]);
});

test("does not retry permanent read failures", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return Response.json({ success: false }, { status: 403 });
  };
  await assert.rejects(
    ensureCacheRule({
      zoneId: "zone",
      token: "token",
      fetchImpl,
      sleep: async () => assert.fail("unexpected retry"),
    }),
    /HTTP 403/,
  );
  assert.equal(calls, 1);
});

test("does not repeat writes after an ambiguous server error", async () => {
  const methods = [];
  const fetchImpl = async (_url, options = {}) => {
    methods.push(options.method || "GET");
    if (options.method === "PUT") return Response.json({ success: false }, { status: 500 });
    return Response.json({ success: true, result: { rules: [] } });
  };
  await assert.rejects(
    ensureCacheRule({
      zoneId: "zone",
      token: "token",
      fetchImpl,
      sleep: async () => assert.fail("unexpected retry"),
    }),
    /installing zone cache rule/,
  );
  assert.deepEqual(methods, ["GET", "PUT"]);
});
