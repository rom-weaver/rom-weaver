// @vitest-environment happy-dom
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  buildOutputCompressionPanel,
  CompressPanelBody,
} from "../../../src/public/react/components/ds/compress-panel.tsx";
import { OutputCard } from "../../../src/public/react/components/ds/output-card.tsx";
import { buildCompressPanel } from "../../../src/public/react/compress-options.ts";

/**
 * Collapsed output options: every option rides the drawer header as a chip that
 * names its value, so the settings read without opening the drawer. Pinned here
 * because the header is built from the same field models the drawer body
 * renders - a chip that stopped naming its value would otherwise go unnoticed.
 */

const chips = (container: HTMLElement) =>
  Array.from(container.querySelectorAll(".outopts .readouts > .rb")).map((chip) => ({
    label: chip.querySelector(".k")?.textContent ?? null,
    value: chip.querySelector(".t")?.textContent ?? chip.textContent,
  }));

const renderOutput = (format: string, settings: Record<string, unknown>, extra = {}) => {
  const panel = buildCompressPanel(format, settings);
  return render(
    <OutputCard
      compress={buildOutputCompressionPanel({
        fields: panel?.fields,
        format: `.${format}`,
        note: panel?.note,
        onFieldChange: () => undefined,
        ...extra,
      })}
      fileName="game"
      format={format}
      formatOptions={[{ label: `.${format}`, value: format }]}
      onFileNameChange={() => undefined}
      onFormatChange={() => undefined}
    />,
  );
};

describe("output options header chips", () => {
  it("names every option with its resolved value", () => {
    const { container } = renderOutput("zip", { compressionProfile: "max", zipCodec: "" });
    expect(chips(container)).toEqual([
      { label: "Type", value: ".zip" },
      // An unset codec reads as the default the run will actually use.
      { label: "Codec", value: "deflate:9" },
      { label: "Level", value: "Max" },
    ]);
  });

  it("reports an explicit codec level as an overridden profile", () => {
    const { container } = renderOutput("zip", { compressionProfile: "max", zipCodec: "zstd:12" });
    expect(chips(container)).toEqual([
      { label: "Type", value: ".zip" },
      { label: "Codec", value: "zstd:12" },
      { label: "Level", value: "Overridden" },
    ]);
  });

  it("carries a format-implied note as an unlabelled muted chip", () => {
    const { container } = renderOutput("z3ds", { compressionProfile: "max" });
    const note = container.querySelector(".outopts .readouts > .rb.muted");
    expect(note?.textContent).toBe("zstd:22");
    expect(note?.querySelector(".k")).toBeNull();
  });

  it("appends caller-supplied chips and the timing after the option chips", () => {
    const { container } = renderOutput("zip", { compressionProfile: "max" }, { timing: "1.2s" });
    const rendered = chips(container);
    expect(rendered.at(-1)).toEqual({ label: null, value: "1.2s" });
    expect(container.querySelector(".outopts .readouts > .rb.time")?.textContent).toBe("1.2s");
  });

  it("builds codec, block-size, and profile fields for every compressed format", () => {
    const sevenZip = buildCompressPanel("7z", { sevenZipCodec: "lzma2", compressionProfile: "max" });
    expect(sevenZip?.fields.map((field) => field.key)).toEqual(["sevenZipCodec", "compressionProfile"]);
    expect(sevenZip?.fields[0]?.chip.value).toBe("lzma2:9");
    expect(sevenZip?.fields[1]?.value).toBe("max");

    const rvz = buildCompressPanel("rvz", { rvzCodec: "zstd", rvzBlockSize: 131072, compressionProfile: "small" });
    expect(rvz?.fields.map((field) => field.key)).toEqual(["rvzCodec", "rvzBlockSize", "compressionProfile"]);
    expect(rvz?.fields[1]?.chip.value).toBe("131072");
    expect(rvz?.fields[1]?.value).toBe("131072");
  });

  it("selects CHD codec sets from explicit and detected disc modes", () => {
    const cd = buildCompressPanel("chd", { chdOutputMode: "cd", chdCreateCdCodecs: "cdlz:8,cdfl" });
    expect(cd?.fields[0]?.key).toBe("chdCreateCdCodecs");
    expect(cd?.fields[0]?.value).toBe("cdlz:8,cdfl");
    expect(cd?.note).toBeUndefined();

    const dvd = buildCompressPanel("chd", { chdOutputMode: "dvd" }, { metadata: { format: "DVD" } });
    expect(dvd?.fields[0]?.key).toBe("chdCreateDvdCodecs");
    expect(dvd?.fields[0]?.value).toBe("lzma,zlib,huff,flac");
    expect(dvd?.note).toBe("DVD");

    const auto = buildCompressPanel("chd", {}, { metadata: { format: "CD" } });
    expect(auto?.fields[0]?.key).toBe("chdCreateCdCodecs");
    expect(auto?.fields[0]?.value).toBe("cdlz,cdzl,cdfl");
    expect(auto?.note).toBe("CD-ROM");
  });

  it("defaults unknown CHD media to no codec field and rejects uncompressed formats", () => {
    const unknown = buildCompressPanel("chd", {}, { metadata: { format: "tape" } });
    expect(unknown?.fields[0]?.key).toBe("chdCreateDvdCodecs");
    expect(unknown?.fields[0]?.value).toBe("lzma,zlib,huff,flac");
    expect(unknown?.note).toBeUndefined();
    expect(buildCompressPanel("none", {})).toBeNull();
    expect(buildCompressPanel("", {})).toBeNull();
  });

  it("renders compression controls and forwards profile updates", () => {
    const panel = buildCompressPanel("zip", { compressionProfile: "max", zipCodec: "zstd:12" });
    const onChange = vi.fn();
    const rendered = render(<CompressPanelBody disabled={false} fields={panel?.fields ?? []} onChange={onChange} />);
    const codec = rendered.container.querySelector("input[role=combobox]") as HTMLInputElement;
    const profile = rendered.container.querySelector("select[name=compressionProfile]") as HTMLSelectElement;

    fireEvent.change(codec, { target: { value: "zstd:11" } });
    expect(onChange).toHaveBeenLastCalledWith("zipCodec", "zstd:11", { zipCodec: "zstd:11" });

    fireEvent.change(profile, { target: { value: "min" } });
    expect(onChange).toHaveBeenLastCalledWith("compressionProfile", "min", {
      compressionProfile: "min",
      zipCodec: "zstd",
    });

    rendered.unmount();
    const rvz = buildCompressPanel("rvz", { rvzBlockSize: 131072, rvzCodec: "zstd", compressionProfile: "max" });
    const rvzChange = vi.fn();
    const rvzRendered = render(<CompressPanelBody disabled fields={rvz?.fields ?? []} onChange={rvzChange} />);
    const blockSize = rvzRendered.container.querySelector("input[name=rvzBlockSize]") as HTMLInputElement;
    expect(blockSize.value).toBe("131072");
    expect(blockSize.disabled).toBe(true);
    rvzRendered.unmount();
  });
});
