import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { useListReorder } from "../../src/public/react/components/ds/use-list-reorder.ts";

let mountedRoot = null;

const getRoot = () => {
  const existing = document.getElementById("app");
  if (existing) return existing;
  const element = document.createElement("div");
  element.id = "app";
  document.body.appendChild(element);
  return element;
};

const mount = (element) => {
  mountedRoot?.unmount?.();
  mountedRoot = null;
  const root = createRoot(getRoot());
  root.render(element);
  mountedRoot = root;
  return root;
};

afterEach(() => {
  mountedRoot?.unmount?.();
  mountedRoot = null;
  document.body.innerHTML = "";
});

// Double rAF so the browser has committed layout before rects are read.
const settle = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

const ROW_HEIGHT = 48;
const ROW_GAP = 8;

/** Renders real, laid-out rows exactly the way apply-patch-list-step.tsx wires
 * containerRef / rowProps / handleProps onto FileCard + PatchDragHandle. */
const Harness = ({ count, disabled, onReorder }) => {
  const { containerRef, displayIndex, dragging, handleProps, rowProps } = useListReorder({
    count,
    disabled,
    onReorder,
  });
  const displayIndexes = [];
  for (let index = 0; index < count; index += 1) displayIndexes.push(displayIndex(index));
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    const { rootRef, style: rowStyle, ...restRowProps } = rowProps(index);
    rows.push(
      createElement(
        "div",
        {
          ...restRowProps,
          "data-row-index": index,
          key: index,
          ref: rootRef,
          style: { boxSizing: "border-box", height: `${ROW_HEIGHT}px`, ...rowStyle },
        },
        createElement("button", { ...handleProps(index), id: `handle-${index}`, type: "button" }, `Row ${index}`),
      ),
    );
  }
  return createElement(
    "div",
    {
      "data-dragging": dragging ? "1" : "0",
      "data-display-indexes": displayIndexes.join(","),
      id: "reorder-container",
      ref: containerRef,
      style: { display: "flex", flexDirection: "column", gap: `${ROW_GAP}px`, width: "200px" },
    },
    rows,
  );
};

const mountHarness = (props) => {
  mount(createElement(Harness, props));
};

const getContainer = () => document.getElementById("reorder-container");

const dispatchKey = (element, key) => {
  element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key }));
};

const dispatchPointer = (element, type, options) => {
  element.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      button: 0,
      cancelable: true,
      isPrimary: true,
      pointerId: 1,
      pointerType: "mouse",
      ...options,
    }),
  );
};

test("ArrowDown moves focus row forward and ArrowUp moves it back", async () => {
  const onReorder = vi.fn();
  mountHarness({ count: 4, onReorder });
  await settle();

  const handle1 = document.getElementById("handle-1");
  dispatchKey(handle1, "ArrowDown");
  expect(onReorder).toHaveBeenCalledWith(1, 2);

  dispatchKey(handle1, "ArrowUp");
  expect(onReorder).toHaveBeenCalledWith(1, 0);

  expect(onReorder).toHaveBeenCalledTimes(2);
});

test("ArrowUp on the first row and ArrowDown on the last row are no-ops", async () => {
  const onReorder = vi.fn();
  mountHarness({ count: 3, onReorder });
  await settle();

  dispatchKey(document.getElementById("handle-0"), "ArrowUp");
  dispatchKey(document.getElementById("handle-2"), "ArrowDown");

  expect(onReorder).not.toHaveBeenCalled();
});

test("disabled suppresses keyboard reordering", async () => {
  const onReorder = vi.fn();
  mountHarness({ count: 3, disabled: true, onReorder });
  await settle();

  dispatchKey(document.getElementById("handle-1"), "ArrowDown");
  dispatchKey(document.getElementById("handle-1"), "ArrowUp");

  expect(onReorder).not.toHaveBeenCalled();
});

test("disabled suppresses pointer reordering (no drag state, no commit)", async () => {
  const onReorder = vi.fn();
  mountHarness({ count: 4, disabled: true, onReorder });
  await settle();

  const handle = document.getElementById("handle-0");
  const rect = handle.getBoundingClientRect();
  const startX = rect.left + rect.width / 2;
  const startY = rect.top + rect.height / 2;

  dispatchPointer(handle, "pointerdown", { clientX: startX, clientY: startY });
  dispatchPointer(handle, "pointermove", { clientX: startX, clientY: startY + 200 });
  dispatchPointer(handle, "pointerup", { clientX: startX, clientY: startY + 200 });
  await settle();

  expect(getContainer().dataset.dragging).toBe("0");
  expect(onReorder).not.toHaveBeenCalled();
});

test("pointer drag past a sibling's midpoint commits a reorder on release", async () => {
  const onReorder = vi.fn();
  mountHarness({ count: 4, onReorder });
  await settle();

  const row0 = document.querySelector('[data-row-index="0"]').getBoundingClientRect();
  const row1 = document.querySelector('[data-row-index="1"]').getBoundingClientRect();
  const handle0 = document.getElementById("handle-0");
  const handleRect = handle0.getBoundingClientRect();
  const startX = handleRect.left + handleRect.width / 2;
  const startY = handleRect.top + handleRect.height / 2;

  // Enough travel to carry row 0's leading (bottom) edge past row 1's centre:
  // half of row 0's own height plus the inter-row gap, plus a safety margin.
  const dy = (row0.height / 2 + (row1.top - row0.bottom)) * 1.5 + 10;

  dispatchPointer(handle0, "pointerdown", { clientX: startX, clientY: startY });
  dispatchPointer(handle0, "pointermove", { clientX: startX, clientY: startY + dy });
  await settle();

  expect(getContainer().dataset.dragging).toBe("1");
  // While dragging, row 0's live destination is index 1, and row 1 (displaced)
  // reports index 0 - this is what feeds the "Patch N of M" a11y label.
  expect(getContainer().dataset.displayIndexes).toBe("1,0,2,3");

  dispatchPointer(handle0, "pointerup", { clientX: startX, clientY: startY + dy });
  await settle();

  expect(onReorder).toHaveBeenCalledWith(0, 1);
  expect(getContainer().dataset.dragging).toBe("0");
  // Once the drag ends, display indexes revert to identity (the mock
  // onReorder doesn't actually mutate the rendered list).
  expect(getContainer().dataset.displayIndexes).toBe("0,1,2,3");
});

test("pointer drag that returns to the start slot cancels without committing", async () => {
  const onReorder = vi.fn();
  mountHarness({ count: 4, onReorder });
  await settle();

  const handle0 = document.getElementById("handle-0");
  const handleRect = handle0.getBoundingClientRect();
  const startX = handleRect.left + handleRect.width / 2;
  const startY = handleRect.top + handleRect.height / 2;

  dispatchPointer(handle0, "pointerdown", { clientX: startX, clientY: startY });
  dispatchPointer(handle0, "pointermove", { clientX: startX, clientY: startY + 200 });
  await settle();
  dispatchPointer(handle0, "pointermove", { clientX: startX, clientY: startY });
  await settle();
  dispatchPointer(handle0, "pointerup", { clientX: startX, clientY: startY });
  await settle();

  expect(onReorder).not.toHaveBeenCalled();
  expect(getContainer().dataset.dragging).toBe("0");
});

test("pointercancel discards the drag without committing", async () => {
  const onReorder = vi.fn();
  mountHarness({ count: 4, onReorder });
  await settle();

  const handle0 = document.getElementById("handle-0");
  const handleRect = handle0.getBoundingClientRect();
  const startX = handleRect.left + handleRect.width / 2;
  const startY = handleRect.top + handleRect.height / 2;

  dispatchPointer(handle0, "pointerdown", { clientX: startX, clientY: startY });
  dispatchPointer(handle0, "pointermove", { clientX: startX, clientY: startY + 200 });
  await settle();
  dispatchPointer(handle0, "pointercancel", { clientX: startX, clientY: startY + 200 });
  await settle();

  expect(onReorder).not.toHaveBeenCalled();
  expect(getContainer().dataset.dragging).toBe("0");
});
