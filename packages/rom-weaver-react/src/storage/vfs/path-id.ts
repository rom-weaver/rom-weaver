const createVfsPathId = (): string => {
  if (typeof globalThis.crypto.randomUUID === "function") return globalThis.crypto.randomUUID();
  const words = globalThis.crypto.getRandomValues(new Uint32Array(4));
  return [...words].map((word) => word.toString(16).padStart(8, "0")).join("");
};

export { createVfsPathId };
