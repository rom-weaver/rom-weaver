// @vitest-environment happy-dom
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OutputCard } from "../../../src/public/react/components/ds/output-card.tsx";

/**
 * Output card: the shared filename + format control. Pins the double-extension
 * warning that fires when the typed name already ends in an output-looking
 * extension (the format selector adds the extension itself).
 */

const baseProps = {
  format: "none",
  formatOptions: [
    { label: "None", value: "none" },
    { label: ".zip", value: "zip" },
  ],
  onFileNameChange: () => undefined,
  onFormatChange: () => undefined,
};

describe("OutputCard double-extension warning", () => {
  it("keeps the format arrow inside the format control", () => {
    const { container } = render(<OutputCard {...baseProps} fileName="game" />);
    expect(container.querySelector(".fname > .dropdown-select > select")).toBeTruthy();
    expect(container.querySelector(".fname > .dropdown-select > .dropdown-arrow")).toBeTruthy();
  });

  it("warns when the name ends in an output extension", () => {
    const { container } = render(<OutputCard {...baseProps} fileName="game.zip" />);
    const warn = container.querySelector(".outname-ext-warn");
    expect(warn).toBeTruthy();
    expect(warn?.getAttribute("role")).toBe("alert");
    expect(warn?.textContent).toContain(".zip");
  });

  it("stays silent for a bare name or a non-output extension", () => {
    expect(
      render(<OutputCard {...baseProps} fileName="game" />).container.querySelector(".outname-ext-warn"),
    ).toBeNull();
    expect(
      render(<OutputCard {...baseProps} fileName="game.sfc" />).container.querySelector(".outname-ext-warn"),
    ).toBeNull();
  });
});

describe("OutputCard identified-name toggle", () => {
  it("reports the switch back through onChange", () => {
    const changes: boolean[] = [];
    const { container } = render(
      <OutputCard
        {...baseProps}
        fileName="Tetris (USA)"
        nameSource={{ identifiedName: "Tetris (USA)", on: true, onChange: (on) => changes.push(on) }}
      />,
    );
    const toggle = container.querySelector<HTMLInputElement>('.outname-source input[type="checkbox"]');
    if (!toggle) throw new Error("The naming toggle did not render.");
    expect(toggle.checked).toBe(true);
    expect(container.querySelector(".outname-source")?.textContent).toContain("Tetris (USA)");

    fireEvent.click(toggle);
    expect(changes).toEqual([false]);
  });

  it("renders nothing when the ROM has no identified title", () => {
    const { container } = render(<OutputCard {...baseProps} fileName="rom_final" nameSource={null} />);
    expect(container.querySelector(".outname-source")).toBeNull();
  });
});
