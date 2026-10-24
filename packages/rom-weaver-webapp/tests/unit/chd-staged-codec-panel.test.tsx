// @vitest-environment happy-dom
import { fireEvent, render, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { getProgressStagedInputInfo, createRomInputRow } from "../../src/public/react/apply-session-inputs.ts";
import { useCompressionResolver } from "../../src/public/react/use-compression-resolver.ts";
import { buildCompressPanel } from "../../src/public/react/compress-options.ts";
import { CompressPanelBody } from "../../src/public/react/components/ds/compress-panel.tsx";
import type { ApplyPatchFormSettings } from "../../src/public/react/patcher-form.ts";

// Header recognition (MBR, GPT, FAT, NTFS, exFAT hybrids) is Rust's `ChdContainerHandler`
// auto-inference; the webapp stages the verdict from the early `probe-identity` manifest.
const stage = (createMode: string) => ({
  progress: getProgressStagedInputInfo({
    details: { probe_manifest: { chd_create_mode: createMode, disc_format: "CD" } },
    stage: "probe-identity",
  } as never),
});

const settings = { output: { compression: "chd" } } as ApplyPatchFormSettings;

const row = (chdCodecMode?: "dvd" | null) =>
  createRomInputRow({
    id: "source",
    chdCodecMode,
    chdMode: "cd",
    size: 204800,
    info: { fileName: "hybrid.bin", romType: { discFormat: "CD", recommendedFormat: "chd" } },
  });

describe("staged CHD codec panel", () => {
  it("uses generic codecs for a Rust hard-disk verdict on a CD-identified image and preserves selection", () => {
    const { progress } = stage("hd");
    expect(progress.chdCodecMode).toBe("dvd");
    const inputs = [new File([], "hybrid.bin")];
    const resolve = (chdCodecMode?: "dvd" | null) =>
      useCompressionResolver({
        activeSettings: settings,
        compressionOptions: ["chd", "zip", "none"],
        effectiveInputs: inputs,
        outputCompressionEdited: true,
        romInputs: [row(chdCodecMode)],
      });
    const hook = renderHook(({ mode }) => resolve(mode), { initialProps: { mode: progress.chdCodecMode } });
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
  });

  it("keeps a CD-identified image on the CD codec path when Rust reports no hard-disk verdict", () => {
    const { progress } = stage("cd");
    expect(progress.chdCodecMode).toBeUndefined();
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
