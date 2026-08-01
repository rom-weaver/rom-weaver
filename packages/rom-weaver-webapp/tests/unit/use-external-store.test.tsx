// @vitest-environment happy-dom
import { render } from "@testing-library/preact";
import { createElement } from "preact";
import { useExternalStore, setExternalStoreHydrating } from "../../src/lib/use-external-store.ts";
import { afterEach, describe, expect, it } from "vitest";

afterEach(() => setExternalStoreHydrating(false));

describe("useExternalStore", () => {
  it("uses the live snapshot for a late client mount", () => {
    let current = "stored";
    const seen: string[] = [];
    const Reader = () => {
      const value = useExternalStore(
        () => () => undefined,
        () => current,
        () => "server",
      );
      seen.push(value);
      return createElement("output", {}, value);
    };

    setExternalStoreHydrating(false);
    const { container } = render(createElement(Reader, {}));

    expect(seen[0]).toBe("stored");
    expect(container.textContent).toBe("stored");
  });

  it("starts hydration from the server snapshot and reconciles before paint", () => {
    let current = "stored";
    const seen: string[] = [];
    const Reader = () => {
      const value = useExternalStore(
        () => () => undefined,
        () => current,
        () => "server",
      );
      seen.push(value);
      return createElement("output", {}, value);
    };

    setExternalStoreHydrating(true);
    const { container } = render(createElement(Reader, {}));

    expect(seen[0]).toBe("server");
    expect(seen.at(-1)).toBe("stored");
    expect(container.textContent).toBe("stored");
  });
});
