import { parse } from "parse5";

export const parseDocument = (html) => parse(html, { sourceCodeLocationInfo: true });

export function* documentNodes(node) {
  yield node;
  for (const child of node.childNodes ?? []) yield* documentNodes(child);
}

const NON_PROSE_ELEMENTS = new Set(["script", "style", "template"]);
const BLOCK_ELEMENTS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "div",
  "dl",
  "dt",
  "dd",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "td",
  "th",
  "tr",
  "ul",
]);

const proseText = (node) => {
  if (NON_PROSE_ELEMENTS.has(node.tagName)) return "";
  if (node.nodeName === "#text") return node.value;
  const text = (node.childNodes ?? []).map(proseText).join("");
  return BLOCK_ELEMENTS.has(node.tagName) ? ` ${text} ` : text;
};

export const countVisibleWords = (source) => {
  const document = parseDocument(source);
  const body = [...documentNodes(document)].find((node) => node.tagName === "body");
  return proseText(body).trim().split(/\s+/).filter(Boolean).length;
};

const headingText = (node) => {
  if (NON_PROSE_ELEMENTS.has(node.tagName)) return "";
  if (node.nodeName === "#text") return node.value;
  return (node.childNodes ?? []).map(headingText).join("");
};

export const hasDescriptiveHeading = (html, siteName) => {
  const headings = [...documentNodes(parseDocument(html))].filter((node) => node.tagName === "h1");
  if (headings.length !== 1) return false;
  const text = headingText(headings[0]).trim();
  return text.length > 0 && text !== siteName;
};

export const replaceSourceRanges = (html, edits) => {
  for (const { start, end, text } of edits.sort((a, b) => b.start - a.start)) {
    html = html.slice(0, start) + text + html.slice(end);
  }
  return html;
};
