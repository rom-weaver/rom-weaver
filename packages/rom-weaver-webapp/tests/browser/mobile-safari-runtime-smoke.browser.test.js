import { expect, test } from "vitest";
import { getFileInputAcceptAttributes } from "../../src/public/react/file-input-accept.ts";
import { collectBrowserRuntimeDiagnostics } from "../../src/webapp/browser-runtime-diagnostics.ts";

test("browser runtime diagnostics reports the gates needed by Mobile Safari verification", async () => {
  const diagnostics = await collectBrowserRuntimeDiagnostics();

  expect(window.ROM_WEAVER_BROWSER_DIAGNOSTICS?.collect).toBeTypeOf("function");
  expect(window.ROM_WEAVER_MOBILE_SAFARI_DIAGNOSTICS?.log).toBeTypeOf("function");
  expect(diagnostics.href).toBe(location.href);
  expect(diagnostics.isSecureContext).toBe(globalThis.isSecureContext === true);
  expect(diagnostics.crossOriginIsolated).toBe(globalThis.crossOriginIsolated === true);
  expect(diagnostics.sharedArrayBuffer).toBe(typeof SharedArrayBuffer);
  expect(diagnostics.atomicsWaitAsync).toBe(typeof Atomics === "object" ? typeof Atomics.waitAsync : "undefined");
  expect(diagnostics.opfs.available).toBe(typeof navigator.storage?.getDirectory === "function");
  expect(diagnostics.webAssembly).toBe(typeof WebAssembly);
  expect(diagnostics.worker).toBe(typeof Worker);
  expect(diagnostics.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
});

test("Mobile Safari file inputs use the file-only accept fallback", () => {
  const accept = getFileInputAcceptAttributes({
    maxTouchPoints: 5,
    platform: "iPhone",
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
  });

  expect(accept.unifiedApply).toContain("application/octet-stream");
  expect(accept.unifiedApply).toContain(".zip");
  expect(accept.unifiedApply).not.toContain(".ips");
  expect(accept.unifiedRom).toBe(accept.unifiedApply);
});

test("desktop apply file inputs accept xdelta compatibility extensions", () => {
  const accept = getFileInputAcceptAttributes({
    maxTouchPoints: 0,
    platform: "MacIntel",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
  });

  expect(accept.unifiedApply).toContain(".xdelta");
  expect(accept.unifiedApply).toContain(".delta");
  expect(accept.unifiedApply).toContain(".dat");
  expect(accept.unifiedRom).not.toContain(".xdelta");
});
