// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "vitest";
import { resolveAssetUrl } from "../../src/public/react/asset-url.ts";
import { readGuidedSampleFromSearch, resolveGuidedSampleHref } from "../../src/public/react/guided-sample-start.ts";
import { matchAppRoute, readAppBaseUrl } from "../../src/webapp/app-routes.ts";
import { DOC_ROUTES } from "../../src/webapp/docs-pages.mjs";
import { WORKFLOW_ENTRY_ROUTES, WORKFLOW_SEO_ROUTES } from "../../src/webapp/workflow-seo.mjs";
import { LEGACY_WORKFLOW_ROUTES } from "../../scripts/vite-config/root-static-assets.mjs";

const appBase = vi.hoisted(() => ({ path: "/" }));
vi.mock("../../src/webapp/app-base.ts", () => ({
  get APP_BASE_PATH() {
    return appBase.path;
  },
}));

afterEach(() => {
  appBase.path = "/";
});

describe("matchAppRoute", () => {
  test.each(["/", "/rom-weaver/", "/docs/", "/apply/"])("resolves routes below the base %s", (base) => {
    expect(matchAppRoute(base, base)).toBe("home");
    expect(matchAppRoute(base.slice(0, -1), base)).toBe("home");
    expect(matchAppRoute(`${base}index.html`, base)).toBe("home");
    expect(matchAppRoute(`${base}create-rom-patch/`, base)).toBe("creator");
    expect(matchAppRoute(`${base}create-rom-patch`, base)).toBe("creator");
    expect(matchAppRoute(`${base}create-rom-patch.html`, base)).toBe("creator");
    expect(matchAppRoute(`${base}create-rom-patch/index.html`, base)).toBe("creator");
    expect(matchAppRoute(`${base}Create-ROM-Patch`, base)).toBe("creator");
    expect(matchAppRoute(`${base}apply-cheats`, base)).toBe("patcher");
    expect(matchAppRoute(`${base}docs`, base)).toBe("docs");
    expect(matchAppRoute(`${base}docs/faq`, base)).toBe("docs");
    expect(matchAppRoute(`${base}docs/faq.html`, base)).toBe("docs");
    expect(matchAppRoute(`${base}docs/nope`, base)).toBeNull();
    expect(matchAppRoute(`${base}x/`, base)).toBeNull();
    expect(matchAppRoute(`${base}x.html`, base)).toBeNull();
    expect(matchAppRoute(`${base}x/index.html`, base)).toBeNull();
    expect(matchAppRoute(`${base}constructor`, base)).toBeNull();
  });

  test.each(["/", "/rom-weaver/"])(
    "resolves the PPF undo page and its legacy slug with and without .html below %s",
    (base) => {
      for (const slug of ["ppf-undo", "tools"]) {
        for (const suffix of ["", "/", ".html", "/index.html"]) {
          expect(matchAppRoute(`${base}${slug}${suffix}`, base)).toBe("ppf-undo");
        }
      }
    },
  );

  // The build writes `<slug>.html` and `<slug>/index.html` for each of these; a static host serves them with
  // 200, so the client has to resolve every one or it paints not-found over a real page.
  test("resolves every route document the build writes", () => {
    // The home page's empty slug is `index.html`, which the first test covers.
    const slugs = [
      ...Object.values(WORKFLOW_SEO_ROUTES).map(({ slug }) => slug),
      ...Object.values(WORKFLOW_ENTRY_ROUTES).map(({ slug }) => slug),
      ...Object.keys(LEGACY_WORKFLOW_ROUTES),
      ...DOC_ROUTES.map(({ slug }) => slug),
      "rom-save-editor",
      "tools",
      "whats-new",
    ].filter(Boolean);
    const unresolved = ["/", "/rom-weaver/"].flatMap((base) =>
      slugs.flatMap((slug) =>
        [`${base}${slug}.html`, `${base}${slug}/index.html`].filter((path) => matchAppRoute(path, base) === null),
      ),
    );
    expect(unresolved).toEqual([]);
  });

  test("never reads a segment above the base as a route", () => {
    expect(matchAppRoute("/a/apply-rom-patches", "/")).toBeNull();
    expect(matchAppRoute("/rom-weaver/apply-rom-patches", "/")).toBeNull();
    expect(matchAppRoute("/apply-rom-patches", "/rom-weaver/")).toBeNull();
    expect(matchAppRoute("/rom-weaver-x/", "/rom-weaver/")).toBeNull();
    expect(matchAppRoute("/docs/docs/faq", "/docs/")).toBe("docs");
    expect(matchAppRoute("/docs/docs/faq", "/")).toBeNull();
    expect(matchAppRoute("/apply/apply", "/apply/")).toBe("patcher");
    expect(matchAppRoute("/apply/apply", "/")).toBeNull();
  });

  test("reads the page location and the served base by default", () => {
    appBase.path = "/rom-weaver/";
    window.history.replaceState({}, "", "/rom-weaver/");
    expect(matchAppRoute()).toBe("home");
    window.history.replaceState({}, "", "/rom-weaver/no-such-route");
    expect(matchAppRoute()).toBeNull();
    window.history.replaceState({}, "", "/");
  });
});

describe("readAppBaseUrl", () => {
  test("is the served base, wherever the page sits below it", () => {
    appBase.path = "/rom-weaver/";
    window.history.replaceState({}, "", "/rom-weaver/docs/faq?x=1#frag");
    expect(readAppBaseUrl()).toBe(`${window.location.origin}/rom-weaver/`);
    window.history.replaceState({}, "", "/rom-weaver/no-such-route/");
    expect(readAppBaseUrl()).toBe(`${window.location.origin}/rom-weaver/`);
    window.history.replaceState({}, "", "/");
  });

  test("is the origin root for a root deployment", () => {
    window.history.replaceState({}, "", "/apply-rom-patches");
    expect(readAppBaseUrl()).toBe(`${window.location.origin}/`);
    window.history.replaceState({}, "", "/");
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
    expect(resolveGuidedSampleHref("https://weaver.example/", "apply")).toBe("/apply-rom-patches?guide=apply");
  });

  test("keeps guide links inside a sub-path deployment", () => {
    expect(resolveGuidedSampleHref("https://weaver.example/roms/", "create")).toBe(
      "/roms/create-rom-patch?guide=create",
    );
  });

  test("keeps the authored link when the base is invalid", () => {
    expect(resolveGuidedSampleHref("not a url", "test")).toBe("/play-rom?guide=test");
  });
});

describe("readGuidedSampleFromSearch", () => {
  test("reads a supported guide and rejects unknown values", () => {
    expect(readGuidedSampleFromSearch("?guide=weave")).toBe("weave");
    expect(readGuidedSampleFromSearch("?guide=unknown")).toBeNull();
    expect(readGuidedSampleFromSearch("?guide=toString")).toBeNull();
  });
});
