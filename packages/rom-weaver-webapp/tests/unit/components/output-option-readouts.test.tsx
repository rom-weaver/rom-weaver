// @vitest-environment happy-dom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { buildOutputCompressionPanel } from "../../../src/public/react/components/ds/compress-panel.tsx";
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
});
