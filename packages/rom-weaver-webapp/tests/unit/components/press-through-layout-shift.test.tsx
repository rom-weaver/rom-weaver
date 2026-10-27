// @vitest-environment happy-dom
import { fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProgressActionButton } from "../../../src/presentation/react/progress-action-button.tsx";

/**
 * A run button that moves under a held mouse press (cards above it finished
 * loading) loses the release to another element, and the browser clicks their
 * shared ancestor. These tests replay that event sequence by hand: press on the
 * button, move it, release over a neighbour, then the browser's ancestor click.
 */

const PRESS = { button: 0, clientX: 100, clientY: 120, pointerId: 1 };

const box = (top: number) => ({
  bottom: top + 40,
  height: 40,
  left: 0,
  right: 200,
  toJSON: () => ({}),
  top,
  width: 200,
  x: 0,
  y: top,
});

const setup = ({ ariaDisabled = false } = {}) => {
  const onClick = vi.fn();
  const { container } = render(
    <div id="outer">
      <textarea id="neighbour" />
      <ProgressActionButton
        ariaDisabled={ariaDisabled}
        disabled={false}
        label="Apply"
        onClick={onClick}
        progress={null}
      />
    </div>,
  );
  const button = container.querySelector("button.run") as HTMLButtonElement;
  const neighbour = container.querySelector("#neighbour") as HTMLTextAreaElement;
  const outer = container.querySelector("#outer") as HTMLDivElement;
  let top = 100;
  vi.spyOn(button, "getBoundingClientRect").mockImplementation(() => box(top) as DOMRect);
  const moveButton = (nextTop: number) => {
    top = nextTop;
  };
  return { button, moveButton, neighbour, onClick, outer };
};

const scrollYDescriptor = Object.getOwnPropertyDescriptor(globalThis, "scrollY");
const setScrollY = (value: number) =>
  Object.defineProperty(globalThis, "scrollY", { configurable: true, get: () => value });

afterEach(() => {
  vi.useRealTimers();
  if (scrollYDescriptor) Object.defineProperty(globalThis, "scrollY", scrollYDescriptor);
  else Reflect.deleteProperty(globalThis, "scrollY");
});

describe("run button press through a layout shift", () => {
  it("clicks the button when it moved during the press and the release stayed on the pressed spot", () => {
    const { button, moveButton, neighbour, onClick, outer } = setup();
    fireEvent.pointerDown(button, PRESS);
    moveButton(153);
    fireEvent.pointerUp(neighbour, PRESS);
    fireEvent.click(outer);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("follows the button on screen when the page also scrolled during the press", () => {
    const { button, moveButton, neighbour, onClick, outer } = setup();
    setScrollY(500);
    fireEvent.pointerDown(button, PRESS);
    // The document shrank and regrew: the page scrolled back 50 px and the button moved down.
    setScrollY(450);
    moveButton(153);
    fireEvent.pointerUp(neighbour, PRESS);
    fireEvent.click(outer);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("does not click twice when the browser's own click reached the button", () => {
    const { button, moveButton, onClick } = setup();
    fireEvent.pointerDown(button, PRESS);
    moveButton(153);
    fireEvent.pointerUp(button, PRESS);
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("keeps drag-off cancel when the button did not move", () => {
    const { button, neighbour, onClick, outer } = setup();
    fireEvent.pointerDown(button, PRESS);
    fireEvent.pointerUp(neighbour, PRESS);
    fireEvent.click(outer);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("cancels when the pointer left the area the press went down on", () => {
    const { button, moveButton, neighbour, onClick, outer } = setup();
    fireEvent.pointerDown(button, PRESS);
    moveButton(153);
    fireEvent.pointerUp(neighbour, { ...PRESS, clientY: 150 });
    fireEvent.click(outer);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("ignores a click that arrives after the release's task", () => {
    vi.useFakeTimers();
    const { button, moveButton, neighbour, onClick, outer } = setup();
    fireEvent.pointerDown(button, PRESS);
    moveButton(153);
    fireEvent.pointerUp(neighbour, PRESS);
    vi.runAllTimers();
    fireEvent.click(outer);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("ignores a cancelled pointer and other mouse buttons", () => {
    const { button, moveButton, neighbour, onClick, outer } = setup();
    fireEvent.pointerDown(button, PRESS);
    moveButton(153);
    fireEvent.pointerCancel(neighbour, PRESS);
    fireEvent.pointerUp(neighbour, PRESS);
    fireEvent.click(outer);
    moveButton(100);
    fireEvent.pointerDown(button, { ...PRESS, button: 2 });
    moveButton(153);
    fireEvent.pointerUp(neighbour, PRESS);
    fireEvent.click(outer);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("drops the press on another press, a context menu, or a wheel scroll", () => {
    const { button, moveButton, neighbour, onClick, outer } = setup();
    for (const interrupt of [
      () => fireEvent.pointerDown(neighbour, PRESS),
      () => fireEvent.contextMenu(button, PRESS),
      () => fireEvent.wheel(neighbour, { deltaY: 60 }),
    ]) {
      moveButton(100);
      fireEvent.pointerDown(button, PRESS);
      interrupt();
      moveButton(153);
      fireEvent.pointerUp(neighbour, PRESS);
      fireEvent.click(outer);
    }
    expect(onClick).not.toHaveBeenCalled();
  });

  it("leaves an aria-disabled button inert", () => {
    const { button, moveButton, neighbour, onClick, outer } = setup({ ariaDisabled: true });
    fireEvent.pointerDown(button, PRESS);
    moveButton(153);
    fireEvent.pointerUp(neighbour, PRESS);
    fireEvent.click(outer);
    expect(onClick).not.toHaveBeenCalled();
  });
});
