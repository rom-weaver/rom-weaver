import assert from "node:assert/strict";
import { test } from "node:test";
import { createServerCard, discoveryResponse, handleMcpRequest } from "../src/webapp/mcp-server.mjs";

const call = (method, params = {}, overrides = {}) =>
  handleMcpRequest(
    new Request("https://rom-weaver.com/mcp", {
      method: "POST",
      headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      ...overrides,
    }),
  );

test("discovery and initialization agree with the implemented transport and capabilities", async () => {
  const request = new Request("https://rom-weaver.com/.well-known/ai-catalog.json");
  const response = discoveryResponse(request, "catalog");
  assert.equal(response.status, 200);
  const catalog = await response.json();
  assert.equal(catalog.entries[0].url, "https://rom-weaver.com/mcp/server-card");
  const card = createServerCard("https://rom-weaver.com");
  assert.equal(card.remotes[0].url, "https://rom-weaver.com/mcp");
  const legacy = await discoveryResponse(request, "legacy").json();
  const { result } = await (
    await call("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    })
  ).json();
  assert.deepEqual(legacy.serverInfo, result.serverInfo);
  assert.deepEqual(legacy.capabilities, result.capabilities);
  assert.equal(card.version, result.serverInfo.version);
  assert.equal(card.name, result.serverInfo.name);
  assert.equal(result.capabilities.prompts, undefined);
});

test("lists and calls public tools and resources", async () => {
  const { result: listed } = await (await call("tools/list")).json();
  assert.deepEqual(
    listed.tools.map(({ name }) => name),
    ["search_docs", "get_supported_formats"],
  );
  const { result: search } = await (
    await call("tools/call", { name: "search_docs", arguments: { query: "patch" } })
  ).json();
  assert.ok(
    JSON.parse(search.content[0].text).some(({ url }) => url === "https://rom-weaver.com/docs/apply-rom-patches"),
  );
  const { result: formats } = await (await call("tools/call", { name: "get_supported_formats" })).json();
  assert.ok(JSON.parse(formats.content[0].text).patchFormats.length > 0);
  const { result: resources } = await (await call("resources/list")).json();
  for (const resource of resources.resources) {
    const { result } = await (await call("resources/read", { uri: resource.uri })).json();
    assert.equal(result.contents[0].uri, resource.uri);
    assert.doesNotThrow(() => JSON.parse(result.contents[0].text));
  }
});

test("rejects malformed requests, cross-origin calls, unsupported transports, and private operations", async () => {
  assert.equal((await handleMcpRequest(new Request("https://rom-weaver.com/mcp"))).status, 405);
  assert.equal((await call("tools/list", {}, { headers: { Origin: "https://evil.example" } })).status, 403);
  assert.equal((await call("tools/list", {}, { headers: { "MCP-Protocol-Version": "invalid" } })).status, 400);
  assert.equal((await call("tools/list", {}, { headers: { Accept: "application/json" } })).status, 406);
  assert.equal((await call("ping", {}, { body: "not json" })).status, 400);
  assert.equal((await call("ping", {}, { body: " ".repeat(16385) })).status, 413);
  for (const params of [
    { name: "request_apply_patches" },
    { name: "search_docs", arguments: null },
    { name: "search_docs", arguments: { query: "a".repeat(501) } },
    { name: "get_supported_formats", arguments: { upload: "bytes" } },
  ]) {
    const { error } = await (await call("tools/call", params)).json();
    assert.equal(error.code, -32602);
  }
  const notification = await call(
    "notifications/initialized",
    {},
    { body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) },
  );
  assert.equal(notification.status, 202);
  assert.equal(await notification.text(), "");
});

test("validates complete initialization and exact media types", async () => {
  const headers = { Accept: "application/json, text/event-stream", "Content-Type": "application/json" };
  assert.equal(
    (await call("ping", {}, { headers: { ...headers, Accept: "application/json-seq, text/event-streaming" } })).status,
    406,
  );
  assert.equal(
    (await call("ping", {}, { headers: { ...headers, Accept: "application/json;q=0, text/event-stream" } })).status,
    406,
  );
  assert.equal(
    (await call("ping", {}, { headers: { ...headers, "Content-Type": "application/jsonevil" } })).status,
    415,
  );
  assert.equal(
    (await call("ping", {}, { headers: { ...headers, "Content-Type": "application/json; charset=utf-8" } })).status,
    200,
  );
  for (const params of [
    { protocolVersion: "2025-11-25" },
    { protocolVersion: "2025-11-25", capabilities: null, clientInfo: { name: "test", version: "1" } },
    { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test" } },
  ]) {
    const response = await (await call("initialize", params)).json();
    assert.equal(response.error.code, -32602);
  }
});
