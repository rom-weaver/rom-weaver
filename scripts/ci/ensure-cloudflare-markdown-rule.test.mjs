import assert from "node:assert/strict";
import test from "node:test";

import {
  MARKDOWN_RULE_DESCRIPTION,
  markdownRule,
  ensureMarkdownRule,
} from "./ensure-cloudflare-markdown-rule.mjs";

test("installs a documentation-only Markdown rule and preserves other rules", async () => {
  const otherRule = { description: "keep me", action: "set_config" };
  const oldRule = { ...markdownRule(), expression: 'http.host eq "rom-weaver.com"' };
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    return {
      status: 200,
      json: async () =>
        options.method === "PUT"
          ? { success: true }
          : { success: true, result: { rules: [otherRule, oldRule] } },
    };
  };

  assert.equal(await ensureMarkdownRule({ zoneId: "zone", token: "token", fetchImpl }), "installed");
  assert.match(requests[0].url, /http_config_settings\/entrypoint$/);
  assert.equal(requests[1].options.method, "PUT");
  assert.deepEqual(JSON.parse(requests[1].options.body).rules, [otherRule, markdownRule()]);
  assert.equal(
    JSON.parse(requests[1].options.body).rules.filter(
      (rule) => rule.description === MARKDOWN_RULE_DESCRIPTION,
    ).length,
    1,
  );
  assert.match(markdownRule().expression, /uri\.path eq "\/docs"/);
  assert.match(markdownRule().expression, /starts_with\(http\.request\.uri\.path, "\/docs\/"\)/);
  assert.doesNotMatch(markdownRule().expression, /"\/apply-patches"/);
});

test("does not replace an identical Markdown rule", async () => {
  let requests = 0;
  const fetchImpl = async () => {
    requests += 1;
    return { status: 200, json: async () => ({ success: true, result: { rules: [markdownRule()] } }) };
  };

  assert.equal(await ensureMarkdownRule({ zoneId: "zone", token: "token", fetchImpl }), "exists");
  assert.equal(requests, 1);
});

test("creates the configuration ruleset when it does not exist", async () => {
  const requests = [];
  const fetchImpl = async (_url, options = {}) => {
    requests.push(options);
    return options.method === "PUT"
      ? { status: 200, json: async () => ({ success: true }) }
      : { status: 404, json: async () => ({ success: false }) };
  };

  assert.equal(await ensureMarkdownRule({ zoneId: "zone", token: "token", fetchImpl }), "installed");
  assert.deepEqual(JSON.parse(requests[1].body).rules, [markdownRule()]);
});

test("skips without a zone ID", async () => {
  assert.equal(
    await ensureMarkdownRule({
      zoneId: "",
      token: "token",
      fetchImpl: async () => assert.fail("fetch must not run"),
    }),
    "skipped",
  );
});
