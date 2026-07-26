import assert from "node:assert/strict";
import test from "node:test";

import { tagPolicy } from "./docker-tag-policy.mjs";

// Tags arrive as `v0.6.0` from a ref name and `0.6.0` from workflow_dispatch.
test("normalizes both spellings of a version", () => {
  assert.deepEqual(tagPolicy("v0.6.0"), tagPolicy("0.6.0"));
  assert.equal(tagPolicy("v0.6.0").version, "0.6.0");
});

// The whole point of the policy: `docker pull rom-weaver` must never serve an
// alpha, so a prerelease claims neither `latest` nor a series tag.
test("a prerelease claims no moving stable tag", () => {
  const policy = tagPolicy("1.2.0-alpha.1");
  assert.equal(policy.release, false);
  assert.equal(policy.majorTag, false);
});

// `0` would float across 0.5 -> 0.6, which semver treats as breaking.
test("the major series tag starts at 1.0.0", () => {
  assert.equal(tagPolicy("0.9.9").majorTag, false);
  assert.equal(tagPolicy("1.0.0").majorTag, true);
});

test("a stable release claims latest", () => {
  assert.equal(tagPolicy("1.0.0").release, true);
});

test("rejects an empty version rather than tagging an image `latest` from nothing", () => {
  assert.throws(() => tagPolicy(""), /no version given/);
  assert.throws(() => tagPolicy(undefined), /no version given/);
});
