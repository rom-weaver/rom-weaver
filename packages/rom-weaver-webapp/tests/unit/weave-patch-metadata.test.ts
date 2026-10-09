import { describe, expect, it } from "vitest";
import { mergeWeaveMetaForIds } from "../../src/public/react/use-weave-apply-session.ts";

describe("weave patch metadata", () => {
  it("updates shared fields without replacing individual metadata", () => {
    const previous = new Map([
      ["patch-a", { author: "Old author", description: "First patch" }],
      ["patch-b", { name: "Second patch", version: "0.9" }],
    ]);

    const result = mergeWeaveMetaForIds(previous, ["patch-a", "patch-b"], {
      author: "Shared author",
      version: "1.0",
    });

    expect(result.get("patch-a")).toEqual({
      author: "Shared author",
      description: "First patch",
      version: "1.0",
    });
    expect(result.get("patch-b")).toEqual({
      author: "Shared author",
      name: "Second patch",
      version: "1.0",
    });
    expect(previous.get("patch-a")?.author).toBe("Old author");
  });

  it("clears only the selected shared field", () => {
    const previous = new Map([["patch-a", { author: "Author", version: "1.0" }]]);

    const result = mergeWeaveMetaForIds(previous, ["patch-a"], { version: undefined });

    expect(result.get("patch-a")).toEqual({ author: "Author", version: undefined });
  });
});
