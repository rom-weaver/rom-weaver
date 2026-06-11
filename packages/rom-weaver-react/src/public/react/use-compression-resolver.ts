import { useMemo } from "react";
import {
  isRomSpecificCompressionFormat,
  resolveAutomaticCompressionFormat,
} from "../../lib/compression/container-format-registry.ts";
import OutputCompressionManager from "../../lib/compression/output-compression-manager.ts";
import type { CompressionFormat } from "../../types/settings.ts";
import { getBinarySourceFileName, getBinarySourceSize } from "./input-session-helpers.ts";
import { createOutputOptions } from "./output-view-model.ts";
import type { ApplyPatchFormSettings, BinarySource } from "./patcher-form.ts";
import type { RomInputRowState } from "./patcher-ui-state.ts";
import {
  allowsDefaultCompressionSpecial,
  getDefaultCompressionArchive,
  getDefaultCompressionMode,
} from "./settings-context.tsx";

const isSpecialOutputCompression = (compression: CompressionFormat | string | null | undefined) =>
  isRomSpecificCompressionFormat(compression);

interface CompressionResolverInput {
  activeSettings: ApplyPatchFormSettings;
  effectiveInputs: BinarySource[];
  outputCompressionEdited: boolean;
  resolvedOutputCompression?: CompressionFormat;
  romInputs: RomInputRowState[];
  z3dsLabelSource: BinarySource | undefined;
}

// Pure derivation of the output compression a run should request and the value the UI should display.
// Mirrors the precedence rules in the container compression registry; kept free of hooks so it can be
// unit-tested in isolation from the React session hook.
const resolveCompressionState = ({
  activeSettings,
  effectiveInputs,
  outputCompressionEdited,
  resolvedOutputCompression,
  romInputs,
  z3dsLabelSource,
}: CompressionResolverInput) => {
  const defaultCompressionMode = getDefaultCompressionMode(activeSettings);
  const defaultArchiveCompression = getDefaultCompressionArchive(defaultCompressionMode);
  const configuredOutputCompression = activeSettings.output?.compression;
  const hasConfiguredOutputCompression =
    configuredOutputCompression !== undefined &&
    configuredOutputCompression !== null &&
    String(configuredOutputCompression).trim() !== "";
  const activeCompression = configuredOutputCompression || defaultArchiveCompression;
  const effectiveActiveCompression =
    activeCompression === "auto" ||
    OutputCompressionManager.supportsOutputCompression(z3dsLabelSource, activeCompression)
      ? activeCompression
      : "none";
  const resolvedSourceSize = romInputs[0]?.size ?? getBinarySourceSize(effectiveInputs[0]);
  const autoResolvedCompression = resolveAutomaticCompressionFormat({
    fallback: "zip",
    parentCompressions: romInputs[0]?.archivePathEntries,
    sourceFileName: String(romInputs[0]?.info?.fileName || getBinarySourceFileName(effectiveInputs[0], "")),
    sourceSize: resolvedSourceSize,
  });
  const defaultResolvedCompression = resolveAutomaticCompressionFormat({
    fallback: defaultArchiveCompression,
    parentCompressions: romInputs[0]?.archivePathEntries,
    sourceFileName: String(romInputs[0]?.info?.fileName || getBinarySourceFileName(effectiveInputs[0], "")),
    sourceSize: resolvedSourceSize,
  });
  const automaticSpecialCompression = OutputCompressionManager.resolveOutputCompression(z3dsLabelSource, {
    compressionFormat: "auto",
  });
  const specialCompressionFormat = isSpecialOutputCompression(defaultResolvedCompression)
    ? defaultResolvedCompression
    : isSpecialOutputCompression(automaticSpecialCompression)
      ? automaticSpecialCompression
      : null;
  const requestedCompression = outputCompressionEdited
    ? effectiveActiveCompression
    : hasConfiguredOutputCompression && activeCompression !== "auto"
      ? effectiveActiveCompression
      : allowsDefaultCompressionSpecial(defaultCompressionMode) && specialCompressionFormat
        ? specialCompressionFormat
        : defaultCompressionMode === "auto"
          ? defaultResolvedCompression
          : effectiveActiveCompression === "auto"
            ? defaultArchiveCompression
            : effectiveActiveCompression;
  const displayedCompression =
    requestedCompression === "auto"
      ? effectiveInputs.length
        ? resolvedOutputCompression || autoResolvedCompression
        : autoResolvedCompression
      : requestedCompression;
  return {
    activeCompression,
    displayedCompression,
    effectiveActiveCompression,
    requestedCompression,
  };
};

interface CompressionResolverHookInput extends Omit<CompressionResolverInput, "z3dsLabelSource"> {
  compressionOptions: string[];
}

// Builds the z3ds-aware label source, supported option list, and resolved compression values for the
// apply session. Memoizes the source/option derivations so downstream panels keep referential stability.
const useCompressionResolver = ({
  activeSettings,
  compressionOptions,
  effectiveInputs,
  outputCompressionEdited,
  resolvedOutputCompression,
  romInputs,
}: CompressionResolverHookInput) => {
  const z3dsLabelSource = useMemo<BinarySource | undefined>(() => {
    const selectedInputFileName = String(romInputs[0]?.info?.fileName || "").trim();
    const chdMode = romInputs[0]?.chdMode;
    const baseSource = effectiveInputs[0];
    if (!selectedInputFileName) return baseSource;
    if (baseSource && typeof baseSource === "object") {
      // Spreading a File drops its prototype getters (size included), so the
      // byte size is carried over explicitly for disc-image heuristics.
      const baseSize = romInputs[0]?.size ?? getBinarySourceSize(baseSource);
      return {
        ...(baseSource as unknown as Record<string, unknown>),
        ...(chdMode ? { _chdMode: chdMode } : {}),
        ...(typeof baseSize === "number" && Number.isFinite(baseSize) ? { size: baseSize } : {}),
        fileName: selectedInputFileName,
        name: selectedInputFileName,
      } as unknown as BinarySource;
    }
    if (typeof File === "function") return new File([], selectedInputFileName);
    return { fileName: selectedInputFileName } as unknown as BinarySource;
  }, [effectiveInputs, romInputs]);
  const supportedCompressionOptions = useMemo(
    () =>
      compressionOptions.filter((option) =>
        OutputCompressionManager.supportsOutputCompression(z3dsLabelSource, option),
      ),
    [compressionOptions, z3dsLabelSource],
  );
  const { activeCompression, displayedCompression, effectiveActiveCompression, requestedCompression } =
    resolveCompressionState({
      activeSettings,
      effectiveInputs,
      outputCompressionEdited,
      resolvedOutputCompression,
      romInputs,
      z3dsLabelSource,
    });
  const outputOptions = useMemo(
    () => createOutputOptions(supportedCompressionOptions, z3dsLabelSource),
    [supportedCompressionOptions, z3dsLabelSource],
  );
  const selectedOutputOptionLabel = useMemo(
    () => outputOptions.find((option) => option.value === displayedCompression)?.label,
    [displayedCompression, outputOptions],
  );
  return {
    activeCompression,
    displayedCompression,
    effectiveActiveCompression,
    outputOptions,
    requestedCompression,
    selectedOutputOptionLabel,
    z3dsLabelSource,
  };
};

export type { CompressionResolverInput };
export { resolveCompressionState, useCompressionResolver };
