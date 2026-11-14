import { normalizePath } from "vite";

// The dev server sets `define` names as globals from /@vite/env, which pages import.
// This adds that import to the dev service worker, as Vite does for module workers.
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
