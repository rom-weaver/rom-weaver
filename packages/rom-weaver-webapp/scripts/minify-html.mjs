import fs from "node:fs";
import path from "node:path";
import { minify } from "html-minifier-terser";

// Keep React's hydration markers. They are comments by design, and removing
// them makes React hydrate the server-rendered shell incorrectly.
const HTML_MINIFIER_OPTIONS = Object.freeze({
  collapseBooleanAttributes: false,
  collapseWhitespace: true,
  conservativeCollapse: true,
  minifyCSS: true,
  minifyJS: true,
  removeComments: false,
  keepClosingSlash: true,
  removeAttributeQuotes: false,
  removeEmptyAttributes: false,
  removeOptionalTags: false,
  removeRedundantAttributes: false,
  useShortDoctype: true,
});

const collectHtmlFiles = (directory) => {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectHtmlFiles(filePath));
    else if (entry.isFile() && entry.name.endsWith(".html")) files.push(filePath);
  }
  return files;
};

export const minifyHtml = (source) => minify(source, HTML_MINIFIER_OPTIONS);

export const minifyHtmlDirectory = async (directory) => {
  const files = collectHtmlFiles(directory);
  for (const filePath of files) {
    const source = fs.readFileSync(filePath, "utf8");
    const output = await minifyHtml(source);
    if (output !== source) fs.writeFileSync(filePath, output);
  }
  return files.length;
};
