// @vitest-environment happy-dom
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FileCard, FileTargetPill, RemoveButton } from "../../../src/public/react/components/ds/file-card.tsx";

/**
 * Loom card contract: header layout (name column + action column), the
 * `.card`/`.file` class pair the browser tests query rows by, and the verdict
 * border classes.
 */

describe("FileCard", () => {
  it("renders the loom card header with name, meta, and actions", () => {
    const onRemove = vi.fn();
    const { container } = render(
      <FileCard
        meta={<span className="fsize mono">14 B</span>}
        name={
          <div className="nmline">
            <span className="nm">game.bin</span>
          </div>
        }
        onRemove={onRemove}
        removeLabel="Remove ROM input"
      />,
    );
    const card = container.querySelector(".card.file");
    expect(card).toBeTruthy();
    expect(card?.querySelector(".card-top .card-name .nm")?.textContent).toBe("game.bin");
    expect(card?.querySelector(".card-meta .fsize")?.textContent).toBe("14 B");
    const remove = card?.querySelector(".card-actions .card-btns .rm") as HTMLButtonElement;
    expect(remove.getAttribute("aria-label")).toBe("Remove ROM input");
    fireEvent.click(remove);
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("applies verdict + patch classes", () => {
    const { container } = render(<FileCard name={<span className="nm">p.ips</span>} patch state="ok" />);
    const card = container.querySelector(".card");
    expect(card?.classList.contains("ok")).toBe(true);
    expect(card?.classList.contains("patch")).toBe(true);
    expect(card?.classList.contains("grabbable")).toBe(true);
  });

  it("renders the drag handle in the action column", () => {
    const { container } = render(
      <FileCard handle={<button className="handle" type="button" />} name={<span className="nm">p.ips</span>} patch />,
    );
    expect(container.querySelector(".card-btns .handle")).toBeTruthy();
  });
});

describe("FileTargetPill", () => {
  it("renders a static target when not interactive and a button when it is", () => {
    const { container, rerender } = render(<FileTargetPill label="Track 1" />);
    expect(container.querySelector(".target-grp .meta-target-static")?.textContent).toBe("Track 1");
    const onClick = vi.fn();
    rerender(<FileTargetPill label="Track 1" onClick={onClick} />);
    const button = container.querySelector(".target-grp button") as HTMLButtonElement;
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("RemoveButton", () => {
  it("is an icon button labelled for assistive tech", () => {
    const { container } = render(<RemoveButton label="Remove patch" onClick={() => undefined} />);
    expect(container.querySelector("button.rm")?.getAttribute("aria-label")).toBe("Remove patch");
  });
});
