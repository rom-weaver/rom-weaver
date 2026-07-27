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
