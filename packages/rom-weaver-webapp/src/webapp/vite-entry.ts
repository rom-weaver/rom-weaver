import "./console-log-capture.ts";
import "./browser-runtime-diagnostics.ts";
// Applies the persisted/system theme to <html data-theme> before first paint.
import "./theme.ts";
// style.css is imported by design-system/index.css into the `style` cascade layer, so the
// full layer order lives in one place.
import "./design-system/index.css";
import "./webapp.ts";
