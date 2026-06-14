type BrowserStorageEstimateState = {
  availableBytes?: number;
  error?: string;
  persisted?: boolean;
  quotaBytes?: number;
  usageBytes?: number;
};

type BrowserStorageManagerLike = Pick<StorageManager, "estimate" | "persist" | "persisted">;

const getStorageManager = (storageOverride?: BrowserStorageManagerLike | null): BrowserStorageManagerLike | null => {
  if (storageOverride !== undefined) return storageOverride;
  const storage = typeof navigator === "undefined" ? undefined : navigator.storage;
  return storage && typeof storage === "object" ? storage : null;
};

const getBrowserStorageEstimateState = async (
  storageOverride?: BrowserStorageManagerLike | null,
): Promise<BrowserStorageEstimateState> => {
  const storage = getStorageManager(storageOverride);
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
  const unitBase = 1000;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = Math.max(0, value);
  let unitIndex = 0;
  while (size >= unitBase && unitIndex + 1 < units.length) {
    size /= unitBase;
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

export type { BrowserStorageManagerLike };
export { formatBrowserStorageEstimateState, formatByteCount, getBrowserStorageEstimateState };
