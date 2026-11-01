// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RomWeaverSettingsProvider, useUiLocalizer } from "../../../src/public/react/settings-context.tsx";
import type { SaveField } from "../../../src/wasm/generated/rom-weaver-rust-types.d.ts";
import { SaveNumberField } from "../../../src/webapp/components/save-number-field.tsx";

const field = (overrides: Partial<SaveField> = {}): SaveField => ({
  constraints: { choices: [], max: null, max_length: null, min: null },
  description: "",
  editable: true,
  encoding: null,
  id: "coins",
  kind: "unsigned_integer",
  label: "Coins",
  section_id: 0,
  step: 1,
  value: { u32: 2 },
  warnings: [],
  ...overrides,
});

const Harness = ({
  initial,
  source,
  onValue,
}: {
  initial: string;
  source: SaveField;
  onValue: (v: string) => void;
}) => {
  const localizer = useUiLocalizer();
  const [text, setText] = useState(initial);
  return (
    <>
      <label htmlFor="save-field-coins">Coins</label>
      <SaveNumberField
        disabled={false}
        field={source}
        id="save-field-coins"
        localizer={localizer}
        onChange={(value) => {
          setText(value);
          onValue(value);
        }}
        text={text}
      />
    </>
  );
};

const mount = (source: SaveField, initial: string) => {
  const onValue = vi.fn();
  render(
    <RomWeaverSettingsProvider settings={{}}>
      <Harness initial={initial} onValue={onValue} source={source} />
    </RomWeaverSettingsProvider>,
  );
  return onValue;
};

afterEach(cleanup);

describe("SaveNumberField", () => {
  it("never steps an unsigned field below zero when its schema has no minimum", () => {
    mount(field(), "1");
    const lower = screen.getByRole("button", { name: "Lower Coins by 1" });
    fireEvent.click(lower, { detail: 0 });
    expect((screen.getByLabelText("Coins") as HTMLInputElement).value).toBe("0");
    expect(lower.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(lower, { detail: 0 });
    expect((screen.getByLabelText("Coins") as HTMLInputElement).value).toBe("0");
  });

  it("steps a signed field with no minimum below zero", () => {
    mount(field({ kind: "signed_integer" }), "0");
    fireEvent.click(screen.getByRole("button", { name: "Lower Coins by 1" }), { detail: 0 });
    expect((screen.getByLabelText("Coins") as HTMLInputElement).value).toBe("-1");
  });

  it("shows no slider for a field without a range", () => {
    mount(field(), "5");
    expect(screen.queryByRole("slider")).toBeNull();
  });

  it("shows the range at the ends of the slider and moves by the step with the keys", () => {
    const onValue = mount(field({ constraints: { choices: [], max: 160, max_length: null, min: 24 }, step: 8 }), "24");
    const slider = screen.getByRole("slider", { name: "Coins slider" });
    expect(slider.getAttribute("aria-valuemin")).toBe("24");
    expect(slider.getAttribute("aria-valuemax")).toBe("160");
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(onValue).toHaveBeenLastCalledWith("32");
    fireEvent.keyDown(slider, { key: "End" });
    expect(onValue).toHaveBeenLastCalledWith("160");
    fireEvent.keyDown(slider, { key: "Home" });
    expect(onValue).toHaveBeenLastCalledWith("24");
  });

  it("does not report a press that lands on the stored value", () => {
    const onValue = mount(field({ constraints: { choices: [], max: 10, max_length: null, min: 0 } }), "10");
    fireEvent.keyDown(screen.getByRole("slider"), { key: "End" });
    fireEvent.click(screen.getByRole("button", { name: "Raise Coins by 1" }), { detail: 0 });
    expect(onValue).not.toHaveBeenCalled();
  });

  describe("pointer presses", () => {
    const press = (type: string, pointerType: string) =>
      fireEvent(
        screen.getByRole("button", { name: "Raise Coins by 1" }),
        Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
          button: 0,
          pointerId: 1,
          pointerType,
        }),
      );

    it("steps a touch tap on release, and not when the browser cancels it to scroll", () => {
      vi.stubGlobal("PointerEvent", Event);
      Object.assign(HTMLElement.prototype, { setPointerCapture: () => undefined });
      const onValue = mount(field(), "5");
      press("pointerdown", "touch");
      press("pointercancel", "touch");
      expect(onValue).not.toHaveBeenCalled();
      press("pointerdown", "touch");
      press("pointerup", "touch");
      expect(onValue).toHaveBeenLastCalledWith("6");
      vi.unstubAllGlobals();
    });

    it("steps a mouse press at once", () => {
      Object.assign(HTMLElement.prototype, { setPointerCapture: () => undefined });
      const onValue = mount(field(), "5");
      press("pointerdown", "mouse");
      expect(onValue).toHaveBeenLastCalledWith("6");
      press("pointerup", "mouse");
    });
  });
});
