import type { BrowserApplyResult } from "../../../platform/browser/browser-api.ts";

const isEmulatorArchive = (fileName: string) => /\.(?:7z|zip)$/i.test(fileName);

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
    const extracted = await result.output.getBlob?.();
    if (!extracted) throw new Error("The ROM could not be extracted for EmulatorJS.");
    return { blob: extracted, fileName: result.output.fileName };
  } finally {
    await Promise.all(result?.outputs.map((output) => output.dispose().catch(() => undefined)) || []);
    await workflow.dispose().catch(() => undefined);
  }
};

export { loadEmulatorRom };
