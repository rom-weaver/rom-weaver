// @vitest-environment happy-dom
import { beforeEach, describe, expect, test } from "vitest";
import { resolveAssetUrl } from "../../src/public/react/asset-url.ts";
import { readGuidedSampleFromSearch, resolveGuidedSampleHref } from "../../src/public/react/guided-sample-start.ts";
import { readAppBaseUrl } from "../../src/webapp/webapp-controller.ts";

const at = (path: string) => {
  window.history.replaceState({}, "", path);
  return readAppBaseUrl();
};

describe("readAppBaseUrl", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
  });

  test("strips a route segment, with or without a trailing slash", () => {
    expect(new URL(at("/apply/")).pathname).toBe("/");
    expect(new URL(at("/apply")).pathname).toBe("/");
    expect(new URL(at("/apply.html")).pathname).toBe("/");
    expect(new URL(at("/create")).pathname).toBe("/");
    expect(new URL(at("/create.html")).pathname).toBe("/");
    expect(new URL(at("/trim/")).pathname).toBe("/");
  });

  test("keeps a sub-path deployment prefix", () => {
    expect(new URL(at("/roms/apply/")).pathname).toBe("/roms/");
    expect(new URL(at("/roms/create")).pathname).toBe("/roms/");
    expect(new URL(at("/roms/")).pathname).toBe("/roms/");
  });

  test("handles the root and an explicit index.html", () => {
    expect(new URL(at("/")).pathname).toBe("/");
    expect(new URL(at("/index.html")).pathname).toBe("/");
    expect(new URL(at("/roms/index.html")).pathname).toBe("/roms/");
  });

  test("drops any query and hash so it is usable as a base", () => {
    const base = new URL(at("/apply/?bundle=first-weave.zip#frag"));
    expect(base.search).toBe("");
    expect(base.hash).toBe("");
  });
});

describe("resolveAssetUrl", () => {
  test("resolves a bare name against the app base", () => {
    expect(resolveAssetUrl("https://weaver.example/", "first-weave.zip")).toBe(
      "https://weaver.example/first-weave.zip",
    );
    expect(resolveAssetUrl("https://weaver.example/roms/", "first-weave.zip")).toBe(
      "https://weaver.example/roms/first-weave.zip",
    );
  });

  test("keeps the historical root-absolute path when no base is configured", () => {
    expect(resolveAssetUrl(undefined, "first-weave.zip")).toBe("/first-weave.zip");
    expect(resolveAssetUrl("   ", "first-weave.zip")).toBe("/first-weave.zip");
  });

  test("leaves an absolute asset url alone", () => {
    expect(resolveAssetUrl("https://weaver.example/", "https://cdn.example/first-weave.zip")).toBe(
      "https://cdn.example/first-weave.zip",
    );
  });
});

describe("resolveGuidedSampleHref", () => {
  test("keeps root-host guide links root-relative", () => {
    expect(resolveGuidedSampleHref("https://weaver.example/", "apply")).toBe("/apply?guide=apply");
  });

  test("keeps guide links inside a sub-path deployment", () => {
    expect(resolveGuidedSampleHref("https://weaver.example/roms/", "create")).toBe("/roms/create?guide=create");
  });

  test("keeps the authored link when the base is invalid", () => {
    expect(resolveGuidedSampleHref("not a url", "test")).toBe("/test?guide=test");
  });
});

describe("readGuidedSampleFromSearch", () => {
  test("reads a supported guide and rejects unknown values", () => {
    expect(readGuidedSampleFromSearch("?guide=bundle")).toBe("bundle");
    expect(readGuidedSampleFromSearch("?guide=unknown")).toBeNull();
    expect(readGuidedSampleFromSearch("?guide=toString")).toBeNull();
  });
});
