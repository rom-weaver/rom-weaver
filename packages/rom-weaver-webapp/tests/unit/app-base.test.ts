import { describe, expect, it } from "vitest";
import { normalizeBasePath } from "../../src/webapp/app-base.ts";

describe("normalizeBasePath", () => {
  it("keeps a single-slash base", () => {
    expect(normalizeBasePath("/")).toBe("/");
    expect(normalizeBasePath("/rom-weaver/")).toBe("/rom-weaver/");
  });

  it("collapses leading slashes that would parse as a host", () => {
    expect(normalizeBasePath("//")).toBe("/");
    expect(normalizeBasePath("//rom-weaver/")).toBe("/rom-weaver/");
    expect(new URL(normalizeBasePath("//rom-weaver/"), "https://example.test").href).toBe(
      "https://example.test/rom-weaver/",
    );
  });
});
