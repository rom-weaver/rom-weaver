import { createElement } from "preact";
import { useState } from "preact/hooks";
import { createRoot } from "./preact-root.js";
import { expect, test } from "vitest";
import { page } from "vitest/browser";
import { getCompressionCodecOptions, getCompressionCodecSuggestions } from "../../src/lib/compression/codec-fields.ts";
import { CodecCombobox } from "../../src/public/react/components/ds/codec-combobox.tsx";
import "../../src/webapp/design-system/index.css";

const ContainedHarness = () => {
  const [value, setValue] = useState("deflate");
  return createElement(
    "div",
    { className: "rw-app", style: { paddingTop: "650px", width: "400px" } },
    createElement(
      "div",
      { className: "card", style: { marginLeft: "40px", width: "320px" } },
      createElement(CodecCombobox, {
        id: "codec-containment-test",
        label: "ZIP codec",
        onChange: setValue,
        options: getCompressionCodecOptions("zipCodec"),
        suggestions: getCompressionCodecSuggestions("zipCodec"),
        value,
      }),
    ),
  );
};

test("codec dropdown keeps viewport coordinates inside a contained card", async () => {
  const host = document.createElement("div");
  document.body.replaceChildren(host);
  const root = createRoot(host);
  root.render(createElement(ContainedHarness));

  const input = page.getByRole("combobox", { name: "ZIP codec" });
  await input.click();
  await expect.poll(() => document.querySelector(".codec-combobox-list")).not.toBeNull();

  const list = document.querySelector(".codec-combobox-list");
  const inputElement = document.querySelector("#codec-containment-test");
  const listRect = list?.getBoundingClientRect();
  const inputRect = inputElement?.getBoundingClientRect();
  expect(getComputedStyle(list).position).toBe("fixed");
  expect(listRect?.left).toBeCloseTo(inputRect?.left ?? 0, 0);
  expect(listRect?.top).toBeGreaterThanOrEqual(inputRect?.bottom ?? 0);
  expect((listRect?.top ?? 0) - (inputRect?.bottom ?? 0)).toBeLessThanOrEqual(8);

  root.unmount();
  document.body.replaceChildren();
});
