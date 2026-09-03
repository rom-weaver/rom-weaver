// @vitest-environment happy-dom
import { act, fireEvent, render } from "@testing-library/react";
import { useState, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodecCombobox } from "../../src/public/react/components/ds/codec-combobox.tsx";
import type { CompressionCodecOption } from "../../src/lib/compression/codec-fields.ts";

const options: CompressionCodecOption[] = [
  { label: "Deflate", maxLevel: 9, minLevel: 0, searchText: "zlib", value: "deflate" },
  { label: "Zstandard", maxLevel: 22, minLevel: 1, value: "zstd" },
  { label: "LZMA", maxLevel: 9, minLevel: 0, value: "lzma" },
];

const StatefulCombobox = ({
  initial = "",
  ...props
}: { initial?: string } & Partial<ComponentProps<typeof CodecCombobox>>) => {
  const [value, setValue] = useState(initial);
  return <CodecCombobox ariaLabel="Codec" onChange={setValue} options={options} value={value} {...props} />;
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("CodecCombobox", () => {
  it("opens suggestions, filters by typed text, and selects with Enter", async () => {
    const { container } = render(<StatefulCombobox />);
    const input = container.querySelector("input[role=combobox]") as HTMLInputElement;

    await act(async () => {
      fireEvent.focus(input);
      Object.defineProperty(input, "selectionStart", { configurable: true, get: () => 1 });
      fireEvent.change(input, { target: { value: "z" } });
    });
    expect(document.querySelector("[role=listbox]")).toBeTruthy();
    expect(Array.from(document.querySelectorAll("[role=option]")).map((node) => node.textContent)).toEqual([
      "Deflate",
      "Zstandard",
      "LZMA",
    ]);
    await act(async () => {
      fireEvent.mouseDown(
        Array.from(document.querySelectorAll("[role=option]")).find(
          (node) => node.textContent === "Zstandard",
        ) as HTMLElement,
      );
    });
    expect(input.value).toBe("zstd");
  });

  it("supports arrows, mouse selection, and preserves a codec level suffix", async () => {
    const { container } = render(<StatefulCombobox initial="zstd:7" />);
    const input = container.querySelector("input[role=combobox]") as HTMLInputElement;
    await act(async () => {
      fireEvent.focus(input);
      fireEvent.keyDown(input, { key: "ArrowDown" });
      fireEvent.keyDown(input, { key: "ArrowUp" });
    });
    const deflate = Array.from(document.querySelectorAll("[role=option]")).find((node) =>
      node.textContent?.includes("Deflate"),
    );
    expect(deflate).toBeTruthy();
    await act(async () => {
      fireEvent.mouseDown(deflate as HTMLElement);
    });
    expect(input.value).toBe("deflate:7");
    expect(document.querySelector("[role=listbox]")).toBeNull();
  });

  it("replaces a complete multiple-codec token and rejects malformed values", async () => {
    const { container } = render(
      <StatefulCombobox
        initial="deflate:6"
        multiple
        suggestions={[{ label: "Fast preset", maxLevel: null, minLevel: null, replaceValue: true, value: "zstd,lzma" }]}
      />,
    );
    const input = container.querySelector("input[role=combobox]") as HTMLInputElement;
    await act(async () => {
      fireEvent.focus(input);
    });
    const preset = document.querySelector("[role=option]") as HTMLElement;
    expect(preset.textContent).toContain("Fast preset");
    await act(async () => fireEvent.mouseDown(preset));
    expect(input.value).toBe("zstd,lzma");

    const malformed = render(
      <CodecCombobox ariaLabel="Codec" forceInvalid onChange={() => undefined} options={options} value="bad:99" />,
    );
    const invalid = malformed.container.querySelector("input[role=combobox]") as HTMLInputElement;
    expect(invalid.getAttribute("aria-invalid")).toBe("true");
    expect(invalid.title).toContain("valid values");
  });

  it("does not open while disabled and closes after blur", async () => {
    const { container } = render(<StatefulCombobox disabled initial="deflate" />);
    const input = container.querySelector("input[role=combobox]") as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector("[role=listbox]")).toBeNull();

    const active = render(<StatefulCombobox />);
    const activeInput = active.container.querySelector("input[role=combobox]") as HTMLInputElement;
    await act(async () => {
      fireEvent.focus(activeInput);
    });
    expect(document.querySelector("[role=listbox]")).toBeTruthy();
    fireEvent.blur(activeInput);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120);
    });
    expect(document.querySelector("[role=listbox]")).toBeNull();
  });
});
