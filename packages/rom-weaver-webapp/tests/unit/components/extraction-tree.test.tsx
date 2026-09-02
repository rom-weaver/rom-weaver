// @vitest-environment happy-dom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ExtractDrawer } from "../../../src/public/react/components/ds/extraction-tree.tsx";

describe("ExtractDrawer", () => {
  it("shows extract and identify durations in the Files readouts", () => {
    const { container } = render(
      <ExtractDrawer decompressionTimeMs={120} fileName="game.gba" fileSize={4} identifyTimeMs={45} />,
    );

    expect(Array.from(container.querySelectorAll(".rb.time"), (entry) => entry.textContent)).toEqual([
      "Extract 120ms",
      "Identify 45ms",
    ]);
  });
});
