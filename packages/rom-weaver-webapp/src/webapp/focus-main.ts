/**
 * Moves keyboard focus to the page's main landmark once a navigation has
 * rendered. Activating a link or palette row unmounts or scrolls away from the
 * control that held focus, which would otherwise drop it on BODY. The main
 * element is the skip link's target and takes programmatic focus.
 */
const focusMainLanding = (): void => {
  window.requestAnimationFrame(() => {
    document.getElementById("main-content")?.focus({ preventScroll: true });
  });
};

export { focusMainLanding };
