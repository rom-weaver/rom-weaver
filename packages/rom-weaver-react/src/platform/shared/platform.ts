import type { LargeFileVfs } from "../../storage/vfs/types.ts";

type PlatformEnvironment = "browser";

type PlatformCapabilities = {
  fileSystemAccess: boolean;
  opfs: boolean;
  sidecars: boolean;
  workers: boolean;
};

type RuntimePlatform = {
  capabilities: PlatformCapabilities;
  environment: PlatformEnvironment;
  vfs: LargeFileVfs;
};

type BrowserRuntimePlatform = RuntimePlatform & {
  environment: "browser";
};

const createPlatformCapabilities = (capabilities: Partial<PlatformCapabilities> = {}): PlatformCapabilities => ({
  fileSystemAccess: capabilities.fileSystemAccess ?? false,
  opfs: capabilities.opfs ?? false,
  sidecars: capabilities.sidecars ?? false,
  workers: capabilities.workers ?? false,
});

export type { BrowserRuntimePlatform, PlatformCapabilities, PlatformEnvironment, RuntimePlatform };
export { createPlatformCapabilities };
