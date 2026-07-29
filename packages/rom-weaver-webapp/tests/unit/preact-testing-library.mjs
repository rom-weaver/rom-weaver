import { fireEvent as preactFireEvent } from "@testing-library/preact";

// Preact Testing Library's global compat detection eventually rewrites every `change`
// to `input`, including file inputs and selects whose compat event remains `change`.
const dispatch = (element, type, init = {}) => {
  for (const [name, value] of Object.entries(init.target || {})) {
    Object.defineProperty(element, name, { configurable: true, value });
  }
  const event = new element.ownerDocument.defaultView.Event(type, {
    bubbles: true,
    cancelable: true,
  });
  return preactFireEvent(element, event);
};

const fireEvent = Object.assign((...args) => preactFireEvent(...args), preactFireEvent, {
  change: (element, init) => dispatch(element, "change", init),
  // preact/compat normalizes React's focus handler to the bubbling focusin event.
  focus: (element) => dispatch(element, "focusin"),
});

export * from "@testing-library/preact";
export { fireEvent };
