// @vitest-environment happy-dom
import { fireEvent, render, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { prepareInputAssets } from "../../src/lib/input/input-preparation-service.ts";
import { getProgressStagedInputInfo, createRomInputRow } from "../../src/public/react/apply-session-inputs.ts";
import { useCompressionResolver } from "../../src/public/react/use-compression-resolver.ts";
import { buildCompressPanel } from "../../src/public/react/compress-options.ts";
import { CompressPanelBody } from "../../src/public/react/components/ds/compress-panel.tsx";
import type { ApplyPatchFormSettings } from "../../src/public/react/patcher-form.ts";

const hybrid = (kind: string) => {
  const bytes = new Uint8Array(204800);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("CD001"), 32769);
  bytes.set([0x55, 0xaa], 510);
  if (kind === "mbr") {
    bytes[450] = 0x83;
    view.setUint32(454, 1, true);
    view.setUint32(458, 399, true);
  } else if (kind === "gpt") {
    bytes.set(new TextEncoder().encode("EFI PART"), 512);
    view.setUint32(524, 92, true);
    for (const [offset, value] of [
      [536, 1],
      [544, 399],
      [552, 34],
      [560, 398],
      [584, 2],
    ])
      view.setBigUint64(offset, BigInt(value), true);
    view.setUint32(592, 1, true);
    view.setUint32(596, 128, true);
  } else if (kind === "fat") {
    view.setUint16(11, 512, true);
    bytes[13] = 1;
    view.setUint16(14, 1, true);
    bytes[16] = 2;
    view.setUint16(19, 400, true);
    view.setUint16(22, 1, true);
  } else if (kind === "ntfs") {
    bytes.set(new TextEncoder().encode("NTFS    "), 3);
    view.setUint16(11, 512, true);
    bytes[13] = 1;
    view.setBigUint64(40, 400n, true);
    view.setBigUint64(48, 1n, true);
  } else {
    bytes.set(new TextEncoder().encode("EXFAT   "), 3);
    view.setBigUint64(72, 400n, true);
    view.setUint32(80, 1, true);
    view.setUint32(84, 1, true);
    view.setUint32(88, 2, true);
    view.setUint32(92, 1, true);
    bytes[108] = 9;
  }
  return bytes;
};

const runtime = { name: "browser" as const, sidecars: {} };
const settings = { output: { compression: "chd" } } as ApplyPatchFormSettings;

const stage = async (bytes: Uint8Array<ArrayBuffer>) => {
  const onProgress = vi.fn();
  const [asset] = await prepareInputAssets(
    new File([bytes], "hybrid.bin"),
    {
      input: { containerInputsEnabled: false },
      onProgress,
    },
    0,
    runtime,
  );
  const event = onProgress.mock.calls.map(([event]) => event).find((event) => event.details?.chdCodecMode);
  return { asset, progress: event ? getProgressStagedInputInfo(event) : undefined };
};

const row = (chdCodecMode?: "dvd" | null) =>
  createRomInputRow({
    id: "source",
    chdCodecMode,
    chdMode: "cd",
    size: 204800,
    info: { fileName: "hybrid.bin", romType: { discFormat: "CD", recommendedFormat: "chd" } },
  });

describe("staged CHD codec panel", () => {
  it.each(["mbr", "gpt", "fat", "ntfs", "exfat"])(
    "uses generic codecs for valid %s/CD hybrids and preserves selection",
    async (kind) => {
      const { asset, progress } = await stage(hybrid(kind));
      expect(asset?.chdCodecMode).toBe("dvd");
      expect(progress?.chdCodecMode).toBe("dvd");
      expect(asset?.file.metadata?.mode).toBeUndefined();
      const inputs = [new File([], "hybrid.bin")];
      const resolve = (chdCodecMode?: "dvd" | null) =>
        useCompressionResolver({
          activeSettings: settings,
          compressionOptions: ["chd", "zip", "none"],
          effectiveInputs: inputs,
          outputCompressionEdited: true,
          romInputs: [row(chdCodecMode)],
        });
      const hook = renderHook(({ mode }) => resolve(mode), { initialProps: { mode: asset?.chdCodecMode } });
      const source = hook.result.current.z3dsLabelSource;
      expect((source as { metadata?: { mode?: string } }).metadata?.mode).toBeUndefined();
      const panelSettings = { chdCreateCdCodecs: "cdlz", chdCreateDvdCodecs: "lzma" };
      const panel = buildCompressPanel("chd", panelSettings, source);
      expect(panel?.fields[0]?.key).toBe("chdCreateDvdCodecs");
      expect(panel?.note).toBeUndefined();
      const onChange = vi.fn();
      const rendered = render(<CompressPanelBody fields={panel?.fields ?? []} onChange={onChange} />);
      const codec = rendered.container.querySelector("input[role=combobox]") as HTMLInputElement;
      fireEvent.change(codec, { target: { value: "zstd" } });
      expect(onChange).toHaveBeenLastCalledWith("chdCreateDvdCodecs", "zstd", { chdCreateDvdCodecs: "zstd" });
      const updatedSettings = { ...panelSettings, chdCreateDvdCodecs: "zstd" };
      hook.rerender({ mode: null });
      const cdPanel = buildCompressPanel("chd", updatedSettings, hook.result.current.z3dsLabelSource);
      expect(cdPanel?.fields[0]?.key).toBe("chdCreateCdCodecs");
      expect(cdPanel?.fields[0]?.value).toBe("cdlz");
      hook.rerender({ mode: "dvd" });
      expect(buildCompressPanel("chd", updatedSettings, hook.result.current.z3dsLabelSource)?.fields[0]?.value).toBe(
        "zstd",
      );
    },
  );

  it.each(["mbr", "gpt", "fat", "ntfs", "exfat"])("keeps malformed %s headers on the CD codec path", async (kind) => {
    const bytes = hybrid(kind);
    if (kind === "gpt") bytes[512] = 0;
    else bytes[510] = 0;
    const { asset, progress } = await stage(bytes);
    expect(asset?.chdCodecMode).toBeUndefined();
    expect(progress).toBeUndefined();
    const panel = buildCompressPanel("chd", {}, { fileName: "hybrid.bin", metadata: { format: "CD" } });
    expect(panel?.fields[0]?.key).toBe("chdCreateCdCodecs");
  });

  it("keeps automatic output and supported formats unchanged by the panel hint", () => {
    const inputs = [new File([], "raw.bin")];
    const hook = renderHook(
      ({ mode }: { mode?: "dvd" | null }) =>
        useCompressionResolver({
          activeSettings: {} as ApplyPatchFormSettings,
          compressionOptions: ["chd", "zip", "none"],
          effectiveInputs: inputs,
          outputCompressionEdited: false,
          romInputs: [
            createRomInputRow({
              id: "raw",
              size: 204800,
              chdCodecMode: mode,
              info: { fileName: "raw.bin", crc32: "12345678" },
            }),
          ],
        }),
      { initialProps: { mode: undefined } },
    );
    const initial = hook.result.current;
    hook.rerender({ mode: "dvd" });
    expect(hook.result.current.requestedCompression).toBe(initial.requestedCompression);
    expect(hook.result.current.outputOptions).toEqual(initial.outputOptions);
  });

  it.each(["disc.cue", "disc.gdi"])("keeps %s and explicit modes authoritative", (fileName) => {
    const source = { fileName, chdCodecMode: "dvd", metadata: { format: "CD" } };
    expect(buildCompressPanel("chd", {}, source)?.fields[0]?.key).toBe("chdCreateCdCodecs");
    expect(
      buildCompressPanel("chd", {}, { ...source, fileName: "disc.bin", metadata: { mode: "cd" } })?.fields[0]?.key,
    ).toBe("chdCreateCdCodecs");
    expect(
      buildCompressPanel("chd", {}, { ...source, fileName: "disc.bin", metadata: { cuePath: "disc.cue" } })?.fields[0]
        ?.key,
    ).toBe("chdCreateCdCodecs");
  });
});
