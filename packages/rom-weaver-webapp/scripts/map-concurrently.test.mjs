import assert from "node:assert/strict";
import test from "node:test";
import { mapConcurrently } from "./map-concurrently.mjs";

test("returns results in item order even when later items finish first", async () => {
  const delays = [30, 1, 10];
  const results = await mapConcurrently(delays, 3, async (delay, index) => {
    await new Promise((resolve) => setTimeout(resolve, delay));
    return index;
  });
  assert.deepEqual(results, [0, 1, 2]);
});

test("never runs more than the limit at once and visits every item once", async () => {
  let running = 0;
  let peak = 0;
  const visited = [];
  await mapConcurrently([1, 2, 3, 4, 5, 6, 7], 3, async (item) => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    visited.push(item);
    running -= 1;
  });
  assert.equal(peak, 3);
  assert.deepEqual(
    visited.toSorted((a, b) => a - b),
    [1, 2, 3, 4, 5, 6, 7],
  );
});

test("handles an empty list and a limit above the item count", async () => {
  assert.deepEqual(await mapConcurrently([], 4, async () => 1), []);
  assert.deepEqual(await mapConcurrently(["a"], 4, async (item) => item), ["a"]);
});

test("rejects with the first task error", async () => {
  await assert.rejects(
    mapConcurrently([1, 2], 2, async (item) => {
      if (item === 2) throw new Error("boom");
    }),
    /boom/,
  );
});
