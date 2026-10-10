const isRawHtmlContainer = (content) => {
  const lines = content.trim().split("\n");
  const openingTag = lines[0]?.trim().match(/^<([a-z][\w:-]*)\b[^>]*>$/iu);
  if (!openingTag || lines.length < 2) {
    return false;
  }

  return lines.at(-1)?.trim().toLowerCase() === `</${openingTag[1].toLowerCase()}>`;
};

const closingRunStart = (content, from, width) => {
  for (let search = from; search < content.length; ) {
    const start = content.indexOf("`", search);
    if (start < 0) {
      return -1;
    }
    let end = start;
    while (content[end] === "`") {
      end += 1;
    }
    if (end - start === width) {
      return start;
    }
    search = end;
  }
  return -1;
};

// markdown-it folds a line ending inside a code span into the span's text, so it
// never becomes a softbreak token. Find those breaks in the raw inline source and
// return each one's zero-based line offset within it.
const codeSpanBreakOffsets = (content) => {
  const offsets = [];
  let index = 0;
  while (index < content.length) {
    if (content[index] === "\\") {
      index += 2;
      continue;
    }
    if (content[index] !== "`") {
      index += 1;
      continue;
    }
    let openEnd = index;
    while (content[openEnd] === "`") {
      openEnd += 1;
    }
    const width = openEnd - index;
    const close = closingRunStart(content, openEnd, width);
    if (close < 0) {
      index = openEnd;
      continue;
    }
    if (content.slice(openEnd, close).includes("\n")) {
      offsets.push(content.slice(0, index).split("\n").length - 1);
    }
    index = close + width;
  }
  return offsets;
};

const noSoftLineBreaks = {
  names: ["RW001", "no-soft-line-breaks"],
  description: "Prose contains an unintentional line break",
  tags: ["whitespace"],
  parser: "markdownit",
  function: (params, onError) => {
    for (const token of params.parsers.markdownit.tokens) {
      if (isRawHtmlContainer(token.content ?? "")) {
        continue;
      }

      for (const child of token.children ?? []) {
        if (child.type !== "softbreak") {
          continue;
        }

        onError({
          lineNumber: child.lineNumber,
          detail: "Join the prose or use an intentional hard break.",
          context: child.line,
        });
      }

      if (!token.children) {
        continue;
      }
      const lines = (token.content ?? "").split("\n");
      for (const offset of codeSpanBreakOffsets(token.content ?? "")) {
        onError({
          lineNumber: token.lineNumber + offset,
          detail: "Join the code span onto one line.",
          context: lines[offset],
        });
      }
    }
  },
};

export default noSoftLineBreaks;
