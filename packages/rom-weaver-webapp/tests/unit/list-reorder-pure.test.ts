import { describe, expect, test } from "vitest";
import { reorder } from "../../src/public/react/components/ds/use-list-reorder.ts";

describe("reorder", () => {
  test("moves an item forward", () => {
    expect(reorder(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
  });

  test("moves an item backward", () => {
    expect(reorder(["a", "b", "c", "d"], 3, 1)).toEqual(["a", "d", "b", "c"]);
  });

  test("moving an adjacent item forward by one swaps the pair", () => {
    expect(reorder(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
  });

  test("moving an adjacent item backward by one swaps the pair", () => {
    expect(reorder(["a", "b", "c"], 1, 0)).toEqual(["b", "a", "c"]);
  });

  test("is a no-op when from equals to, but still returns a new array", () => {
    const list = ["a", "b", "c"];
    const result = reorder(list, 1, 1);
    expect(result).toEqual(list);
    expect(result).not.toBe(list);
  });

  test("returns an unchanged copy for a negative from index", () => {
    const list = ["a", "b", "c"];
    const result = reorder(list, -1, 1);
    expect(result).toEqual(list);
    expect(result).not.toBe(list);
  });

  test("returns an unchanged copy for a negative to index", () => {
    const list = ["a", "b", "c"];
    const result = reorder(list, 1, -1);
    expect(result).toEqual(list);
    expect(result).not.toBe(list);
  });

  test("returns an unchanged copy when from is out of range (>= length)", () => {
    const list = ["a", "b", "c"];
    const result = reorder(list, 5, 0);
    expect(result).toEqual(list);
    expect(result).not.toBe(list);
  });

  test("returns an unchanged copy when to is out of range (>= length)", () => {
    const list = ["a", "b", "c"];
    const result = reorder(list, 0, 5);
    expect(result).toEqual(list);
    expect(result).not.toBe(list);
  });

  test("does not mutate the input list", () => {
    const list = ["a", "b", "c", "d"];
    const snapshot = [...list];
    reorder(list, 0, 3);
    expect(list).toEqual(snapshot);
  });

  test("single-element list is always a no-op copy", () => {
    const list = ["only"];
    expect(reorder(list, 0, 0)).toEqual(["only"]);
    // `to` of 1 is out of range for a single-element list.
    expect(reorder(list, 0, 1)).toEqual(["only"]);
  });

  test("empty list returns an empty copy", () => {
    const result = reorder([], 0, 0);
    expect(result).toEqual([]);
  });

  test("moving the first item to the last slot", () => {
    expect(reorder(["a", "b", "c", "d"], 0, 3)).toEqual(["b", "c", "d", "a"]);
  });

  test("moving the last item to the first slot", () => {
    expect(reorder(["a", "b", "c", "d"], 3, 0)).toEqual(["d", "a", "b", "c"]);
  });
});
