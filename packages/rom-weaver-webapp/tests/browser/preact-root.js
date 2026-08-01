import { render } from "preact";

const createRoot = (container) => ({
  render: (children) => render(children, container),
  unmount: () => render(null, container),
});

export { createRoot };
