// @vitest-environment happy-dom
import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChecksumList, ChecksumRow } from "../../../src/public/react/components/ds/checksum-list.tsx";

/**
 * Checksum row/list contract: the `.ck` / `.ck-k` / `.ck-v` structure is what
 * the browser tests read hashes from, and the whole row is the copy control.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ChecksumRow", () => {
  it("renders the loom row structure browser tests key off", () => {
    const { container } = render(<ChecksumRow label="CRC32" value="C6FB1252" />);
    const row = container.querySelector("button.ck");
    expect(row).toBeTruthy();
    expect(row?.querySelector(".ck-k")?.textContent).toBe("CRC32");
    expect(row?.querySelector(".ck-v")?.textContent).toBe("C6FB1252");
  });

  it("copies the value when the row is clicked", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const { container } = render(<ChecksumRow copyValue="deadbeef" label="CRC32" value="DEADBEEF" />);
    fireEvent.click(container.querySelector("button.ck") as HTMLButtonElement);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("deadbeef"));
  });

  it("marks mismatching rows bad", () => {
    const { container } = render(<ChecksumRow bad label="CRC32" value="0" />);
    expect(container.querySelector(".ck.bad")).toBeTruthy();
  });
});

describe("ChecksumList", () => {
  it("wraps rows in a drawer with timing and verdict readouts", () => {
    const { container } = render(
      <ChecksumList defaultOpen label="Input Check" match={{ label: null, ok: true }} timing="Verify 2.1s">
        <ChecksumRow label="BYTES" value="13" />
      </ChecksumList>,
    );
    expect(container.querySelector(".cks.is-open")).toBeTruthy();
    expect(container.querySelector(".rb.time")?.textContent).toBe("Verify 2.1s");
    expect(container.querySelector(".rb-mark.ok")).toBeTruthy();
    expect(container.querySelector(".ckrows .ck")).toBeTruthy();
  });
});
