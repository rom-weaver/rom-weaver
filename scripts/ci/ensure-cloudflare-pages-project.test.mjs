import assert from "node:assert/strict";
import test from "node:test";

import { ensurePagesProject } from "./ensure-cloudflare-pages-project.mjs";

const project = "rom-weaver-preview";
const accountId = "account-id";
const token = "token";

const response = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const duplicateResponse = () => response({ success: false, errors: [{ code: 8000002, message: "Project already exists" }] }, 400);

const makeFetch = (responses) => {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, init });
      const next = responses.shift();
      assert.ok(next, `unexpected request: ${url}`);
      return next;
    },
  };
};

test("keeps an existing Pages project unchanged without the obsolete Brotli flag", async () => {
  const { calls, fetchImpl } = makeFetch([
    duplicateResponse(),
    response({
      success: true,
      result: {
        deployment_configs: {
          preview: { compatibility_flags: ["nodejs_compat"] },
          production: { compatibility_flags: [] },
        },
      },
    }),
  ]);

  assert.equal(await ensurePagesProject({ accountId, token, project, fetchImpl }), "exists");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[1].init.method, undefined);
});

test("removes the obsolete Brotli flag without dropping existing flags", async () => {
  const { calls, fetchImpl } = makeFetch([
    duplicateResponse(),
    response({
      success: true,
      result: {
        deployment_configs: {
          preview: { compatibility_flags: ["nodejs_compat", "brotli_content_encoding"] },
          production: { compatibility_flags: ["brotli_content_encoding"] },
        },
      },
    }),
    response({ success: true, result: {} }),
  ]);

  assert.equal(await ensurePagesProject({ accountId, token, project, fetchImpl }), "updated");
  assert.equal(calls.length, 3);
  assert.deepEqual(JSON.parse(calls[2].init.body), {
    deployment_configs: {
      preview: { compatibility_flags: ["nodejs_compat"] },
      production: { compatibility_flags: [] },
    },
  });
});

test("creates a Pages project without adding the obsolete Brotli flag", async () => {
  const { calls, fetchImpl } = makeFetch([
    response({ success: true, result: {} }),
    response({ success: true, result: { deployment_configs: {} } }),
  ]);

  assert.equal(await ensurePagesProject({ accountId, token, project, fetchImpl }), "created");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.method, "POST");
});
