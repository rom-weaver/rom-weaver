const normalizeRequiredOutputName = (outputName: string | null | undefined) =>
  typeof outputName === "string" ? outputName.trim() : "";

const hasRequiredOutputName = (outputName: string | null | undefined) =>
  normalizeRequiredOutputName(outputName).length > 0;

const requireOutputName = (outputName: string | null | undefined) => {
  const normalized = normalizeRequiredOutputName(outputName);
  if (!normalized) throw new Error("output.outputName is required");
  return normalized;
};

export { hasRequiredOutputName, requireOutputName };
