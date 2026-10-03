// Interception MUST be installed before WASM workers start because Chromium can
// stall when routing changes after threaded operations.
export const createGuidedLoadingAudit = async (context, scanLiveApp) => {
  let active = null;
  await context.route("**/{first-weave.zip,hello-world.nes,modified-world.nes}", (route) => {
    const sampleName = new URL(route.request().url()).pathname.split("/").at(-1);
    if (!active?.sampleNames.includes(sampleName)) return route.continue();
    const continued = active.release.promise.then(() => route.continue());
    active.pendingRequests.push(continued);
    return continued;
  });

  return async (page, sampleNames, label, start) => {
    if (active) throw new Error("A guided loading audit is already active");
    /** @type {Promise<void>[]} */
    const pendingRequests = [];
    const audit = { pendingRequests, release: Promise.withResolvers(), sampleNames };
    active = audit;
    try {
      await start();
      await page.locator('.sample-tutorial-dialog[data-loading="true"]').waitFor({ state: "visible" });
      await scanLiveApp(page, label);
    } finally {
      active = null;
      audit.release.resolve();
      await Promise.all(audit.pendingRequests);
    }
  };
};
