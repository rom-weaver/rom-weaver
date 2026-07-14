import { describe, expect, test } from "vitest";
import { readUrlSessionRequest } from "../../src/webapp/url-session/url-session-request.ts";

const BASE = "https://weaver.example/app/index.html";

describe("readUrlSessionRequest", () => {
  test("returns null without session params", () => {
    expect(readUrlSessionRequest("", BASE).request).toBeNull();
    expect(readUrlSessionRequest("?theme=dark", BASE).request).toBeNull();
  });

  test("parses a bundle request and resolves relative urls", () => {
    const { request, warnings } = readUrlSessionRequest("?bundle=packs/rom-weaver-bundle.json", BASE);
    expect(request).toEqual({
      bundleUrl: "https://weaver.example/app/packs/rom-weaver-bundle.json",
      kind: "bundle",
    });
    expect(warnings).toEqual([]);
  });

  test("bundle wins over rom/patch shortcuts with a warning", () => {
    const { request, warnings } = readUrlSessionRequest(
      "?bundle=https://host.example/rom-weaver-bundle.json&rom=https://host.example/game.bin&patch=a.ips",
      BASE,
    );
    expect(request).toEqual({
      bundleUrl: "https://host.example/rom-weaver-bundle.json",
      kind: "bundle",
    });
    expect(warnings).toHaveLength(1);
  });

  test("parses direct rom plus repeatable ordered patches", () => {
    const { request } = readUrlSessionRequest(
      "?rom=https://host.example/game.bin&patch=https://host.example/a.ips&patch=https://host.example/b.ips",
      BASE,
    );
    expect(request).toEqual({
      kind: "direct",
      patchUrls: ["https://host.example/a.ips", "https://host.example/b.ips"],
      romUrl: "https://host.example/game.bin",
    });
  });

  test("supports patch-only sessions (the user supplies the ROM)", () => {
    const { request } = readUrlSessionRequest("?patch=https://host.example/a.ips", BASE);
    expect(request).toEqual({
      kind: "direct",
      patchUrls: ["https://host.example/a.ips"],
      romUrl: null,
    });
  });

  test("rejects non-http(s) schemes with warnings", () => {
    const { request, warnings } = readUrlSessionRequest("?rom=file:///etc/passwd&patch=javascript:alert(1)", BASE);
    expect(request).toBeNull();
    expect(warnings).toHaveLength(2);
  });
});
