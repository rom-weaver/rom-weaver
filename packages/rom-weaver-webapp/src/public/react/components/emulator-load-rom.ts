import type { WorkflowProgress } from "../../../platform/browser/browser-api.ts";
import { isRomFileName } from "../file-classification.ts";
import { coreReadsChd, getEmulatorJsCore } from "./emulatorjs.ts";

type BrowserApi = typeof import("../../../platform/browser/browser-api.ts");
type IngestRom = BrowserApi["ingestRom"];
type ProbeRom = BrowserApi["probeRom"];
type ArchiveOutput = Awaited<ReturnType<IngestRom>>["outputs"][number];
type LoadEmulatorRomOptions = {
  onProgress?: (progress: WorkflowProgress) => void;
  signal?: AbortSignal;
};

const normalizedSha1 = (value: string | undefined): string | undefined => {
  const sha1 = value?.trim().toLowerCase();
  return sha1 && /^[a-f0-9]{40}$/.test(sha1) ? sha1 : undefined;
};

/**
 * Pick the ROM to hand to EmulatorJS out of an archive's extracted outputs.
 * Archives often bundle a readme or cover art alongside the ROM, so
 * `outputs[0]` (the workflow's default `output`) can be the wrong file; prefer
 * a known ROM extension, then one with a supported emulator core, falling
 * back to the first output only when nothing matches a ROM extension.
 */
const pickEmulatorRomOutput = (outputs: readonly ArchiveOutput[]): ArchiveOutput => {
  const first = outputs[0];
  if (!first) throw new Error("The archive did not produce any files for EmulatorJS.");
  const romOutputs = outputs.filter((output) => isRomFileName(output.fileName));
  const withCore = romOutputs.find((output) => getEmulatorJsCore(undefined, output.fileName));
  return withCore || romOutputs[0] || first;
};

/**
 * Keep an apply output's chosen name on the extracted ROM: only the extension
 * follows the file that actually came out of the archive. Without this, a
 * renamed output plays (and saves) under the original inner-archive name.
 */
const renameRomToOutput = (outputFileName: string, romFileName: string) => {
  const stem = outputFileName.replace(/\.[^./]+$/, "");
  const extension = romFileName.match(/\.[^./]+$/)?.[0] || "";
  return `${stem}${extension}`;
};

const isChdFileName = (fileName: string) => /\.chd$/i.test(fileName.trim());

/**
 * A CHD goes to EmulatorJS as-is when its core reads CHD: a decompressed
 * multi-track disc would be several files the player cannot take as one blob.
 * The metadata-only probe supplies the platform, decoded from the disc data,
 * and the header's payload SHA-1, which becomes the save identity. Returns
 * `undefined` when the disc belongs to a core that cannot read a CHD (ppsspp)
 * or the probe named no platform at all, leaving the caller to extract the
 * disc as it did before.
 */
const loadEmulatorChd = async (blob: Blob, fileName: string, probeRom: ProbeRom, options: LoadEmulatorRomOptions) => {
  let sequence = 0;
  const probe = await probeRom(blob, fileName, {
    onProgress: (progress: { label?: string; message?: string; percent?: number | null; stage?: string }) =>
      options.onProgress?.({
        id: "emulator-probe",
        label: progress.label || progress.message || "Reading CHD...",
        percent: progress.percent,
        role: "input",
        sequence: ++sequence,
        stage: (progress.stage as WorkflowProgress["stage"]) || "checksum",
        workflow: "apply",
      }),
    signal: options.signal,
  });
  if (!coreReadsChd(getEmulatorJsCore(probe.platform, fileName))) return undefined;
  const checksum = normalizedSha1(probe.chd?.rawSha1) || normalizedSha1(probe.chd?.sha1);
  if (!checksum) throw new Error("The CHD header carries no SHA-1, so rom-weaver cannot identify its saves.");
  return { blob, checksum, fileName, ...(probe.platform ? { platform: probe.platform } : {}) };
};

const loadEmulatorRom = async (blob: Blob, fileName: string, options: LoadEmulatorRomOptions = {}) => {
  const { getIngestOutputBlob, ingestRom, probeRom } = await import("../../../platform/browser/browser-api.ts");
  if (isChdFileName(fileName)) {
    const loaded = await loadEmulatorChd(blob, fileName, probeRom, options);
    if (loaded) return loaded;
  }
  let sequence = 0;
  const { outputs, result } = await ingestRom(blob, fileName, {
    identify: false,
    onProgress: (progress) =>
      options.onProgress?.({
        id: "emulator-ingest",
        label: progress.label || progress.message || "Reading ROM...",
        percent: progress.percent,
        role: "input",
        sequence: ++sequence,
        stage: (progress.stage as WorkflowProgress["stage"]) || "checksum",
        workflow: "apply",
      }),
    signal: options.signal,
  });
  try {
    const bare = result.assets.find((asset) => asset.copiedInPlace);
    if (bare) {
      const checksum = normalizedSha1(bare.checksums?.sha1);
      if (!checksum) throw new Error("rom-weaver did not return the ROM SHA-1 checksum.");
      return { blob, checksum, fileName, ...(bare.platform ? { platform: bare.platform } : {}) };
    }
    const chosen = pickEmulatorRomOutput(outputs);
    const extracted = await getIngestOutputBlob(chosen);
    const checksum = normalizedSha1(chosen.checksums?.sha1);
    if (!checksum) throw new Error("rom-weaver did not return the extracted ROM SHA-1 checksum.");
    const platform = chosen.romType?.platform;
    return { blob: extracted, checksum, fileName: chosen.fileName, ...(platform ? { platform } : {}) };
  } finally {
    await Promise.all(outputs.map((output) => output.dispose().catch(() => undefined)));
  }
};

export { loadEmulatorRom, pickEmulatorRomOutput, renameRomToOutput };
