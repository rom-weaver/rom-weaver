const normalizeRequiredOutputName = (outputName: string | null | undefined) =>
  typeof outputName === "string" ? outputName.trim() : "";

const requireOutputName = (outputName: string | null | undefined) => {
  const normalized = normalizeRequiredOutputName(outputName);
  if (!normalized) throw new Error("output.outputName is required");
  return normalized;
};

export { requireOutputName };
