export const summarizeCssCoverage = (entries) => {
  const stylesheets = new Map();
  for (const entry of entries) {
    let pathname;
    try {
      pathname = new URL(entry.url).pathname;
    } catch {
      continue;
    }
    if (!pathname.endsWith(".css") || typeof entry.text !== "string") continue;
    // Separate-origin audits load the same bundle, so key stylesheets by path, not origin.
    const key = `${pathname}\0${entry.text}`;
    const stylesheet = stylesheets.get(key) ?? { ranges: [], text: entry.text };
    stylesheet.ranges.push(...entry.ranges);
    stylesheets.set(key, stylesheet);
  }

  let totalBytes = 0;
  let usedBytes = 0;
  for (const { ranges, text } of stylesheets.values()) {
    totalBytes += Buffer.byteLength(text);
    let usedEnd = 0;
    for (const range of ranges.toSorted((left, right) => left.start - right.start)) {
      const start = Math.max(usedEnd, range.start);
      if (start < range.end) usedBytes += Buffer.byteLength(text.slice(start, range.end));
      usedEnd = Math.max(usedEnd, range.end);
    }
  }
  return { stylesheetCount: stylesheets.size, totalBytes, unusedBytes: totalBytes - usedBytes, usedBytes };
};
