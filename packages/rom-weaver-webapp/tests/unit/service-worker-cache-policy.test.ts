import { describe, expect, it } from "vitest";
import {
  createServiceWorkerCachePolicy,
  findStaleServiceWorkerCaches,
} from "../../src/webapp/pwa/service-worker-cache-policy.ts";

describe("service worker cache policy", () => {
  it("keeps active caches and removes stale builds without touching unrelated caches", () => {
    const policy = createServiceWorkerCachePolicy({
      emulatorJsCacheName: "precache-rom-weaver-emulatorjs-4.2.3",
      emulatorJsCachePrefix: "precache-rom-weaver-emulatorjs-",
      identifyOptionalCacheName: "precache-rom-weaver-identify-optional",
      managedCachePrefix: "precache-rom-weaver-",
      precacheName: "precache-rom-weaver-scope",
      runtimeCacheName: "precache-rom-weaver-runtime-current-scope",
    });
    expect(policy.activeCacheNames).toEqual([
      "precache-rom-weaver-scope",
      "precache-rom-weaver-runtime-current-scope",
      "precache-rom-weaver-emulatorjs-4.2.3",
      "precache-rom-weaver-identify-optional",
    ]);
    expect(
      findStaleServiceWorkerCaches(
        [
          ...policy.activeCacheNames,
          "precache-rom-weaver-0.12.0+old",
          "precache-rom-weaver-runtime-0.12.0+old",
          "precache-rom-weaver-emulatorjs-4.1.0",
          "precache-another-app-cache",
        ],
        policy,
      ),
    ).toEqual([
      "precache-rom-weaver-0.12.0+old",
      "precache-rom-weaver-runtime-0.12.0+old",
      "precache-rom-weaver-emulatorjs-4.1.0",
    ]);
  });
});
