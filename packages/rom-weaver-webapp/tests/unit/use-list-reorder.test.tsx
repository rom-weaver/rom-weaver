// @vitest-environment happy-dom
import { fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useListReorder } from "../../src/public/react/components/ds/use-list-reorder.ts";

type Rect = { height: number; left: number; top: number; width: number };

const ROW_HEIGHT = 40;
const ROW_GAP = 10;

/** Vertical stack: row `index` sits at `index * 50`, so a neighbour's centre is 50px away. */
const stackRect = (index: number): Rect => ({
  height: ROW_HEIGHT,
  left: 0,
  top: index * (ROW_HEIGHT + ROW_GAP),
  width: 200,
});

/** Two-column grid: rows 0/1 on the first line, rows 2/3 on the second. */
const gridRect = (index: number): Rect => ({
  height: ROW_HEIGHT,
  left: (index % 2) * 220,
  top: Math.floor(index / 2) * (ROW_HEIGHT + ROW_GAP),
  width: 200,
});

const applyRect = (element: HTMLElement, readRect: () => Rect) => {
  element.getBoundingClientRect = () => {
    const rect = readRect();
    return {
      bottom: rect.top + rect.height,
      height: rect.height,
      left: rect.left,
      right: rect.left + rect.width,
      top: rect.top,
      width: rect.width,
      x: rect.left,
      y: rect.top,
      toJSON: () => undefined,
    } as DOMRect;
  };
};

const Harness = ({
  count,
  disabled,
  grid = false,
  onReorder,
  rectFor,
  skipRowRef = -1,
}: {
  count: number;
  disabled?: boolean;
  grid?: boolean;
  onReorder: (from: number, to: number) => void;
  rectFor: (index: number) => Rect;
  skipRowRef?: number;
}) => {
  const { containerRef, displayIndex, dragging, handleProps, rowProps } = useListReorder({
    count,
    disabled,
    onReorder,
  });
  return (
    <div
      className="rows"
      data-dragging={dragging ? "yes" : "no"}
      ref={(element) => {
        containerRef.current = element;
        if (element) {
          applyRect(element, () => ({ height: 400, left: 0, top: 0, width: 200 }));
          if (grid) {
            element.style.display = "grid";
            element.style.gridTemplateColumns = "1fr 1fr";
          }
        }
      }}
    >
      {Array.from({ length: count }, (_, index) => {
        const row = rowProps(index);
        return (
          <div
            className={`row ${row.className ?? ""}`}
            data-index={index}
            data-transform={row.style?.transform ?? ""}
            key={index}
            ref={(element) => {
              if (element) applyRect(element, () => rectFor(index));
              if (index === skipRowRef) return;
              row.rootRef(element);
            }}
          >
            <button className="handle" data-display={displayIndex(index)} type="button" {...handleProps(index)}>
              {index}
            </button>
          </div>
        );
      })}
    </div>
  );
};

const handles = (container: HTMLElement) => Array.from(container.querySelectorAll<HTMLButtonElement>(".handle"));
const rows = (container: HTMLElement) => Array.from(container.querySelectorAll<HTMLElement>(".row"));

beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false })),
  );
  window.matchMedia = vi.fn(() => ({ matches: false })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("keyboard reordering", () => {
  it("moves a row up and down with the arrow keys", () => {
    const onReorder = vi.fn();
    const { container } = render(<Harness count={3} onReorder={onReorder} rectFor={stackRect} />);

    fireEvent.keyDown(handles(container)[1] as HTMLButtonElement, { key: "ArrowUp" });
    fireEvent.keyDown(handles(container)[1] as HTMLButtonElement, { key: "ArrowDown" });

    expect(onReorder.mock.calls).toEqual([
      [1, 0],
      [1, 2],
    ]);
  });

  it("does nothing at the ends of the list or for another key", () => {
    const onReorder = vi.fn();
    const { container } = render(<Harness count={3} onReorder={onReorder} rectFor={stackRect} />);

    fireEvent.keyDown(handles(container)[0] as HTMLButtonElement, { key: "ArrowUp" });
    fireEvent.keyDown(handles(container)[2] as HTMLButtonElement, { key: "ArrowDown" });
    fireEvent.keyDown(handles(container)[1] as HTMLButtonElement, { key: "Enter" });

    expect(onReorder).not.toHaveBeenCalled();
  });

  it("ignores the arrow keys while reordering is disabled", () => {
    const onReorder = vi.fn();
    const { container } = render(<Harness count={3} disabled onReorder={onReorder} rectFor={stackRect} />);

    fireEvent.keyDown(handles(container)[1] as HTMLButtonElement, { key: "ArrowUp" });

    expect(onReorder).not.toHaveBeenCalled();
  });
});

describe("pointer reordering in a vertical stack", () => {
  const dragTo = (container: HTMLElement, from: number, clientY: number) => {
    const handle = handles(container)[from] as HTMLButtonElement;
    fireEvent.pointerDown(handle, { clientX: 10, clientY: 20, pointerId: 1, pointerType: "mouse" });
    fireEvent.pointerMove(handle, { clientX: 10, clientY, pointerId: 1 });
    return handle;
  };

  it("commits a downward move once the leading edge passes the next row's centre", () => {
    const onReorder = vi.fn();
    const { container } = render(<Harness count={4} onReorder={onReorder} rectFor={stackRect} />);

    const handle = dragTo(container, 0, 90);
    expect(container.querySelector(".rows")?.getAttribute("data-dragging")).toBe("yes");
    expect(rows(container)[0]?.className).toContain("rw-dragging");
    // Rows between the grabbed slot and the target slide up by one row span.
    expect(rows(container)[1]?.getAttribute("data-transform")).toBe("translateY(-50px)");
    expect(handles(container)[0]?.getAttribute("data-display")).toBe("1");
    expect(handles(container)[1]?.getAttribute("data-display")).toBe("0");

    fireEvent.pointerUp(handle, { pointerId: 1 });

    expect(onReorder).toHaveBeenCalledWith(0, 1);
  });

  it("commits an upward move and shifts the rows it passes down", () => {
    const onReorder = vi.fn();
    const { container } = render(<Harness count={4} onReorder={onReorder} rectFor={stackRect} />);

    const handle = dragTo(container, 3, -50);
    expect(rows(container)[2]?.getAttribute("data-transform")).toBe("translateY(50px)");
    expect(handles(container)[3]?.getAttribute("data-display")).toBe("2");

    fireEvent.pointerUp(handle, { pointerId: 1 });

    expect(onReorder).toHaveBeenCalledWith(3, 2);
  });

  it("drops the move when the pointer is cancelled", () => {
    const onReorder = vi.fn();
    const { container } = render(<Harness count={4} onReorder={onReorder} rectFor={stackRect} />);

    const handle = dragTo(container, 0, 90);
    fireEvent.pointerCancel(handle, { pointerId: 1 });

    expect(onReorder).not.toHaveBeenCalled();
    expect(container.querySelector(".rows")?.getAttribute("data-dragging")).toBe("no");
  });

  it("does not commit when the row never leaves its own slot", () => {
    const onReorder = vi.fn();
    const { container } = render(<Harness count={4} onReorder={onReorder} rectFor={stackRect} />);

    const handle = dragTo(container, 1, 22);
    fireEvent.pointerUp(handle, { pointerId: 1 });

    expect(onReorder).not.toHaveBeenCalled();
  });

  it("swallows the click that ends a drag, then lets the next one through", () => {
    const onReorder = vi.fn();
    const onClick = vi.fn();
    const { container } = render(<Harness count={4} onReorder={onReorder} rectFor={stackRect} />);
    const handle = dragTo(container, 0, 90);
    fireEvent.pointerUp(handle, { pointerId: 1 });

    const suppressed = fireEvent.click(handle);
    expect(suppressed).toBe(false);
    expect(fireEvent.click(handle)).toBe(true);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("refuses to start when a row element was never registered", () => {
    const onReorder = vi.fn();
    const { container } = render(<Harness count={3} onReorder={onReorder} rectFor={stackRect} skipRowRef={2} />);

    fireEvent.pointerDown(handles(container)[0] as HTMLButtonElement, {
      clientX: 0,
      clientY: 0,
      pointerId: 1,
      pointerType: "mouse",
    });

    expect(container.querySelector(".rows")?.getAttribute("data-dragging")).toBe("no");
  });

  it("ignores a non-primary mouse button and a disabled stack", () => {
    const onReorder = vi.fn();
    const { container } = render(<Harness count={3} onReorder={onReorder} rectFor={stackRect} />);
    fireEvent.pointerDown(handles(container)[0] as HTMLButtonElement, {
      button: 2,
      pointerId: 1,
      pointerType: "mouse",
    });
    expect(container.querySelector(".rows")?.getAttribute("data-dragging")).toBe("no");

    const disabled = render(<Harness count={3} disabled onReorder={onReorder} rectFor={stackRect} />);
    fireEvent.pointerDown(handles(disabled.container)[0] as HTMLButtonElement, { pointerId: 1, pointerType: "mouse" });
    expect(disabled.container.querySelector(".rows")?.getAttribute("data-dragging")).toBe("no");
  });
});

describe("pointer reordering in a grid", () => {
  it("claims the nearest cell rather than the next row", () => {
    const onReorder = vi.fn();
    const { container } = render(<Harness count={4} grid onReorder={onReorder} rectFor={gridRect} />);

    const handle = handles(container)[0] as HTMLButtonElement;
    fireEvent.pointerDown(handle, { clientX: 0, clientY: 0, pointerId: 1, pointerType: "mouse" });
    fireEvent.pointerMove(handle, { clientX: 220, clientY: 0, pointerId: 1 });

    expect(rows(container)[0]?.getAttribute("data-transform")).toBe("translate(220px, 0px)");
    expect(rows(container)[1]?.getAttribute("data-transform")).toBe("translate(-220px, 0px)");

    fireEvent.pointerUp(handle, { pointerId: 1 });

    expect(onReorder).toHaveBeenCalledWith(0, 1);
  });

  it("leaves rows outside the moved range untransformed", () => {
    const onReorder = vi.fn();
    const { container } = render(<Harness count={4} grid onReorder={onReorder} rectFor={gridRect} />);

    const handle = handles(container)[0] as HTMLButtonElement;
    fireEvent.pointerDown(handle, { clientX: 0, clientY: 0, pointerId: 1, pointerType: "mouse" });
    fireEvent.pointerMove(handle, { clientX: 220, clientY: 0, pointerId: 1 });

    expect(rows(container)[2]?.getAttribute("data-transform")).toBe("");
    expect(rows(container)[3]?.getAttribute("data-transform")).toBe("");
  });
});

describe("mouse fallback", () => {
  it("drives a whole drag through mouse events", () => {
    const onReorder = vi.fn();
    const { container } = render(<Harness count={4} onReorder={onReorder} rectFor={stackRect} />);
    const handle = handles(container)[0] as HTMLButtonElement;

    fireEvent.mouseDown(handle, { clientX: 10, clientY: 20 });
    fireEvent.mouseMove(handle, { clientX: 10, clientY: 90 });
    expect(container.querySelector(".rows")?.getAttribute("data-dragging")).toBe("yes");

    fireEvent.mouseUp(handle);

    expect(onReorder).toHaveBeenCalledWith(0, 1);
  });

  it("ignores mouse moves and releases with no drag in flight", () => {
    const onReorder = vi.fn();
    const { container } = render(<Harness count={4} onReorder={onReorder} rectFor={stackRect} />);
    const handle = handles(container)[0] as HTMLButtonElement;

    fireEvent.mouseMove(handle, { clientX: 10, clientY: 90 });
    fireEvent.mouseUp(handle);

    expect(onReorder).not.toHaveBeenCalled();
    expect(container.querySelector(".rows")?.getAttribute("data-dragging")).toBe("no");
  });

  it("does not restart a drag that is already running", () => {
    const onReorder = vi.fn();
    const { container } = render(<Harness count={4} onReorder={onReorder} rectFor={stackRect} />);
    const handle = handles(container)[0] as HTMLButtonElement;

    fireEvent.mouseDown(handle, { clientX: 10, clientY: 20 });
    fireEvent.mouseDown(handles(container)[2] as HTMLButtonElement, { clientX: 10, clientY: 20 });
    fireEvent.mouseMove(handle, { clientX: 10, clientY: 90 });
    fireEvent.mouseUp(handle);

    expect(onReorder).toHaveBeenCalledWith(0, 1);
  });
});

describe("document-level pointer fallback", () => {
  // Some engines refuse pointer capture on a synthetic pointerdown; the hook then tracks the
  // drag through document listeners instead, which is the path exercised here.
  beforeEach(() => {
    vi.spyOn(Element.prototype, "setPointerCapture").mockImplementation(() => {
      throw new Error("pointer capture is unavailable");
    });
    vi.spyOn(Element.prototype, "hasPointerCapture").mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("commits a drag tracked on the document", () => {
    const onReorder = vi.fn();
    const { container } = render(<Harness count={4} onReorder={onReorder} rectFor={stackRect} />);

    fireEvent.pointerDown(handles(container)[0] as HTMLButtonElement, {
      clientX: 10,
      clientY: 20,
      pointerId: 7,
      pointerType: "mouse",
    });
    fireEvent.pointerMove(document, { clientX: 10, clientY: 90, pointerId: 7 });
    expect(container.querySelector(".rows")?.getAttribute("data-dragging")).toBe("yes");

    fireEvent.pointerUp(document, { pointerId: 7 });

    expect(onReorder).toHaveBeenCalledWith(0, 1);
  });

  it("ignores document events from a different pointer", () => {
    const onReorder = vi.fn();
    const { container } = render(<Harness count={4} onReorder={onReorder} rectFor={stackRect} />);

    fireEvent.pointerDown(handles(container)[0] as HTMLButtonElement, {
      clientX: 10,
      clientY: 20,
      pointerId: 7,
      pointerType: "mouse",
    });
    fireEvent.pointerMove(document, { clientX: 10, clientY: 90, pointerId: 8 });
    fireEvent.pointerUp(document, { pointerId: 8 });

    expect(onReorder).not.toHaveBeenCalled();
    expect(container.querySelector(".rows")?.getAttribute("data-dragging")).toBe("yes");
  });

  it("drops the drag on a document pointercancel", () => {
    const onReorder = vi.fn();
    const { container } = render(<Harness count={4} onReorder={onReorder} rectFor={stackRect} />);

    fireEvent.pointerDown(handles(container)[0] as HTMLButtonElement, {
      clientX: 10,
      clientY: 20,
      pointerId: 7,
      pointerType: "mouse",
    });
    fireEvent.pointerMove(document, { clientX: 10, clientY: 90, pointerId: 7 });
    fireEvent.pointerCancel(document, { pointerId: 7 });

    expect(onReorder).not.toHaveBeenCalled();
    expect(container.querySelector(".rows")?.getAttribute("data-dragging")).toBe("no");
  });
});

describe("FLIP settle after a commit", () => {
  it("translates the moved row back to its old position before releasing it", () => {
    // Rows swap places when the reorder commits, so the layout effect sees a real delta.
    const order = [0, 1, 2, 3];
    const rectFor = (index: number) => stackRect(order.indexOf(index));
    const onReorder = vi.fn((from: number, to: number) => {
      const [moved] = order.splice(from, 1);
      if (moved !== undefined) order.splice(to, 0, moved);
    });
    const { container, rerender } = render(<Harness count={4} onReorder={onReorder} rectFor={rectFor} />);

    fireEvent.keyDown(handles(container)[1] as HTMLButtonElement, { key: "ArrowUp" });
    rerender(<Harness count={4} onReorder={onReorder} rectFor={rectFor} />);

    expect(onReorder).toHaveBeenCalledWith(1, 0);
    const moved = rows(container)[1];
    expect(moved?.style.transition).toContain("180ms");
    expect(moved?.style.transform).toBe("");
    moved?.dispatchEvent(new Event("transitionend"));
    expect(moved?.style.transition).toBe("");
  });
});
