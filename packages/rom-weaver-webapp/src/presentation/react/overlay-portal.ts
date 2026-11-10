/** Native modal siblings are inert regardless of z-index. An owner scopes the modal lookup to its ancestors. */
const getOverlayPortalTarget = (owner?: Element | null): Element =>
  (owner === undefined
    ? (document.activeElement?.closest("dialog:modal") ?? document.querySelector("dialog:modal"))
    : owner?.closest("dialog:modal")) ??
  document.querySelector(".rw-app") ??
  document.body;

export { getOverlayPortalTarget };
