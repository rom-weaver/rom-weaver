// @vitest-environment happy-dom
import { act, render } from "@testing-library/preact";
import { createElement } from "preact";
import { describe, expect, it } from "vitest";
import { createAsyncComponent } from "../../src/webapp/async-component.tsx";

describe("createAsyncComponent", () => {
  it("updates a mounted component when preload resolves before its effect subscribes", async () => {
    let resolveLoader: ((module: { default: () => ReturnType<typeof createElement> }) => void) | undefined;
    const loader = new Promise<{ default: () => ReturnType<typeof createElement> }>((resolve) => {
      resolveLoader = resolve;
    });
    const route = createAsyncComponent(() => loader);
    const { container } = render(createElement(route.Component, {}));

    resolveLoader?.({ default: () => createElement("div", { "data-testid": "loaded" }, "Ready") });
    await act(async () => {
      await route.preload();
    });

    expect(container.querySelector('[data-testid="loaded"]')?.textContent).toBe("Ready");
  });
});
