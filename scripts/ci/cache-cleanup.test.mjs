import assert from "node:assert/strict";
import test from "node:test";

import { cleanupCaches, supersededCaches } from "./cache-cleanup.mjs";

function cache(overrides = {}) {
  return {
    id: 1,
    key: "v0-rust-Linux-x64-11223344-aabbccdd",
    ref: "refs/heads/main",
    version: "cache-version",
    created_at: "2026-09-10T12:00:00Z",
    size_in_bytes: 1024,
    ...overrides,
  };
}

function response(body, { headers = {}, status = 200 } = {}) {
  return {
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

test("keeps the newest cache in each compatible restore scope", () => {
  const old = cache({ id: 1, key: "v0-rust-Linux-x64-11223344-12345678", created_at: "2026-09-09T12:00:00Z" });
  const current = cache({ id: 2 });
  const differentVersion = cache({ id: 3, version: "other-version" });
  const differentRef = cache({ id: 4, ref: "refs/pull/5/merge" });
  const exactOnly = cache({ id: 5, key: "node-modules-Linux-24-aabbccdd" });
  const wasm = cache({ id: 6, key: "wasm-prod-Linux-aabbccdd" });
  const changedRustEnvironment = cache({ id: 7, key: "v0-rust-Linux-x64-ffeeddcc-aabbccdd" });
  const oldCcache = cache({
    id: 8,
    created_at: "2026-09-09T12:00:00Z",
    key: "ccache-build-Linux-aabbccdd",
  });
  const currentCcache = cache({ id: 9, key: "ccache-build-Linux-ddeeff00" });
  const oldIdentifyBrotli = cache({
    id: 10,
    created_at: "2026-09-09T12:00:00Z",
    key: "identify-brotli-Linux-epoch1-aabbccdd",
  });
  const currentIdentifyBrotli = cache({
    id: 11,
    key: "identify-brotli-Linux-epoch1-ddeeff00",
  });

  assert.deepEqual(
    supersededCaches([
      old,
      current,
      differentVersion,
      differentRef,
      exactOnly,
      wasm,
      changedRustEnvironment,
      oldCcache,
      currentCcache,
      oldIdentifyBrotli,
      currentIdentifyBrotli,
    ]),
    [old, oldCcache, oldIdentifyBrotli],
  );
});

test("sccache cleanup preserves separate jobs, runners, refs, and cache versions", () => {
  const old = cache({
    key: "sccache-wasm-Linux-X64-aabbccdd",
    created_at: "2026-09-09T12:00:00Z",
  });
  const current = cache({ id: 2, key: "sccache-wasm-Linux-X64-ddeeff00" });
  const separateScopes = [
    cache({ id: 3, key: "sccache-native-Linux-X64-aabbccdd" }),
    cache({ id: 4, key: "sccache-wasm-macOS-X64-aabbccdd" }),
    cache({ id: 5, key: "sccache-wasm-Linux-ARM64-aabbccdd" }),
    { ...current, id: 6, ref: "refs/pull/7/merge" },
    { ...current, id: 7, version: "other-version" },
    cache({ id: 8, key: "sccache-wasm-Linux-X64-no-hash" }),
  ];
  assert.deepEqual(supersededCaches([old, current, ...separateScopes]), [old]);
});

test("reads every cache page and retains the current cache for an open pull request", async () => {
  const calls = [];
  const firstPage = cache({ id: 1, ref: "refs/pull/7/merge", key: "ccache-build-Linux-aabbccdd" });
  const old = cache({ id: 2, created_at: "2026-09-09T12:00:00Z" });
  const current = cache({ id: 3 });
  const fetchImpl = async (url, options = {}) => {
    const request = new URL(url);
    calls.push({ method: options.method ?? "GET", path: `${request.pathname}${request.search}` });
    if (request.pathname.endsWith("/cache/usage")) return response({ active_caches_size_in_bytes: 10 * 1024 });
    if (request.pathname.endsWith("/actions/caches") && request.searchParams.get("page") !== "2") {
      return response(
        { actions_caches: [firstPage, old] },
        { headers: { link: `<${request.origin}${request.pathname}?per_page=100&page=2>; rel="next"` } },
      );
    }
    if (request.pathname.endsWith("/actions/caches")) return response({ actions_caches: [current] });
    if (request.pathname.endsWith("/pulls/7")) return response({ state: "open", merged_at: null });
    if (request.pathname.endsWith("/actions/caches/2") && options.method === "DELETE") return response(null, { status: 204 });
    throw new Error(`unexpected request: ${request.pathname}${request.search}`);
  };

  const result = await cleanupCaches({
    apiBase: "https://api.example.test",
    fetchImpl,
    logger: { write() {} },
    repo: "owner/repo",
    summaryFile: null,
    token: "token",
  });

  assert.equal(result.superseded, 1);
  assert.equal(result.closed, 0);
  assert.equal(calls.filter((call) => call.path.endsWith("/actions/caches/2")).length, 1);
  assert.ok(calls.some((call) => call.path.endsWith("/actions/caches?per_page=100&page=2")));
  assert.ok(!calls.some((call) => call.path.endsWith("/actions/caches/1") && call.method === "DELETE"));
});

test("preserves pull request caches when the pull request lookup fails", async () => {
  const calls = [];
  const pullCache = cache({ id: 1, ref: "refs/pull/7/merge" });
  const olderCache = { ...pullCache, id: 2, created_at: "2026-09-09T12:00:00Z" };
  const logs = [];
  const fetchImpl = async (url, options = {}) => {
    const request = new URL(url);
    calls.push({ method: options.method ?? "GET", path: request.pathname });
    if (request.pathname.endsWith("/cache/usage")) return response({ active_caches_size_in_bytes: 10 * 1024 });
    if (request.pathname.endsWith("/actions/caches")) return response({ actions_caches: [pullCache, olderCache] });
    if (request.pathname.endsWith("/pulls/7")) return response({ message: "unavailable" }, { status: 503 });
    throw new Error(`unexpected request: ${request.pathname}`);
  };

  const result = await cleanupCaches({
    apiBase: "https://api.example.test",
    fetchImpl,
    logger: { write: (line) => logs.push(line) },
    repo: "owner/repo",
    summaryFile: null,
    token: "token",
  });

  assert.equal(result.closed, 0);
  assert.ok(logs.some((line) => line.includes("preserving its caches")));
  assert.ok(!calls.some((call) => call.method === "DELETE"));
});

test("continues after a closed-pull-request cache deletion fails", async () => {
  const first = cache({ id: 1, ref: "refs/pull/7/merge" });
  const second = cache({ id: 2, ref: "refs/pull/7/merge", key: "wasm-prod-Linux-aabbccdd" });
  const logs = [];
  const fetchImpl = async (url, options = {}) => {
    const request = new URL(url);
    if (request.pathname.endsWith("/cache/usage")) return response({ active_caches_size_in_bytes: 10 * 1024 });
    if (request.pathname.endsWith("/actions/caches") && !options.method) {
      return response({ actions_caches: [first, second] });
    }
    if (request.pathname.endsWith("/pulls/7")) return response({ state: "closed", merged_at: null });
    if (request.pathname.endsWith("/actions/caches/1")) return response({ message: "conflict" }, { status: 409 });
    if (request.pathname.endsWith("/actions/caches/2")) return response(null, { status: 204 });
    throw new Error(`unexpected request: ${request.pathname}`);
  };

  const result = await cleanupCaches({
    apiBase: "https://api.example.test",
    fetchImpl,
    logger: { write: (line) => logs.push(line) },
    repo: "owner/repo",
    summaryFile: null,
    token: "token",
  });

  assert.equal(result.closed, 1);
  assert.equal(result.reclaimed, second.size_in_bytes);
  assert.ok(logs.some((line) => line.includes("could not delete cache 1")));
});
