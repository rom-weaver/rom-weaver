import { SITE_ORIGIN } from "./docs-routing.mjs";

// RFC 9727 publishes an API catalog at the well-known "api-catalog" URI. The
// webapp is static and runs all work in the browser, so its only machine-facing
// HTTP interface is the URL session API: GET routes whose query parameters
// preload a session. The catalog points at the OpenAPI description of that API
// and at the guide that documents it for people.
const API_CATALOG_PATH = "/.well-known/api-catalog";
const OPENAPI_PATH = "/openapi.json";
const WEBAPP_INTEGRATION_DOC_PATH = "/docs/webapp-integration";

const OPENAPI_SOURCE = {
  openapi: "3.1.0",
  info: {
    title: "rom-weaver webapp integration API",
    version: "1.0.0",
    summary: "Preload a rom-weaver patch session through the webapp URL.",
    description:
      "rom-weaver runs entirely in the browser and exposes no server-side data API. " +
      "These GET routes accept query parameters that the client reads once at startup to " +
      `preload a session. See ${SITE_ORIGIN}${WEBAPP_INTEGRATION_DOC_PATH}.`,
    license: { identifier: "AGPL-3.0-or-later", name: "AGPL-3.0-or-later" },
  },
  servers: [{ url: SITE_ORIGIN }],
  // The routes are public: no authentication, cookies, or tokens.
  security: [],
  paths: {
    "/apply-patches": {
      get: {
        operationId: "openApplyWorkflow",
        description:
          "Loads the Apply workflow with preloaded inputs. The client fetches each source in " +
          "the browser, so every remote host MUST allow the webapp origin through CORS.",
        parameters: [
          {
            description: "URL of the source ROM to preload.",
            in: "query",
            name: "rom",
            required: false,
            schema: { format: "uri", type: "string" },
          },
          {
            description: "URL of a patch to preload. Repeat the parameter to preload several patches in order.",
            in: "query",
            name: "patch",
            required: false,
            schema: { items: { format: "uri", type: "string" }, type: "array" },
          },
        ],
        responses: {
          200: {
            content: { "text/html": { schema: { type: "string" } } },
            description: "The webapp shell. The session runs in the browser.",
          },
        },
        summary: "Open the Apply workflow with preloaded inputs",
      },
    },
    "/bundle-patches": {
      get: {
        operationId: "openBundleWorkflow",
        description:
          "Loads the Bundle workflow with a preloaded bundle. The client fetches the bundle " +
          "URL in the browser, so the remote host MUST allow the webapp origin through CORS.",
        parameters: [
          {
            description: "URL of a rom-weaver bundle to preload.",
            in: "query",
            name: "bundle",
            required: false,
            schema: { format: "uri", type: "string" },
          },
        ],
        responses: {
          200: {
            content: { "text/html": { schema: { type: "string" } } },
            description: "The webapp shell. The bundle resolves in the browser.",
          },
        },
        summary: "Open the Bundle workflow with a preloaded bundle",
      },
    },
  },
};

const createApiCatalogSource = () =>
  `${JSON.stringify(
    {
      linkset: [
        {
          anchor: `${SITE_ORIGIN}/`,
          "service-desc": [{ href: `${SITE_ORIGIN}${OPENAPI_PATH}`, type: "application/json" }],
          "service-doc": [{ href: `${SITE_ORIGIN}${WEBAPP_INTEGRATION_DOC_PATH}`, type: "text/html" }],
        },
      ],
    },
    null,
    2,
  )}\n`;

const createOpenApiSource = () => `${JSON.stringify(OPENAPI_SOURCE, null, 2)}\n`;

export { API_CATALOG_PATH, createApiCatalogSource, createOpenApiSource, OPENAPI_PATH };
