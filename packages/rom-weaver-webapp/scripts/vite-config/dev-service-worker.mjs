import { normalizePath } from "vite";

// The dev server leaves `define` names in the source and sets them as globals from /@vite/env instead.
// Pages and Vite's own workers import that module, but the service worker vite-plugin-pwa serves does not.
// This mirrors Vite's injection into module workers.
export const importDevServiceWorkerDefines = (serviceWorkerSource) => {
  const serviceWorkerId = normalizePath(serviceWorkerSource);
  return {
    apply: "serve",
    name: "rom-weaver-dev-service-worker-defines",
    transform(code, id) {
      if (id === serviceWorkerId) return { code: `import "/@vite/env";${code}`, map: null };
    },
  };
};
