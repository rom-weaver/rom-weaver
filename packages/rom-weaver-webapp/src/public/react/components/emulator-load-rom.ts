import type { BrowserApplyResult } from "../../../platform/browser/browser-api.ts";
import { isRomFileName } from "../file-classification.ts";
import { getEmulatorJsCore } from "./emulatorjs.ts";

const isEmulatorArchive = (fileName: string) => /\.(?:7z|zip)$/i.test(fileName);

type ArchiveOutput = BrowserApplyResult["outputs"][number];

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

const loadEmulatorRom = async (blob: Blob, fileName: string) => {
  if (!isEmulatorArchive(fileName)) return { blob, fileName };
  // Imported here, not at module scope: a static import would pull the whole
  // browser API out of its own dynamic chunk for every visitor.
  const { ApplyWorkflow } = await import("../../../platform/browser/browser-api.ts");
  const workflow = new ApplyWorkflow({ settings: { output: { compression: "none" } } });
  let result: BrowserApplyResult | undefined;
  try {
    await workflow.setInput(new File([blob], fileName, { type: blob.type }));
    result = await workflow.run();
    const chosen = pickEmulatorRomOutput(result.outputs);
    const extracted = await chosen.getBlob?.();
    if (!extracted) throw new Error("The ROM could not be extracted for EmulatorJS.");
    return { blob: extracted, fileName: chosen.fileName };
  } finally {
    await Promise.all(result?.outputs.map((output) => output.dispose().catch(() => undefined)) || []);
    await workflow.dispose().catch(() => undefined);
  }
};

export { loadEmulatorRom, pickEmulatorRomOutput };
