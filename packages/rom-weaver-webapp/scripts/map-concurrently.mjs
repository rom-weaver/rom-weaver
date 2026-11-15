// Runs `task(item, index)` on each item, at most `limit` at once. Results keep item order.
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
