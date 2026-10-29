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

const baseName = (fileName: string) => fileName.replace(/^.*[\\/]/, "").toLowerCase();

/**
 * EmulatorJS pairs a lone `.bin` with an invented `MODE1/2352` cue sheet, so a
 * disc whose extracted cue holds a single 2048-byte data track MUST reach the
 * core as an `.iso`, or the core misreads every sector. Returns the `.iso` name
 * for such a `.bin`, otherwise `undefined`.
 */
const cookedBinIsoName = async (
  chosen: ArchiveOutput,
  outputs: readonly ArchiveOutput[],
  readOutput: (output: ArchiveOutput) => Promise<Blob>,
): Promise<string | undefined> => {
  if (!/\.bin$/i.test(chosen.fileName)) return undefined;
  const cue = outputs.find((output) => /\.cue$/i.test(output.fileName));
  if (!cue) return undefined;
  const lines = (await (await readOutput(cue)).text()).split(/\r?\n/).map((line) => line.trim());
  const files = lines.flatMap((line) => line.match(/^FILE\s+"?(.+?)"?\s+\S+$/i)?.[1] ?? []);
  const tracks = lines.flatMap((line) => line.match(/^TRACK\s+\d+\s+(\S+)$/i)?.[1] ?? []);
  const [file] = files;
  const [track] = tracks;
  if (files.length !== 1 || tracks.length !== 1 || !file || !track) return undefined;
  if (baseName(file) !== baseName(chosen.fileName) || !/^MODE[12]\/2048$/i.test(track)) return undefined;
  return chosen.fileName.replace(/\.bin$/i, ".iso");
};

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

type LoadedEmulatorRom = {
  blob: Blob;
  checksum: string;
  fileName: string;
  platform?: string;
  expandedSizeBytes?: number;
};

const loadEmulatorRom = async (
  blob: Blob,
  fileName: string,
  options: LoadEmulatorRomOptions = {},
): Promise<LoadedEmulatorRom> => {
  const { getIngestOutputBlob, ingestRom, prepareEmulatorPbp, probeRom } =
    await import("../../../platform/browser/browser-api.ts");
  let sequence = 0;
  const onProgress = (progress: { label?: string; message?: string; percent?: number | null; stage?: string }) =>
    options.onProgress?.({
      id: "emulator-ingest",
      label: progress.label || progress.message || "Reading ROM...",
      percent: progress.percent,
      role: "input",
      sequence: ++sequence,
      stage: (progress.stage as WorkflowProgress["stage"]) || "checksum",
      workflow: "apply",
    });
  if (/\.pbp$/i.test(fileName.trim())) {
    // The probe MUST validate the section table and every PS1 disc before preparing the complete-disc bundle.
    const probe = await probeRom(blob, fileName, { signal: options.signal });
    if (probe.pbp) {
      const prepared = await prepareEmulatorPbp(blob, fileName, probe.pbp.discCount, {
        onProgress,
        signal: options.signal,
      });
      const checksum = normalizedSha1(prepared.checksum);
      if (!checksum) throw new Error("rom-weaver did not return the PBP SHA-1 checksum.");
      return {
        blob: prepared.blob,
        checksum,
        expandedSizeBytes: prepared.expandedSizeBytes,
        fileName: fileName.trim().replace(/\.pbp$/i, ".zip"),
        platform: "Sony PlayStation",
      };
    }
  }
  if (isChdFileName(fileName)) {
    const loaded = await loadEmulatorChd(blob, fileName, probeRom, options);
    if (loaded) return loaded;
  }
  const { outputs, result } = await ingestRom(blob, fileName, {
    identify: false,
    interactiveSelectionEnabled: false,
    preserveNestedFormats: ["pbp"],
    onProgress,
    signal: options.signal,
  });
  let released: Promise<unknown> | undefined;
  const releaseOutputs = () => {
    released ??= Promise.all(outputs.map((output) => output.dispose().catch(() => undefined)));
    return released;
  };
  try {
    const bare = result.assets.find((asset) => asset.copiedInPlace);
    if (bare) {
      const checksum = normalizedSha1(bare.checksums?.sha1);
      if (!checksum) throw new Error("rom-weaver did not return the ROM SHA-1 checksum.");
      return { blob, checksum, fileName, ...(bare.platform ? { platform: bare.platform } : {}) };
    }
    const chosen = pickEmulatorRomOutput(outputs);
    const checksum = normalizedSha1(chosen.checksums?.sha1);
    if (!checksum) throw new Error("rom-weaver did not return the extracted ROM SHA-1 checksum.");
    const extracted = await getIngestOutputBlob(chosen);
    if (/\.pbp$/i.test(chosen.fileName.trim())) {
      // The extracted Blob outlives its output; release the ingest copy before the bundle stages another.
      await releaseOutputs();
      return await loadEmulatorRom(extracted, chosen.fileName, options);
    }
    const platform = chosen.romType?.platform;
    const romFileName = (await cookedBinIsoName(chosen, outputs, getIngestOutputBlob)) ?? chosen.fileName;
    return { blob: extracted, checksum, fileName: romFileName, ...(platform ? { platform } : {}) };
  } finally {
    await releaseOutputs();
  }
};

export { loadEmulatorRom, pickEmulatorRomOutput, renameRomToOutput };
