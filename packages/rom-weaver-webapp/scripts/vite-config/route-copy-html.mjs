// Anchor hrefs that the page's own URL cannot resolve: not rooted, not a fragment or query, and no scheme.
const RELATIVE_ANCHOR_HREF = /(<a\b[^>]*?\shref=")(?![/#?]|[a-z][a-z0-9+.-]*:)([^"]*")/gi;

/**
 * The `/<slug>/` copy of a route resolves its assets through `<base href="../">`, which
 * a crawler ignores, so its bare anchor hrefs (`compress`) would land at `/<slug>/compress`.
 * Rooting them keeps them valid either way.
 */
export const rootRelativeAnchors = (html) => html.replace(RELATIVE_ANCHOR_HREF, "$1/$2");
