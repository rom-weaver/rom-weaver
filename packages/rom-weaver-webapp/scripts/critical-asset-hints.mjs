// The stylesheet and entry module are the only two render-critical subresources, and the
// parser cannot discover either until the document has been fetched and parsed. Emitting
// them as `Link` response headers lets Cloudflare replay them in a 103 Early Hints
// response, so both fetches start during server think time instead of after HTML parse.
// Browsers that ignore 103 still honour the header on the document response itself, which
// is earlier than the parser either way.
//
// Both hints use `rel=preload`, not `rel=modulepreload`, because Cloudflare only replays
// `preload` and `preconnect` in the 103 - a `modulepreload` line is honoured on the
// document response but silently dropped from the Early Hints, which is the half of the
// win worth having. Chrome starts the entry fetch from `as=script` and the module script
// then reuses it (one request, `initiatorType: "link"`), so nothing double-fetches.
//
// Both carry `crossorigin` to match how the document fetches them - the stylesheet link
// and the module script both have the attribute - or the browser would fetch each twice.
//
// The build and `verify-seo-build.mjs` share these so a change to the emitted header and
// the check that guards it cannot drift apart.
const CRITICAL_ASSET_PATTERNS = [
  { as: "style", label: "stylesheet", pattern: /<link[^>]+rel="stylesheet"[^>]+href="\.(\/assets\/[^"]+\.css)"/ },
  { as: "script", label: "entry module", pattern: /<script[^>]+type="module"[^>]+src="\.(\/assets\/[^"]+\.js)"/ },
];

// Read out of the built index.html rather than the bundle so the hinted URLs are
// byte-for-byte the ones the document requests; a stale hint would preload a dead asset
// and leave the real ones on the post-parse critical path.
export const criticalAssetLinkHeaders = (indexHtml) =>
  CRITICAL_ASSET_PATTERNS.map(({ as, label, pattern }) => {
    const href = indexHtml.match(pattern)?.[1];
    if (!href) throw new Error(`index.html is missing its ${label}`);
    return `Link: <${href}>; rel=preload; as=${as}; crossorigin`;
  });
