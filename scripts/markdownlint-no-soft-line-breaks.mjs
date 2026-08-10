const isRawHtmlContainer = (content) => {
  const lines = content.trim().split("\n");
  const openingTag = lines[0]?.trim().match(/^<([a-z][\w:-]*)\b[^>]*>$/iu);
  if (!openingTag || lines.length < 2) {
    return false;
  }

  return lines.at(-1)?.trim().toLowerCase() === `</${openingTag[1].toLowerCase()}>`;
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
    }
  },
};

export default noSoftLineBreaks;
