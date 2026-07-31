import { fireEvent as preactFireEvent } from "@testing-library/preact";

// Preact Testing Library's global compat detection eventually rewrites every `change`
// to `input`, including file inputs and selects whose compat event remains `change`.
// `init.target` is assigned onto the element the same way @testing-library/dom does it - the
// properties it overwrites (`files`, `value`) are read-only, so there is no setter to go through.
const dispatch = (element, type, init = {}) => {
  const { target, ...eventInit } = init;
  for (const [name, value] of Object.entries(target || {})) {
    Object.defineProperty(element, name, { configurable: true, value });
  }
  const event = new element.ownerDocument.defaultView.Event(type, {
    bubbles: true,
    cancelable: true,
    ...eventInit,
  });
  return preactFireEvent(element, event);
};

const fireEvent = Object.assign((...args) => preactFireEvent(...args), preactFireEvent, {
  change: (element, init) => dispatch(element, "change", init),
  // preact/compat normalizes React's focus handler to the bubbling focusin event. Focus the element
  // for real rather than dispatching focusin at it: that moves document.activeElement (which a
  // synthetic dispatch leaves untouched, so any activeElement assertion would be meaningless) and
  // the DOM emits focus and focusin itself.
  focus: (element) => {
    element.focus();
    return true;
  },
  // preact/compat normalizes React's blur handler to the bubbling focusout event.
  blur: (element, init) => preactFireEvent.focusOut(element, init),
});

export * from "@testing-library/preact";
export { fireEvent };
