import { describe, expect, test } from "vitest";
import { readUrlSessionRequest } from "../../src/webapp/url-session/url-session-request.ts";

const BASE = "https://weaver.example/app/index.html";

describe("readUrlSessionRequest", () => {
  test("returns null without session params", () => {
    expect(readUrlSessionRequest("", BASE).request).toBeNull();
    expect(readUrlSessionRequest("?theme=dark", BASE).request).toBeNull();
  });

  test("parses a weave request and resolves relative urls", () => {
    const { request, warnings } = readUrlSessionRequest("?weave=packs/rom-weaver-weave.json", BASE);
    expect(request).toEqual({
      weaveUrl: "https://weaver.example/app/packs/rom-weaver-weave.json",
      kind: "weave",
    });
    expect(warnings).toEqual([]);
  });

  test("accepts the legacy bundle query as a weave request", () => {
    expect(readUrlSessionRequest("?bundle=old.json", BASE).request).toEqual({
      kind: "weave",
      weaveUrl: "https://weaver.example/app/old.json",
    });
  });

  test("canonical weave query wins over legacy bundle query", () => {
    expect(readUrlSessionRequest("?bundle=old.json&weave=new.json", BASE).request).toEqual({
      kind: "weave",
      weaveUrl: "https://weaver.example/app/new.json",
    });
    expect(readUrlSessionRequest("?weave=&bundle=old.json", BASE).request).toBeNull();
  });

  test("weave wins over rom/patch shortcuts with a warning", () => {
    const { request, warnings } = readUrlSessionRequest(
      "?weave=https://host.example/rom-weaver-weave.json&rom=https://host.example/game.bin&patch=a.ips",
      BASE,
    );
    expect(request).toEqual({
      weaveUrl: "https://host.example/rom-weaver-weave.json",
      kind: "weave",
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
