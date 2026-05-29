type BrowserStorageEstimateState = {
  availableBytes?: number;
  error?: string;
  persisted?: boolean;
  quotaBytes?: number;
  usageBytes?: number;
};

const getStorageManager = (): StorageManager | null => {
  const storage = typeof navigator === "undefined" ? undefined : navigator.storage;
  return storage && typeof storage === "object" ? storage : null;
};

const getBrowserStorageEstimateState = async (): Promise<BrowserStorageEstimateState> => {
  const storage = getStorageManager();
  if (!storage) return {};

  let persisted: boolean | undefined;
  let usageBytes: number | undefined;
  let quotaBytes: number | undefined;
  let error: string | undefined;

  try {
    if (typeof storage.persisted === "function") persisted = await storage.persisted();
    if (typeof storage.estimate === "function") {
      const estimate = await storage.estimate();
      usageBytes = typeof estimate.usage === "number" ? Math.max(0, estimate.usage) : undefined;
      quotaBytes = typeof estimate.quota === "number" ? Math.max(0, estimate.quota) : undefined;
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught || "unknown storage estimate error");
  }

  const availableBytes =
    typeof usageBytes === "number" && typeof quotaBytes === "number" ? Math.max(0, quotaBytes - usageBytes) : undefined;
  return {
    availableBytes,
    error,
    persisted,
    quotaBytes,
    usageBytes,
  };
};

const formatByteCount = (value: number | undefined): string => {
  if (typeof value !== "number" || !Number.isFinite(value)) return "unknown";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let size = Math.max(0, value);
  let unitIndex = 0;
  while (size >= 1024 && unitIndex + 1 < units.length) {
    size /= 1024;
    unitIndex++;
  }
  const digits = unitIndex === 0 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(digits)} ${units[unitIndex]}`;
};

const formatBrowserStorageEstimateState = (state: BrowserStorageEstimateState): string => {
  const parts = [
    `persisted=${String(state.persisted ?? false)}`,
    `usage=${formatByteCount(state.usageBytes)}`,
    `quota=${formatByteCount(state.quotaBytes)}`,
    `available=${formatByteCount(state.availableBytes)}`,
  ];
  if (state.error) parts.push(`error=${state.error}`);
  return parts.join(" ");
};

export type { BrowserStorageEstimateState };
export { formatBrowserStorageEstimateState, getBrowserStorageEstimateState };
