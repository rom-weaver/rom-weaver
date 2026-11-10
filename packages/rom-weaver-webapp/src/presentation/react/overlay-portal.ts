/** Native modal siblings are inert regardless of z-index; other overlays inherit the styled app root. */
const getOverlayPortalTarget = (): Element =>
  document.activeElement?.closest("dialog:modal") ??
  document.querySelector("dialog:modal") ??
  document.querySelector(".rw-app") ??
  document.body;

export { getOverlayPortalTarget };
