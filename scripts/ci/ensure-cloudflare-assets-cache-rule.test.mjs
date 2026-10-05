import assert from "node:assert/strict";
import test from "node:test";

import {
  CACHE_RULE_DESCRIPTION,
  CACHE_RULE_EXPRESSION,
  cacheRule,
  pageCacheRule,
  PAGE_CACHE_RULE_EXPRESSION,
  ensureCacheRule,
} from "./ensure-cloudflare-assets-cache-rule.mjs";

test("does not cache asset errors and replaces the old rule", async () => {
  const oldRule = {
    description: CACHE_RULE_DESCRIPTION,
    expression: CACHE_RULE_EXPRESSION,
    action: "set_cache_settings",
    action_parameters: { cache: true, edge_ttl: { mode: "respect_origin" } },
    enabled: true,
  };
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    return {
      status: 200,
      json: async () =>
        options.method === "PUT" ? { success: true } : { success: true, result: { rules: [oldRule] } },
    };
  };

  assert.equal(await ensureCacheRule({ zoneId: "zone", token: "token", fetchImpl }), "installed");
  assert.equal(requests[1].options.method, "PUT");
  assert.deepEqual(JSON.parse(requests[1].options.body).rules, [cacheRule(), pageCacheRule()]);
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
    return Response.json({ success: true, result: { rules: [cacheRule(), pageCacheRule()] } });
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
    return Response.json({ success: false, errors: [{ message: "internal server error" }] }, { status: 500 });
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

test("retries even when the failed response body has already errored", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) {
      const body = new ReadableStream({
        start(controller) {
          controller.error(new Error("upstream body terminated"));
        },
      });
      return new Response(body, { status: 503 });
    }
    return Response.json({ success: true, result: { rules: [cacheRule(), pageCacheRule()] } });
  };
  assert.equal(await ensureCacheRule({ zoneId: "zone", token: "token", fetchImpl, sleep: async () => {} }), "exists");
  assert.equal(calls, 2);
});

test("page rule caches only published negotiated pages with raw Accept variants", () => {
  assert.ok(PAGE_CACHE_RULE_EXPRESSION.includes('"/docs"'));
  assert.ok(PAGE_CACHE_RULE_EXPRESSION.includes('"/docs/faq"'));
  assert.ok(!PAGE_CACHE_RULE_EXPRESSION.includes("starts_with"));
  assert.ok(!PAGE_CACHE_RULE_EXPRESSION.includes("request.method"));
  assert.deepEqual(pageCacheRule().action_parameters.vary, {
    default: { action: "bypass" },
    headers: { accept: { action: "passthrough" }, "accept-encoding": { action: "normalize" } },
  });
  assert.equal(pageCacheRule().action_parameters.edge_ttl.mode, "respect_origin");
  assert.deepEqual(pageCacheRule().action_parameters.browser_ttl, { mode: "respect_origin" });
  assert.ok(PAGE_CACHE_RULE_EXPRESSION.length <= 4096);
});

test("preserves unrelated rules and skips absent zone configuration", async () => {
  assert.equal(await ensureCacheRule({ fetchImpl: () => assert.fail("unexpected fetch") }), "skipped");
  const unrelated = { description: "owner rule", action: "set_cache_settings" };
  await ensureCacheRule({
    zoneId: "zone",
    token: "token",
    fetchImpl: async (_url, options) => {
      if (options.method === "PUT") {
        assert.deepEqual(JSON.parse(options.body).rules, [unrelated, cacheRule(), pageCacheRule()]);
        return Response.json({ success: true });
      }
      return Response.json({ success: true, result: { rules: [unrelated, cacheRule()] } });
    },
  });
});
