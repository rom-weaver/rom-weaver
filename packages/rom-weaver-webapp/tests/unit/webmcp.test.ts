// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";
import { installWebMcp } from "../../src/webapp/webmcp.ts";

afterEach(() => vi.unstubAllGlobals());

test("does nothing when WebMCP is unavailable", () => {
  expect(() => installWebMcp()()).not.toThrow();
});

test.each(["document", "navigator"])("registers usable tools through %s and cleans up", (owner) => {
  const registered = new Map<string, { execute: (input: unknown) => unknown }>();
  const unregisterTool = vi.fn();
  const registerTool = vi.fn((tool, options) => {
    registered.set(tool.name, tool);
    options.signal.addEventListener("abort", () => registered.delete(tool.name));
  });
  vi.stubGlobal(
    owner,
    new Proxy(owner === "document" ? document : navigator, {
      get(target, key) {
        if (key === "modelContext") return { registerTool, unregisterTool };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  );
  const cleanup = installWebMcp();
  expect([...registered.keys()]).toEqual(["search_site", "navigate_site", "get_supported_formats"]);
  expect(registered.get("search_site")?.execute({ query: "patch" })).toEqual(
    expect.arrayContaining([expect.objectContaining({ slug: "apply-patches" })]),
  );
  expect(registered.get("get_supported_formats")?.execute({})).toBeTruthy();
  expect(() => registered.get("navigate_site")?.execute({ slug: "https://evil.example" })).toThrow("Unknown page slug");
  expect(() => registered.get("search_site")?.execute(null)).toThrow("Missing query");
  cleanup();
  expect(registered.size).toBe(0);
  expect(unregisterTool).toHaveBeenCalledTimes(3);
});

test("exposes one action API without a dedicated Apply tool", () => {
  const registered: string[] = [];
  Object.defineProperty(navigator, "modelContext", {
    configurable: true,
    value: { registerTool: (tool: { name: string }) => registered.push(tool.name) },
  });
  const cleanup = installWebMcp({
    getState: () => ({ currentView: "patcher", patcherSession: { pendingDownloadFileName: null } }),
    confirmAction: async () => false,
  });
  expect(registered).toEqual([
    "search_site",
    "navigate_site",
    "get_supported_formats",
    "get_workflow_state",
    "list_workflows",
    "configure_workflow",
    "request_workflow_action",
  ]);
  cleanup();
  Reflect.deleteProperty(navigator, "modelContext");
});

test("restores registrations after the initial pageshow and a cached navigation", () => {
  const registerTool = vi.fn();
  Object.defineProperty(navigator, "modelContext", { configurable: true, value: { registerTool } });
  const cleanup = installWebMcp();
  window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false }));
  window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
  expect(registerTool.mock.calls[0][1].signal.aborted).toBe(true);
  const restored = new Event("pageshow");
  Object.defineProperty(restored, "persisted", { value: true });
  window.dispatchEvent(restored);
  expect(registerTool).toHaveBeenCalledTimes(6);
  expect(registerTool.mock.calls[3][1].signal.aborted).toBe(false);
  cleanup();
  expect(registerTool.mock.calls[3][1].signal.aborted).toBe(true);
  window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  expect(registerTool).toHaveBeenCalledTimes(6);
  Reflect.deleteProperty(navigator, "modelContext");
});
