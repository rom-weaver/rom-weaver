// Runs `task(item, index)` for every item with at most `limit` in flight and returns the results in item order.
export const mapConcurrently = async (items, limit, task) => {
  const results = Array.from({ length: items.length });
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await task(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
};
