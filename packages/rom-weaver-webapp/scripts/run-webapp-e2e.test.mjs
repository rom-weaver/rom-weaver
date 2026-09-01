// node --test coverage for the pure/testable helpers extracted from the
// hand-rolled Playwright E2E driver (run-webapp-e2e.mjs). The driver itself
// still runs real browsers and is not exercised here; this file only pins
// the assertion/route-enumeration logic that would otherwise let the E2E
// suite "pass" while silently testing nothing if it were wrong.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertNoProductionDocsSamples,
  assertSingleDocsHeading,
  buildWorkerReuseManifestCase,
  checkCssCoverage,
  computeDocsRouteSlugs,
  hasVisiblePrerenderedShell,
  resolveE2EShard,
  sha256,
  shouldRejectUnauthorized,
} from "./run-webapp-e2e.mjs";

describe("resolveE2EShard", () => {
  it("runs the complete suite when no shard is given", () => {
    assert.equal(resolveE2EShard([]), "all");
  });

  it("selects each supported shard", () => {
    assert.equal(resolveE2EShard(["--a11y"]), "a11y");
    assert.equal(resolveE2EShard(["--journeys"]), "journeys");
  });

  it("rejects incompatible shard flags", () => {
    assert.throws(() => resolveE2EShard(["--a11y", "--journeys"]), /Use only one E2E shard: --a11y or --journeys/);
  });
});

describe("shouldRejectUnauthorized", () => {
  it("skips TLS verification for loopback hostnames", () => {
    for (const url of ["https://localhost:5173/", "https://127.0.0.1:5173/", "https://[::1]:5173/"]) {
      assert.equal(shouldRejectUnauthorized(url), false, url);
    }
  });

  it("keeps TLS verification for non-loopback hostnames", () => {
    assert.equal(shouldRejectUnauthorized("https://rom-weaver.com/"), true);
  });

  it("fails closed (rejects) on an unparsable URL", () => {
    assert.equal(shouldRejectUnauthorized("not a url"), true);
  });
});

describe("sha256", () => {
  it("hashes bytes to the expected lowercase hex digest", () => {
    assert.equal(sha256(Buffer.from("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("is deterministic for the same input", () => {
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    assert.equal(sha256(bytes), sha256(bytes));
  });
});

describe("computeDocsRouteSlugs", () => {
  it("maps each doc source to its slug, preserving order", () => {
    const sources = [
      { file: "a.md", label: "A", slug: "docs/a" },
      { file: "b.md", label: "B", slug: "docs/b" },
    ];
    assert.deepEqual(computeDocsRouteSlugs(sources), ["docs/a", "docs/b"]);
  });

  it("returns an empty array for an empty route table", () => {
    assert.deepEqual(computeDocsRouteSlugs([]), []);
  });
});

describe("hasVisiblePrerenderedShell", () => {
  it("requires both prerendering and an in-viewport dock", () => {
    assert.equal(hasVisiblePrerenderedShell({ footerInFirstViewport: true, prerendered: true }), true);
    assert.equal(hasVisiblePrerenderedShell({ footerInFirstViewport: false, prerendered: true }), false);
    assert.equal(hasVisiblePrerenderedShell({ footerInFirstViewport: true, prerendered: false }), false);
  });
});

describe("assertSingleDocsHeading", () => {
  it("does not throw for exactly one heading", () => {
    assert.doesNotThrow(() => assertSingleDocsHeading(1, "docs/get-started"));
  });

  it("throws with the slug and count for zero headings", () => {
    assert.throws(
      () => assertSingleDocsHeading(0, "docs/get-started"),
      /^Error: docs\/get-started rendered 0 level-one headings; expected exactly 1$/,
    );
  });

  it("throws with the slug and count for more than one heading", () => {
    assert.throws(
      () => assertSingleDocsHeading(2, "docs/faq"),
      /^Error: docs\/faq rendered 2 level-one headings; expected exactly 1$/,
    );
  });
});

describe("assertNoProductionDocsSamples", () => {
  it("does not throw when no sample links point at production", () => {
    assert.doesNotThrow(() => assertNoProductionDocsSamples({ local: 3, production: 0 }, "docs/get-started"));
  });

  it("throws naming the slug and count when a sample still points at production", () => {
    assert.throws(
      () => assertNoProductionDocsSamples({ local: 0, production: 2 }, "docs/get-started"),
      /^Error: docs\/get-started still downloads 2 sample\(s\) from production$/,
    );
  });
});

describe("buildWorkerReuseManifestCase", () => {
  it("derives deterministic sha256 digests and byte counts from the given archive/payload", () => {
    const archive = Buffer.from("archive-bytes");
    const payload = Buffer.from("payload-bytes");
    const manifestCase = buildWorkerReuseManifestCase(archive, payload);
    assert.equal(manifestCase.compressedBytes, archive.byteLength);
    assert.equal(manifestCase.sha256, sha256(archive));
    assert.equal(manifestCase.expectedSha256, sha256(payload));
    assert.equal(manifestCase.fileName, "many-entries.zip");
    assert.equal(manifestCase.id, "many-entries");
    assert.equal(manifestCase.kind, "generated");
    assert.equal(manifestCase.url, "/__rom_weaver_corpus__/files/many-entries.zip");
  });
});

describe("checkCssCoverage", () => {
  const cssEntry = (url, text, ranges) => ({ ranges, text, url });

  it("does not throw when a stylesheet is present and under budget", () => {
    const entries = [cssEntry("https://example.test/app.css", ".a{color:red}", [{ end: 13, start: 0 }])];
    assert.doesNotThrow(() => checkCssCoverage(entries));
  });

  it("throws when no CSS stylesheet entry is present", () => {
    assert.throws(() => checkCssCoverage([]), /^Error: CSS coverage did not include a bundled stylesheet$/);
  });

  it("ignores non-CSS entries when checking for a bundled stylesheet", () => {
    const entries = [cssEntry("https://example.test/app.js", "console.log(1)", [{ end: 5, start: 0 }])];
    assert.throws(() => checkCssCoverage(entries), /CSS coverage did not include a bundled stylesheet/);
  });

  it("throws once unused bytes exceed the configured budget", () => {
    const unusedText = `.unused{${"a".repeat(200_000)}:1}`;
    const entries = [cssEntry("https://example.test/app.css", unusedText, [{ end: 1, start: 0 }])];
    assert.throws(() => checkCssCoverage(entries), /CSS coverage budget failed/);
  });
});
