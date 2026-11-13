const DOCS_PAGE_MODULE_PREFIX = "\0virtual:rom-weaver-docs-page/";

/** @param {{ moduleIds?: string[] }} chunk */
const isDocsPageChunk = ({ moduleIds = [] }) => moduleIds.some((id) => id.startsWith(DOCS_PAGE_MODULE_PREFIX));

/** Keep each guide lazy-loaded while sharing the Pages route wildcard with other docs assets. */
const chunkFileNames = (chunk) => (isDocsPageChunk(chunk) ? "assets/docs-page-[hash].js" : "assets/[name]-[hash].js");

export { chunkFileNames };
