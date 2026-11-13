import fs from "node:fs";
import path from "node:path";
import { minifyInlineScripts } from "../minify-inline-scripts.mjs";
import { documentNodes, parseDocument, replaceSourceRanges } from "../html-document.mjs";

// Head spacing has no visual effect. Script and style contents MUST retain their whitespace.
export const minifyDocumentHead = (html) => {
  const head = [...documentNodes(parseDocument(html))].find((node) => node.tagName === "head");
  const edits = [];
  for (const node of head.childNodes) {
    if (node.nodeName !== "#text" || !/^\s*$/.test(node.value)) continue;
    const location = node.sourceCodeLocation;
    if (location) edits.push({ start: location.startOffset, end: location.endOffset, text: "" });
  }
  return replaceSourceRanges(html, edits);
};

// The channel stamp derives each route document from the template. PRERENDER_ROOT
// adds two inline scripts, so the minifier runs on finished files, not in transformIndexHtml.
// It MUST run before the precache manifest is injected, which hashes these
// documents from disk.
export const minifyDocumentInlineScripts = (distDir) => {
  for (const name of fs.readdirSync(distDir, { recursive: true })) {
    const relativePath = String(name);
    if (!relativePath.endsWith(".html")) continue;
    const filePath = path.join(distDir, relativePath);
    const html = fs.readFileSync(filePath, "utf8");
    const minified = minifyDocumentHead(minifyInlineScripts(html, relativePath));
    if (minified !== html) fs.writeFileSync(filePath, minified);
  }
};
